/**
 * A frame of an Aseprite file to RGBA pixels, the way Aseprite composes it:
 * a port of `render::Render::renderSprite` and `doc::RenderPlan` (MIT, see
 * `blend.ts` for the notice).
 *
 * What it follows from Aseprite:
 *   - layers draw bottom to top in file order; the background layer draws in a
 *     pass of its own, before every other layer;
 *   - a cel's z-index moves it among the layers, sorted by
 *     `layer order + z-index`, ties broken by the z-index itself;
 *   - opacity is cel × layer; layer opacity counts only when the header says it
 *     is valid, and never on the background layer;
 *   - hidden layers — and layers in hidden groups — and reference layers are
 *     left out;
 *   - groups are flattened into their children unless the header sets
 *     "composite groups", in which case each group renders to its own image
 *     first and is blended in with its own opacity and mode;
 *   - tilemap cels draw their tiles, flips included.
 *
 * Where it deliberately differs: indexed sprites are composed in RGBA, as
 * Aseprite draws them on its canvas, not in palette indices, as Aseprite's
 * "Save As PNG" does. The two agree for opaque, normal-blend layers, which is
 * what indexed art almost always is; with translucency, this render is the one
 * the artist saw.
 */

import {
  ancestors,
  childrenOf,
  decodeTile,
  paletteAt,
  resolveCel,
  type AsepriteFile,
  type BlendMode,
  type ImageCel,
  type Layer,
  type ResolvedCel,
  type TilemapCel,
  type Tileset,
} from '@papercut/aseprite'
import { blenderFor, getA, mul, rgba, type Blender, type Color } from './blend'

export interface RgbaPixels {
  width: number
  height: number
  /** Row-major RGBA, 4 bytes a pixel, not premultiplied. */
  data: Uint8ClampedArray<ArrayBuffer>
}

export interface RenderOptions {
  /**
   * Which layers draw. A layer draws when it passes and so does every group
   * it sits in. Defaults to Aseprite's own rule, the layer's visibility flag;
   * pass `() => true` to draw hidden layers too.
   */
  include?: (layer: Layer, file: AsepriteFile) => boolean
  /** Draw reference layers too. Aseprite leaves them out of every render. */
  referenceLayers?: boolean
  /** Hears about things the render had to skip, like a tilemap whose tileset is missing. */
  warn?: (message: string) => void
}

interface Canvas {
  width: number
  height: number
  pixels: Uint32Array
}

interface Context {
  file: AsepriteFile
  palette: Color[]
  /** The colour a source pixel skips when it equals it: Aseprite's "mask colour". */
  mask: number
  grayscale: boolean
  composeGroups: boolean
  include: (layer: Layer) => boolean
  referenceLayers: boolean
  warn: (message: string) => void
}

interface PlanItem {
  order: number
  layer: Layer
  cel: ResolvedCel | null
}

/** Render `frame` (0-based) of `file` at its own size. */
export function renderFrame(file: AsepriteFile, frame: number, options: RenderOptions = {}): RgbaPixels {
  if (!Number.isInteger(frame) || frame < 0 || frame >= file.frames.length) {
    throw new RangeError(`Frame ${frame} is out of range: the file has ${file.frames.length}.`)
  }
  const include = options.include ?? ((layer: Layer) => layer.flags.visible)
  const palette = paletteAt(file, frame).map((e) => rgba(e.r, e.g, e.b, e.a))
  const ctx: Context = {
    file,
    palette,
    mask: file.colorMode === 'indexed' ? file.transparentIndex : 0,
    grayscale: file.colorMode === 'grayscale',
    composeGroups: file.flags.groupBlending,
    include: (layer) => include(layer, file) && ancestors(file, layer).every((group) => include(group, file)),
    referenceLayers: options.referenceLayers ?? false,
    warn: options.warn ?? (() => undefined),
  }
  const canvas: Canvas = { width: file.width, height: file.height, pixels: new Uint32Array(file.width * file.height) }

  // An indexed sprite with a background shows the transparent index's colour
  // wherever the background holds it, so the canvas starts out that colour.
  const background = file.layers.find((l) => l.flags.background && l.type !== 'group')
  if (file.colorMode === 'indexed' && background !== undefined && ctx.include(background)) {
    canvas.pixels.fill(palette[file.transparentIndex] ?? 0)
  }

  const plan = makePlan(ctx, childrenOf(file, null), frame)
  renderPlan(ctx, canvas, plan, frame, true, false)
  renderPlan(ctx, canvas, plan, frame, false, true)
  return { width: canvas.width, height: canvas.height, data: toBytes(canvas.pixels) }
}

