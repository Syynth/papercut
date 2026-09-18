import { describe, expect, it } from 'vitest'

import { tagOf, type RgbaImage, type Tag } from '@papercut/document'

import { TerrainAtlas, type CornerKeys } from './atlas'
import { cutGrid, fitsOf, gridCells, remapTags } from './grid'
import { TerrainSetError, cornerAt, createTerrainSet, edgeCoverage, edgeTile, exactTile, pairAuthored, removeMaterial, stampTemplate, tagCorner, templateTags, terrainOf, terrainSetFrom } from './terrainset'

const T = 4

/**
 * The materials the little ground set below is drawn for, as a tag spells
 * them. A tag names a material of the project rather than anything local to
 * the sheet (ruling of 2026-09-17), so these are ids: 0, 1 and 2.
 */
const GRASS = tagOf(0)
const PATH = tagOf(1)
const DIRT = tagOf(2)

/** A sheet whose every tile is one flat colour keyed to its index, so a blit can be traced back. */
function sheetImage(columns: number, rows: number, alphaFor: (index: number, x: number, y: number) => number = () => 255): RgbaImage {
  const width = columns * T
  const height = rows * T
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = Math.floor(y / T) * columns + Math.floor(x / T)
      const i = (y * width + x) * 4
      data[i] = index
      data[i + 1] = 0
      data[i + 2] = 0
      data[i + 3] = alphaFor(index, x % T, y % T)
    }
  }
  return { width, height, data }
}

function groundSet() {
  // Four 4×4 blocks fill rows 0–7; row 8 stays untagged.
  let set = createTerrainSet('ground.png', T, 8, 9)
  set = stampTemplate(set, 0, 0, null, GRASS) // grass edge set
  set = stampTemplate(set, 4, 0, null, PATH) // path edge set
  set = stampTemplate(set, 0, 4, GRASS, PATH) // the authored pair
  set = stampTemplate(set, 4, 4, null, DIRT) // dirt edge set
  return set
}

