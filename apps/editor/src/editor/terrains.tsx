/**
 * The Terrains section of Project settings: a terrain set's editor, after
 * Tiled's (decision-log 2026-09-14). The artist picks a sheet, keeps its
 * terrain list beside the image, and tags tile corners by clicking or
 * dragging over the image with a terrain chosen; every tagged corner shows
 * as a translucent quadrant in its terrain's colour, so the whole set reads
 * at a glance. Painting on the map is untouched — this is what decides
 * which tile a painted corner gets.
 *
 * Every stroke is one write: the corners tagged while the button is down
 * land on a draft, and the draft goes to `updateTerrainSet` on release, which
 * writes the sidecar and swaps the set into the viewport. A set with no
 * sidecar yet gets one on its first stroke or first terrain. Nothing here
 * is undoable: a set is a setting, as brink's are, not a stroke on the map.
 *
 * This is the app's rather than the terrain feature's for the same reason
 * the materials library is: the sheet's pixels live on the viewport actor.
 */

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

import type { RgbaImage } from '@papercut/document'
import { useHost, useProject, useProjectSelector, useViewportSelector } from '@papercut/editor-host'
import { addTerrain, cornerAt, edgeCoverage, removeTerrain, tagCorner, type LoadedSet, type Tag, type TerrainDef, type TerrainSet } from '@papercut/geometry'
import { slugOf } from '@papercut/project'
import { Action, ColorInput, Field, FieldGrid, Item, List, Note, Row, Segmented, Select, SettingsBlock, Status, Table, TableRow, Tagger, TaggerHint, TextInput } from '@papercut/ui'

import { run } from './commands'
import { rgbaToCanvas } from './rgba'
import { updateTerrainSet, type Session } from './session'

const TERRAIN_COLOURS = ['#6aa84f', '#8b6b45', '#8e8e8e', '#d9c27e', '#b08f5e', '#5f8fb0', '#a06060', '#7a6a52']
const CORNER_NAMES = ['NW', 'NE', 'SW', 'SE'] as const
const ZOOMS = ['fit', 1, 2, 4] as const
type Zoom = (typeof ZOOMS)[number]

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const mapLabel = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.map\.json$/, '')

/** The sheet's pixels on a canvas, once per image. */
const canvases = new WeakMap<RgbaImage, HTMLCanvasElement>()
function canvasOf(image: RgbaImage): HTMLCanvasElement {
  const known = canvases.get(image)
  if (known) return known
  const canvas = rgbaToCanvas(image)
  canvases.set(image, canvas)
  return canvas
}

interface Corner {
  index: number
  corner: number
}

/**
 * Draw the sheet with its tags over it: a translucent quadrant per tagged
 * corner in the terrain's colour, the tile grid faintly, and the corner
 * under the pointer outlined. Drawn whole on every change; a sheet is a few
 * hundred tiles, which is nothing to a canvas.
 */
function draw(canvas: HTMLCanvasElement, loaded: LoadedSet, set: TerrainSet, scale: number, hover: Corner | null): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { image } = loaded
  const width = Math.round(image.width * scale)
  const height = Math.round(image.height * scale)
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(canvasOf(image), 0, 0, width, height)
  const t = set.tile * scale
  const half = t / 2
  const colours = new Map(set.terrains.map((terrain) => [terrain.id, terrain.color]))
  ctx.globalAlpha = 0.5
  for (const [index, tags] of set.tiles) {
    const x = (index % set.columns) * t
    const y = Math.floor(index / set.columns) * t
    tags.forEach((tag, corner) => {
      if (tag === null) return
      ctx.fillStyle = colours.get(tag) ?? '#ff00ff'
      ctx.fillRect(x + (corner & 1) * half, y + (corner >> 1) * half, half, half)
    })
  }
  ctx.globalAlpha = 1
  if (t >= 8) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let c = 1; c < set.columns; c++) {
      ctx.moveTo(c * t + 0.5, 0)
      ctx.lineTo(c * t + 0.5, height)
    }
    for (let r = 1; r < set.rows; r++) {
      ctx.moveTo(0, r * t + 0.5)
      ctx.lineTo(width, r * t + 0.5)
    }
    ctx.stroke()
  }
  if (hover) {
    const x = (hover.index % set.columns) * t + (hover.corner & 1) * half
    const y = Math.floor(hover.index / set.columns) * t + (hover.corner >> 1) * half
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)'
    ctx.lineWidth = 1.5
    ctx.strokeRect(x + 0.75, y + 0.75, half - 1.5, half - 1.5)
  }
}

/** How many corners across the sheet carry each terrain. */
function cornerCounts(set: TerrainSet): Map<string, number> {
  const counts = new Map<string, number>()
  for (const tags of set.tiles.values()) for (const tag of tags) if (tag !== null) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  return counts
}

