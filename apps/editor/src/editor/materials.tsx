/**
 * Materials, in two places: the inspector's PICKER — the project's list in
 * priority order with a swatch from its terrain set, click to make one the
 * brush's — and the Project settings' LIBRARY, where a material is edited:
 * name, archetype, terrains, colour, priority, and what transitions its terrain
 * set has authored to the others (decision-log 2026-09-14: materials are the
 * project's, edited in Project settings).
 *
 * This is the app's rather than the terrain feature's because the swatches
 * need pixels: the loaded terrain sets live on the viewport actor, which no
 * feature package holds. Every edit is one `project.materials.set` with the
 * whole list, because the list's order is the materials' priority and a
 * reorder is as much an edit as a rename.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { AIR, PLACEHOLDER_SHEET, materialById, nextMaterialId, type MaterialDef, type ReadonlyMapDoc, type ReadonlyProjectDoc, type RgbaImage, type TerrainRef } from '@papercut/document'
import { useDocumentSelector, useHost, useProject, type SettingsSection } from '@papercut/editor-host'
import { CORNER_BITS, archetypeOf, archetypes, assemble, exactTile, requiredSlots, templateTags, terrainKey, type Archetype, type LoadedSet, type PatchCorner, type Tag } from '@papercut/geometry'
import { Action, Actions, ColorInput, Dialog, Field, Item, Library, LibraryGroup, List, Note, Section, Select, Status, TextInput } from '@papercut/ui'

import { run } from './commands'
import { rgbaToCanvas, rgbaToDataUrl } from './rgba'
import { repaintAndDeleteMaterial, type Session } from './session'

/** One tile's pixels as a data URL, once per image and tile. */
const swatches = new WeakMap<RgbaImage, Map<number, string>>()

function tileUrl(loaded: LoadedSet, index: number): string {
  let byIndex = swatches.get(loaded.image)
  if (!byIndex) {
    byIndex = new Map()
    swatches.set(loaded.image, byIndex)
  }
  const known = byIndex.get(index)
  if (known) return known
  const { image, set } = loaded
  const t = set.tile
  const sx = (index % set.columns) * t
  const sy = Math.floor(index / set.columns) * t
  const data = new Uint8ClampedArray(t * t * 4)
  for (let y = 0; y < t; y++) data.set(image.data.subarray(((sy + y) * image.width + sx) * 4, ((sy + y) * image.width + sx + t) * 4), y * t * 4)
  const url = rgbaToDataUrl({ width: t, height: t, data })
  byIndex.set(index, url)
  return url
}

/** The swatch a terrain reference shows: its full tile, or nothing when its set is not loaded. */
export function swatchFor(sets: readonly LoadedSet[], ref: TerrainRef): string | undefined {
  const loaded = sets.find((s) => s.set.sheet === ref.sheet)
  if (!loaded) return undefined
  const index = exactTile(loaded.set, [ref.terrain, ref.terrain, ref.terrain, ref.terrain])
  return index === null ? undefined : `url(${tileUrl(loaded, index)}) center / cover`
}

const cssColor = (color: number): string => `#${color.toString(16).padStart(6, '0')}`
const refKey = (ref: TerrainRef): string => terrainKey(ref.sheet, ref.terrain)
const parseRef = (key: string): TerrainRef => ({ sheet: key.slice(0, key.lastIndexOf('/')), terrain: key.slice(key.lastIndexOf('/') + 1) })
const materialsOf = (project: ReadonlyProjectDoc): readonly MaterialDef[] => project.materials

/** How many voxels and face overrides of the open map use each material, by id. Walks every voxel, so it is selected settled. */
function usage(doc: ReadonlyMapDoc): Record<number, number> {
  const counts: Record<number, number> = {}
  for (const id of doc.structureOrder) {
    const s = doc.structures[id]
    if (!s || s.kind !== 'voxel') continue
    for (const m of s.voxels.material) if (m !== AIR) counts[m] = (counts[m] ?? 0) + 1
    for (const m of Object.values(s.paint.faces)) counts[m] = (counts[m] ?? 0) + 1
  }
  return counts
}

const sameCounts = (a: Record<number, number>, b: Record<number, number>): boolean => {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => a[Number(k)] === b[Number(k)])
}

