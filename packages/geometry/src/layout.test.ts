import { describe, expect, it } from 'vitest'

import { tagOf } from '@papercut/document'

import { ORDINARY, archetypeOf, archetypes, arrangements, maskKind, requiredSlots, slotSize } from './archetype'
import { CORNER_BLOCKS, conventionOf, conventions, layoutTags, terrainFromLayout } from './layout'
import { renderTemplate } from './template'
import { assemble, createTerrainSet, exactTile, stampBlock, stampTemplate, templateTags, terrainSetFrom } from './terrainset'

/** The same little ground set the terrain tests use: three materials by id over a 4 px sheet. */
const GRASS = tagOf(0)
const PATH = tagOf(1)
const DIRT = tagOf(2)

function groundSet() {
  let set = createTerrainSet('ground.png', 4, 8, 9)
  set = stampTemplate(set, 0, 0, null, GRASS)
  set = stampTemplate(set, 4, 0, null, PATH)
  set = stampTemplate(set, 0, 4, GRASS, PATH)
  set = stampTemplate(set, 4, 4, null, DIRT)
  return set
}

/**
 * The materials a layout lays out, by id. They are deliberately not 0, 1, 2, 3: a layout names
 * the project's materials (ruling of 2026-09-17), and a value in a block is an index into its own
 * list rather than a material id, so ids that are not their own positions catch a confusion of the two.
 */
const ids = (n: number) => [5, 7, 2, 9, 4].slice(0, n)
const materials = (n: number) => ids(n).map((id, i) => ({ id, color: ['#6aa84f', '#d9c27e', '#8e8e8e', '#5f8fb0', '#a06060'][i] ?? '#808080' }))
const tagsOf = (n: number) => ids(n).map((id) => tagOf(id))

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
  const spec = () => ({ convention: 'corner-blocks', origin: { x: 0, y: 0 }, materials: ids(4) })

  it('names the tags by material, places them from the origin, and tags every block the convention has', () => {
    const tiles = layoutTags(spec(), 11, 60)
    expect(Object.keys(tiles)).toHaveLength(CORNER_BLOCKS.tiles(4).length)
    // Tile 0 is the first of the 0+1 block: mask 8 of the layout's first material, so SE only.
    expect(tiles['0']).toEqual([null, null, null, tagsOf(4)[0]])
    // There is no list of blocks left undrawn any more (ruling of 2026-09-17). The layout says what the
    // sheet IS, so every block it lays out is tagged, and what nobody has painted yet is a question about
    // pixels rather than an entry kept beside the tags.
    const tagged = new Set(Object.keys(tiles).map(Number))
    for (const block of CORNER_BLOCKS.blocks(4)) expect(tagged.has(block.row * 11 + block.column)).toBe(true)
    // An origin shifts every tile by the same amount.
    const moved = layoutTags({ ...spec(), origin: { x: 2, y: 1 } }, 20, 70)
    expect(moved[String(1 * 20 + 2)]).toEqual([null, null, null, tagsOf(4)[0]])
  })

  it("lets the entry's own tags win over the layout's", () => {
    const own = tagsOf(4)[1]
    const overrides = { tiles: { '0': [own, own, own, own] as [string, string, string, string] } }
    const merged = terrainFromLayout(spec(), overrides, 11, 60)
    expect(merged.tiles['0']).toEqual([own, own, own, own])
    expect(merged.tiles['1']).toBeDefined()
    // What comes back is an image's terrain, which is its tags and nothing else.
    expect(Object.keys(merged)).toEqual(['tiles'])
  })

  it('drops a tile the image is too small to hold rather than writing off its edge', () => {
    const tiles = layoutTags(spec(), 11, 10)
    expect(Object.keys(tiles).length).toBeGreaterThan(0)
    expect(Math.max(...Object.keys(tiles).map(Number))).toBeLessThan(11 * 10)
  })

  it('answers nothing for a convention it does not have', () => {
    expect(layoutTags({ ...spec(), convention: 'nope' }, 11, 60)).toEqual({})
  })
})

