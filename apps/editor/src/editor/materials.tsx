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

import { materialById, slotMaterial, nextMaterialId, tagOf, type MaterialDef, type ReadonlyMapDoc, type ReadonlyProjectDoc, type RgbaImage, type Tag } from '@papercut/document'
import { useDocumentSelector, useHost, useProject, type SettingsSection } from '@papercut/editor-host'
import { CORNER_BITS, archetypeOf, archetypes, arrangements, exactTile, templateTags, type Archetype, type CornerTags, type LoadedSet } from '@papercut/geometry'
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

/**
 * The tile tagged exactly so, wherever it was drawn.
 *
 * A tag names a material rather than something local to an image (ruling of
 * 2026-09-17), so a corner's art can be on any of the project's sheets and
 * the search is across all of them. The first sheet that has it wins, in the
 * project's image order, which is the same rule the atlas follows.
 */
function findTile(sets: readonly LoadedSet[], tags: CornerTags): { loaded: LoadedSet; index: number } | null {
  for (const loaded of sets) {
    const index = exactTile(loaded.set, tags)
    if (index !== null) return { loaded, index }
  }
  return null
}

/** The swatch a material shows: its own solid tile, or nothing when nobody has drawn one. */
export function swatchFor(sets: readonly LoadedSet[], material: number): string | undefined {
  const found = findTile(sets, templateTags(15, null, tagOf(material)))
  return found === null ? undefined : `url(${tileUrl(found.loaded, found.index)}) center / cover`
}

const cssColor = (color: number): string => `#${color.toString(16).padStart(6, '0')}`
const materialsOf = (project: ReadonlyProjectDoc): readonly MaterialDef[] => project.materials

/** How many faces of the open map hold each material on any material layer, by id. Walks every face, so it is selected settled. */
function usage(doc: ReadonlyMapDoc): Record<number, number> {
  const counts: Record<number, number> = {}
  for (const id of doc.structureOrder) {
    const s = doc.structures[id]
    if (!s || s.kind !== 'voxel') continue
    for (const stack of Object.values(s.paint.faces)) {
      for (const m of new Set(stack.map(slotMaterial))) if (m !== null) counts[m] = (counts[m] ?? 0) + 1
    }
  }
  return counts
}

const sameCounts = (a: Record<number, number>, b: Record<number, number>): boolean => {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => a[Number(k)] === b[Number(k)])
}

/** The inspector's picker. `active` is the active material's ID, what the brush paints and what a face's layers hold — never a position in the list. */
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
          <Item key={m.id} name={m.name} meta={`${m.archetype} · ${counts[m.id] ?? 0}`} swatch={swatchFor(sets, m.id) ?? cssColor(m.color)} active={m.id === active} onClick={() => select(m.id)} />
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
 * Which ARRANGEMENT a corner of the patch is, in the subject being shown: the
 * bits of the corner that are THIS material, provided every other corner is
 * what it meets — the other material in a pairing, nothing on its own.
 *
 * Both halves matter. Counting only this material's corners made the outside
 * edge of a pairing's patch, where this material meets nothing, answer the same
 * mask as the boundary with the other material, and the hover lit tiles the
 * strip's tile does not draw. `null` for any corner that belongs to a different
 * subject: the outside edge in a pairing, the inside of the other material's
 * island, and the solid tile, which is this material's own and not the pairing's.
 */
function maskAt(corner: Assembled, mine: Tag, theirs: Tag): number | null {
  let mask = 0
  for (let i = 0; i < 4; i++) {
    const tag = corner.corners[i]
    if (tag === mine) mask |= CORNER_BITS[i]
    else if (tag !== theirs) return null
  }
  if (mask === 0) return null
  if (mask === 15 && theirs !== null) return null
  return mask
}

/** One corner of the assembled patch, with the tile that draws it and the sheet that tile is on. */
interface Assembled {
  column: number
  row: number
  corners: CornerTags
  found: { loaded: LoadedSet; index: number } | null
}

/**
 * Lay a patch of cells out through the dual grid and find each corner's tile across every sheet.
 *
 * `geometry`'s own `assemble` answers within one set, which is all the mesher ever needed. The
 * screen has to search them all, because a pairing's art can sit on a different sheet from either
 * material's own — which is the thing that just became possible.
 */
