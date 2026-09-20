/**
 * The tagger: a sheet with its corner tags drawn over it, tagged by clicking or
 * dragging with a brush, or a whole block at a time (decisions of 2026-09-14,
 * 2026-09-17 and 2026-09-19).
 *
 * It is a HOOK rather than a screen because the Materials section spreads a
 * tagger's controls over its own frame: the sheet on the stage, undo and zoom
 * in the bar, the sheet picker and the tool in the form. What the pointer
 * writes comes from outside — the section's selected material, slot and face
 * are the brush, its spelled transition is the block — so this owns only what
 * is the tagger's: which sheet, the zoom, the stroke in progress, and an undo
 * history per sheet that lives while the section is open.
 *
 * Every stroke is one write: the corners tagged while the button is down land
 * on a draft, and the draft goes to `setImageTerrain` on release.
 */

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'

import { archetypeOfTag, materialOfTag, sheetName, slotOfTag, withArchetype, type ArchetypeId, type ReadonlyProjectDoc, type RgbaImage } from '@papercut/document'
import { useHost, useProject } from '@papercut/editor-host'
import { conventionOf, cornerAt, stampBlock, tagCorner, type BlockShape, type LoadedSet, type Tag, type TerrainSet } from '@papercut/geometry'
import type { PickerOption } from '@papercut/ui'

import { run } from './commands'
import { thumbOf } from './images'
import { rgbaToCanvas } from './rgba'
import { setImageTerrain, type Session } from './session'

const CORNER_NAMES = ['NW', 'NE', 'SW', 'SE'] as const
/** The zoom steps − and + walk, and ⌘ wheel. */
const ZOOMS = [0.25, 0.5, 1, 2, 3, 4, 6, 8] as const

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export type TagTool = 'corners' | 'erase' | 'block'

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

/** The block the pointer is standing over: where it would land, and whether a click would place it. */
interface Pending {
  column: number
  row: number
  shape: BlockShape
  values: readonly Tag[]
  fits: boolean
}

/**
 * How strongly a tag is drawn in a working context (decision of 2026-09-19): what is lit is what the brush would
 * write. Under an archetype, tags for it are lit, tags for any face are faint because they draw there too, and tags
 * for another archetype are hidden; under Any, every archetype is lit. Tags of another slot than the one picked are
 * faint, so a material's fringes or seams can be found by picking them.
 */
function shownAt(tag: Tag, context: ArchetypeId | null, slot: string | null): number {
  const archetype = archetypeOfTag(tag)
  const byArchetype = context === null || archetype === context ? 1 : archetype === null ? 0.35 : 0
  return byArchetype * (slotOfTag(tag) === slot ? 1 : 0.35)
}

/**
 * What a block would write on one tile, as shapes rather than four flat quadrants (decision of 2026-09-19): the
 * under value fills the tile, and each value over it is a region whose convex corners at the tile's centre are
 * rounded and whose concave ones are filleted, the way the art rounds, so where each material lands is plain.
 */
function drawGhostTile(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, corners: readonly Tag[], values: readonly Tag[], colourOf: (tag: Tag) => string): void {
  const half = t / 2
  const [under, ...overs] = values
  ctx.globalAlpha = 0.62
  if (under !== null) {
    ctx.fillStyle = colourOf(under)
    ctx.fillRect(x, y, t, t)
  }
  for (const over of overs) {
    if (over === null || over === under || !corners.includes(over)) continue
    const is = (q: number): boolean => corners[q] === over
    ctx.fillStyle = colourOf(over)
    const radius = half * 0.55
    for (let q = 0; q < 4; q++) {
      if (!is(q)) continue
      const qx = x + (q & 1) * half
      const qy = y + (q >> 1) * half
      // The quadrant's corner at the tile's centre is convex when neither orthogonal neighbour is this value.
      const convex = !is(q ^ 1) && !is(q ^ 2)
      const radii = [0, 0, 0, 0]
      // Corner order for roundRect: top-left, top-right, bottom-right, bottom-left. The centre is opposite the quadrant.
      if (convex) radii[[2, 3, 1, 0][q]] = radius
      ctx.beginPath()
      ctx.roundRect(qx, qy, half, half, radii)
      ctx.fill()
    }
    // A concave corner, three quadrants of this value around one that is not: fillet it.
    for (let q = 0; q < 4; q++) {
      if (is(q) || !is(q ^ 1) || !is(q ^ 2)) continue
      const fillet = half * 0.35
      const cx = x + half
      const cy = y + half
      const sx = q & 1 ? 1 : -1
      const sy = q >> 1 ? 1 : -1
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(cx + sx * fillet, cy)
      ctx.arcTo(cx, cy, cx, cy + sy * fillet, fillet)
      ctx.closePath()
      ctx.fill()
    }
  }
  ctx.globalAlpha = 1
}

