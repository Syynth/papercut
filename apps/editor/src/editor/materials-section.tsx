/**
 * Project settings › Materials (decisions of 2026-09-19): one section where
 * there were two. The Materials screen showed what the tags amount to and the
 * Terrain sets screen edited the tags, over the same list of materials in two
 * dressings; here the material is the SUBJECT and the stage shows views of it.
 *
 * The side column is the project's materials in priority order, and only that.
 * The selected one expands into its subjects — on its own, then meeting each
 * other material — and the lit one is what every view shows: what Preview
 * assembles, what Tag's block writes. The views switch through a control that
 * floats on the stage; the bar across the top only names the subject and holds
 * the view's own tools; the form is about the subject, with the Tagging block
 * on top while tagging.
 *
 * Nothing about a transition is stored (ruling of 2026-09-17). Everything
 * shown is a query over the tags (`coverage.ts`), and everything written is a
 * corner tag (`tagger.tsx`). Every material edit is one `project.materials.set`
 * with the whole list, because its order is the materials' priority.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import { DEFAULT_FRINGE_ANGLE, DEFAULT_PICKET_DISTANCE, MAX_PICKET_DISTANCE, materialById, materialOfTag, nextMaterialId, archetypeOfTag, directionOfTag, slotOfTag, tagOf, withArchetype, withDirection, type ArchetypeId, type DirectionCount, type MaterialDef, type ReadonlyProjectDoc, type Tag, type TagDirection } from '@papercut/document'
import { useHost, useProject, useViewSelector } from '@papercut/editor-host'
import { allSlots, archetypeOf, archetypes, arrangements, type LoadedSet, type Slot } from '@papercut/geometry'
import { Action, AssetPicker, ColorInput, CoverageMark, FaceMarks, Field, FloatStage, StagePanel, StageToolbar, Library, LibraryGroup, MaterialRow, Note, NumberInput, Segmented, Select, StageFloat, SubjectRow, TextInput, type IconName } from '@papercut/ui'

import { run } from './commands'
import { assembleAcross, coverageOf, cropOf, directionsOffered, facesOf, maskAt, pairingFace, subjectTags, type Coverage, type Found, type Subject } from './coverage'
import { Fixture } from './fixture-view'
import { useDeleteMaterial } from './materials'
import { PatchPreview, SheetCrop, TileGrid } from './preview'
import type { Session } from './session'
import { useTagger } from './tagger'

type View = 'preview' | 'tag' | '3d'

const FACE_ICONS: Record<ArchetypeId, IconName> = { floor: 'faceFloor', wall: 'faceWall', ramp: 'faceRamp' }

/**
 * The working context (decision of 2026-09-19): which archetype the section is working with, for every view — what
 * the Preview assembles, which tags the sheet lights, what the brush and a block write. `null` is Any: art that
 * draws on every face, which is what most art is.
 */
type Context = ArchetypeId | null
/** Where a preview starts in a context: flat for floors and Any, on the fixture for walls and ramps, which are not flat. The artist can still switch. */
const viewFor = (context: Context): View => (context === 'wall' || context === 'ramp' ? '3d' : 'preview')
/** The slots a context offers: its archetype's own, and for Any the ones every archetype has. */
const slotsFor = (context: Context): readonly Slot[] => archetypeOf(context ?? 'floor').slots
const contextName = (context: Context): string => (context === null ? 'any face' : `${context}s`)
/**
 * The archetypes whose faces have a direction the map asks art for today: a ramp, by the way it descends. Direction
 * is an axis of every tag (ruling of 2026-09-19), but offering it where nothing would ever ask for it would only
 * make art that never draws.
 */
const DIRECTED: readonly ArchetypeId[] = ['ramp']
const DIRECTION_NAMES: Record<TagDirection, string> = { n: 'runs north', e: 'runs east, across the sheet', s: 'runs south, down the sheet', w: 'runs west' }

const cssColor = (color: number): string => `#${color.toString(16).padStart(6, '0')}`
const materialsOf = (project: ReadonlyProjectDoc): readonly MaterialDef[] => project.materials

/**
 * The shape a subject is previewed in: `1` this material, `2` the one it meets, anything else nothing. Between them
 * the two shapes reach all fifteen corner masks, so an arrangement nobody drew shows up in the patch. The MEETING
 * shape keeps the second material strictly inside the first, because a corner where three things meet is one no
 * two-material tile can answer.
 */