function assembleAcross(sets: readonly LoadedSet[], cells: Tag[][]): Assembled[] {
  const rows = cells.length
  const columns = rows === 0 ? 0 : cells[0].length
  const at = (r: number, c: number): Tag => (r < 0 || c < 0 || r >= rows || c >= columns ? null : (cells[r][c] ?? null))
  const out: Assembled[] = []
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= columns; c++) {
      const corners: CornerTags = [at(r - 1, c - 1), at(r - 1, c), at(r, c - 1), at(r, c)]
      out.push({ column: c, row: r, corners, found: corners.every((t) => t === null) ? null : findTile(sets, corners) })
    }
  }
  return out
}

/**
 * The patch, on a canvas: one tile blitted per corner, and a cross-hatch where nothing is tagged
 * so a gap reads as a gap. Scaled by whole numbers, because this is pixel art.
 *
 * Hovering a corner names the arrangement it came from, and a named arrangement lights every corner
 * drawn with it, so the strip and the patch point at each other. The light is the rest of the patch
 * going dark rather than the matches going bright, because at one tile in forty the bright version
 * is the harder read.
 */
function PatchPreview({ tile, corners, columns, rows, scale, mine, theirs, lit, onLight }: { tile: number; corners: readonly Assembled[]; columns: number; rows: number; scale: number; mine: Tag; theirs: Tag; lit: number | null; onLight: (mask: number | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const step = tile * scale
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

    const paint = (corner: Assembled): void => {
      const dx = corner.column * step
      const dy = corner.row * step
      if (corner.found === null) {
        if (corner.corners.every((c) => c === null)) return
        // Nothing is tagged for it on any sheet, so the atlas would composite it: show it as missing.
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
      const { loaded, index } = corner.found
      const t = loaded.set.tile
      const sx = (index % loaded.set.columns) * t
      const sy = Math.floor(index / loaded.set.columns) * t
      ctx.drawImage(tileCanvas(loaded), sx, sy, t, t, dx, dy, step, step)
    }

    for (const corner of corners) paint(corner)
    if (lit === null) return

    // Everything goes under a veil, then the arrangement's own corners come back up through it.
    ctx.fillStyle = 'rgba(15, 17, 21, 0.68)'
    ctx.fillRect(0, 0, w, h)
    for (const corner of corners) {
      if (maskAt(corner, mine, theirs) !== lit) continue
      paint(corner)
      ctx.strokeStyle = '#e9a23b'
      ctx.lineWidth = 2
      ctx.strokeRect(corner.column * step + 1, corner.row * step + 1, step - 2, step - 2)
    }
  }, [tile, corners, scale, columns, rows, mine, theirs, lit])

  const at = (event: { clientX: number; clientY: number }): number | null => {
    const canvas = ref.current
    if (!canvas) return null
    const box = canvas.getBoundingClientRect()
    if (box.width === 0) return null
    const step = tile * scale
    const column = Math.floor(((event.clientX - box.left) * (canvas.width / box.width)) / step)
    const row = Math.floor(((event.clientY - box.top) * (canvas.height / box.height)) / step)
    const corner = corners[row * columns + column]
    return corner && corner.column === column && corner.row === row ? maskAt(corner, mine, theirs) : null
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

/** One arrangement, with the tile that draws it or an empty frame. Hovering it lights its corners in the patch. */
function SlotTile({ found, title, lit, onLight }: { found: { loaded: LoadedSet; index: number } | null; title: string; lit: boolean; onLight: () => void }) {
  const url = found === null ? undefined : tileUrl(found.loaded, found.index)
  return (
    <span className={`ui-slot ${url ? '' : 'is-empty'} ${lit ? 'is-lit' : ''}`} title={title} onPointerEnter={onLight}>
      {url ? <img src={url} alt="" /> : null}
    </span>
  )
}

/** Where a material's art lives, and which of its archetype's slots are filled. */
/** How much of a material's art, or a pairing's, has been drawn: the arrangements it owes, and where each one's tile is. */
interface Coverage {
  /** The arrangements this subject owes. Fifteen for a material alone; fourteen for a pairing. */
  masks: readonly number[]
  /** Per corner mask, the tile that draws it and the sheet it is on. */
  tiles: Map<number, { loaded: LoadedSet; index: number } | null>
  drawn: number
}

/**
 * Query the tags for what a material draws, or what two draw where they meet.
 *
 * This is the whole of what a transition IS (ruling of 2026-09-17). Nothing is
 * stored about one: the tiles tagged with exactly these materials are the
 * transition, the arrangements no tile answers are what is left to draw, and
 * where its art sits is wherever those tiles turned up.
 */
function coverageOf(sets: readonly LoadedSet[], mine: Tag, against: Tag): Coverage {
  // Mask 15 is every corner this material and none of the other, which is the material's OWN tile
  // and not something a pairing owes. Counting it made every pairing read as one-fifteenth drawn
  // before anyone had drawn anything, which is the same reason `pairAuthored` stops at fourteen.
  const masks = arrangements()
    .map((a) => a.mask)
    .filter((mask) => against === null || mask !== 15)
  const tiles = new Map<number, { loaded: LoadedSet; index: number } | null>()
  let drawn = 0
  for (const mask of masks) {
    const found = findTile(sets, templateTags(mask, against, mine))
    tiles.set(mask, found)
    if (found !== null) drawn += 1
  }
  return { masks, tiles, drawn }
}

/** What one material meeting another comes to, for the Meets list. */
interface Meeting {
  other: MaterialDef
  archetype: Archetype
  drawn: number
  owed: number
}

export function MaterialsSettings({ session, selected, onSelect, sets }: { session: Session; selected: number; onSelect: (id: number) => void; sets: readonly LoadedSet[] }) {
  const host = useHost()
  const materials = useProject(materialsOf)
  const counts = useDocumentSelector(usage, { equal: sameCounts, settled: true })
  const summaries = useSyncExternalStore(session.summaries.subscribe, session.summaries.get)
  const currentMap = host.children.project.getSnapshot().context.map
  const mapsUsing = (id: number): number => summaries.filter((s) => (s.path === currentMap ? (counts[id] ?? 0) > 0 : s.materials.has(id))).length
  const [meeting, setMeeting] = useState<number | null>(null)
  // The arrangement the pointer is over, in the strip or in the patch; each lights the other.
  const [lit, setLit] = useState<number | null>(null)
  const [deleting, setDeleting] = useState<{ from: MaterialDef; to: number } | null>(null)
  const notify = (notice: string): void => void run(host, 'view.set', { notice })

  const material = materialById(materials, selected) ?? materials[0]
  const active = material?.id ?? -1
  const position = materials.findIndex((m) => m.id === active)

  const commit = (next: readonly MaterialDef[]): void => void run(host, 'project.materials.set', { materials: next.map((m) => ({ ...m })) })
  const change = (changes: Partial<MaterialDef>): void => {
    if (!material) return
    const next = { ...material, ...changes }
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
      : { id, name: `Material ${materials.length + 1}`, color: 0x808080, archetype: 'floor' }
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
        // A pairing is drawn on the face it appears on: two floors meet on a floor, and a floor
        // meeting a wall is drawn in the wall's, because that is the face the boundary is on.
        const id = material.archetype === 'floor' && other.archetype === 'floor' ? 'floor' : other.archetype === 'floor' ? material.archetype : other.archetype
        const cover = coverageOf(sets, tagOf(material.id), tagOf(other.id))
        return { other, archetype: archetypeOf(id), drawn: cover.drawn, owed: cover.masks.length }
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
  const mine = material ? tagOf(material.id) : null
  const theirs = other ? tagOf(other.id) : null
  const cover = mine === null ? null : coverageOf(sets, mine, theirs)
  const cells = useMemo(() => (mine === null ? [] : cellsOf(theirs === null ? BLOB : MEETING, mine, theirs)), [mine, theirs])
  // Assembled here rather than in the preview, because the strip's readout counts the corners too.
  const corners = useMemo(() => assembleAcross(sets, cells), [sets, cells])
  const litKind = lit === null ? undefined : arrangements().find((a) => a.mask === lit)
  const litCount = lit === null ? 0 : corners.filter((c) => maskAt(c, mine, theirs) === lit).length
  /** The one tile size everything is drawn at: the project's density, which every loaded set is cut to. */
  const tile = sets[0]?.set.tile ?? 16
  /** Which sheets this material's art actually turned up on. More than one is now ordinary rather than a problem. */
  const sheetsBehind = useMemo(() => [...new Set([...(cover?.tiles.values() ?? [])].filter((f) => f !== null).map((f) => f.loaded.set.sheet))], [cover])

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
      {sets.length === 0 ? (
        <Note tone="warn">No images are loaded, so there is nothing to draw the patch from.</Note>
      ) : (
        <>
          <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
            <PatchPreview
              tile={tile}
              corners={corners}
              columns={(cells[0]?.length ?? 0) + 1}
              rows={cells.length + 1}
              scale={tile <= 16 ? 3 : 1}
              mine={mine}
              theirs={theirs}
              lit={lit}
              onLight={setLit}
            />
            <span className="ui-hint-line">{other ? 'how the two draw where they meet' : 'how it draws — the arrangements, assembled'}</span>
          </div>
          <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }} onPointerLeave={() => setLit(null)}>
            <div className="ui-slots">
              {arrangements()
                .filter((a) => cover?.tiles.has(a.mask))
                .map((a) => {
                  const found = cover?.tiles.get(a.mask) ?? null
                  return <SlotTile key={a.mask} found={found} title={`${a.name} — ${a.kind}${found ? ` · drawn on ${found.loaded.set.sheet}` : ' · nobody has drawn it'}`} lit={lit === a.mask} onLight={() => setLit(a.mask)} />
                })}
            </div>
            <span className="ui-hint-line">
              {litKind ? (
                <>
                  {litKind.name} · {litKind.kind} · {litCount} {litCount === 1 ? 'corner' : 'corners'} of the patch
                </>
              ) : (
                <>
                  {cover?.drawn ?? 0} of {cover?.masks.length ?? 0} arrangements drawn
                  {sheetsBehind.length > 1 ? ` · across ${sheetsBehind.join(', ')}` : sheetsBehind.length === 1 ? ` · on ${sheetsBehind[0]}` : ''}
                </>
              )}
            </span>
          </div>
          {previewArchetype.slots.length > 1 ? (
            <div style={{ display: 'grid', gap: 6, justifyItems: 'start' }}>
              <div className="ui-k">{previewArchetype.title} slots</div>
              <span className="ui-hint-line">
                {previewArchetype.slots
                  .filter((slot) => !slot.ordinary)
                  .map((slot) => `${slot.name}${slot.note ? ` — ${slot.note}` : ''}`)
                  .join('. ')}
                . Nothing authors these yet; a tag can name one, and the mesher mitres what is undrawn.
              </span>
            </div>
          ) : null}
        </>
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

      <div className="ui-k">Meets</div>
      {archetypes().map((a) => {
        const rows = byArchetype.get(a.id) ?? []
        return (
          <div key={a.id} style={{ display: 'grid', gap: 2 }}>
            <div className="ui-k" style={{ color: 'var(--ui-accent)', marginTop: 2 }}>
              {a.title}
            </div>
            {rows.length === 0 ? <div className="ui-hint-line" style={{ padding: '0 0 4px' }}>nothing yet</div> : null}
            {rows.map((m) => (
              <div key={m.other.id} className={`ui-tagger-item ${meeting === m.other.id ? 'is-active' : ''}`}>
                <span className="ui-tagger-swatch" style={{ background: cssColor(m.other.color), cursor: 'default' }} />
                <button type="button" className="ui-tagger-name" onClick={() => { setMeeting(meeting === m.other.id ? null : m.other.id); setLit(null) }}>
                  {m.other.name}
                </button>
                <Status tone={m.drawn === m.owed ? 'ok' : m.drawn === 0 ? 'muted' : 'warn'}>{m.drawn === m.owed ? 'drawn' : m.drawn === 0 ? 'composites' : `${m.drawn} / ${m.owed}`}</Status>
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