describe('terrain sets', () => {
  it('tags a template block by position, over at the set corners and under elsewhere', () => {
    const set = groundSet()
    // mask 3 = NW + NE: the top half is path, the bottom half grass, at column 3 of the pair block's first row.
    expect(set.tiles.get(4 * 8 + 3)).toEqual([PATH, PATH, GRASS, GRASS])
    expect(templateTags(0, GRASS, PATH)).toEqual([GRASS, GRASS, GRASS, GRASS])
    expect(templateTags(15, null, GRASS)).toEqual([GRASS, GRASS, GRASS, GRASS])
  })

  it('answers the exact tile for a corner, and nothing for a combination nobody tagged', () => {
    const set = groundSet()
    // mask 12 = SW + SE, at column 0, row 4 + 3 of the pair block.
    expect(exactTile(set, [GRASS, GRASS, PATH, PATH])).toBe(7 * 8 + 0)
    expect(exactTile(set, [GRASS, GRASS, DIRT, DIRT])).toBeNull()
    expect(exactTile(set, [GRASS, PATH, DIRT, GRASS])).toBeNull()
    // A slot is part of the tag, so a corner asking for grass's convex seam is not the corner asking for its surface.
    expect(exactTile(set, [GRASS, GRASS, tagOf(0, 'convex'), tagOf(0, 'convex')])).toBeNull()
  })

  it("finds a material's edge set, and knows which pairs are authored", () => {
    const set = groundSet()
    expect(edgeCoverage(set, GRASS)).toBe(16)
    expect(edgeCoverage(set, DIRT)).toBe(16)
    expect(edgeTile(set, PATH, 1)).toBe(4 + 1)
    expect(pairAuthored(set, GRASS, PATH)).toBe(true)
    expect(pairAuthored(set, PATH, GRASS)).toBe(true)
    expect(pairAuthored(set, GRASS, DIRT)).toBe(false)
  })

  it('tags one corner at a time, and forgets a tile tagged nothing everywhere', () => {
    let set = groundSet()
    set = tagCorner(set, 64, 0, DIRT)
    expect(set.tiles.get(64)).toEqual([DIRT, null, null, null])
    set = tagCorner(set, 64, 0, null)
    expect(set.tiles.has(64)).toBe(false)
  })

  it('round-trips through the shape the project file holds, and drops a tag past the edge by index', () => {
    const set = groundSet()
    const terrain = terrainOf(set)
    expect(Object.keys(terrain.tiles).map(Number)).toEqual([...set.tiles.keys()].sort((a, b) => a - b))
    const back = terrainSetFrom('ground.png', T, 8, 9, terrain)
    expect(back.dropped).toEqual([])
    // A set is its tags plus the sheet it was read against; the file holds the tags, the reader supplies the rest.
    expect(back.set).toMatchObject({ sheet: 'ground.png', tile: T, columns: 8, rows: 9 })
    expect([...back.set.tiles.entries()]).toEqual([...set.tiles.entries()].sort((a, b) => a[0] - b[0]))
    // The same tags over an image that lost its last row: the row's tiles are dropped and named, the rest stand.
    const shorter = terrainSetFrom('ground.png', T, 8, 7, terrain)
    expect(shorter.dropped).toEqual([56, 57, 58, 59, 60, 61, 62, 63])
    expect(shorter.set.tiles.size).toBe(set.tiles.size - 8)
  })

  it('finds the corner under a point on the sheet, and nothing off it', () => {
    const set = groundSet()
    // Tile 9 is column 1, row 1: its pixels run 4..8 both ways, its centre at 6,6.
    expect(cornerAt(set, 4, 4)).toEqual({ index: 9, corner: 0 })
    expect(cornerAt(set, 7.9, 4)).toEqual({ index: 9, corner: 1 })
    expect(cornerAt(set, 4, 6)).toEqual({ index: 9, corner: 2 })
    expect(cornerAt(set, 6, 6)).toEqual({ index: 9, corner: 3 })
    expect(cornerAt(set, 5.99, 5.99)).toEqual({ index: 9, corner: 0 })
    expect(cornerAt(set, -1, 4)).toBeNull()
    expect(cornerAt(set, 32, 4)).toBeNull()
    expect(cornerAt(set, 4, 36)).toBeNull()
    expect(cornerAt(set, Number.NaN, 4)).toBeNull()
  })

  it('removes a material with every corner it tagged, whatever slot the tag named', () => {
    let set = groundSet()
    set = tagCorner(set, 64, 0, DIRT)
    set = tagCorner(set, 64, 1, GRASS)
    // A slot on the tag is dirt all the same, so deleting dirt takes this corner too.
    set = tagCorner(set, 65, 0, tagOf(2, 'convex'))
    set = removeMaterial(set, 2)
    expect(set.tiles.get(64)).toEqual([null, GRASS, null, null])
    expect(set.tiles.has(65)).toBe(false)
    // Dirt's edge set was sixteen tiles tagged dirt or nothing: every one that carried dirt is gone; the block's all-nothing tile never did, and stays.
    expect([...set.tiles.keys()].filter((i) => i % 8 >= 4 && i >= 32)).toEqual([36])
    expect(edgeCoverage(set, GRASS)).toBe(16)
    // A material the set never tagged leaves it exactly as it was: deleting is about the art, and there is none of it here.
    expect([...removeMaterial(set, 2).tiles.entries()]).toEqual([...set.tiles.entries()])
  })

  it('refuses a template block that leaves the sheet', () => {
    expect(() => stampTemplate(createTerrainSet('x.png', T, 6, 6), 3, 0, null, GRASS)).toThrow(TerrainSetError)
  })
})