interface DrawState {
  image: RgbaImage
  set: TerrainSet
  colourOf: (tag: Tag) => string
  scale: number
  hover: Corner | null
  pending: Pending | null
  /** The working context: which archetype's tags are lit, and the slot picked within it. */
  context: ArchetypeId | null
  slot: string | null
  /** The material whose art stands out: every tile with no corner of it is dimmed. `null` dims nothing. */
  selected: number | null
}

/** Draw the sheet with its tags over it. Drawn whole on every change; a sheet is a few hundred tiles, which is nothing to a canvas. */
function draw(canvas: HTMLCanvasElement, { image, set, colourOf, scale, hover, pending, context, slot, selected }: DrawState): void {
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

  // Every tile with no corner of the selected material goes under a veil, so its own art stands out (decision of 2026-09-19).
  if (selected !== null) {
    ctx.fillStyle = 'rgba(15, 17, 21, 0.62)'
    for (let index = 0; index < set.columns * set.rows; index++) {
      const tags = set.tiles.get(index)
      if (tags && tags.some((tag) => materialOfTag(tag) === selected)) continue
      ctx.fillRect((index % set.columns) * t, Math.floor(index / set.columns) * t, t, t)
    }
  }

  ctx.lineWidth = 1
  for (const [index, tags] of set.tiles) {
    const x = (index % set.columns) * t
    const y = Math.floor(index / set.columns) * t
    tags.forEach((tag, corner) => {
      if (tag === null) return
      const strength = shownAt(tag, context, slot)
      if (strength === 0) return
      const colour = colourOf(tag)
      const qx = x + (corner & 1) * half
      const qy = y + (corner >> 1) * half
      ctx.globalAlpha = 0.55 * strength
      ctx.fillStyle = colour
      ctx.fillRect(qx, qy, half, half)
      ctx.globalAlpha = strength
      ctx.strokeStyle = colour
      ctx.strokeRect(qx + 0.5, qy + 0.5, half - 1, half - 1)
    })
  }
  ctx.globalAlpha = 1
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

  if (pending) {
    const { shape, values, fits } = pending
    const x = pending.column * t
    const y = pending.row * t
    const w = shape.columns * t
    const h = shape.rows * t
    if (fits) {
      for (const cell of shape.cells) {
        drawGhostTile(ctx, x + cell.column * t, y + cell.row * t, t, cell.corners.map((v) => values[v] ?? null), values, colourOf)
      }
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let c = 1; c < shape.columns; c++) {
        ctx.moveTo(x + c * t + 0.5, y)
        ctx.lineTo(x + c * t + 0.5, y + h)
      }
      for (let r = 1; r < shape.rows; r++) {
        ctx.moveTo(x, y + r * t + 0.5)
        ctx.lineTo(x + w, y + r * t + 0.5)
      }
      ctx.stroke()
    } else {
      ctx.globalAlpha = 0.18
      ctx.fillStyle = '#e5636f'
      ctx.fillRect(x, y, w, h)
      ctx.globalAlpha = 1
    }
    ctx.setLineDash([4, 3])
    ctx.strokeStyle = fits ? '#e9a23b' : '#e5636f'
    ctx.lineWidth = 2
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2)
    ctx.setLineDash([])
  } else if (hover) {
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

export interface TaggerInput {
  session: Session
  sets: readonly LoadedSet[]
  /** Whether the tagger is on screen: its keys and its wheel are only taken while it is. */
  active: boolean
  tool: TagTool
  /** What the brush writes, slot and archetype and all; `null` is nothing. */
  brush: Tag
  /** The spelled transition, under first, as the tags a block writes. */
  values: readonly Tag[]
  /** Whether Place on the sheet has armed the pointer. A block is only ever placed while it has. */
  armed: boolean
  onPlaced: () => void
  /** The working context and the slot picked in it: which tags the sheet lights. What the brush writes already carries both. */
  context: ArchetypeId | null
  slot: string | null
  /** The material whose art stands out. */
  selected: number | null
  /** What a tag is called, for the tooltip and the foot. */
  nameOfTag: (tag: Tag) => string
  colourOf: (tag: Tag) => string
  /** A sheet to open on, when the section knows where the subject's art is. */
  preferred: string | null
}

export interface Tagger {
  loaded: LoadedSet | undefined
  set: TerrainSet | undefined
  /** The sheet picker's options, and what it says about images that do not draw. */
  options: PickerOption[]
  pickerFooter: string | undefined
  setSheet: (sheet: string) => void
  scale: number
  zoomIn: () => void
  zoomOut: () => void
  canZoomIn: boolean
  canZoomOut: boolean
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
  /** The block the spelled values make, or `null` for a spelling that makes none. */
  shape: BlockShape | null
  /** The stage's content: the canvas and the tooltip. */
  stage: ReactNode
  foot: ReactNode
  scrollRef: RefObject<HTMLDivElement | null>
  /** Scroll the sheet so a tile is in view. */
  reveal: (index: number) => void
}

const imagesOf = (project: ReadonlyProjectDoc): ReadonlyProjectDoc['images'] => project.images

export function useTagger({ session, sets, active, tool, brush, values, armed, onPlaced, context, slot, selected, nameOfTag, colourOf, preferred }: TaggerInput): Tagger {
  const host = useHost()
  const images = useProject(imagesOf)
  const [sheet, setSheetState] = useState<string | null>(null)
  const [zoom, setZoom] = useState<number | null>(null)
  /** The corner under the pointer, with where the pointer is in the stage's scroll box; `flip` when a tooltip to its right would leave the box. */
  const [hover, setHover] = useState<(Corner & { x: number; y: number; flip: boolean }) | null>(null)
  /** The set as the stroke in progress has it, until the write lands. */
  const [draft, setDraft] = useState<TerrainSet | null>(null)
  /** Bumped when the history changes, so the buttons follow it. */
  const [, setTick] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  /** The canvas as state rather than a ref: it is only mounted while the tagger is on screen, and a new one is a reason to draw. */
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null)
  const stroke = useRef<{ tag: Tag; set: TerrainSet; last: Corner | null } | null>(null)
  const histories = useRef(new Map<string, History>())

  const loaded = sets.find((s) => s.set.sheet === sheet) ?? sets.find((s) => s.set.sheet === preferred) ?? sets.find((s) => s.set.tiles.size > 0) ?? sets[0]
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

  // ⌘Z / ⌘⇧Z are the tagger's while it is on screen: taken on the way down, before the editor's keymap on window sees them.
  useEffect(() => {
    if (!active) return
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
    const box = scrollRef.current
    if (!box || !active) return
    const onWheel = (event: WheelEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      setZoom((current) => stepZoom(current ?? scale, event.deltaY < 0 ? 1 : -1))
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [scale, active])

  const shape = useMemo(() => {
    const convention = conventionOf('corner-blocks')
    // A spelling is its under value and every value over it that has been picked.
    return convention ? convention.blockShape(values.length) : null
  }, [values])

  /** Where the block under the pointer would land. The pointer names its top-left tile. */
  const pending = useMemo((): Pending | null => {
    if (tool !== 'block' || !armed || !hover || !set || !shape) return null
    const column = hover.index % set.columns
    const row = Math.floor(hover.index / set.columns)
    return { column, row, shape, values, fits: column + shape.columns <= set.columns && row + shape.rows <= set.rows }
  }, [tool, armed, hover, set, shape, values])

  useEffect(() => {
    if (canvas && loaded && set) draw(canvas, { image: loaded.image, set, colourOf, scale, hover, pending, context, slot, selected })
  }, [canvas, loaded, set, colourOf, scale, hover, pending, context, slot, selected])

  const cornerUnder = (event: ReactPointerEvent<HTMLCanvasElement>): Corner | null => {
    if (!set) return null
    const rect = event.currentTarget.getBoundingClientRect()
    return cornerAt(set, (event.clientX - rect.left) / scale, (event.clientY - rect.top) / scale)
  }
  const placeBlock = (): void => {
    if (!set || !pending?.fits) return
    try {
      commit(stampBlock(set, pending.shape, pending.values, pending.column, pending.row))
      notify(`${pending.shape.columns} × ${pending.shape.rows} block placed at ${pending.column}, ${pending.row}`)
      onPlaced()
    } catch (error) {
      notify(messageOf(error))
    }
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
    // A block lands whole on one click; there is no stroke to drag. Unarmed, the block tool does nothing to the sheet.
    if (tool === 'block') {
      if (event.button === 0 && armed) placeBlock()
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    stroke.current = { tag: event.button === 2 || tool === 'erase' ? null : brush, set, last: null }
    apply(corner)
  }
  const move = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const corner = cornerUnder(event)
    const box = scrollRef.current
    const rect = box?.getBoundingClientRect()
    setHover(corner && box && rect ? { ...corner, x: event.clientX - rect.left + box.scrollLeft, y: event.clientY - rect.top + box.scrollTop, flip: event.clientX - rect.left > rect.width - 240 && event.clientX - rect.left > 260 } : null)
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

  /** Listed tilesets the viewport could not draw: named in the picker's footer with the fix in Images. */
  const notDrawn = images.filter((i) => i.kind === 'tileset' && !sets.some((s) => s.set.sheet === sheetName(i.path))).map((i) => i.name)
  const options = sets.map((s): PickerOption => {
    const entry = images.find((i) => sheetName(i.path) === s.set.sheet)
    return { value: s.set.sheet, name: entry?.name ?? s.set.sheet, meta: `${s.set.columns} × ${s.set.rows} tiles · ${entry?.grid.tile ?? s.set.tile} px${entry && entry.grid.tile !== s.set.tile ? ` · ${s.set.tile / entry.grid.tile}×` : ''} · ${s.set.tiles.size} tagged`, thumb: thumbOf(s) }
  })

  const hovered = hover && set ? (set.tiles.get(hover.index)?.[hover.corner] ?? null) : null
  const writes = tool === 'erase' ? null : brush
  const spelled = values.length > 1 ? `${values.slice(1).map(nameOfTag).join(' + ')} over ${nameOfTag(values[0])}` : ''

  const stage = loaded && set ? (
    <>
      <canvas ref={setCanvas} style={{ display: 'block', margin: '56px 20px 48px', touchAction: 'none', cursor: tool === 'block' && !armed ? 'default' : 'crosshair' }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={() => setHover(null)} onContextMenu={(event) => event.preventDefault()} />
      {hover && (tool !== 'block' || armed) ? (
        <div className="ui-tagger-tip" style={hover.flip ? { left: hover.x - 14, top: hover.y + 14, transform: 'translateX(-100%)' } : { left: hover.x + 14, top: hover.y + 14 }}>
          {pending ? (
            <>
              <b>Tile {hover.index}</b> · {pending.shape.columns} × {pending.shape.rows} block from here · {pending.fits ? 'click to place' : <b>does not fit on the sheet</b>}
            </>
          ) : (
            <>
              <b>Tile {hover.index}</b> · {CORNER_NAMES[hover.corner]} · {nameOfTag(hovered)}
              {hovered !== writes ? (
                <>
                  {' → '}
                  <b>{nameOfTag(writes)}</b>
                </>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </>
  ) : null

  const foot =
    tool === 'block' ? (
      armed ? (
        <>
          <b>{spelled}</b> · {shape ? `${shape.columns} × ${shape.rows}` : 'no block'} · what it writes is drawn under the pointer · click its top-left tile · swap a value for the next · Esc when done
        </>
      ) : (
        <>Pick what is drawn over it in the toolbar · ⌘ wheel to zoom</>
      )
    ) : (
      <>
        <b>{tool === 'erase' ? 'Erase' : nameOfTag(brush)}</b> · click or drag over corners · right-click for nothing · ⌘ wheel to zoom
      </>
    )

  const reveal = (index: number): void => {
    const box = scrollRef.current
    if (!box || !set) return
    const t = set.tile * scale
    box.scrollTo({ left: Math.max(0, (index % set.columns) * t - box.clientWidth / 2), top: Math.max(0, Math.floor(index / set.columns) * t - box.clientHeight / 2) })
  }

  return {
    loaded,
    set,
    options,
    pickerFooter: notDrawn.length ? `${notDrawn.length} ${notDrawn.length === 1 ? 'image' : 'images'} in Images ${notDrawn.length === 1 ? 'does' : 'do'} not draw in this project — ${notDrawn.join(', ')}` : undefined,
    setSheet: setSheetState,
    scale,
    zoomIn: () => setZoom((z) => stepZoom(z ?? scale, 1)),
    zoomOut: () => setZoom((z) => stepZoom(z ?? scale, -1)),
    canZoomIn: scale < ZOOMS[ZOOMS.length - 1],
    canZoomOut: scale > ZOOMS[0],
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    shape,
    stage,
    foot,
    scrollRef,
    reveal,
  }
}

/** The same tag, written for one kind of face, or for any. */
export const forFace = (tag: Tag, face: ArchetypeId | null): Tag => withArchetype(tag, face)