describe('the template a layout draws', () => {
  it('is exactly the size the convention asks for, and every tile it tags has pixels', () => {
    const template = renderTemplate('corner-blocks', materials(4), { tile: 16 })
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
    const template = renderTemplate('corner-blocks', materials(3), { tile: 8 })
    const spec = { convention: 'corner-blocks', origin: { x: 0, y: 0 }, materials: ids(3) }
    const terrain = { tiles: layoutTags(spec, template.columns, template.rows) }
    const { set, dropped } = terrainSetFrom('template.png', 8, template.columns, template.rows, terrain)
    expect(dropped).toEqual([])
    const [a, b, c] = tagsOf(3)
    // Every corner of three or fewer materials has a tile of its own; nothing composites.
    for (const corners of [[a, a, a, a], [a, null, null, null], [a, b, a, b], [a, b, c, b], [a, b, null, b]]) {
      expect(exactTile(set, corners as [string | null, string | null, string | null, string | null])).not.toBeNull()
    }
  })

  it('refuses a convention it does not have, no materials, or a tile too small to halve', () => {
    expect(() => renderTemplate('nope', materials(2), { tile: 16 })).toThrow(/No layout convention/)
    expect(() => renderTemplate('corner-blocks', [], { tile: 16 })).toThrow(/at least one material/)
    expect(() => renderTemplate('corner-blocks', materials(2), { tile: 1 })).toThrow(/whole number of pixels/)
  })
})

describe('archetypes and assembling a patch', () => {
  it('gives every archetype one ordinary surface, and the seams to the wall alone', () => {
    expect(archetypes().map((a) => a.id)).toEqual(['floor', 'wall', 'ramp'])
    // Exactly one slot per archetype is the one a tag means when it names none, and it is spelled `surface`.
    for (const archetype of archetypes()) {
      const ordinary = archetype.slots.filter((s) => s.ordinary)
      expect(ordinary).toHaveLength(1)
      expect(ordinary[0].id).toBe(ORDINARY)
    }
    // Every material has the trim slots, whatever its face: a fringe and a picket are edges of any surface.
    expect(archetypeOf('floor').slots.map((s) => s.id)).toEqual([ORDINARY, 'fringe', 'picket'])
    expect(archetypeOf('ramp').slots.map((s) => s.id)).toEqual([ORDINARY, 'fringe', 'picket'])
    // A seam is two wall faces meeting at an angle, which no arrangement of four coplanar corners can say,
    // so it is the wall's alone and nobody else carries one.
    expect(archetypeOf('wall').slots.map((s) => s.id)).toEqual([ORDINARY, 'convex', 'concave', 'fringe', 'picket'])
    // The seams are the optional ones: left undrawn they are mitred, so they do not count as owed.
    expect(requiredSlots(archetypeOf('wall')).map((s) => s.id)).toEqual([ORDINARY])
  })

  it('sorts the fifteen arrangements into what they actually are, which is not a vocabulary anybody owns', () => {
    // The fifteen used to be listed as the floor's slots. They are neither the floor's nor slots: they are
    // the ways ANY surface meets what is beside it, because every face is meshed through the same dual grid.
    const all = arrangements()
    expect(all.map((a) => a.mask)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1))
    const kinds = all.reduce<Record<string, number>>((acc, a) => ({ ...acc, [a.kind]: (acc[a.kind] ?? 0) + 1 }), {})
    expect(kinds).toEqual({ interior: 1, 'outside corner': 4, edge: 4, 'inside corner': 4, diagonal: 2 })
    expect(maskKind(15)).toBe('interior')
    expect(maskKind(9)).toBe('diagonal')
    expect(archetypes().every((a) => a.slots.length < all.length)).toBe(true)
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
    const patch = assemble(set, [[GRASS, GRASS], [GRASS, GRASS]])
    expect(patch).toHaveLength(9)
    // The middle corner has grass on all four sides, so it is the interior tile.
    const middle = patch.find((p) => p.column === 1 && p.row === 1)
    expect(middle?.corners).toEqual([GRASS, GRASS, GRASS, GRASS])
    expect(middle?.tile).not.toBeNull()
    // The top-left corner has grass only at its SE, which is an outside corner and authored.
    const nw = patch.find((p) => p.column === 0 && p.row === 0)
    expect(nw?.corners).toEqual([null, null, null, GRASS])
    expect(nw?.tile).not.toBeNull()
    // Every corner of the patch is answered, so nothing would composite.
    expect(patch.filter((p) => p.tile === null && p.corners.some((c) => c !== null))).toEqual([])
  })

  it('answers null where nothing is tagged, which is exactly what would composite', () => {
    const set = groundSet()
    // Dirt has an edge set but no pair with path, so where they meet there is no tile.
    const patch = assemble(set, [[DIRT, PATH]])
    const between = patch.find((p) => p.column === 1 && p.row === 0)
    expect(between?.corners).toEqual([null, null, DIRT, PATH])
    expect(between?.tile).toBeNull()
    // An all-nothing corner is not a hole; it is simply outside the patch.
    const outside = assemble(set, [[null]])
    expect(outside.every((p) => p.tile === null)).toBe(true)
  })
})

