import { describe, expect, it } from 'vitest'

import { archetypeOf, archetypes, requiredSlots, slotSize } from './archetype'
import { CORNER_BLOCKS, conventionOf, conventions, layoutTags, terrainFromLayout } from './layout'
import { renderTemplate } from './template'
import { addTerrain, assemble, createTerrainSet, exactTile, stampTemplate, terrainSetFrom } from './terrainset'

/** The same little ground set the terrain tests use: grass, path and dirt over a 4 px sheet. */
function groundSet() {
  let set = createTerrainSet('ground.png', 4, 8, 9)
  set = addTerrain(set, { id: 'grass', name: 'Grass', color: '#4f8a46' })
  set = addTerrain(set, { id: 'path', name: 'Path', color: '#b08f5e' })
  set = addTerrain(set, { id: 'dirt', name: 'Dirt', color: '#8a6a45' })
  set = stampTemplate(set, 0, 0, null, 'grass')
  set = stampTemplate(set, 4, 0, null, 'path')
  set = stampTemplate(set, 0, 4, 'grass', 'path')
  set = stampTemplate(set, 4, 4, null, 'dirt')
  return set
}

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

describe('archetypes and assembling a patch', () => {
  it('names a vocabulary per archetype, and only the floor is corners', () => {
    expect(archetypes().map((a) => a.id)).toEqual(['floor', 'wall', 'ramp'])
    const floor = archetypeOf('floor')
    expect(floor.slots).toHaveLength(15)
    expect(floor.slots.every((s) => s.mask !== undefined)).toBe(true)
    expect(floor.slots.map((s) => s.mask)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1))
    const wall = archetypeOf('wall')
    expect(wall.slots.some((s) => s.mask !== undefined)).toBe(false)
    expect(wall.slots.map((s) => s.id)).toContain('convex')
    // The seams are the optional ones: left empty they are mitred, so they do not count as owed.
    expect(requiredSlots(wall).map((s) => s.id)).toEqual(['face', 'top', 'bottom', 'end-left', 'end-right'])
    expect(requiredSlots(floor)).toHaveLength(15)
  })

  it('sorts the floor slots into what they actually are', () => {
    const kinds = archetypeOf('floor').slots.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.note ?? '']: (acc[s.note ?? ''] ?? 0) + 1 }), {})
    expect(kinds).toEqual({ interior: 1, 'outside corner': 4, edge: 4, 'inside corner': 4, diagonal: 2 })
  })

  it('gives a ramp taller tiles than the density, and the others square ones', () => {
    expect(slotSize(archetypeOf('floor'), 16)).toEqual({ width: 16, height: 16 })
    expect(slotSize(archetypeOf('wall'), 16)).toEqual({ width: 16, height: 16 })
    expect(slotSize(archetypeOf('ramp'), 16)).toEqual({ width: 16, height: 23 })
    expect(slotSize(archetypeOf('ramp'), 48)).toEqual({ width: 48, height: 68 })
    expect(() => archetypeOf('nope' as 'floor')).toThrow(/No archetype/)
  })

  it('assembles a patch of cells into the tiles a map would draw, and shows the holes', () => {
    const set = groundSet()
    // A 2 x 2 block of grass: the corner grid around it is 3 x 3.
    const patch = assemble(set, [['grass', 'grass'], ['grass', 'grass']])
    expect(patch).toHaveLength(9)
    // The middle corner has grass on all four sides, so it is the interior tile.
    const middle = patch.find((p) => p.column === 1 && p.row === 1)
    expect(middle?.corners).toEqual(['grass', 'grass', 'grass', 'grass'])
    expect(middle?.tile).not.toBeNull()
    // The top-left corner has grass only at its SE, which is an outside corner and authored.
    const nw = patch.find((p) => p.column === 0 && p.row === 0)
    expect(nw?.corners).toEqual([null, null, null, 'grass'])
    expect(nw?.tile).not.toBeNull()
    // Every corner of the patch is answered, so nothing would composite.
    expect(patch.filter((p) => p.tile === null && p.corners.some((c) => c !== null))).toEqual([])
  })

  it('answers null where nothing is tagged, which is exactly what would composite', () => {
    const set = groundSet()
    // Dirt has an edge set but no pair with path, so where they meet there is no tile.
    const patch = assemble(set, [['dirt', 'path']])
    const between = patch.find((p) => p.column === 1 && p.row === 0)
    expect(between?.corners).toEqual([null, null, 'dirt', 'path'])
    expect(between?.tile).toBeNull()
    // An all-nothing corner is not a hole; it is simply outside the patch.
    const outside = assemble(set, [[null]])
    expect(outside.every((p) => p.tile === null)).toBe(true)
  })
})