describe('an image grid', () => {
  it('counts whole tiles with margin and spacing, and what is left over', () => {
    expect(gridCells(64, 32, { tile: 16, margin: { x: 0, y: 0 }, spacing: { x: 0, y: 0 } })).toEqual({ columns: 4, rows: 2, ignored: { x: 0, y: 0 } })
    expect(gridCells(70, 40, { tile: 16, margin: { x: 0, y: 0 }, spacing: { x: 0, y: 0 } })).toEqual({ columns: 4, rows: 2, ignored: { x: 6, y: 8 } })
    // 1 px margin, 2 px gutters: 1 + 16 + 2 + 16 + 2 + 16 = 53 across, three tiles exactly.
    expect(gridCells(53, 17, { tile: 16, margin: { x: 1, y: 1 }, spacing: { x: 2, y: 0 } })).toEqual({ columns: 3, rows: 1, ignored: { x: 0, y: 0 } })
    expect(gridCells(10, 10, { tile: 16, margin: { x: 0, y: 0 }, spacing: { x: 0, y: 0 } })).toEqual({ columns: 0, rows: 0, ignored: { x: 10, y: 10 } })
  })

  it('offers the tile sizes that fit exactly among those that divide the density, largest first', () => {
    const plain = { margin: { x: 0, y: 0 }, spacing: { x: 0, y: 0 } }
    expect(fitsOf(592, 960, plain, 48)).toEqual([16, 8, 4, 2])
    expect(fitsOf(1536, 768, plain, 48)).toEqual([48, 24, 16, 12, 8, 6, 4, 3, 2])
    expect(fitsOf(53, 17, { margin: { x: 1, y: 1 }, spacing: { x: 2, y: 0 } }, 48)).toEqual([16, 4])
    expect(fitsOf(7, 7, plain, 48)).toEqual([])
  })

  it('cuts tiles out along the grid and scales each by a whole number, nearest neighbour', () => {
    // A 2×1-tile image of 2 px tiles with a 1 px margin and gutter: |m|aa|g|bb| → 6 px wide, 3 tall.
    const width = 6
    const height = 3
    const data = new Uint8ClampedArray(width * height * 4)
    const put = (x: number, y: number, v: number): void => {
      const i = (y * width + x) * 4
      data[i] = v
      data[i + 3] = 255
    }
    for (let y = 1; y < 3; y++) for (let x = 1; x < 3; x++) put(x, y, 10)
    for (let y = 1; y < 3; y++) for (let x = 4; x < 6; x++) put(x, y, 20)
    const cut = cutGrid({ width, height, data }, { tile: 2, margin: { x: 1, y: 1 }, spacing: { x: 1, y: 0 } }, 2)
    expect([cut.columns, cut.rows, cut.image.width, cut.image.height]).toEqual([2, 1, 8, 4])
    const at = (x: number, y: number): number => cut.image.data[(y * cut.image.width + x) * 4]
    expect([at(0, 0), at(3, 3), at(4, 0), at(7, 3)]).toEqual([10, 10, 20, 20])
    expect(() => cutGrid({ width, height, data }, { tile: 2, margin: { x: 0, y: 0 }, spacing: { x: 0, y: 0 } }, 1.5)).toThrow(/whole number/)
  })
})