/** The inspector's picker. `active` is the active material's ID, what the brush paints and what a voxel stores — never a position in the list. */
export function MaterialsPicker({ active, sets }: { active: number; sets: readonly LoadedSet[] }) {
  const host = useHost()
  const materials = useProject(materialsOf)
  const counts = useDocumentSelector(usage, { equal: sameCounts, settled: true })
  const material = materialById(materials, active)
  const select = (id: number): void => void run(host, 'terrain.params', { material: id })
  const openSettings = (section: SettingsSection): void => void run(host, 'view.set', { settings: section })
  return (
    <Section title="Materials" summary={material ? `${materials.length} · ${material.name}` : materials.length}>
      <List>
        {[...materials].reverse().map((m) => (
          <Item key={m.id} name={m.name} meta={`${m.archetype} · ${counts[m.id] ?? 0}`} swatch={swatchFor(sets, m.top) ?? cssColor(m.color)} active={m.id === active} onClick={() => select(m.id)} />
        ))}
      </List>
      <Note>The project's library, shared by every map in it. Top of the list draws over what is below it where two meet in a corner nobody has drawn.</Note>
      <Actions>
        <Action title="Edit in Project settings…" onClick={() => openSettings('materials')} />
      </Actions>
    </Section>
  )
}

/**
 * The Project settings' Materials screen (design of 2026-09-17).
 *
 * A material shows the PATCH IT ACTUALLY DRAWS — its archetype's slots run
 * through the dual grid and blitted from the real sheet — beside the raw
 * slots, and a list of everything it meets. The preview is assembled rather
 * than swatched on purpose: a slot nobody drew leaves a hole in the patch,
 * so an incomplete material looks incomplete instead of looking fine.
 *
 * Meets is grouped by ARCHETYPE, because the archetype decides the shape of
 * the art: a floor pairing owes fifteen slots, a wall seven, a ramp four.
 * Picking a pairing swaps the preview for it — same screen, same shape, one
 * material become two.
 */

/**
 * The shape a material is previewed in: `.` nothing, `1` this material, `2`
 * the one it meets. Between them the two shapes reach all fifteen corner
 * masks, so a slot nobody drew shows up in the patch rather than only in the
 * strip. The MEETING shape keeps the second material strictly inside the
 * first, because a corner where three things meet is one no two-material
 * tile can answer — that is the compositor's job, not a hole in the art.
 */
