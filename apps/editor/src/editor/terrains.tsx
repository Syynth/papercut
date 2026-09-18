/**
 * The Terrains section of Project settings: a terrain set's editor, after
 * Tiled's (decision-log 2026-09-14, and the pass of 2026-09-17 that cut it
 * to Tiled's pieces). The section takes the window. The artist picks a
 * sheet, keeps its terrain list down the side, and tags tile corners by
 * clicking or dragging over the image with a terrain chosen; every tagged
 * corner shows as a filled quadrant with a hairline in its terrain's colour.
 * Painting on the map is untouched — this is what decides which tile a
 * painted corner gets.
 *
 * Every stroke is one write: the corners tagged while the button is down
 * land on a draft, and the draft goes to `setImageTerrain` on release, which
 * writes the sidecar and swaps the set into the viewport. A set with no
 * sidecar yet gets one on its first stroke or first terrain.
 *
 * Tagging is undoable (decision-log 2026-09-17): the editor keeps its own
 * history per sheet while it is open — a stroke, an add, a removal, a rename
 * or a recolour is one step — separate from the map's, and gone when the
 * section unmounts. ⌘Z / ⌘⇧Z are taken here, before the editor's keymap
 * sees them.
 *
 * This is the app's rather than the terrain feature's for the same reason
 * the materials library is: the sheet's pixels live on the viewport actor.
 */

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

import { sheetName, slotOfTag, tagOf, type RgbaImage } from '@papercut/document'
import { useHost, useProject } from '@papercut/editor-host'
import { archetypeOf, cornerAt, tagCorner, type LoadedSet, type Tag, type TerrainSet } from '@papercut/geometry'
import { Action, AssetPicker, Note, Tagger, TaggerItem } from '@papercut/ui'

import { run } from './commands'
import { rgbaToCanvas } from './rgba'
import { setImageTerrain, type Session } from './session'
import { thumbOf } from './images'

const CORNER_NAMES = ['NW', 'NE', 'SW', 'SE'] as const
/** The zoom steps − and + walk, and ⌘ wheel. */
const ZOOMS = [0.25, 0.5, 1, 2, 3, 4, 6, 8] as const

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

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

interface History {
  past: TerrainSet[]
  future: TerrainSet[]
}

/**
 * Draw the sheet with its tags over it: a filled quadrant with a hairline
 * per tagged corner in the terrain's colour, the tile grid faintly, and the
 * corner under the pointer outlined. Drawn whole on every change; a sheet is
 * a few hundred tiles, which is nothing to a canvas.
 */
function draw(canvas: HTMLCanvasElement, image: RgbaImage, set: TerrainSet, colours: ReadonlyMap<Tag, string>, scale: number, hover: Corner | null): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
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
  ctx.lineWidth = 1
  for (const [index, tags] of set.tiles) {
    const x = (index % set.columns) * t
    const y = Math.floor(index / set.columns) * t
    tags.forEach((tag, corner) => {
      if (tag === null) return
      const colour = colours.get(tag) ?? '#ff00ff'
      const qx = x + (corner & 1) * half
      const qy = y + (corner >> 1) * half
      ctx.globalAlpha = 0.55
      ctx.fillStyle = colour
      ctx.fillRect(qx, qy, half, half)
      ctx.globalAlpha = 1
      ctx.strokeStyle = colour
      ctx.strokeRect(qx + 0.5, qy + 0.5, half - 1, half - 1)
    })
  }
  if (t >= 8) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)'
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

const nearestZoom = (scale: number): number => ZOOMS.reduce<number>((best, z) => (Math.abs(z - scale) < Math.abs(best - scale) ? z : best), ZOOMS[0])
const stepZoom = (scale: number, by: 1 | -1): number => {
  const at = ZOOMS.indexOf(nearestZoom(scale) as (typeof ZOOMS)[number])
  return ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, at + by))]
}