describe("placing one block where an artist drew it", () => {
  const blank = () => createTerrainSet('kit.png', 16, 12, 12)

  it('gives a pair block the fifteen arrangements of its two values, from the block corner', () => {
    const shape = CORNER_BLOCKS.blockShape(2)
    expect(shape).toMatchObject({ columns: 5, rows: 3 })
    const set = stampBlock(blank(), shape!, [null, tagOf(4)], 2, 6)

    // Fifteen, not sixteen: the block's shape has all sixteen cells, and the all-over tile is the
    // one a block drawn against nothing already answers, so a block over nothing keeps it.
    expect(set.tiles.size).toBe(15)
    // Every tile lands inside the 5 x 3 the artist pointed at, and nowhere else.
    for (const index of set.tiles.keys()) {
      const column = index % 12
      const row = Math.floor(index / 12)
      expect(column).toBeGreaterThanOrEqual(2)
      expect(column).toBeLessThan(7)
      expect(row).toBeGreaterThanOrEqual(6)
      expect(row).toBeLessThan(9)
    }
    // And the corner it answers is the one the mesher will ask for.
    expect(exactTile(set, templateTags(7, null, tagOf(4)))).not.toBeNull()
  })

  it("leaves the all-over tile alone when the block is drawn over something, because it is the other material's", () => {
    // Grass over dirt draws a solid-grass tile in the middle of its block, but that tile is grass's
    // own. Claiming it here would have this block answer a corner that is not about this pairing.
    const set = stampBlock(blank(), CORNER_BLOCKS.blockShape(2)!, [tagOf(1), tagOf(0)], 0, 0)
    expect(set.tiles.size).toBe(14)
    expect(exactTile(set, [tagOf(0), tagOf(0), tagOf(0), tagOf(0)])).toBeNull()
    expect(exactTile(set, templateTags(3, tagOf(1), tagOf(0)))).not.toBeNull()
  })

  it('refuses a block that would run off the sheet rather than tagging half of it', () => {
    expect(() => stampBlock(blank(), CORNER_BLOCKS.blockShape(2)!, [null, tagOf(0)], 9, 0)).toThrow(/does not fit/)
    expect(() => stampBlock(blank(), CORNER_BLOCKS.blockShape(3)!, [null, tagOf(0), tagOf(1)], 0, 8)).toThrow(/does not fit/)
  })

  it('has no shape for four values at a corner, which is the case the atlas composites', () => {
    expect(CORNER_BLOCKS.blockShape(4)).toBeNull()
    expect(CORNER_BLOCKS.blockShape(3)).toMatchObject({ columns: 6, rows: 6 })
  })
})
