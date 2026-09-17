/**
 * Tileset layout conventions: how a sheet's corner tags are DESCRIBED rather
 * than enumerated (ruling of 2026-09-17).
 *
 * A convention says, for a given number of terrains, exactly which tiles a
 * sheet holds and what each one is tagged with. Papercut derives every tag
 * from it at load, so an image laid out to a convention carries a line rather
 * than hundreds of entries — and, because papercut can also DRAW the layout,
 * an artist starts from a template whose tags are right before a pixel exists.
 *
 * The values a layout arranges are `nothing` and the terrains, in that order:
 * value 0 is nothing — the edge of the ground — and value k is the k-th
 * terrain of the layout's list. A BLOCK is one combination of those values,
 * and holds every tile in which exactly those values meet at a corner.
 *
 * Papercut does not infer a convention from an existing sheet's pixels; a
 * sheet is brought in by generating the template and moving the art into it.
 */

import type { Axes, ImageTerrain, Tag } from '@papercut/document'

/** A block of a layout: the values that meet in it, and where it sits. */
export interface LayoutBlock {
  /** Names the block in an entry's `unauthored` list: the values, joined, as `0+1` or `1+2+3`. */
  key: string
  /** Indexes into [nothing, ...terrains]; 0 is nothing. */
  values: number[]
  /** In tiles, from the layout's origin. */
  column: number
  row: number
  columns: number
  rows: number
}

/** One tile a layout defines: where it sits, and what meets at its corner. */
export interface LayoutTile {
  column: number
  row: number
  /** NW, NE, SW, SE as indexes into [nothing, ...terrains]. */
  corners: [number, number, number, number]
  block: string
}

export interface Convention {
  readonly id: string
  readonly title: string
  readonly note: string
  /** The size in tiles the layout needs for `count` terrains. */
  extent(count: number): { columns: number; rows: number }
  blocks(count: number): LayoutBlock[]
  tiles(count: number): LayoutTile[]
}

const choose = (values: readonly number[], k: number): number[][] => {
  if (k === 0) return [[]]
  const out: number[][] = []
  values.forEach((v, i) => {
    for (const rest of choose(values.slice(i + 1), k - 1)) out.push([v, ...rest])
  })
  return out
}

/**
 * The corner-block convention, as an existing Tilesetter sheet lays one out.
 *
 * Two bands. PAIRS are 5 × 3 blocks in the first: the fifteen ways two values
 * can meet at a corner, by the mask of the LATER value over the earlier, so
 * `0+1` is terrain 1's edge set against nothing. TRIPLES are 6 × 6 blocks in
 * the second: the thirty-six ways three values meet with all three present.
 * Four different values at one corner are not drawn — there is no block for
 * them — which is exactly the case the atlas composites.
 */
const PAIR_MASKS: readonly (readonly number[])[] = [
  [8, 12, 4, 7, 11],
  [10, 15, 5, 13, 14],
  [2, 3, 1, 9, 6],
]

/** Each cell is the four corners as indexes into the block's three values. */
const TRIPLE_CELLS: readonly (readonly string[])[] = [
  ['1102', '1120', '1201', '2110', '1202', '2120'],
  ['0211', '2011', '0112', '1021', '0212', '2021'],
  ['1210', '2101', '1220', '2102', '1200', '2100'],
  ['1012', '0121', '2012', '0221', '0012', '0021'],
  ['1022', '0122', '1002', '0120', '1020', '0102'],
  ['2210', '2201', '0210', '2001', '2010', '0201'],
]

const PAIR_W = 5
const PAIR_H = 3
const TRIPLE_W = 6
const TRIPLE_H = 6

const keyOf = (values: readonly number[]): string => values.join('+')

function pairsAndTriples(count: number): { pairs: number[][]; triples: number[][] } {
  const values = Array.from({ length: count + 1 }, (_, i) => i)
  return { pairs: choose(values, 2), triples: choose(values, 3) }
}