const BLOB = ['..1111....', '.1111111..', '111111111.', '111..11111', '111..11111', '.11111111.', '..1111.1..', '11......11', '11......11']
const MEETING = ['...11111.....', '..111111111..', '.11222221111.', '1112222212111', '1122222221211', '1112222111111', '.11122111111.', '..111111111..', '...11111.....']

const cellsOf = (shape: readonly string[], first: Tag, second: Tag): Tag[][] => shape.map((row) => [...row].map((ch) => (ch === '1' ? first : ch === '2' ? second : null)))

/** A coverage as the sixteen cells of its mark: cell k is arrangement mask k. */
const cellsOfCoverage = (cover: Coverage): Array<'on' | 'off' | 'na'> => Array.from({ length: 16 }, (_, k) => (!cover.masks.includes(k) ? 'na' : cover.tiles.get(k) ? 'on' : 'off'))

/** A spelled transition (decision of 2026-09-19): what it is drawn over, what is drawn over that, and a third when three meet. Material ids; `null` under is nothing, `null` over or third is not picked. */
interface Spell {
  under: number | null
  over: number | null
  third: number | null
}

export function MaterialsSection({ session, selected, onSelect, sets, tagSets }: { session: Session; selected: number; onSelect: (id: number) => void; /** Everything the map draws with, the generated placeholder included: what coverage is asked of. */ sets: readonly LoadedSet[]; /** The project's own sheets: what can be tagged. */ tagSets: readonly LoadedSet[] }) {
  const host = useHost()
  const materials = useProject(materialsOf)
  const summaries = useSyncExternalStore(session.summaries.subscribe, session.summaries.get)
  const [other, setOther] = useState<number | null>(null)
  const [view, setView] = useState<View>('preview')
  const [context, setContext] = useState<Context>(null)
  /** The small preview on the Tag stage: which side it shows, and whether it is folded away. */
  const [mini, setMini] = useState<'2d' | '3d'>('2d')
  const [miniOpen, setMiniOpen] = useState(true)
  /** The arrangement the pointer is over, in the patch or in the crop; each lights the other. */
  const [lit, setLit] = useState<number | null>(null)
  const [tool, setTool] = useState<'corners' | 'erase'>('corners')
  const [slot, setSlot] = useState<string | null>(null)
  /** The direction the art being worked on is drawn for; `null` is every direction, which is what art that has no run wants. */
  const [direction, setDirection] = useState<TagDirection | null>(null)
  const [spell, setSpell] = useState<Spell>(() => ({ under: null, over: materialById(materials, selected)?.id ?? materials[0]?.id ?? null, third: null }))
  /**
   * Placing transitions is a MODE of the Tag stage (decision of 2026-09-19): entered by New transition…, left by Done
   * or Esc. While it lasts the pointer is armed and its controls are a toolbar on the stage.
   */
  const [placing, setPlacing] = useState(false)
  /** A tile to scroll to once the Tag view has the sheet up. */
  const [reveal, setReveal] = useState<Found | null>(null)
  /** What no tile answers on the 3D fixture, named once each: what its marks are. */
  const [missing, setMissing] = useState<readonly string[]>([])
  const fallback = useViewSelector((snapshot) => snapshot.context.fallback)

  const material = materialById(materials, selected) ?? materials[0]
  const active = material?.id ?? -1
  const position = materials.findIndex((m) => m.id === active)
  const meets = other === null ? null : (materialById(materials, other) ?? null)
  const subject: Subject = { material: active, other: meets?.id ?? null }

  /** The transition a subject spells: a material alone is its edge set against nothing; a pairing is the later by priority over the earlier. */
  const spellOf = (id: number, against: number | null): Spell => {
    if (against === null) return { under: null, over: id < 0 ? null : id, third: null }
    const later = materials.findIndex((m) => m.id === id) > materials.findIndex((m) => m.id === against)
    return later ? { under: against, over: id, third: null } : { under: id, over: against, third: null }
  }
  /** Choosing a subject also spells it; the spelling then stays until the artist changes it, which is what swapping a value for the next block is. */
  const select = (id: number, next: number | null = null): void => {
    onSelect(id)
    setOther(next)
    setLit(null)
    // Placing stays on: picking another subject while placing is how the next transition is spelled.
    setSpell(spellOf(id, next))
    // Tagging is left alone: the artist is in the middle of something. Otherwise the view is the face's (below).
    if (view !== 'tag') setView(viewFor(context))
  }
  /** Walls and ramps preview in 3D by default (decision of 2026-09-19): neither is flat, and a flat patch shows none of what matters about them. */
  const chooseContext = (next: Context): void => {
    setContext(next)
    // A slot the new archetype does not have falls back to its surface.
    if (slot !== null && !slotsFor(next).some((s) => s.id === slot)) setSlot(null)
    // Only a context whose faces have a direction keeps one.
    if (next === null || !DIRECTED.includes(next)) setDirection(null)
    setMini(viewFor(next) === '3d' ? '3d' : '2d')
    if (view !== 'tag') setView(viewFor(next))
  }
  const { remove, mapsUsing, dialog } = useDeleteMaterial(session, (next) => select(next))

  const commit = (next: readonly MaterialDef[]): void => void run(host, 'project.materials.set', { materials: next.map((m) => ({ ...m })) })
  const change = (changes: Partial<MaterialDef>): void => {
    if (material) commit(materials.map((m) => (m.id === active ? { ...material, ...changes } : m)))
  }
  const move = (to: number): void => {
    if (position < 0 || to < 0 || to >= materials.length) return
    const next = [...materials]
    const [moved] = next.splice(position, 1)
    next.splice(to, 0, moved)
    commit(next)
  }
  const add = (from: MaterialDef | undefined): void => {
    const id = nextMaterialId(materials)
    commit([...materials, from ? { ...from, id, name: `${from.name} copy` } : { id, name: `Material ${materials.length + 1}`, color: 0x808080 }])
    select(id)
  }

  // --- what the tags amount to ----------------------------------------------------
  /** Each material on its own, for the list: has anyone drawn it, on any face. */
  const alone = useMemo(() => new Map(materials.map((m) => [m.id, coverageOf(sets, { material: m.id, other: null }, null)] as const)), [materials, sets])
  const faces = useMemo(() => new Map(materials.map((m) => [m.id, facesOf(sets, m.id)] as const)), [materials, sets])
  /** The selected material meeting each of the others. */
  const pairings = useMemo(() => (material ? materials.filter((m) => m.id !== material.id).map((m) => ({ other: m, cover: coverageOf(sets, { material: material.id, other: m.id }, null) })) : []), [material, materials, sets])

  const { mine, theirs } = subjectTags(subject)
  /** The subject as the chosen face draws it: what the Preview shows. */
  const cover = useMemo(() => (material ? coverageOf(sets, { material: active, other: meets?.id ?? null }, context, direction) : null), [material, active, meets, sets, context, direction])
  const crop = useMemo(() => (cover ? cropOf(cover) : null), [cover])
  const cells = useMemo(() => (material ? cellsOf(theirs === null ? BLOB : MEETING, mine, theirs) : []), [material, mine, theirs])
  const corners = useMemo(() => assembleAcross(sets, cells, context, direction), [sets, cells, context, direction])
  const tile = sets[0]?.set.tile ?? 16
  const drawnFor = cover ? pairingFace(cover) : null

  // --- tagging --------------------------------------------------------------------
  const nameOfTag = useMemo(() => {
    const names = new Map(materials.map((m) => [m.id, m.name] as const))
    const slots = new Map(allSlots().map((s) => [s.id, s.name] as const))
    return (tag: Tag): string => {
      if (tag === null) return 'nothing'
      const name = names.get(materialOfTag(tag) ?? -1) ?? tag
      const slotName = slotOfTag(tag)
      const archetype = archetypeOfTag(tag)
      const drawnFor = directionOfTag(tag)
      return `${name}${slotName ? ` · ${slots.get(slotName) ?? slotName}` : ''}${archetype ? ` @ ${archetype}` : ''}${drawnFor ? ` / ${drawnFor}` : ''}`
    }
  }, [materials])
  const colourOf = useMemo(() => {
    const byMaterial = new Map(materials.map((m) => [m.id, cssColor(m.color)] as const))
    return (tag: Tag): string => byMaterial.get(materialOfTag(tag) ?? -1) ?? '#ff00ff'
  }, [materials])
  /** The spelled transition as the tags a block writes, under first; empty while what is drawn over it is not picked. */
  const values = useMemo((): Tag[] => {
    if (spell.over === null) return []
    const of = (id: number | null): Tag => (id === null ? null : withDirection(withArchetype(tagOf(id), context), direction))
    return [of(spell.under), of(spell.over), ...(spell.third === null ? [] : [of(spell.third)])]
  }, [spell, context, direction])
  const brush = material ? tagOf(material.id, slot, context, direction) : null
  /** The sheet that holds the subject's art, when one does: where the Tag view opens. */
  const preferred = useMemo(() => [...(cover?.tiles.values() ?? [])].find((f) => f !== null && tagSets.includes(f.loaded))?.loaded.set.sheet ?? null, [cover, tagSets])
  const tagger = useTagger({ session, sets: tagSets, active: view === 'tag', tool: placing ? 'block' : tool, brush, values, armed: placing && values.length > 1, onPlaced: () => undefined, context, slot, direction, selected: material ? material.id : null, nameOfTag, colourOf, preferred })

  // Esc leaves the placing mode, before anything else hears it: it must not close the settings under the artist.
  useEffect(() => {
    if (!placing) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setPlacing(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [placing])
  // A tile asked for from the Preview is scrolled to once its sheet is the one on the stage.
  useEffect(() => {
    if (view !== 'tag' || !reveal || tagger.loaded !== reveal.loaded) return
    tagger.reveal(reveal.index)
    setReveal(null)
  }, [view, reveal, tagger])

  /** From the Preview: a drawn tile opens its sheet at that tile; a missing one opens the sheet with the subject as the brush. */
  const openInTag = (_mask: number, found: Found | null): void => {
    setView('tag')
    setTool('corners')
    setPlacing(false)
    if (found && tagSets.includes(found.loaded)) {
      tagger.setSheet(found.loaded.set.sheet)
      setReveal(found)
    }
  }
  const newTransition = (): void => {
    setView('tag')
    setPlacing(true)
  }

  // --- the side column: the materials, and only that -----------------------------------
  const side = (
    <>
      <div className="ui-library-list">
        <LibraryGroup>By priority</LibraryGroup>
        {materials.map((m) => {
          const art = faces.get(m.id)
          const own = alone.get(m.id)
          return (
            <div key={m.id}>
              <MaterialRow
                name={m.name}
                swatch={cssColor(m.color)}
                active={m.id === active}
                onClick={() => select(m.id)}
                marks={art ? <FaceMarks faces={archetypes().map((a) => ({ id: a.id, title: a.title, icon: FACE_ICONS[a.id], art: art[a.id] }))} /> : null}
                trailing={own ? <CoverageMark cells={cellsOfCoverage(own)} drawn={own.drawn} owed={own.masks.length} /> : null}
              />
              {m.id === active ? (
                <div className="ui-subject-list">
                  <SubjectRow label="On its own" active={meets === null} onClick={() => select(m.id)} trailing={own ? <CoverageMark cells={cellsOfCoverage(own)} drawn={own.drawn} owed={own.masks.length} /> : null} />
                  {pairings.map((p) => {
                    const drawnIn = pairingFace(p.cover)
                    return (
                      <SubjectRow
                        key={p.other.id}
                        prefix="meets"
                        label={p.other.name}
                        note={drawnIn ?? undefined}
                        swatch={cssColor(p.other.color)}
                        active={meets?.id === p.other.id}
                        onClick={() => select(m.id, p.other.id)}
                        trailing={<CoverageMark cells={cellsOfCoverage(p.cover)} drawn={p.cover.drawn} owed={p.cover.masks.length} />}
                      />
                    )
                  })}
                  <Action title="New transition…" onClick={newTransition} />
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
      <div className="ui-library-foot" style={{ display: 'grid', gap: 6 }}>
        <Action title="New material" tone="accent" onClick={() => add(undefined)} />
        <Action title="Duplicate" disabled={!material} onClick={() => add(material)} />
      </div>
    </>
  )

  // An empty library (ruling of 2026-09-19) still has the list and New material: that is how it stops being empty.
  if (!material || !cover) {
    return (
      <Library
        tabs={<span className="ui-subject-bar-name">No materials</span>}
        side={side}
        stage={<Note>The library is empty. Add a material, then tag a sheet's corners with it in the Tag view; until then every face draws the fallback colour.</Note>}
        form={null}
      />
    )
  }

  /** Whether the context's faces have a direction, and which the material's art for it is drawn for. */
  const directed = context !== null && DIRECTED.includes(context)
  const count: DirectionCount = (context !== null ? material.directions?.[context] : undefined) ?? 1
  const offered = directionsOffered(count)
  /** Everything owed across the directions offered, beside the count for the one being worked in. */
  const allDirections = directed && offered.length > 1 ? offered.map((d) => coverageOf(sets, subject, context, d)) : null

  // --- the bar: the subject, and the view's own tools ---------------------------------
  const art = faces.get(material.id)
  const tabs = (
    <div className="ui-subject-bar">
      <span className="ui-swatch" style={{ background: cssColor(material.color), width: 14, height: 14 }} />
      <span className="ui-subject-bar-name">{material.name}</span>
      {art ? <FaceMarks faces={archetypes().map((a) => ({ id: a.id, title: a.title, icon: FACE_ICONS[a.id], art: art[a.id] }))} /> : null}
      {meets ? (
        <>
          <span className="ui-hint-line">meets</span>
          <span className="ui-swatch" style={{ background: cssColor(meets.color), width: 14, height: 14 }} />
          <span className="ui-subject-bar-name">{meets.name}</span>
        </>
      ) : (
        <span className="ui-hint-line">on its own</span>
      )}
      {drawnFor ? <span className="ui-hint-line">· drawn for {drawnFor}s</span> : null}
      <CoverageMark cells={cellsOfCoverage(cover)} drawn={cover.drawn} owed={cover.masks.length} large />
      {allDirections ? (
        <span className="ui-hint-line" title="Drawn and owed across every direction this material's art is drawn for">
          all {allDirections.length} directions {allDirections.reduce((n, c) => n + c.drawn, 0)}/{allDirections.reduce((n, c) => n + c.masks.length, 0)}
        </span>
      ) : null}
      <span className="ui-subject-bar-grow" />
      <div style={{ width: 250 }}>
        <Segmented
          value={context ?? 'any'}
          options={[{ value: 'any', label: 'Any', title: 'Art that draws on every face, which is what most art is' }, ...archetypes().map((a): { value: string; label: string; title: string } => ({ value: a.id, label: a.title, title: a.note }))]}
          onChange={(next) => chooseContext(next === 'any' ? null : (next as ArchetypeId))}
          title="What we are working on: the preview, the tags the sheet lights, and what the brush and a block write"
        />
      </div>
      {view === 'tag' ? (
        <>
          <span className="ui-tagger-divider" />
          <Action title="Undo" kbd="⌘Z" disabled={!tagger.canUndo} onClick={tagger.undo} />
          <Action title="Redo" kbd="⌘⇧Z" disabled={!tagger.canRedo} onClick={tagger.redo} />
          <span className="ui-tagger-divider" />
          <Action title="−" disabled={!tagger.canZoomOut} onClick={tagger.zoomOut} />
          <span className="ui-tagger-pct">{Math.round(tagger.scale * 100)}%</span>
          <Action title="+" disabled={!tagger.canZoomIn} onClick={tagger.zoomIn} />
        </>
      ) : null}
    </div>
  )

  // --- the pickers a spelling and a brush are made of ---------------------------------------
  const pick = (value: number | null, none: string | null, exclude: ReadonlyArray<number | null>, onChange: (id: number | null) => void) => (
    <Select value={value === null ? '' : String(value)} options={[...(none === null ? [] : [{ value: '', label: none }]), ...materials.filter((m) => m.id === value || !exclude.includes(m.id)).map((m) => ({ value: String(m.id), label: m.name }))]} onChange={(next) => onChange(next === '' ? null : Number(next))} />
  )

  // --- the stage: a view of the subject, its switch floating on it -----------------------
  const litKind = lit === null ? undefined : arrangements().find((a) => a.mask === lit)
  const litCount = lit === null ? 0 : corners.filter((c) => maskAt(c, mine, theirs) === lit).length
  const viewSwitch = (
    <StageFloat corner="right">
      <Segmented value={view} options={[{ value: 'preview', label: 'Preview' }, { value: 'tag', label: 'Tag' }, { value: '3d', label: '3D', title: "The subject on a fixture, drawn by the map's own renderer" }]} onChange={(next) => { setView(next); setPlacing(false) }} />
    </StageFloat>
  )
  const stage =
    view === 'preview' ? (
      <FloatStage floats={viewSwitch}>
        <div className="ui-patch-stage">
          {sets.length === 0 ? (
            <Note tone="warn">No images are loaded, so there is nothing to draw the patch from.</Note>
          ) : (
            <>
              <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
                <PatchPreview tile={tile} corners={corners} columns={(cells[0]?.length ?? 0) + 1} rows={cells.length + 1} scale={tile <= 16 ? 2 : 1} mine={mine} theirs={theirs} lit={lit} onLight={setLit} />
                <span className="ui-hint-line">{meets ? `how the two draw where they meet, on ${contextName(context)}` : `how it draws on ${contextName(context)} — the arrangements, assembled`}. A hatched corner is one no tile answers.</span>
              </div>
              <div style={{ display: 'flex', gap: 20, alignItems: 'start', flexWrap: 'wrap' }}>
                {crop ? <SheetCrop crop={crop} scale={tile <= 16 ? 3 : 1} lit={lit} onLight={setLit} onOpen={openInTag} /> : <TileGrid cover={cover} names={(mask) => arrangements().find((a) => a.mask === mask)?.kind ?? ''} lit={lit} onLight={setLit} onOpen={openInTag} />}
                <div style={{ display: 'grid', gap: 8, alignContent: 'start', maxWidth: 280 }}>
                  <span className="ui-hint-line">
                    {crop ? (
                      <>
                        <b>{crop.loaded.set.sheet}</b> at tiles ({crop.column}, {crop.row}) · {cover.drawn} of {cover.masks.length} drawn
                        {crop.unplaced.length ? ` · ${crop.unplaced.length} more have no tile and no place on the sheet yet` : ''}
                      </>
                    ) : cover.drawn === 0 ? (
                      'Nobody has drawn any of it yet.'
                    ) : (
                      `${cover.drawn} of ${cover.masks.length} drawn, across more than one sheet`
                    )}
                  </span>
                  <span className="ui-hint-line">{litKind ? `${litKind.name} · ${litKind.kind} · ${litCount} ${litCount === 1 ? 'corner' : 'corners'} of the patch · ${cover.tiles.get(litKind.mask) ? 'click to see it on the sheet' : 'nobody has drawn it — click to tag it'}` : 'Hover the patch or a tile: each lights the other. Click a tile to open the sheet there.'}</span>
                </div>
              </div>
            </>
          )}
        </div>
      </FloatStage>
    ) : view === '3d' ? (
      <FloatStage
        floats={
          <>
            {viewSwitch}
            {crop ? (
              <div className="ui-stage-float is-left" style={{ top: 'auto', bottom: 44, flexDirection: 'column', alignItems: 'start', padding: 8, gap: 6 }}>
                <SheetCrop crop={crop} scale={tile <= 16 ? 2 : 1} lit={lit} onLight={setLit} onOpen={openInTag} />
                <span className="ui-hint-line">
                  {crop.loaded.set.sheet} at ({crop.column}, {crop.row}) · {cover.drawn} of {cover.masks.length} drawn
                </span>
              </div>
            ) : null}
          </>
        }
        foot={
          <>
            {meets ? `${material.name} on a plateau walled and ramped in ${meets.name}, on ${material.name} ground with a patch of ${meets.name}` : `${material.name}: its top, its walls, its ramp and its ground`} · {missing.length === 0 ? 'every corner is answered' : `${missing.length} ${missing.length === 1 ? 'transition' : 'transitions'} fall back: ${missing.slice(0, 3).join('; ')}${missing.length > 3 ? '…' : ''}`} · drag to orbit · scroll to zoom
          </>
        }
      >
        <div style={{ position: 'absolute', inset: 0 }}>
          <Fixture material={active} other={meets?.id ?? null} sets={sets} fallback={fallback} onMissing={setMissing} />
        </div>
      </FloatStage>
    ) : (
      <FloatStage
        scrollRef={tagger.scrollRef}
        foot={tagger.foot}
        toolbar={
          placing ? (
            <StageToolbar title={`New transition · for ${contextName(context)}`} onDone={() => setPlacing(false)} hint={values.length < 2 ? 'Pick what is drawn over it' : !tagger.shape ? 'No block for that spelling' : `${tagger.shape.columns} × ${tagger.shape.rows} · click its top-left tile`}>
              <label>
                <span>under</span>
                {pick(spell.under, 'Nothing', [spell.over, spell.third], (under) => setSpell({ ...spell, under }))}
              </label>
              <label>
                <span>over it</span>
                {pick(spell.over, spell.over === null ? 'Pick a material…' : null, [spell.under, spell.third], (over) => setSpell({ ...spell, over }))}
              </label>
              <label>
                <span>third</span>
                {pick(spell.third, 'none', [spell.under, spell.over], (third) => setSpell({ ...spell, third }))}
              </label>
            </StageToolbar>
          ) : null
        }
        floats={
          <>
            {viewSwitch}
            {/* The slot picker for the archetype in the bar: what the brush writes, and which tags are lit. */}
            <StageFloat corner="left">
              <Select value={slot ?? ''} options={slotsFor(context).map((s) => ({ value: s.ordinary ? '' : s.id, label: `Slot: ${s.name}${s.note ? ` — ${s.note}` : ''}` }))} onChange={(next) => setSlot(next === '' ? null : next)} />
              {/* Direction is its own axis beside the slot: as many as the material says its art for this archetype is drawn for. */}
              {directed ? (
                <Select
                  value={direction ?? ''}
                  options={[{ value: '', label: 'Direction: any' }, ...offered.map((d): { value: string; label: string } => ({ value: d, label: `Direction: ${DIRECTION_NAMES[d]}` }))]}
                  onChange={(next) => setDirection(next === '' ? null : (next as TagDirection))}
                />
              ) : null}
            </StageFloat>
            {/* The subject as the tags now make it draw, small and where the work is; it follows each stroke. */}
            <StagePanel
              title="Preview"
              open={miniOpen}
              onToggle={() => setMiniOpen(!miniOpen)}
              controls={<Segmented value={mini} options={[{ value: '2d', label: '2D' }, { value: '3d', label: '3D' }]} onChange={setMini} />}
              caption={`${cover.drawn} of ${cover.masks.length} drawn on ${contextName(context)}${mini === '3d' && missing.length ? ` · ${missing.length} fall back` : ''}`}
            >
              {mini === '2d' ? (
                <PatchPreview tile={tile} corners={corners} columns={(cells[0]?.length ?? 0) + 1} rows={cells.length + 1} scale={1} mine={mine} theirs={theirs} lit={lit} onLight={setLit} />
              ) : (
                <div style={{ position: 'absolute', inset: 0 }}>
                  <Fixture material={active} other={meets?.id ?? null} sets={sets} fallback={fallback} onMissing={setMissing} />
                </div>
              )}
            </StagePanel>
          </>
        }
      >
        {tagger.stage ?? <Note>No sheet is loaded. Add one in Images to tag it.</Note>}
      </FloatStage>
    )

  // --- the form: about the subject, with the Tagging block on top while tagging ------------
  const tagging = (
    <>
      <div className="ui-k">Tagging</div>
      <Field label="Sheet">
        {tagger.loaded ? <AssetPicker value={tagger.loaded.set.sheet} options={tagger.options} onChange={tagger.setSheet} footer={tagger.pickerFooter} /> : <span className="ui-hint-line">No sheet is loaded.</span>}
      </Field>
      {placing ? (
        <span className="ui-hint-line">Placing a transition: its values are in the toolbar on the sheet. Click a block's top-left tile to place it, swap a value for the next one, and Done or Esc to finish.</span>
      ) : (
        <>
          <Field label="Tool">
            <Segmented value={tool} options={[{ value: 'corners', label: 'Tag corners' }, { value: 'erase', label: 'Erase' }]} onChange={setTool} />
          </Field>
          <span className="ui-hint-line">The brush writes {material.name} for {contextName(context)}: the archetype is the switch in the bar, the slot is picked on the sheet.</span>
          <Action title="New transition…" onClick={newTransition} />
        </>
      )}
      <div style={{ borderTop: '1px solid var(--ui-line)', margin: '2px 0' }} />
    </>
  )

  const form = (
    <>
      {view === 'tag' ? tagging : null}
      <Field label="Name">
        <TextInput value={material.name} onChange={(name) => (name.trim() ? change({ name }) : undefined)} />
      </Field>
      <Field label="Swatch" hint="Its colour in lists, chips and tags">
        <ColorInput value={material.color} onChange={(color) => change({ color })} />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field label="Fringe angle" hint="Degrees below level: 0 juts out, 90 hangs flat">
          <NumberInput value={material.fringeAngle ?? DEFAULT_FRINGE_ANGLE} min={0} max={90} step={5} onChange={(fringeAngle) => change({ fringeAngle })} />
        </Field>
        <Field label="Picket distance" hint="Pixels of art out from the wall">
          <NumberInput value={material.picketDistance ?? DEFAULT_PICKET_DISTANCE} min={0} max={MAX_PICKET_DISTANCE} step={1} onChange={(picketDistance) => change({ picketDistance })} />
        </Field>
      </div>

      {directed && context !== null ? (
        <Field label={`${context[0].toUpperCase()}${context.slice(1)} art is drawn for`} hint="What you mean to draw: it decides the directions offered on the sheet and how much is owed. The map uses whatever art there is: this direction's, then the opposite mirrored, then another's turned, then art for any.">
          <Select
            value={String(count)}
            options={[
              { value: '1', label: 'One direction, turned for the rest' },
              { value: '2', label: 'Two: down the sheet and across, mirrored' },
              { value: '4', label: 'Four: north, east, south and west' },
            ]}
            onChange={(next) => {
              const rest = Object.fromEntries(Object.entries(material.directions ?? {}).filter(([id]) => id !== context))
              const directions = next === '1' ? rest : { ...rest, [context]: Number(next) as DirectionCount }
              // A direction the new count no longer offers falls back to any.
              if (direction !== null && !directionsOffered(Number(next) as DirectionCount).includes(direction)) setDirection(null)
              // The field is absent rather than empty when every archetype is at one, which is what the file and the schema expect.
              const plain: MaterialDef = { id: material.id, name: material.name, color: material.color, ...(material.fringeAngle === undefined ? {} : { fringeAngle: material.fringeAngle }), ...(material.picketDistance === undefined ? {} : { picketDistance: material.picketDistance }) }
              commit(materials.map((m) => (m.id === active ? (Object.keys(directions).length ? { ...plain, directions } : plain) : m)))
            }}
          />
        </Field>
      ) : null}

      {meets ? (
        <>
          <div className="ui-k" style={{ marginTop: 4 }}>Meeting {meets.name}</div>
          <span className="ui-hint-line">
            {cover.drawn} of {cover.masks.length} arrangements drawn{drawnFor ? `, as art for ${drawnFor}s` : ''}. {cover.drawn === cover.masks.length ? 'Nothing is left to draw.' : 'A block writes the tags for all of them at once, where the art is or will be.'}
          </span>
          {cover.drawn < cover.masks.length ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <Action title="Place block…" onClick={newTransition} />
            </div>
          ) : null}
        </>
      ) : (
        <span className="ui-hint-line">{material.name} on its own. Pick a pairing under it in the list to see the two together, or New transition… to spell one that is not there yet.</span>
      )}

      <div className="ui-k" style={{ marginTop: 4 }}>Priority</div>
      <div className="ui-hint-line">
        {position + 1} of {materials.length} — the order a block places a pair in: the later material is drawn over the earlier.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <Action title="Move up" disabled={position <= 0} onClick={() => move(position - 1)} />
        <Action title="Move down" disabled={position >= materials.length - 1} onClick={() => move(position + 1)} />
        <Action title="Delete" tone="danger" onClick={() => remove(active)} />
      </div>
      <div className="ui-hint-line">Used in {mapsUsing(active)} of {summaries.length} maps. Deleting it clears its tags too.</div>
    </>
  )

  return (
    <>
      <Library tabs={tabs} side={side} stage={stage} form={form} />
      {dialog}
    </>
  )
}