function makePlan(ctx: Context, layers: Layer[], frame: number): PlanItem[] {
  const items: PlanItem[] = []
  let order = 0
  // Hidden layers join the plan too, so z-index ordering counts them, and
  // leave it after the sort — RenderPlan::addLayer and processZIndexes.
  const add = (layer: Layer): void => {
    order++
    if (layer.type === 'group' && !ctx.composeGroups) {
      for (const child of childrenOf(ctx.file, layer)) add(child)
    } else {
      items.push({ order, layer, cel: layer.type === 'group' ? null : resolveCel(ctx.file, layer.index, frame) })
    }
  }
  for (const layer of layers) add(layer)

  const z = (item: PlanItem): number => item.cel?.zIndex ?? 0
  if (items.some((item) => z(item) !== 0)) {
    for (const item of items) item.order += z(item)
    items.sort((a, b) => a.order - b.order || z(a) - z(b))
  }
  return items.filter((item) => ctx.include(item.layer))
}

/** A layer's opacity and mode as Aseprite reads them: only transparent layers have them, groups only when composited. */
function layerOpacity(ctx: Context, layer: Layer): number {
  if (layer.flags.background || !ctx.file.flags.layerOpacity) return 255
  if (layer.type === 'group' && !ctx.composeGroups) return 255
  return layer.opacity
}

function layerBlend(ctx: Context, layer: Layer): BlendMode {
  if (layer.flags.background) return 'normal'
  if (layer.type === 'group' && !ctx.composeGroups) return 'normal'
  return layer.blendMode
}

function renderPlan(ctx: Context, canvas: Canvas, plan: PlanItem[], frame: number, backgroundPass: boolean, transparentPass: boolean): void {
  for (const { layer, cel } of plan) {
    if (layer.type === 'group') {
      const group: Canvas = { ...canvas, pixels: new Uint32Array(canvas.pixels.length) }
      renderPlan(ctx, group, makePlan(ctx, childrenOf(ctx.file, layer), frame), frame, backgroundPass, transparentPass)
      // Aseprite skips the group image's fully clear pixels (its mask colour, 0).
      const read = (i: number): Color => group.pixels[i] ?? 0
      composite(canvas, 0, 0, canvas.width, canvas.height, read, blenderFor(layerBlend(ctx, layer), ctx.grayscale), layerOpacity(ctx, layer), (i) => read(i) === 0)
      continue
    }
    if (layer.flags.background ? !backgroundPass : !transparentPass) continue
    if (layer.flags.reference && !ctx.referenceLayers) continue
    if (cel === null) continue
    const opacity = mul(cel.opacity, layerOpacity(ctx, layer))
    const blender = blenderFor(layerBlend(ctx, layer), ctx.grayscale)
    if (cel.kind === 'image') drawImage(ctx, canvas, cel, blender, opacity)
    else drawTilemap(ctx, canvas, layer, cel, blender, opacity)
  }
}

/** A source pixel of the file's colour mode as RGBA, and whether it is the mask colour Aseprite skips. */
function sourceReader(ctx: Context, pixels: Uint8Array): { read: (i: number) => Color; isMask: (i: number) => boolean } {
  switch (ctx.file.colorMode) {
    case 'rgba':
      return {
        read: (i) => rgba(pixels[i * 4] ?? 0, pixels[i * 4 + 1] ?? 0, pixels[i * 4 + 2] ?? 0, pixels[i * 4 + 3] ?? 0),
        isMask: (i) => (pixels[i * 4] ?? 0) === 0 && (pixels[i * 4 + 1] ?? 0) === 0 && (pixels[i * 4 + 2] ?? 0) === 0 && (pixels[i * 4 + 3] ?? 0) === 0,
      }
    case 'grayscale':
      return {
        read: (i) => {
          const v = pixels[i * 2] ?? 0
          return rgba(v, v, v, pixels[i * 2 + 1] ?? 0)
        },
        isMask: (i) => (pixels[i * 2] ?? 0) === 0 && (pixels[i * 2 + 1] ?? 0) === 0,
      }
    case 'indexed':
      return { read: (i) => ctx.palette[pixels[i] ?? 0] ?? 0, isMask: (i) => (pixels[i] ?? 0) === ctx.mask }
  }
}