describe('tags follow their pixels when the grid changes', () => {
  const plain = (tile: number, margin = 0, spacing = 0) => ({ tile, margin: { x: margin, y: margin }, spacing: { x: spacing, y: spacing } })
  const terrain = (tiles: Record<string, [Tag, Tag, Tag, Tag]>) => ({ tiles })
  const G = tagOf(0)

  it('moves every tag exactly when only the margin changes, because every tile shifts alike', () => {
    // 4 x 2 tiles of 16 px in a 64 x 32 image; with a 4 px margin only 3 x 1 fit.
    const before = terrain({ 0: [G, null, null, null], 5: [null, G, null, null] })
    const after = remapTags(before, plain(16), plain(16, 4), 64, 32)
    // Tile 0 began at 0,0; with a 4 px margin no tile begins there, so it is dropped.
    // Tile 5 began at 16,16 — the new grid's tile 0 begins at 4,4, so nothing lands there either.
    expect(after.moved + after.dropped).toBe(2)
  })

  it('moves a tag to the tile that starts on the same pixel, and drops one that lands nowhere', () => {
    // A 1 px gutter appearing: 16 px tiles at margin 0 spacing 1 in a 50 x 33 image.
    // Old grid (no gutter) is 3 x 2; tile 1 begins at 16,0. New grid: tile 1 begins at 17,0 — nothing at 16,0.
    const before = terrain({ 0: [G, G, G, G], 1: [G, null, null, null] })
    const after = remapTags(before, plain(16), plain(16, 0, 1), 50, 33)
    // Tile 0 begins at 0,0 on both grids, so it survives; tile 1 does not.
    expect(after.terrain.tiles['0']).toEqual([G, G, G, G])
    expect(after.moved).toBe(1)
    expect(after.dropped).toBe(1)
  })

  it('carries a tag across a spacing change that keeps its pixel, and answers with tags and nothing else', () => {
    // Removing a 2 px gutter: old tile 1 began at 18,0; new grid has no tile there, old tile 0 stays at 0,0.
    const before = terrain({ 0: [G, null, null, null], 1: [null, G, null, null] })
    const after = remapTags(before, plain(16, 0, 2), plain(16), 50, 16)
    // An image's terrain is its tags and nothing else now that a tag names a material, so there is
    // no image-local list to carry across beside them.
    expect(Object.keys(after.terrain)).toEqual(['tiles'])
    expect(after.terrain.tiles['0']).toEqual([G, null, null, null])
    expect(after.moved).toBe(1)
  })

  it('drops everything when the new grid holds no tile at all', () => {
    const before = terrain({ 0: [G, G, G, G] })
    const after = remapTags(before, plain(16), plain(64), 32, 32)
    expect(after.terrain.tiles).toEqual({})
    expect(after.dropped).toBe(1)
  })

  it('drops a tag whose index the old grid never had', () => {
    const before = terrain({ 999: [G, null, null, null] })
    const after = remapTags(before, plain(16), plain(16), 64, 32)
    expect(after.dropped).toBe(1)
    expect(after.moved).toBe(0)
  })
})

