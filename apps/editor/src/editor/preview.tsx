/**
 * The Materials section's Preview view (decisions of 2026-09-17 and 2026-09-19):
 * the patch a subject actually draws, assembled through the dual grid from the
 * real sheets, beside the tiles it was assembled from — shown as a CROP OF THE
 * SHEET they sit on, the missing ones hatched in place, or as a wrapping grid
 * of tiles when they are scattered.
 *
 * The two point at each other: hovering either names an arrangement, and a
 * named arrangement lights every place the other draws it. The light is the
 * rest going dark rather than the matches going bright, because at one tile in
 * forty the bright version is the harder read.
 */

import { useEffect, useRef } from 'react'

import type { RgbaImage, Tag } from '@papercut/document'
import type { LoadedSet } from '@papercut/geometry'

import { maskAt, type Assembled, type Coverage, type Crop, type Found } from './coverage'
import { rgbaToCanvas, rgbaToDataUrl } from './rgba'

/** The sheet as a canvas, once per image, so a patch is blits rather than a hundred data URLs. */
const canvases = new WeakMap<RgbaImage, HTMLCanvasElement>()
function sheetCanvas(loaded: LoadedSet): HTMLCanvasElement {
  const known = canvases.get(loaded.image)
  if (known) return known
  const canvas = rgbaToCanvas(loaded.image)
  canvases.set(loaded.image, canvas)
  return canvas
}

/** One tile's pixels as a data URL, once per image and tile. */
const urls = new WeakMap<RgbaImage, Map<number, string>>()
export function tileUrl(loaded: LoadedSet, index: number): string {
  let byIndex = urls.get(loaded.image)
  if (!byIndex) {
    byIndex = new Map()
    urls.set(loaded.image, byIndex)
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

const MISSING_FILL = 'rgba(229, 99, 111, 0.22)'
const MISSING_LINE = 'rgba(229, 99, 111, 0.85)'
const VEIL = 'rgba(15, 17, 21, 0.68)'
const LIT = '#e9a23b'

/** A cell nothing answers: hatched, so a gap reads as a gap. */
function hatch(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  ctx.fillStyle = MISSING_FILL
  ctx.fillRect(x, y, size, size)
  ctx.strokeStyle = MISSING_LINE
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x + 2, y + 2)
  ctx.lineTo(x + size - 2, y + size - 2)
  ctx.moveTo(x + size - 2, y + 2)
  ctx.lineTo(x + 2, y + size - 2)
  ctx.stroke()
}

function blit(ctx: CanvasRenderingContext2D, found: Found, x: number, y: number, size: number): void {
  const t = found.loaded.set.tile
  ctx.drawImage(sheetCanvas(found.loaded), (found.index % found.loaded.set.columns) * t, Math.floor(found.index / found.loaded.set.columns) * t, t, t, x, y, size, size)
}

/** The patch, on a canvas: one tile blitted per corner, hatched where nothing is tagged. Scaled by whole numbers, because this is pixel art. */
export function PatchPreview({ tile, corners, columns, rows, scale, mine, theirs, lit, onLight }: { tile: number; corners: readonly Assembled[]; columns: number; rows: number; scale: number; mine: Tag; theirs: Tag; lit: number | null; onLight: (mask: number | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const step = tile * scale

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
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
      if (corner.found) blit(ctx, corner.found, corner.column * step, corner.row * step, step)
      else if (!corner.corners.every((c) => c === null)) hatch(ctx, corner.column * step, corner.row * step, step)
    }
    for (const corner of corners) paint(corner)
    if (lit === null) return
    // Everything goes under a veil, then the arrangement's own corners come back up through it.
    ctx.fillStyle = VEIL
    ctx.fillRect(0, 0, w, h)
    for (const corner of corners) {
      if (maskAt(corner, mine, theirs) !== lit) continue
      paint(corner)
      ctx.strokeStyle = LIT
      ctx.lineWidth = 2
      ctx.strokeRect(corner.column * step + 1, corner.row * step + 1, step - 2, step - 2)
    }
  }, [step, corners, columns, rows, mine, theirs, lit])

  const at = (event: { clientX: number; clientY: number }): number | null => {
    const canvas = ref.current
    if (!canvas) return null
    const box = canvas.getBoundingClientRect()
    if (box.width === 0) return null
    const column = Math.floor(((event.clientX - box.left) * (canvas.width / box.width)) / step)
    const row = Math.floor(((event.clientY - box.top) * (canvas.height / box.height)) / step)
    const corner = corners[row * columns + column]
    return corner && corner.column === column && corner.row === row ? maskAt(corner, mine, theirs) : null
  }

  return <canvas ref={ref} className="ui-patch" onPointerMove={(event) => onLight(at(event))} onPointerLeave={() => onLight(null)} />
}

