/**
 * An image's grid, cut and scaled (ruling of 2026-09-17): square tiles of
 * `tile` px after `margin` px, `spacing` px apart, with whatever lies past
 * the last whole tile ignored — and every tile scaled by a whole number to
 * the project's density, by nearest neighbour, so a 16 px kit draws at 3×
 * in a 48 px project without a resampled texel.
 *
 * Nothing here knows a project. `gridCells` is the arithmetic the import
 * dialog shows live; `cutGrid` is what the loader hands the atlas: a plain
 * image, tiles edge to edge at the density, which is the one shape the atlas
 * reads.
 */

import type { Grid, RgbaImage } from '@papercut/document'

export interface GridCells {
  columns: number
  rows: number
  /** Pixels past the last whole tile, right and bottom. */
  ignored: { x: number; y: number }
}

/** How many whole tiles an image holds on a grid, and what is left over. Zero columns or rows when not even one tile fits. */
export function gridCells(width: number, height: number, grid: Grid): GridCells {
  const along = (extent: number, margin: number, spacing: number): [number, number] => {
    const room = extent - margin
    if (room < grid.tile) return [0, Math.max(0, room)]
    const n = Math.floor((room + spacing) / (grid.tile + spacing))
    return [n, room - n * grid.tile - (n - 1) * spacing]
  }
  const [columns, x] = along(width, grid.margin.x, grid.spacing.x)
  const [rows, y] = along(height, grid.margin.y, grid.spacing.y)
  return { columns, rows, ignored: { x, y } }
}

/** The tile sizes that fit an image exactly — nothing ignored — with the grid's margin and spacing, among those that divide the density, largest first. What the import dialog offers. */
export function fitsOf(width: number, height: number, grid: Pick<Grid, 'margin' | 'spacing'>, density: number): number[] {
  const fits: number[] = []
  for (let tile = density; tile >= 2; tile--) {
    if (density % tile !== 0) continue
    const cells = gridCells(width, height, { ...grid, tile })
    if (cells.columns > 0 && cells.rows > 0 && cells.ignored.x === 0 && cells.ignored.y === 0) fits.push(tile)
  }
  return fits
}

/**
 * Cut the tiles out of an image along its grid and lay them edge to edge, each scaled by `scale` (a whole number)
 * with nearest neighbour. Returns the plain image and its size in tiles.
 */
export function cutGrid(image: RgbaImage, grid: Grid, scale: number): { image: RgbaImage; columns: number; rows: number } {
  if (!Number.isInteger(scale) || scale < 1) throw new Error(`A grid scales by a whole number, not ${scale}.`)
  const { columns, rows } = gridCells(image.width, image.height, grid)
  const t = grid.tile
  const out = t * scale
  const width = columns * out
  const height = rows * out
  const data = new Uint8ClampedArray(width * height * 4)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const sx0 = grid.margin.x + c * (t + grid.spacing.x)
      const sy0 = grid.margin.y + r * (t + grid.spacing.y)
      for (let y = 0; y < out; y++) {
        const sy = sy0 + Math.floor(y / scale)
        const dy = r * out + y
        for (let x = 0; x < out; x++) {
          const sx = sx0 + Math.floor(x / scale)
          const si = (sy * image.width + sx) * 4
          const di = (dy * width + c * out + x) * 4
          data[di] = image.data[si]
          data[di + 1] = image.data[si + 1]
          data[di + 2] = image.data[si + 2]
          data[di + 3] = image.data[si + 3]
        }
      }
    }
  }
  return { image: { width, height, data }, columns, rows }
}
