import { describe, expect, it } from 'vitest'

import { CORNER_BLOCKS, conventionOf, conventions, layoutTags, terrainFromLayout } from './layout'
import { renderTemplate } from './template'
import { exactTile, terrainSetFrom } from './terrainset'

const ids = (n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + i))
const terrains = (n: number) => ids(n).map((id, i) => ({ id, color: ['#6aa84f', '#d9c27e', '#8e8e8e', '#5f8fb0', '#a06060'][i] ?? '#808080' }))

describe('the corner-blocks convention', () => {
  it('is in the registry and lays out pairs and triples of every value including nothing', () => {
    expect(conventions().map((c) => c.id)).toContain('corner-blocks')
    expect(conventionOf('corner-blocks')).toBe(CORNER_BLOCKS)
    expect(conventionOf('nope')).toBeNull()
    // Four terrains plus nothing: C(5,2) pair blocks and C(5,3) triple blocks.
    const blocks = CORNER_BLOCKS.blocks(4)
    expect(blocks.filter((b) => b.values.length === 2)).toHaveLength(10)
    expect(blocks.filter((b) => b.values.length === 3)).toHaveLength(10)
    expect(CORNER_BLOCKS.extent(4)).toEqual({ columns: 11, rows: 60 })
    // The blocks tile their bands without overlapping.
    const pairs = blocks.filter((b) => b.values.length === 2)
    expect(pairs.map((b) => b.row)).toEqual([0, 3, 6, 9, 12, 15, 18, 21, 24, 27])
    expect(new Set(blocks.map((b) => b.key)).size).toBe(blocks.length)
  })

  it('tags a terrain against nothing with a full edge set, and every pair with all sixteen corners', () => {
    const tiles = CORNER_BLOCKS.tiles(4)
    const combos = new Set(tiles.map((t) => t.corners.join(',')))
    // Terrain 1's edge set: every way it can meet nothing, bar the all-nothing tile.
    for (let mask = 1; mask < 16; mask++) {
      const corners = [0, 1, 2, 3].map((k) => ((mask >> k) & 1 ? 1 : 0))
      expect(combos.has(corners.join(','))).toBe(true)
    }
    // Terrains 1 and 2 together: all sixteen, the two pure ones coming from their own blocks.
    for (let mask = 0; mask < 16; mask++) {
      const corners = [0, 1, 2, 3].map((k) => ((mask >> k) & 1 ? 2 : 1))
      expect(combos.has(corners.join(','))).toBe(true)
    }
    // No tile is drawn twice, and none carries four different values.
    expect(new Set(tiles.map((t) => `${t.column},${t.row}`)).size).toBe(tiles.length)
    expect(tiles.some((t) => new Set(t.corners).size === 4)).toBe(false)
  })

  it('covers every corner of three or fewer values and leaves the four-value ones to composite', () => {
    const combos = new Set(CORNER_BLOCKS.tiles(4).map((t) => t.corners.join(',')))
    let covered = 0
    let fourWay = 0
    for (let a = 0; a < 5; a++) for (let b = 0; b < 5; b++) for (let c = 0; c < 5; c++) for (let d = 0; d < 5; d++) {
      const corners = [a, b, c, d]
      if (new Set(corners).size === 4) { fourWay += 1; continue }
      if (corners.every((v) => v === 0)) continue
      if (combos.has(corners.join(','))) covered += 1
    }
    // 5^4 minus the all-nothing tile minus the 120 four-way arrangements.
    expect(covered).toBe(625 - 1 - 120)
    expect(fourWay).toBe(120)
  })
})