export const CORNER_BLOCKS: Convention = {
  id: 'corner-blocks',
  title: 'Corner blocks',
  note: 'Pairs in a 5 × 3 block each, triples in a 6 × 6, and four-way corners left to composite.',
  extent(count) {
    const { pairs, triples } = pairsAndTriples(count)
    return { columns: PAIR_W + TRIPLE_W, rows: Math.max(pairs.length * PAIR_H, triples.length * TRIPLE_H) }
  },
  blocks(count) {
    const { pairs, triples } = pairsAndTriples(count)
    return [
      ...pairs.map((values, i) => ({ key: keyOf(values), values, column: 0, row: i * PAIR_H, columns: PAIR_W, rows: PAIR_H })),
      ...triples.map((values, i) => ({ key: keyOf(values), values, column: PAIR_W, row: i * TRIPLE_H, columns: TRIPLE_W, rows: TRIPLE_H })),
    ]
  },
  tiles(count) {
    const out: LayoutTile[] = []
    for (const block of this.blocks(count)) {
      if (block.values.length === 2) {
        const [under, over] = block.values
        for (let r = 0; r < PAIR_H; r++) {
          for (let c = 0; c < PAIR_W; c++) {
            const mask = PAIR_MASKS[r][c]
            // The all-over tile belongs to that terrain's own block against nothing, so a two-terrain block leaves it out.
            if (mask === 15 && under !== 0) continue
            const corners = [0, 1, 2, 3].map((k) => ((mask >> k) & 1 ? over : under)) as [number, number, number, number]
            out.push({ column: block.column + c, row: block.row + r, corners, block: block.key })
          }
        }
      } else {
        for (let r = 0; r < TRIPLE_H; r++) {
          for (let c = 0; c < TRIPLE_W; c++) {
            const cell = TRIPLE_CELLS[r][c]
            const corners = [0, 1, 2, 3].map((k) => block.values[Number(cell[k])]) as [number, number, number, number]
            out.push({ column: block.column + c, row: block.row + r, corners, block: block.key })
          }
        }
      }
    }
    return out
  },
}

const REGISTRY: readonly Convention[] = [CORNER_BLOCKS]

export function conventions(): readonly Convention[] {
  return REGISTRY
}

export function conventionOf(id: string): Convention | null {
  return REGISTRY.find((c) => c.id === id) ?? null
}

export interface LayoutSpec {
  convention: string
  origin: Axes
  terrains: string[]
  unauthored: string[]
}

/**
 * The tags a layout puts on an image, as an `ImageTerrain`'s `tiles`: every tile of every block the
 * artist has drawn, placed from the layout's origin on a grid `columns` wide. A block named
 * unauthored contributes nothing, so the corners it would have covered composite and are reported
 * as still to author — which is the truth about a sheet with a block left blank.
 */
export function layoutTags(spec: LayoutSpec, columns: number, rows: number): Record<string, [Tag, Tag, Tag, Tag]> {
  const convention = conventionOf(spec.convention)
  if (!convention) return {}
  const skip = new Set(spec.unauthored)
  const tiles: Record<string, [Tag, Tag, Tag, Tag]> = {}
  const name = (value: number): Tag => (value === 0 ? null : (spec.terrains[value - 1] ?? null))
  for (const tile of convention.tiles(spec.terrains.length)) {
    if (skip.has(tile.block)) continue
    const column = spec.origin.x + tile.column
    const row = spec.origin.y + tile.row
    if (column >= columns || row >= rows) continue
    tiles[String(row * columns + column)] = tile.corners.map(name) as [Tag, Tag, Tag, Tag]
  }
  return tiles
}

/** A layout's tags with the entry's own on top: the layout describes the sheet, the entry corrects it. */
export function terrainFromLayout(spec: LayoutSpec, overrides: ImageTerrain, columns: number, rows: number): ImageTerrain {
  return { terrains: overrides.terrains.map((t) => ({ ...t })), tiles: { ...layoutTags(spec, columns, rows), ...overrides.tiles } }
}
