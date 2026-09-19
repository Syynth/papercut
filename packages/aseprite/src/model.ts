/**
 * Questions asked of a parsed file that the file answers only indirectly:
 * which cel a layer shows on a frame once links are followed, what the
 * palette is on a given frame, what a raw tile value means, and whether a
 * layer is visible once its groups are taken into account.
 */

import type { AsepriteFile, Cel, ImageCel, Layer, PaletteEntry, TileMasks, TilemapCel } from './types'

/** A cel with its link followed: pixels or tiles, at the linking cel's own position, opacity and z-index. */
export type ResolvedCel = ImageCel | TilemapCel

/** The cel `layer` has on `frame`, as stored — possibly a link. */
export function celAt(file: AsepriteFile, layer: number, frame: number): Cel | null {
  return file.frames[frame]?.cels.find((cel) => cel.layer === layer) ?? null
}

/**
 * The cel `layer` shows on `frame`, with any link followed to the cel that
 * holds the content. Placement and opacity stay the linking cel's, as
 * Aseprite reads them. Null when the layer is empty on that frame or the link
 * leads nowhere.
 */
export function resolveCel(file: AsepriteFile, layer: number, frame: number): ResolvedCel | null {
  const cel = celAt(file, layer, frame)
  if (cel === null) return null
  if (cel.kind !== 'linked') return cel
  // A link names a frame whose cel holds content; guard against chains and cycles anyway.
  const seen = new Set<number>([frame])
  let target: Cel | null = cel
  while (target !== null && target.kind === 'linked') {
    if (seen.has(target.linkedFrame)) return null
    seen.add(target.linkedFrame)
    target = celAt(file, layer, target.linkedFrame)
  }
  if (target === null) return null
  return { ...target, frame, x: cel.x, y: cel.y, opacity: cel.opacity, zIndex: cel.zIndex, precise: cel.precise, userData: cel.userData }
}

const OPAQUE_BLACK: PaletteEntry = { r: 0, g: 0, b: 0, a: 255, name: null }

/**
 * The palette in effect on `frame`: every palette change from frame 0 up to
 * and including it, applied in order. New entries a resize creates are
 * opaque black, as in Aseprite.
 */
export function paletteAt(file: AsepriteFile, frame: number): PaletteEntry[] {
  const palette: PaletteEntry[] = []
  const last = Math.min(frame, file.frames.length - 1)
  for (let f = 0; f <= last; f++) {
    for (const change of file.frames[f]?.paletteChanges ?? []) {
      const length = change.size ?? Math.max(palette.length, change.from + change.entries.length)
      while (palette.length < length) palette.push(OPAQUE_BLACK)
      palette.length = length
      change.entries.forEach((entry, i) => {
        if (change.from + i < length) palette[change.from + i] = entry
      })
    }
  }
  return palette
}

export interface Tile {
  /** Index into the tileset. */
  index: number
  xFlip: boolean
  yFlip: boolean
  /** Swap x and y (a transpose), applied after the other two flips. */
  diagonalFlip: boolean
}

/** Split a raw tile value from a tilemap cel into its index and flip flags. */
export function decodeTile(value: number, masks: TileMasks): Tile {
  const shift = masks.id === 0 ? 0 : 31 - Math.clz32(masks.id & -masks.id)
  const has = (mask: number): boolean => mask !== 0 && ((value & mask) >>> 0) === mask >>> 0
  return { index: ((value & masks.id) >>> 0) >>> shift, xFlip: has(masks.xFlip), yFlip: has(masks.yFlip), diagonalFlip: has(masks.diagonalFlip) }
}

/** The layer's enclosing groups, innermost first. */
export function ancestors(file: AsepriteFile, layer: Layer): Layer[] {
  const out: Layer[] = []
  for (let p = layer.parent; p !== null; ) {
    const group = file.layers[p]
    if (group === undefined) break
    out.push(group)
    p = group.parent
  }
  return out
}

/** Visible, and so is every group it sits in. */
export function isVisibleInTree(file: AsepriteFile, layer: Layer): boolean {
  return layer.flags.visible && ancestors(file, layer).every((group) => group.flags.visible)
}

/** The layer's direct children, in file order (bottom to top). */
export function childrenOf(file: AsepriteFile, group: Layer | null): Layer[] {
  const parent = group === null ? null : group.index
  return file.layers.filter((layer) => layer.parent === parent)
}