export function TerrainsSettings({ session, sets }: { session: Session; sets: readonly LoadedSet[] }) {
  const host = useHost()
  const materials = useProject((p) => p.materials)
  const missing = useViewportSelector((snapshot) => snapshot.context.stats.missingTransitions)
  const mapName = useProjectSelector((snapshot) => snapshot.context.map)
  const [sheet, setSheet] = useState<string | null>(null)
  /** The terrain the pointer tags; `null` is the eraser. */
  const [brush, setBrush] = useState<Tag>(null)
  const [zoom, setZoom] = useState<Zoom>('fit')
  const [newName, setNewName] = useState('')
  const [hover, setHover] = useState<Corner | null>(null)
  /** The set as the stroke in progress has it, until the write lands. */
  const [draft, setDraft] = useState<TerrainSet | null>(null)
  const [stageWidth, setStageWidth] = useState(0)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stroke = useRef<{ tag: Tag; set: TerrainSet; last: Corner | null } | null>(null)

  const loaded = sets.find((s) => s.set.sheet === sheet) ?? sets.find((s) => s.set.terrains.length > 0) ?? sets[0]
  const set = draft ?? loaded?.set
  const notify = (notice: string): void => void run(host, 'view.set', { notice })
  const write = (next: TerrainSet): void => {
    if (!loaded) return
    setDraft(next)
    updateTerrainSet(host, session, loaded.set.sheet, next).catch((error: unknown) => {
      setDraft(null)
      notify(messageOf(error))
    })
  }

  // The write comes back as a new set on the viewport: the draft has served.
  useEffect(() => setDraft(null), [loaded?.set])
  // A brush that is not in the shown set — after a sheet change or a removal — falls back to the set's first terrain, or the eraser.
  useEffect(() => {
    if (brush !== null && !set?.terrains.some((t) => t.id === brush)) setBrush(set?.terrains[0]?.id ?? null)
  }, [brush, set])

  const hasSheet = loaded !== undefined
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const measure = (): void => setStageWidth(stage.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [hasSheet])

  const scale = useMemo(() => {
    if (!loaded) return 1
    if (zoom !== 'fit') return zoom
    // Whole multiples above 1 and halvings below it, so a texel is never one and a half pixels wide.
    const raw = Math.max(stageWidth - 2, 64) / loaded.image.width
    if (raw >= 1) return Math.min(4, Math.floor(raw))
    return Math.max(0.125, 2 ** Math.floor(Math.log2(raw)))
  }, [loaded, zoom, stageWidth])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas && loaded && set) draw(canvas, loaded, set, scale, hover)
  }, [loaded, set, scale, hover])

  const counts = useMemo(() => (set ? cornerCounts(set) : new Map<string, number>()), [set])
  const selected = set?.terrains.find((t) => t.id === brush)
  const usedBy = (terrain: string): string[] => (loaded ? materials.filter((m) => (m.top.sheet === loaded.set.sheet && m.top.terrain === terrain) || (m.side?.sheet === loaded.set.sheet && m.side.terrain === terrain)).map((m) => m.name) : [])

  const cornerUnder = (event: ReactPointerEvent<HTMLCanvasElement>): Corner | null => {
    if (!set) return null
    const rect = event.currentTarget.getBoundingClientRect()
    return cornerAt(set, (event.clientX - rect.left) / scale, (event.clientY - rect.top) / scale)
  }
  const apply = (corner: Corner): void => {
    const current = stroke.current
    if (!current) return
    if (current.last && current.last.index === corner.index && current.last.corner === corner.corner) return
    current.last = corner
    const tags = current.set.tiles.get(corner.index) ?? [null, null, null, null]
    if (tags[corner.corner] === current.tag) return
    current.set = tagCorner(current.set, corner.index, corner.corner, current.tag)
    setDraft(current.set)
  }
  const down = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!set || (event.button !== 0 && event.button !== 2)) return
    const corner = cornerUnder(event)
    if (!corner) return
    event.currentTarget.setPointerCapture(event.pointerId)
    stroke.current = { tag: event.button === 2 ? null : brush, set, last: null }
    apply(corner)
  }
  const move = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const corner = cornerUnder(event)
    setHover(corner)
    if (corner && stroke.current) apply(corner)
  }
  const up = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const current = stroke.current
    stroke.current = null
    if (!current || !loaded) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (current.set !== loaded.set) write(current.set)
    else setDraft(null)
  }

  const add = (): void => {
    if (!set) return
    const label = newName.trim()
    if (!label) return
    const id = slugOf(label)
    if (set.terrains.some((t) => t.id === id)) {
      notify(`${set.sheet} already has a terrain called ${id}.`)
      return
    }
    setNewName('')
    write(addTerrain(set, { id, name: label, color: TERRAIN_COLOURS[set.terrains.length % TERRAIN_COLOURS.length] }))
    setBrush(id)
  }
  const change = (terrain: TerrainDef, changes: Partial<TerrainDef>): void => {
    if (set) write({ ...set, terrains: set.terrains.map((t) => (t.id === terrain.id ? { ...t, ...changes } : t)) })
  }
  const remove = (terrain: TerrainDef): void => {
    if (!set) return
    write(removeTerrain(set, terrain.id))
    setBrush(null)
  }

  return (
    <>
      <SettingsBlock note="One set per sheet: what each tile is, tagged by corner, stored beside the image as <sheet>.terrain.json so an artist's sheet travels with its tags. Pick a terrain and click or drag over the corners of the tiles that show it; a corner that shows nothing — the edge of the ground — is left untagged." />
      {loaded && set ? (
        <SettingsBlock>
          <Tagger
            stageRef={stageRef}
            side={
              <>
                <List>
                  <Item name="Erase" meta={<Status tone="muted">right-click</Status>} active={brush === null} onClick={() => setBrush(null)} swatch="transparent" />
                  {set.terrains.map((t) => {
                    const coverage = edgeCoverage(set, t.id)
                    return <Item key={t.id} name={t.name} swatch={t.color} active={brush === t.id} onClick={() => setBrush(t.id)} meta={<Status tone={coverage === 16 ? 'ok' : coverage === 0 ? 'muted' : 'warn'}>{counts.get(t.id) ?? 0}</Status>} />
                  })}
                </List>
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    add()
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    add()
                  }}
                >
                  <Row label="">
                    <TextInput value={newName} onChange={setNewName} placeholder="New terrain" />
                    <Action title="Add" disabled={!newName.trim()} onClick={add} />
                  </Row>
                </form>
                {selected ? (
                  <>
                    <FieldGrid columns={2}>
                      <Field label="Name">
                        <TextInput value={selected.name} onChange={(label) => (label.trim() ? change(selected, { name: label }) : undefined)} />
                      </Field>
                      <Field label="Colour">
                        <ColorInput value={parseInt(selected.color.slice(1), 16)} onChange={(color) => change(selected, { color: `#${color.toString(16).padStart(6, '0')}` })} />
                      </Field>
                    </FieldGrid>
                    <TaggerHint>
                      <code>{selected.id}</code> · edge set {edgeCoverage(set, selected.id)} / 16
                      {usedBy(selected.id).length ? <> · used by {usedBy(selected.id).join(', ')}</> : null}
                    </TaggerHint>
                    {usedBy(selected.id).length === 0 ? <Action title="Remove terrain" tone="danger" onClick={() => remove(selected)} /> : null}
                  </>
                ) : null}
              </>
            }
            tools={
              <>
                <Select value={loaded.set.sheet} options={sets.map((s) => ({ value: s.set.sheet, label: `${s.set.sheet} · ${s.set.columns} × ${s.set.rows} · ${s.set.tile} px` }))} onChange={setSheet} />
                <span className="ui-tagger-grow" />
                <Segmented value={zoom} options={ZOOMS.map((z) => ({ value: z, label: z === 'fit' ? 'Fit' : `${z}×` }))} onChange={setZoom} />
              </>
            }
            stage={<canvas ref={canvasRef} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={() => setHover(null)} onContextMenu={(event) => event.preventDefault()} />}
          />
          <TaggerHint>
            {hover ? (
              <>
                Tile <code>{hover.index}</code> · {CORNER_NAMES[hover.corner]} · {(set.tiles.get(hover.index)?.[hover.corner] ?? null) === null ? 'nothing' : set.terrains.find((t) => t.id === set.tiles.get(hover.index)?.[hover.corner])?.name ?? set.tiles.get(hover.index)?.[hover.corner]}
                {' — '}
              </>
            ) : null}
            {brush === null ? 'Click or drag to erase corners.' : `Click or drag to tag corners as ${selected?.name ?? brush}; right-click erases.`}
          </TaggerHint>
        </SettingsBlock>
      ) : (
        <Note>No sheet is loaded. Add one in Sheets to tag it.</Note>
      )}
      <SettingsBlock title="Transitions" note={`Corners painted in ${mapName ? mapLabel(mapName) : 'this map'} that no tile is tagged for, drawn as composites: the tiles still to author. The status bar counts the same list.`}>
        {missing.length === 0 ? (
          <Note>Every corner in this map has an authored tile.</Note>
        ) : (
          <Table
            columns={[
              { title: 'Corner', width: '2fr' },
              { title: 'Drawn as', width: '1fr' },
            ]}
          >
            {missing.map((combo) => (
              <TableRow key={combo} cells={[<code>{combo}</code>, <Status tone="accent">composite, to author</Status>]} />
            ))}
          </Table>
        )}
      </SettingsBlock>
    </>
  )
}