describe('a layout on an image', () => {
  const spec = (over: string[] = []) => ({ convention: 'corner-blocks', origin: { x: 0, y: 0 }, terrains: ids(4), unauthored: over })

  it('names the tags by terrain, places them from the origin, and skips a block nobody drew', () => {
    const tags = layoutTags(spec(), 11, 60)
    expect(Object.keys(tags)).toHaveLength(CORNER_BLOCKS.tiles(4).length)
    // Tile 0 is the first of the 0+1 block: mask 8 of terrain a, so SE only.
    expect(tags['0']).toEqual([null, null, null, 'a'])
    // With that block unauthored it is gone, and only it.
    const without = layoutTags(spec(['0+1']), 11, 60)
    expect(without['0']).toBeUndefined()
    expect(Object.keys(without)).toHaveLength(Object.keys(tags).length - 15)
    // An origin shifts every tile by the same amount.
    const moved = layoutTags({ ...spec(), origin: { x: 2, y: 1 } }, 20, 70)
    expect(moved[String(1 * 20 + 2)]).toEqual([null, null, null, 'a'])
  })

  it("lets the entry's own tags win over the layout's", () => {
    const overrides = { terrains: ids(4).map((id) => ({ id, name: id, color: '#808080' })), tiles: { '0': ['b', 'b', 'b', 'b'] as [string, string, string, string] } }
    const merged = terrainFromLayout(spec(), overrides, 11, 60)
    expect(merged.tiles['0']).toEqual(['b', 'b', 'b', 'b'])
    expect(merged.tiles['1']).toBeDefined()
    expect(merged.terrains).toHaveLength(4)
  })

  it('drops a tile the image is too small to hold rather than writing off its edge', () => {
    const tags = layoutTags(spec(), 11, 10)
    expect(Object.keys(tags).length).toBeGreaterThan(0)
    expect(Math.max(...Object.keys(tags).map(Number))).toBeLessThan(11 * 10)
  })

  it('answers nothing for a convention it does not have', () => {
    expect(layoutTags({ ...spec(), convention: 'nope' }, 11, 60)).toEqual({})
  })
})

describe('the template a layout draws', () => {
  it('is exactly the size the convention asks for, and every tile it tags has pixels', () => {
    const template = renderTemplate('corner-blocks', terrains(4), { tile: 16 })
    expect([template.columns, template.rows]).toEqual([11, 60])
    expect([template.image.width, template.image.height]).toEqual([11 * 16, 60 * 16])
    const opaque = (column: number, row: number, quadrant: number): boolean => {
      const x = column * 16 + (quadrant & 1) * 8 + 3
      const y = row * 16 + (quadrant >> 1) * 8 + 3
      return template.image.data[(y * template.image.width + x) * 4 + 3] > 128
    }
    // A corner showing a terrain is painted; one showing nothing is left transparent.
    for (const tile of CORNER_BLOCKS.tiles(4)) {
      for (let q = 0; q < 4; q++) expect(opaque(tile.column, tile.row, q)).toBe(tile.corners[q] !== 0)
    }
  })

  it('round-trips: a template read back through its own layout answers every corner it drew', () => {
    const template = renderTemplate('corner-blocks', terrains(3), { tile: 8 })
    const spec = { convention: 'corner-blocks', origin: { x: 0, y: 0 }, terrains: ids(3), unauthored: [] }
    const terrain = { terrains: ids(3).map((id) => ({ id, name: id, color: '#808080' })), tiles: layoutTags(spec, template.columns, template.rows) }
    const { set, dropped } = terrainSetFrom('template.png', 8, template.columns, template.rows, terrain)
    expect(dropped).toEqual([])
    // Every corner of three or fewer terrains has a tile of its own; nothing composites.
    for (const corners of [['a', 'a', 'a', 'a'], ['a', null, null, null], ['a', 'b', 'a', 'b'], ['a', 'b', 'c', 'b'], ['a', 'b', null, 'b']]) {
      expect(exactTile(set, corners as [string | null, string | null, string | null, string | null])).not.toBeNull()
    }
  })

  it('refuses a convention it does not have, no terrains, or a tile too small to halve', () => {
    expect(() => renderTemplate('nope', terrains(2), { tile: 16 })).toThrow(/No layout convention/)
    expect(() => renderTemplate('corner-blocks', [], { tile: 16 })).toThrow(/at least one terrain/)
    expect(() => renderTemplate('corner-blocks', terrains(2), { tile: 1 })).toThrow(/whole number of pixels/)
  })
})