const BLOB = [
  '..####....',
  '.#######..',
  '#########.',
  '###..#####',
  '###..#####',
  '.########.',
  '..####.#..',
  '##......##',
  '##......##',
].map((row) => row.replace(/#/g, '1'))

const MEETING = [
  '...11111.....',
  '..111111111..',
  '.11222221111.',
  '1112222212111',
  '1122222221211',
  '1112222111111',
  '.11122111111.',
  '..111111111..',
  '...11111.....',
]

/** A shape's rows as tags: `1` is the material, `2` the one it meets, anything else nothing. */
const cellsOf = (shape: readonly string[], first: string, second: string | null): Tag[][] =>
  shape.map((row) => [...row].map((ch) => (ch === '1' ? first : ch === '2' ? second : null)))

/**
 * Which of the archetype's slots a corner of the patch is: the bits of the
 * corner that are THIS material, which is exactly how `coverageOf` asked for
 * its tile. `null` for a corner that is none of it — the inside of the other
 * material's island — because that is the other material's art, not a slot of
 * this one.
 */
function slotAt(corner: PatchCorner, mine: string): string | null {
  const mask = CORNER_BITS.reduce((m, bit, i) => (corner.corners[i] === mine ? m | bit : m), 0)
  return mask === 0 ? null : `mask:${mask}`
}

/**
 * The patch, on a canvas: one tile blitted per corner, and a cross-hatch where nothing is tagged
 * so a gap reads as a gap. Scaled by whole numbers, because this is pixel art.
 *
 * Hovering a corner names the slot it came from, and a named slot lights every
 * corner drawn with it, so the strip and the patch point at each other. The
 * light is the rest of the patch going dark rather than the matches going
 * bright, because at one tile in forty the bright version is the harder read.
 */
function PatchPreview({ loaded, corners, columns, rows, scale, mine, lit, onLight }: { loaded: LoadedSet; corners: readonly PatchCorner[]; columns: number; rows: number; scale: number; mine: string; lit: string | null; onLight: (slot: string | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const t = loaded.set.tile
    const step = t * scale
    const w = columns * step
    const h = rows * step
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, w, h)
    const source = tileCanvas(loaded)

    const paint = (corner: PatchCorner): void => {
      const dx = corner.column * step
      const dy = corner.row * step
      if (corner.tile === null) {
        if (corner.corners.every((c) => c === null)) return
        // A corner the set has no tile for: the atlas would composite it, so show it as missing.
        ctx.fillStyle = 'rgba(229, 99, 111, 0.22)'
        ctx.fillRect(dx, dy, step, step)
        ctx.strokeStyle = 'rgba(229, 99, 111, 0.85)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(dx + 2, dy + 2)
        ctx.lineTo(dx + step - 2, dy + step - 2)
        ctx.moveTo(dx + step - 2, dy + 2)
        ctx.lineTo(dx + 2, dy + step - 2)
        ctx.stroke()
        return
      }
      const sx = (corner.tile % loaded.set.columns) * t
      const sy = Math.floor(corner.tile / loaded.set.columns) * t
      ctx.drawImage(source, sx, sy, t, t, dx, dy, step, step)
    }

    for (const corner of corners) paint(corner)
    if (!lit) return

    // Everything goes under a veil, then the slot's own corners come back up through it.
    ctx.fillStyle = 'rgba(15, 17, 21, 0.68)'
    ctx.fillRect(0, 0, w, h)
    for (const corner of corners) {
      if (slotAt(corner, mine) !== lit) continue
      paint(corner)
      ctx.strokeStyle = '#e9a23b'
      ctx.lineWidth = 2
      ctx.strokeRect(corner.column * step + 1, corner.row * step + 1, step - 2, step - 2)
    }
  }, [loaded, corners, scale, columns, rows, mine, lit])

  const at = (event: { clientX: number; clientY: number }): string | null => {
    const canvas = ref.current
    if (!canvas) return null
    const box = canvas.getBoundingClientRect()
    if (box.width === 0) return null
    const step = loaded.set.tile * scale
    const column = Math.floor(((event.clientX - box.left) * (canvas.width / box.width)) / step)
    const row = Math.floor(((event.clientY - box.top) * (canvas.height / box.height)) / step)
    const corner = corners[row * columns + column]
    return corner && corner.column === column && corner.row === row ? slotAt(corner, mine) : null
  }

  return <canvas ref={ref} className="ui-patch" onPointerMove={(event) => onLight(at(event))} onPointerLeave={() => onLight(null)} />
}

/** The sheet as a canvas, once per image, so a patch is blits rather than a hundred data URLs. */
const canvases = new WeakMap<RgbaImage, HTMLCanvasElement>()
function tileCanvas(loaded: LoadedSet): HTMLCanvasElement {
  const known = canvases.get(loaded.image)
  if (known) return known
  const canvas = rgbaToCanvas(loaded.image)
  canvases.set(loaded.image, canvas)
  return canvas
}

/** One of an archetype's slots, with the tile that fills it or an empty frame. Hovering it lights its corners in the patch. */
function SlotTile({ loaded, tile, title, lit, onLight }: { loaded: LoadedSet | undefined; tile: number | null; title: string; lit: boolean; onLight: () => void }) {
  const url = loaded && tile !== null ? tileUrl(loaded, tile) : undefined
  return (
    <span className={`ui-slot ${url ? '' : 'is-empty'} ${lit ? 'is-lit' : ''}`} title={title} onPointerEnter={onLight}>
      {url ? <img src={url} alt="" /> : null}
    </span>
  )
}

/** Where a material's art lives, and which of its archetype's slots are filled. */
interface Coverage {
  set: LoadedSet | undefined
  /** Per slot id, the tile that fills it or `null`. */
  tiles: Map<string, number | null>
  filled: number
  required: number
}

function coverageOf(sets: readonly LoadedSet[], archetype: Archetype, ref: TerrainRef, against: TerrainRef | null): Coverage {
  const set = sets.find((s) => s.set.sheet === ref.sheet)
  const tiles = new Map<string, number | null>()
  let filled = 0
  let required = 0
  for (const slot of archetype.slots) {
    // Only the floor archetype's slots are corner masks; the others have no art in today's format yet.
    const tile = set && slot.mask !== undefined ? exactTile(set.set, templateTags(slot.mask, against === null ? null : against.terrain, ref.terrain)) : null
    tiles.set(slot.id, tile)
    if (!slot.optional) {
      required += 1
      if (tile !== null) filled += 1
    }
  }
  return { set, tiles, filled, required }
}

/** What one material meeting another comes to, for the Meets list. */
interface Meeting {
  other: MaterialDef
  archetype: Archetype
  filled: number
  required: number
  /** Their art is on different sheets, so the atlas can never take an authored tile (`atlas.ts`). */
  crossSheet: boolean
}

export function MaterialsSettings({ session, selected, onSelect, sets }: { session: Session; selected: number; onSelect: (id: number) => void; sets: readonly LoadedSet[] }) {
  const host = useHost()
  const materials = useProject(materialsOf)
  const counts = useDocumentSelector(usage, { equal: sameCounts, settled: true })
  const summaries = useSyncExternalStore(session.summaries.subscribe, session.summaries.get)
  const currentMap = host.children.project.getSnapshot().context.map
  const mapsUsing = (id: number): number => summaries.filter((s) => (s.path === currentMap ? (counts[id] ?? 0) > 0 : s.materials.has(id))).length
  const [meeting, setMeeting] = useState<number | null>(null)
  // The slot the pointer is over, in the strip or in the patch; each lights the other.
  const [lit, setLit] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<{ from: MaterialDef; to: number } | null>(null)
  const notify = (notice: string): void => void run(host, 'view.set', { notice })

  const material = materialById(materials, selected) ?? materials[0]
  const active = material?.id ?? -1
  const position = materials.findIndex((m) => m.id === active)
  const terrains = useMemo(() => sets.flatMap((s) => s.set.terrains.map((t) => ({ value: terrainKey(s.set.sheet, t.id), label: `${t.name} · ${s.set.sheet}` }))), [sets])

  const commit = (next: readonly MaterialDef[]): void => void run(host, 'project.materials.set', { materials: next.map((m) => ({ ...m })) })
  const change = (changes: Partial<MaterialDef>): void => {
    if (!material) return
    const next = { ...material, ...changes }
    if (next.side === undefined) delete next.side
    commit(materials.map((m) => (m.id === active ? next : m)))
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
    const fresh: MaterialDef = from
      ? { ...from, id, name: `${from.name} copy` }
      : { id, name: `Material ${materials.length + 1}`, color: 0x808080, archetype: 'floor', top: materials[0]?.top ?? { sheet: PLACEHOLDER_SHEET, terrain: 'grass' } }
    commit([...materials, fresh])
    onSelect(id)
    setMeeting(null)
    setLit(null)
  }
  const remove = (): void => {
    if (!material || materials.length <= 1) return
    if (mapsUsing(active) > 0) {
      setDeleting({ from: material, to: materials.find((m) => m.id !== active)?.id ?? active })
      return
    }
    commit(materials.filter((m) => m.id !== active))
    onSelect(materials.find((m) => m.id !== active)?.id ?? -1)
  }

  // Everything this material can meet, and how far its art goes, grouped by the archetype it is drawn in.
  const meetings = useMemo((): Meeting[] => {
    if (!material) return []
    return materials
      .filter((m) => m.id !== material.id)
      .map((other) => {
        // A pairing is drawn in the archetype of the face it appears on: two floors meet on a floor,
        // and a floor meeting a wall is drawn in the wall's vocabulary.
        const id = material.archetype === 'floor' && other.archetype === 'floor' ? 'floor' : other.archetype === 'floor' ? material.archetype : other.archetype
        const archetype = archetypeOf(id)
        const crossSheet = material.top.sheet !== other.top.sheet
        const cover = crossSheet ? null : coverageOf(sets, archetype, material.top, other.top)
        return { other, archetype, filled: cover?.filled ?? 0, required: cover?.required ?? requiredSlots(archetype).length, crossSheet }
      })
  }, [material, materials, sets])

  const byArchetype = useMemo(() => {
    const out = new Map<string, Meeting[]>()
    for (const a of archetypes()) out.set(a.id, [])
    for (const m of meetings) out.get(m.archetype.id)?.push(m)
    return out
  }, [meetings])

  const other = meeting === null ? null : (materialById(materials, meeting) ?? null)
  const archetype = archetypeOf(material?.archetype ?? 'floor')
  const previewArchetype = other ? (meetings.find((m) => m.other.id === other.id)?.archetype ?? archetype) : archetype
  const cover = material ? coverageOf(sets, previewArchetype, material.top, other ? other.top : null) : null
  const cells = useMemo(
    () => (material ? cellsOf(other ? MEETING : BLOB, material.top.terrain, other ? other.top.terrain : null) : []),
    [material, other],
  )
  const crossSheet = Boolean(other && material && other.top.sheet !== material.top.sheet)
  // Assembled here rather than in the preview, because the strip's readout counts them too.
  const corners = useMemo(() => (cover?.set ? assemble(cover.set.set, cells) : []), [cover?.set, cells])
  const litSlot = lit === null ? undefined : previewArchetype.slots.find((s) => s.id === lit)
  const litCount = lit === null || !material ? 0 : corners.filter((c) => slotAt(c, material.top.terrain) === lit).length

  if (!material) return <Note>No materials.</Note>

  const tabs = (
    <>
      <span className="ui-swatch" style={{ background: cssColor(material.color), width: 14, height: 14, marginRight: 4 }} />
      <span style={{ fontSize: 13, fontWeight: 600 }}>{material.name}</span>
      {other ? (
        <>
          <span className="ui-library-soon" style={{ marginLeft: 2 }}>meets</span>
          <span className="ui-swatch" style={{ background: cssColor(other.color), width: 14, height: 14 }} />
          <span style={{ fontSize: 13 }}>{other.name}</span>
        </>
      ) : null}
      <span className="ui-library-soon">{previewArchetype.title}</span>
      <span className="ui-tagger-grow" />
      {other ? <Action title="Back to the material" onClick={() => { setMeeting(null); setLit(null) }} /> : null}
    </>
  )

  const side = (
    <>
      <div className="ui-library-list">
        {archetypes().map((a) => {
          const mine = materials.filter((m) => m.archetype === a.id)
          return (
            <div key={a.id}>
              <LibraryGroup>{a.title}</LibraryGroup>
              {mine.length === 0 ? <div className="ui-hint-line" style={{ padding: '2px 8px 6px' }}>none</div> : null}
              {mine.map((m) => (
                <div key={m.id} className={`ui-tagger-item ${m.id === active ? 'is-active' : ''}`}>
                  <span className="ui-tagger-swatch" style={{ background: cssColor(m.color), cursor: 'default' }} />
                  <button type="button" className="ui-tagger-name" onClick={() => { onSelect(m.id); setMeeting(null); setLit(null) }}>
                    {m.name}
                  </button>
                  <span className="ui-library-dot is-muted" title={`used in ${mapsUsing(m.id)} maps`} />
                </div>
              ))}
            </div>
          )
        })}
      </div>
      <div className="ui-library-foot" style={{ display: 'grid', gap: 6 }}>
        <Action title="New material" tone="accent" onClick={() => add(undefined)} />
        <Action title="Duplicate" onClick={() => add(material)} />
      </div>
    </>
  )

  const stage = (
    <div className="ui-patch-stage">
      {cover?.set ? (
        <>
          <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
            <PatchPreview
              loaded={cover.set}
              corners={corners}
              columns={(cells[0]?.length ?? 0) + 1}
              rows={cells.length + 1}
              scale={cover.set.set.tile <= 16 ? 3 : 1}
              mine={material.top.terrain}
              lit={lit}
              onLight={setLit}
            />
            <span className="ui-hint-line">
              {other ? 'how the two draw where they meet' : 'how it draws — the slots, assembled'}
            </span>
          </div>
          <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }} onPointerLeave={() => setLit(null)}>
            <div className="ui-slots">
              {previewArchetype.slots.map((slot) => (
                <SlotTile
                  key={slot.id}
                  loaded={cover.set}
                  tile={cover.tiles.get(slot.id) ?? null}
                  title={`${slot.name}${slot.note ? ` — ${slot.note}` : ''}${slot.optional ? ' (mitred when empty)' : ''}`}
                  lit={lit === slot.id}
                  onLight={() => setLit(slot.id)}
                />
              ))}
            </div>
            <span className="ui-hint-line">
              {litSlot ? (
                <>
                  {litSlot.name}
                  {litSlot.note ? ` · ${litSlot.note}` : ''} · {litCount} {litCount === 1 ? 'corner' : 'corners'} of the patch
                </>
              ) : (
                <>
                  {previewArchetype.slots.length} slots · {cover.filled} of {cover.required} drawn
                  {previewArchetype.slots.some((s) => s.optional) ? ' · seams mitred when empty' : ''}
                </>
              )}
            </span>
          </div>
        </>
      ) : (
        <Note tone="warn">
          {crossSheet
            ? `${material.name} draws from ${material.top.sheet} and ${other?.name} from ${other?.top.sheet}. The atlas only takes an authored tile when both are on one sheet, so this pairing always composites.`
            : `No sheet loaded for ${material.top.sheet}.`}
        </Note>
      )}
    </div>
  )

  const form = (
    <>
      <Field label="Name">
        <TextInput value={material.name} onChange={(name) => (name.trim() ? change({ name }) : undefined)} />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field label="Swatch" hint="Where no art covers a corner">
          <ColorInput value={material.color} onChange={(color) => change({ color })} />
        </Field>
        <Field label="Archetype" hint={archetype.note}>
          <Select value={material.archetype} options={archetypes().map((a) => ({ value: a.id, label: a.title }))} onChange={(id) => change({ archetype: id })} />
        </Field>
      </div>
      <Field label="Art">
        <Select value={refKey(material.top)} options={terrains} onChange={(key) => change({ top: parseRef(key) })} />
      </Field>

      <div className="ui-k">Meets</div>
      {archetypes().map((a) => {
        const rows = byArchetype.get(a.id) ?? []
        return (
          <div key={a.id} style={{ display: 'grid', gap: 2 }}>
            <div className="ui-k" style={{ color: 'var(--ui-accent)', marginTop: 2 }}>
              {a.title} · {a.slots.length} slots
            </div>
            {rows.length === 0 ? <div className="ui-hint-line" style={{ padding: '0 0 4px' }}>nothing yet</div> : null}
            {rows.map((m) => (
              <div key={m.other.id} className={`ui-tagger-item ${meeting === m.other.id ? 'is-active' : ''}`}>
                <span className="ui-tagger-swatch" style={{ background: cssColor(m.other.color), cursor: 'default' }} />
                <button type="button" className="ui-tagger-name" onClick={() => { setMeeting(meeting === m.other.id ? null : m.other.id); setLit(null) }}>
                  {m.other.name}
                </button>
                <Status tone={m.crossSheet ? 'warn' : m.filled === m.required ? 'ok' : m.filled === 0 ? 'muted' : 'warn'}>
                  {m.crossSheet ? 'other sheet' : m.filled === m.required ? 'drawn' : m.filled === 0 ? 'composites' : `${m.filled} / ${m.required}`}
                </Status>
              </div>
            ))}
          </div>
        )
      })}

      <div className="ui-k" style={{ marginTop: 4 }}>Priority</div>
      <div className="ui-hint-line">
        {position + 1} of {materials.length} — higher draws over lower where a corner nobody drew is composited.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <Action title="Move up" disabled={position <= 0} onClick={() => move(position - 1)} />
        <Action title="Move down" disabled={position >= materials.length - 1} onClick={() => move(position + 1)} />
        <Action title="Delete" tone="danger" disabled={materials.length <= 1} onClick={remove} />
      </div>
      <div className="ui-hint-line">Used in {mapsUsing(active)} of {summaries.length} maps.</div>
    </>
  )

  return (
    <>
      <Library tabs={tabs} side={side} stage={stage} form={form} />
      {deleting ? (
        <Dialog
          opened
          onClose={() => setDeleting(null)}
          title={`Delete ${deleting.from.name}`}
          description={`${mapsUsing(deleting.from.id)} maps paint with it. Everything made of it is repainted as whatever you pick, in every map, and that cannot be undone beyond this map's history.`}
          width={460}
          footer={
            <>
              <Action title="Cancel" onClick={() => setDeleting(null)} />
              <Action
                title="Repaint and delete"
                tone="danger"
                onClick={() => {
                  const { from, to } = deleting
                  setDeleting(null)
                  repaintAndDeleteMaterial(host, session, from.id, to)
                    .then(() => {
                      onSelect(to)
                      notify(`${from.name} deleted; everything it painted is now ${materialById(materials, to)?.name ?? 'another material'}`)
                    })
                    .catch((error: unknown) => notify(error instanceof Error ? error.message : String(error)))
                }}
              />
            </>
          }
        >
          <Field label="Repaint as">
            <Select
              value={String(deleting.to)}
              options={materials.filter((m) => m.id !== deleting.from.id).map((m) => ({ value: String(m.id), label: m.name }))}
              onChange={(value) => setDeleting({ ...deleting, to: Number(value) })}
            />
          </Field>
        </Dialog>
      ) : null}
    </>
  )
}
