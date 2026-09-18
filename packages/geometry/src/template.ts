/**
 * Drawing a layout: the template an artist paints into (ruling of 2026-09-17).
 *
 * Papercut does not read a convention out of someone else's sheet; it writes
 * one. From a convention and a list of materials it draws every block in
 * place, each tile showing which materials meet at its corner as four
 * quadrants, so the sheet an artist opens already says what belongs in every
 * cell — and its tags are right before a pixel is drawn.
 *
 * The quadrants are flat colour on purpose. They are scaffolding to paint
 * over, not art, and a block left in flat colour reads at a glance as one
 * nobody has drawn yet.
 */

import type { RgbaImage } from '@papercut/document'

import { conventionOf, type Convention } from './layout'

export interface TemplateMaterial {
  id: number
  /** `#rrggbb`, what its quadrants are filled with. */
  color: string
}

export interface TemplateOptions {
  /** Pixels per tile in the image written; the project's density. */
  tile: number
  /** Drawn faintly between the blocks so their bounds read. `false` for a bare template. */
  rules?: boolean
}

export interface Template {
  image: RgbaImage
  columns: number
  rows: number
  convention: Convention
}

const rgb = (hex: string): [number, number, number] => {
  const n = Number.parseInt(hex.replace(/^#/, ''), 16)
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [128, 128, 128]
}

/**
 * Draw a convention's whole layout for `materials`: one image, tiles edge to edge, every block in
 * the convention's order. A corner showing nothing is left transparent, which is what nothing IS —
 * so an artist can see the silhouette of every edge piece before drawing it.
 */
export function renderTemplate(conventionId: string, materials: readonly TemplateMaterial[], options: TemplateOptions): Template {
  const convention = conventionOf(conventionId)
  if (!convention) throw new Error(`No layout convention called ${conventionId}.`)
  if (materials.length < 1) throw new Error('A template lays out at least one material.')
  const { tile, rules = true } = options
  if (!Number.isInteger(tile) || tile < 2) throw new Error(`A template's tile is a whole number of pixels, not ${tile}.`)
  const { columns, rows } = convention.extent(materials.length)
  const width = columns * tile
  const height = rows * tile
  const data = new Uint8ClampedArray(width * height * 4)
  const colours = materials.map((t) => rgb(t.color))
  const half = tile / 2

  const fill = (x0: number, y0: number, w: number, h: number, [r, g, b]: [number, number, number], a: number): void => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * width + x) * 4
        data[i] = r
        data[i + 1] = g
        data[i + 2] = b
        data[i + 3] = a
      }
    }
  }

  for (const t of convention.tiles(materials.length)) {
    const px = t.column * tile
    const py = t.row * tile
    t.corners.forEach((value, k) => {
      if (value === 0) return // nothing: left transparent, so the shape of an edge piece reads
      const colour = colours[value - 1] ?? [128, 128, 128]
      fill(px + (k & 1) * Math.floor(half), py + (k >> 1) * Math.floor(half), Math.ceil(half), Math.ceil(half), colour, 255)
    })
  }

  if (rules) {
    // A hairline between blocks, drawn over the fill, so the bands and their blocks are visible.
    for (const block of convention.blocks(materials.length)) {
      const x0 = block.column * tile
      const y0 = block.row * tile
      const w = block.columns * tile
      const h = block.rows * tile
      for (let x = x0; x < x0 + w; x++) {
        for (const y of [y0, y0 + h - 1]) {
          const i = (y * width + x) * 4
          data[i] = 255
          data[i + 1] = 255
          data[i + 2] = 255
          data[i + 3] = Math.max(data[i + 3], 40)
        }
      }
      for (let y = y0; y < y0 + h; y++) {
        for (const x of [x0, x0 + w - 1]) {
          const i = (y * width + x) * 4
          data[i] = 255
          data[i + 1] = 255
          data[i + 2] = 255
          data[i + 3] = Math.max(data[i + 3], 40)
        }
      }
    }
  }

  return { image: { width, height, data }, columns, rows, convention }
}