describe('the runtime atlas', () => {
  const priority = (key: Tag) => [GRASS, DIRT, PATH].indexOf(key)
  /** What a composite's report calls a material, which the look reads off the material library. */
  const NAMES = new Map<Tag, string>([[GRASS, 'grass'], [PATH, 'path'], [DIRT, 'dirt']])
  const nameOf = (key: Tag): string => NAMES.get(key) ?? String(key)
  // A corner tagged nothing is transparent, as an artist's edge set would be; everything else is opaque.
  const image = () => {
    const set = groundSet()
    return sheetImage(8, 9, (index, x, y) => {
      const tags = set.tiles.get(index)
      if (!tags) return 255
      return tags[(y >= T / 2 ? 2 : 0) + (x >= T / 2 ? 1 : 0)] === null ? 0 : 255
    })
  }

  it('holds every tagged tile from the start and answers an authored corner without growing', () => {
    const atlas = new TerrainAtlas([{ set: groundSet(), image: image() }], priority)
    const before = atlas.version
    const corner: CornerKeys = [GRASS, GRASS, PATH, PATH]
    const { tile, composite } = atlas.tileFor(corner)
    expect(composite).toBe(false)
    expect(atlas.version).toBe(before)
    // The atlas tile carries the sheet tile's pixels: its red channel is the sheet index.
    const [u0, , , v1] = atlas.uv(tile, -1)
    const px = Math.round(u0 * atlas.image.width)
    const py = Math.round((1 - v1) * atlas.image.height)
    expect(atlas.image.data[(py * atlas.image.width + px) * 4]).toBe(7 * 8 + 0)
  })

  it('takes an authored tile whichever sheet it was drawn on', () => {
    // A tag names a material of the project (ruling of 2026-09-17), so nothing about a corner is local
    // to an image any more. Grass's own art is on one sheet and the grass·path pair on another, which
    // is what an artist keeping a kit per sheet ends up with, and the atlas takes each from where it is.
    let edges = createTerrainSet('edges.png', T, 4, 4)
    edges = stampTemplate(edges, 0, 0, null, GRASS)
    let pair = createTerrainSet('pair.png', T, 4, 4)
    pair = stampTemplate(pair, 0, 0, GRASS, PATH)
    // The green channel says which sheet a pixel came from; the red one, as everywhere here, its tile index.
    const marked = (green: number): RgbaImage => {
      const sheet = sheetImage(4, 4)
      for (let i = 1; i < sheet.data.length; i += 4) sheet.data[i] = green
      return sheet
    }
    const atlas = new TerrainAtlas([{ set: edges, image: marked(10) }, { set: pair, image: marked(20) }], priority)
    const sourceOf = (tile: number): [number, number] => {
      const [u0, , , v1] = atlas.uv(tile, -1)
      const px = Math.round(u0 * atlas.image.width)
      const py = Math.round((1 - v1) * atlas.image.height)
      const at = (py * atlas.image.width + px) * 4
      return [atlas.image.data[at], atlas.image.data[at + 1]]
    }
    const half = atlas.tileFor([GRASS, GRASS, PATH, PATH])
    expect(half.composite).toBe(false)
    // Path over the bottom half is mask 12, tile 12 of the pair sheet.
    expect(sourceOf(half.tile)).toEqual([12, 20])
    const corner = atlas.tileFor([GRASS, null, null, null])
    expect(corner.composite).toBe(false)
    // Grass at the NW only is mask 1, tile 1 of the edge sheet.
    expect(sourceOf(corner.tile)).toEqual([1, 10])
  })

  it('bakes a composite for a pair nobody drew, from edge sets in priority order, once', () => {
    const atlas = new TerrainAtlas([{ set: groundSet(), image: image() }], priority, () => null, nameOf)
    const corner: CornerKeys = [GRASS, GRASS, DIRT, DIRT]
    const first = atlas.tileFor(corner)
    const again = atlas.tileFor(corner)
    expect(first.composite).toBe(true)
    expect(again).toBe(first)
    expect(atlas.compositeReport()).toEqual([{ combo: 'grass · dirt', tile: first.tile }])
    // Grass is lowest: its full edge tile (mask 15, sheet index 27) goes under. Dirt's edge tile for SW + SE
    // (mask 12, sheet index 60) goes over it, opaque in the bottom half only.
    const width = atlas.image.width
    const columns = width / T
    const dx = (first.tile % columns) * T
    const dy = Math.floor(first.tile / columns) * T
    const at = (x: number, y: number) => atlas.image.data.subarray(((dy + y) * width + dx + x) * 4, ((dy + y) * width + dx + x) * 4 + 4)
    expect([at(0, 0)[0], at(0, 0)[3]]).toEqual([27, 255])
    expect([at(0, T - 1)[0], at(0, T - 1)[3]]).toEqual([60, 255])
  })

  it('names a corner that meets nothing with "edge", and keeps every UV where it was as it fills', () => {
    const atlas = new TerrainAtlas([{ set: groundSet(), image: image() }], priority, () => null, nameOf)
    const authored = atlas.tileFor([GRASS, GRASS, PATH, PATH]).tile
    const uvBefore = atlas.uv(authored, 0)
    const { height, data } = atlas.image
    const used = atlas.used
    for (let i = 0; i < 40; i++) atlas.tileFor([GRASS, i % 2 ? PATH : DIRT, DIRT, null])
    // Two combinations composited: the image is the same buffer at the same size, so nothing meshed before moved.
    expect(atlas.used).toBe(used + 2)
    expect(atlas.image.height).toBe(height)
    expect(atlas.image.data).toBe(data)
    expect(atlas.uv(authored, 0)).toEqual(uvBefore)
    expect(atlas.tileFor([GRASS, GRASS, PATH, PATH]).tile).toBe(authored)
    expect(atlas.compositeReport().map((c) => c.combo)).toContain('grass · dirt · edge')
    expect(atlas.compositeReport().map((c) => c.combo)).toContain('grass · dirt · path · edge')
  })

  it('quadrant UVs tile the whole rect and sit inside it by half a texel', () => {
    const atlas = new TerrainAtlas([{ set: groundSet(), image: image() }], priority)
    const whole = atlas.uv(5, -1)
    const nw = atlas.uv(5, 0)
    const se = atlas.uv(5, 3)
    expect(nw[0]).toBeCloseTo(whole[0])
    expect(nw[3]).toBeCloseTo(whole[3])
    expect(se[2]).toBeCloseTo(whole[2])
    expect(se[1]).toBeCloseTo(whole[1])
    expect(nw[2]).toBeLessThan(se[0] + 1e-6)
  })
})
