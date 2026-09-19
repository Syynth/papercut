/**
 * An `.aseprite` file as one of the project's images (decision-log
 * 2026-09-19): one frame of it, flattened the way Aseprite shows it, plus
 * what the file knows that the image entry would otherwise ask the artist
 * for again — how many frames there are to pick from, and its tile grid.
 *
 * The papercut side of the Aseprite support: `@papercut/aseprite` and
 * `@papercut/aseprite-render` know nothing of projects, and this is where
 * their model meets `RgbaImage` and `Grid`.
 */

import { isAseprite, parseAseprite, type AsepriteFile } from '@papercut/aseprite'
import { renderFrame } from '@papercut/aseprite-render'
import type { Grid, RgbaImage } from '@papercut/document'

export interface AsepriteSheet {
  /** The chosen frame, every visible layer flattened. */
  image: RgbaImage
  /** The frame drawn: the one asked for, or the last when the file has fewer. */
  frame: number
  /** How many frames the file has. */
  frames: number
  /** The file's tile grid in the project's terms, and where it came from; null when it has none papercut can use. */
  grid: { grid: Grid; from: 'tileset' | 'grid' } | null
  /** What did not come through, one line each, in the artist's terms. */
  warnings: string[]
}

/** Whether the bytes are an Aseprite file rather than a PNG or other image. */
export const isAsepriteSheet = isAseprite

/**
 * Read an `.aseprite` file as a sheet, drawing frame `frame` (0-based).
 * Throws when the bytes are not a readable Aseprite file.
 */
export function readAsepriteSheet(bytes: Uint8Array, frame = 0): AsepriteSheet {
  const file = parseAseprite(bytes)
  const warnings = [...file.warnings]
  const frames = file.frames.length
  if (frames === 0) throw new Error('The Aseprite file has no frames.')
  const drawn = Math.min(Math.max(0, Math.trunc(frame)), frames - 1)
  if (drawn !== frame) warnings.push(`It has ${frames} ${frames === 1 ? 'frame' : 'frames'}, so frame ${drawn + 1} is drawn instead of frame ${frame + 1}.`)
  const out = renderFrame(file, drawn, { warn: (message) => warnings.push(message) })
  return { image: { width: out.width, height: out.height, data: out.data }, frame: drawn, frames, grid: gridOf(file), warnings }
}

/**
 * The tile grid the file describes. A tileset's tile size is the artist's
 * deliberate choice, so it wins; otherwise the sprite's own grid setting,
 * whose offset becomes the margin. Papercut's tiles are square and spaced
 * evenly from the margin, so a grid that is not square is not used.
 *
 * Aseprite writes its default 16×16 grid into every file, so a 16 px grid
 * from the grid setting may be a default rather than a choice.
 */
export function gridOf(file: AsepriteFile): { grid: Grid; from: 'tileset' | 'grid' } | null {
  const used = new Set(file.layers.filter((l) => l.type === 'tilemap').map((l) => l.tilesetId))
  const tileset = file.tilesets.find((t) => used.has(t.id) && t.tileWidth === t.tileHeight && t.tileWidth > 0)
  if (tileset !== undefined) return { grid: { tile: tileset.tileWidth, margin: { x: 0, y: 0 }, spacing: { x: 0, y: 0 } }, from: 'tileset' }
  const g = file.grid
  if (g === null || g.width !== g.height) return null
  const wrap = (offset: number): number => ((offset % g.width) + g.width) % g.width
  return { grid: { tile: g.width, margin: { x: wrap(g.x), y: wrap(g.y) }, spacing: { x: 0, y: 0 } }, from: 'grid' }
}