export function TerrainsSettings({ session, sets }: { session: Session; sets: readonly LoadedSet[] }) {
  const host = useHost()
  const materials = useProject((p) => p.materials)
  const images = useProject((p) => p.images)
  const [sheet, setSheet] = useState<string | null>(null)
  /** The tag the pointer paints; `null` is Nothing. */
  const [brush, setBrush] = useState<Tag>(null)
  const [zoom, setZoom] = useState<number | null>(null)
  /** The corner under the pointer, with where the pointer is in the stage's scroll box; `flip` when a tooltip to its right would leave the box. */
  const [hover, setHover] = useState<(Corner & { x: number; y: number; flip: boolean }) | null>(null)
  /** The set as the stroke in progress has it, until the write lands. */
  const [draft, setDraft] = useState<TerrainSet | null>(null)
  /** Bumped when the history changes, so the buttons follow it. */
  const [, setTick] = useState(0)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stroke = useRef<{ tag: Tag; set: TerrainSet; last: Corner | null } | null>(null)
  const histories = useRef(new Map<string, History>())

  const loaded = sets.find((s) => s.set.sheet === sheet) ?? sets.find((s) => s.set.tiles.size > 0) ?? sets[0]
  const set = draft ?? loaded?.set
  const history: History = loaded ? (histories.current.get(loaded.set.sheet) ?? { past: [], future: [] }) : { past: [], future: [] }
  const scale = zoom ?? (loaded && loaded.set.tile <= 16 ? 2 : 1)

  const notify = (notice: string): void => void run(host, 'view.set', { notice })
  const write = (next: TerrainSet): void => {
    if (!loaded) return
    setDraft(next)
    setImageTerrain(host, session, loaded.set.sheet, next).catch((error: unknown) => {
      setDraft(null)
      notify(messageOf(error))
    })
  }
  const remember = (next: History): void => {
    if (!loaded) return
    histories.current.set(loaded.set.sheet, next)
    setTick((n) => n + 1)
  }
  /** One undoable step: what the set was goes on the past, the future is forfeit, the change is written. */
  const commit = (next: TerrainSet, from: TerrainSet | undefined = set): void => {
    if (!loaded || !from) return
    remember({ past: [...history.past, from], future: [] })
    write(next)
  }
  const undo = (): void => {
    if (!loaded || !set || history.past.length === 0) return
    const previous = history.past[history.past.length - 1]
    remember({ past: history.past.slice(0, -1), future: [...history.future, set] })
    write(previous)
  }
  const redo = (): void => {
    if (!loaded || !set || history.future.length === 0) return
    const next = history.future[history.future.length - 1]
    remember({ past: [...history.past, set], future: history.future.slice(0, -1) })
    write(next)
  }

  // The write comes back as a new set on the viewport: the draft has served.
  useEffect(() => setDraft(null), [loaded?.set])
  // A brush naming a material the project no longer has falls back to Nothing.
  useEffect(() => {
    if (brush !== null && !materials.some((m) => tagOf(m.id, slotOfTag(brush)) === brush)) setBrush(null)
  }, [brush, materials])

  // ⌘Z / ⌘⇧Z are the tagger's while it is open: taken on the way down, before the editor's keymap on window sees them.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.shiftKey) redo()
      else undo()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  // ⌘ wheel zooms; a plain wheel scrolls the sheet as any box does.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (event: WheelEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      setZoom((current) => stepZoom(current ?? scale, event.deltaY < 0 ? 1 : -1))
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [scale])

  /** Every tag the palette offers: each material's ordinary surface, then the slots its archetype adds. */
  const palette = useMemo(
    () =>
      materials.flatMap((m) =>
        archetypeOf(m.archetype).slots.map((slot) => ({
          tag: tagOf(m.id, slot.ordinary ? null : slot.id),
          name: slot.ordinary ? m.name : `${m.name} · ${slot.name}`,
          colour: `#${m.color.toString(16).padStart(6, '0')}`,
          slot,
        })),
      ),
    [materials],
  )
  const colours = useMemo(() => new Map(palette.map((p) => [p.tag, p.colour] as const)), [palette])
  /** How many corners of THIS sheet each tag is on: what says which of the project's materials this image draws. */
  const drawn = useMemo(() => {
    const counts = new Map<Tag, number>()
    if (!set) return counts
    for (const tags of set.tiles.values()) for (const tag of tags) if (tag !== null) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    return counts
  }, [set])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas && loaded && set) draw(canvas, loaded.image, set, colours, scale, hover)
  }, [loaded, set, colours, scale, hover])

  /** Listed tilesets the viewport could not draw: named in the picker's footer with the fix in Images. */
  const notDrawn = images.filter((i) => i.kind === 'tileset' && !sets.some((s) => s.set.sheet === sheetName(i.path))).map((i) => i.name)
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
    const stage = stageRef.current
    const box = stage?.getBoundingClientRect()
    setHover(corner && stage && box ? { ...corner, x: event.clientX - box.left + stage.scrollLeft, y: event.clientY - box.top + stage.scrollTop, flip: event.clientX - box.left > box.width - 220 } : null)
    if (corner && stroke.current) apply(corner)
  }
  const up = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const current = stroke.current
    stroke.current = null
    if (!current || !loaded) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    // The stroke is one step: the past holds the set as it was before the button went down.
    if (current.set !== loaded.set) commit(current.set, loaded.set)
    else setDraft(null)
  }

  if (!loaded || !set) return <Note>No sheet is loaded. Add one in Sheets to tag it.</Note>

  const nameOfTag = (tag: Tag): string => (tag === null ? 'nothing' : (palette.find((p) => p.tag === tag)?.name ?? tag))
  const hovered = hover ? (set.tiles.get(hover.index)?.[hover.corner] ?? null) : null
  const hoveredName = nameOfTag(hovered)
  const brushName = brush === null ? 'Nothing' : nameOfTag(brush)
  return (
    <Tagger
      stageRef={stageRef}
      tools={
        <>
          <AssetPicker
            value={loaded.set.sheet}
            options={sets.map((s) => {
              const entry = images.find((i) => sheetName(i.path) === s.set.sheet)
              return { value: s.set.sheet, name: entry?.name ?? s.set.sheet, meta: `${s.set.sheet} · ${entry?.grid.tile ?? s.set.tile} px${entry && entry.grid.tile !== s.set.tile ? ` · ${s.set.tile / entry.grid.tile}×` : ''} · ${s.set.tiles.size} tagged`, thumb: thumbOf(s) }
            })}
            onChange={setSheet}
            footer={notDrawn.length ? `${notDrawn.length} ${notDrawn.length === 1 ? 'image' : 'images'} in Images ${notDrawn.length === 1 ? 'does' : 'do'} not draw in this project — ${notDrawn.join(', ')}` : undefined}
          />
          <span>
            {set.columns} × {set.rows} tiles · {set.tile} px
          </span>
          <span className="ui-tagger-grow" />
          <Action title="Undo" kbd="⌘Z" disabled={history.past.length === 0} onClick={undo} />
          <Action title="Redo" kbd="⌘⇧Z" disabled={history.future.length === 0} onClick={redo} />
          <span className="ui-tagger-divider" />
          <Action title="−" disabled={scale <= ZOOMS[0]} onClick={() => setZoom((z) => stepZoom(z ?? scale, -1))} />
          <span className="ui-tagger-pct">{Math.round(scale * 100)}%</span>
          <Action title="+" disabled={scale >= ZOOMS[ZOOMS.length - 1]} onClick={() => setZoom((z) => stepZoom(z ?? scale, 1))} />
        </>
      }
      side={
        <>
          <div className="ui-tagger-list">
            <TaggerItem name="Nothing" swatch={null} active={brush === null} onClick={() => setBrush(null)} />
            {palette.map((entry) => (
              <TaggerItem
                key={entry.tag}
                name={entry.name}
                swatch={entry.colour}
                active={brush === entry.tag}
                dim={!drawn.has(entry.tag)}
                meta={drawn.get(entry.tag) ?? 0}
                onClick={() => setBrush(entry.tag)}
              />
            ))}
          </div>
          <div className="ui-tagger-add">
            <span className="ui-hint-line">
              The project&rsquo;s materials. Edit them in Materials; what an image draws is whatever is tagged here.
            </span>
          </div>
        </>
      }
      stage={
        <>
          <canvas ref={canvasRef} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={() => setHover(null)} onContextMenu={(event) => event.preventDefault()} />
          {hover ? (
            <div className="ui-tagger-tip" style={hover.flip ? { right: undefined, left: hover.x - 14, top: hover.y + 14, transform: 'translateX(-100%)' } : { left: hover.x + 14, top: hover.y + 14 }}>
              <b>Tile {hover.index}</b> · {CORNER_NAMES[hover.corner]} · {hoveredName}
              {hovered !== brush ? (
                <>
                  {' → '}
                  <b>{brushName}</b>
                </>
              ) : null}
            </div>
          ) : null}
        </>
      }
      foot={
        <>
          <b>{brushName}</b> · click or drag over corners · right-click for nothing · ⌘ wheel to zoom
        </>
      }
    />
  )
}