/**
 * A subject's tiles as a crop of the sheet they sit on: the sheet inside the crop dimmed, each arrangement's tile at
 * full strength, each missing one hatched where it would go.
 */
export function SheetCrop({ crop, scale, lit, onLight, onOpen }: { crop: Crop; scale: number; lit: number | null; onLight: (mask: number | null) => void; onOpen: (mask: number, found: Found | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const t = crop.loaded.set.tile
  const step = t * scale

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const w = crop.columns * step
    const h = crop.rows * step
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(sheetCanvas(crop.loaded), crop.column * t, crop.row * t, crop.columns * t, crop.rows * t, 0, 0, w, h)
    ctx.fillStyle = 'rgba(15, 17, 21, 0.55)'
    ctx.fillRect(0, 0, w, h)
    for (const cell of crop.cells) {
      const x = cell.column * step
      const y = cell.row * step
      if (cell.found) {
        ctx.clearRect(x, y, step, step)
        blit(ctx, cell.found, x, y, step)
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)'
        ctx.lineWidth = 1
        ctx.strokeRect(x + 0.5, y + 0.5, step - 1, step - 1)
      } else hatch(ctx, x, y, step)
    }
    if (lit === null) return
    for (const cell of crop.cells) {
      if (cell.mask === lit) continue
      ctx.fillStyle = VEIL
      ctx.fillRect(cell.column * step, cell.row * step, step, step)
    }
    const cell = crop.cells.find((c) => c.mask === lit)
    if (cell) {
      ctx.strokeStyle = LIT
      ctx.lineWidth = 2
      ctx.strokeRect(cell.column * step + 1, cell.row * step + 1, step - 2, step - 2)
    }
  }, [crop, step, t, lit])

  const cellAt = (event: { clientX: number; clientY: number }) => {
    const canvas = ref.current
    if (!canvas) return undefined
    const box = canvas.getBoundingClientRect()
    if (box.width === 0) return undefined
    const column = Math.floor(((event.clientX - box.left) * (canvas.width / box.width)) / step)
    const row = Math.floor(((event.clientY - box.top) * (canvas.height / box.height)) / step)
    return crop.cells.find((c) => c.column === column && c.row === row)
  }

  return (
    <canvas
      ref={ref}
      className="ui-crop"
      onPointerMove={(event) => onLight(cellAt(event)?.mask ?? null)}
      onPointerLeave={() => onLight(null)}
      onClick={(event) => {
        const cell = cellAt(event)
        if (cell) onOpen(cell.mask, cell.found)
      }}
    />
  )
}

/** The fallback for tiles that are not together on one sheet: every arrangement as a tile, wrapping to the stage's width. */
export function TileGrid({ cover, names, lit, onLight, onOpen }: { cover: Coverage; names: (mask: number) => string; lit: number | null; onLight: (mask: number | null) => void; onOpen: (mask: number, found: Found | null) => void }) {
  return (
    <div className="ui-tile-grid" onPointerLeave={() => onLight(null)}>
      {cover.masks.map((mask) => {
        const found = cover.tiles.get(mask) ?? null
        return (
          <button key={mask} type="button" className={`ui-slot ${found ? '' : 'is-empty'} ${lit === mask ? 'is-lit' : ''}`} title={`${names(mask)}${found ? ` · drawn on ${found.loaded.set.sheet}` : ' · nobody has drawn it'}`} onPointerEnter={() => onLight(mask)} onClick={() => onOpen(mask, found)}>
            {found ? <img src={tileUrl(found.loaded, found.index)} alt="" /> : null}
          </button>
        )
      })}
    </div>
  )
}