/**
 * Blend a `width × height` source placed at (x, y) into the canvas, clipped
 * to it. `read(i)` gives source pixel `i` (row-major); where `skip(i)` holds —
 * the source's mask colour — the canvas pixel is left alone.
 */
function composite(canvas: Canvas, x: number, y: number, width: number, height: number, read: (i: number) => Color, blender: Blender, opacity: number, skip: (i: number) => boolean): void {
  const x0 = Math.max(0, x)
  const y0 = Math.max(0, y)
  const x1 = Math.min(canvas.width, x + width)
  const y1 = Math.min(canvas.height, y + height)
  for (let cy = y0; cy < y1; cy++) {
    for (let cx = x0; cx < x1; cx++) {
      const i = (cy - y) * width + (cx - x)
      if (skip(i)) continue
      const at = cy * canvas.width + cx
      canvas.pixels[at] = blender(canvas.pixels[at] ?? 0, read(i), opacity)
    }
  }
}

function drawImage(ctx: Context, canvas: Canvas, cel: ImageCel, blender: Blender, opacity: number): void {
  const { read, isMask } = sourceReader(ctx, cel.pixels)
  composite(canvas, cel.x, cel.y, cel.width, cel.height, read, blender, opacity, isMask)
}

function drawTilemap(ctx: Context, canvas: Canvas, layer: Layer, cel: TilemapCel, blender: Blender, opacity: number): void {
  const tileset: Tileset | undefined = ctx.file.tilesets.find((t) => t.id === layer.tilesetId)
  if (tileset === undefined) {
    ctx.warn(`Layer "${layer.name}" uses tileset ${String(layer.tilesetId)}, which the file does not have; it is not drawn.`)
    return
  }
  if (tileset.pixels === null) {
    ctx.warn(`Layer "${layer.name}" uses tileset "${tileset.name}", whose tiles live in another file; it is not drawn.`)
    return
  }
  const { tileWidth: tw, tileHeight: th } = tileset
  const tilePixels = tw * th
  const { read, isMask } = sourceReader(ctx, tileset.pixels)
  const emptyRaw = cel.masks.id >>> 0
  for (let v = 0; v < cel.height; v++) {
    for (let u = 0; u < cel.width; u++) {
      const raw = cel.tiles[v * cel.width + u] ?? 0
      // Current files use tile 0 as the empty tile; very old ones used all-ones.
      if (tileset.zeroIsEmpty ? (raw & cel.masks.id) === 0 : ((raw & cel.masks.id) >>> 0) === emptyRaw) continue
      const tile = decodeTile(raw, cel.masks)
      if (tile.index >= tileset.tileCount) continue
      const base = tile.index * tilePixels
      const left = cel.x + u * tw
      const top = cel.y + v * th
      const flipped = tile.xFlip || tile.yFlip || tile.diagonalFlip
      if (!flipped) {
        composite(canvas, left, top, tw, th, (i) => read(base + i), blender, opacity, (i) => isMask(base + i))
        continue
      }
      // Aseprite's flipped-tile path: mirror, then transpose; a transposed
      // pixel that falls outside a non-square tile clears the canvas.
      const side = Math.min(tw, th)
      for (let ty = Math.max(0, -top); ty < th && top + ty < canvas.height; ty++) {
        for (let tx = Math.max(0, -left); tx < tw && left + tx < canvas.width; tx++) {
          let sx = tile.xFlip ? tw - 1 - tx : tx
          let sy = tile.yFlip ? th - 1 - ty : ty
          let limitW = tw
          let limitH = th
          if (tile.diagonalFlip) {
            ;[sx, sy] = [sy, sx]
            limitW = limitH = side
          }
          const at = (top + ty) * canvas.width + (left + tx)
          if (sx < 0 || sx >= limitW || sy < 0 || sy >= limitH) {
            canvas.pixels[at] = 0
            continue
          }
          const i = base + sy * tw + sx
          if (isMask(i)) continue
          canvas.pixels[at] = blender(canvas.pixels[at] ?? 0, read(i), opacity)
        }
      }
    }
  }
}

function toBytes(pixels: Uint32Array): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(pixels.length * 4)
  for (let i = 0; i < pixels.length; i++) {
    const c = pixels[i] ?? 0
    out[i * 4] = c & 0xff
    out[i * 4 + 1] = (c >>> 8) & 0xff
    out[i * 4 + 2] = (c >>> 16) & 0xff
    out[i * 4 + 3] = getA(c)
  }
  return out
}
