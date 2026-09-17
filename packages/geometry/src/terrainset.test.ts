import { describe, expect, it } from 'vitest'

import type { RgbaImage } from '@papercut/document'

import { TerrainAtlas, terrainKey, type CornerKeys } from './atlas'
import { TerrainSetError, addTerrain, cornerAt, createTerrainSet, edgeCoverage, edgeTile, exactTile, pairAuthored, parseTerrainSet, removeTerrain, serializeTerrainSet, stampTemplate, tagCorner, templateTags } from './terrainset'

const T = 4

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
  set = addTerrain(set, { id: 'grass', name: 'Grass', color: '#4f8a46' })
  set = addTerrain(set, { id: 'path', name: 'Path', color: '#b08f5e' })
  set = addTerrain(set, { id: 'dirt', name: 'Dirt', color: '#8a6a45' })
  set = stampTemplate(set, 0, 0, null, 'grass') // grass edge set
  set = stampTemplate(set, 4, 0, null, 'path') // path edge set
  set = stampTemplate(set, 0, 4, 'grass', 'path') // the authored pair
  set = stampTemplate(set, 4, 4, null, 'dirt') // dirt edge set
  return set
}

describe('terrain sets', () => {
  it('tags a template block by position, over at the set corners and under elsewhere', () => {
    const set = groundSet()
    // mask 3 = NW + NE: the top half is path, the bottom half grass, at column 3 of the pair block's first row.
    expect(set.tiles.get(4 * 8 + 3)).toEqual(['path', 'path', 'grass', 'grass'])
    expect(templateTags(0, 'grass', 'path')).toEqual(['grass', 'grass', 'grass', 'grass'])
    expect(templateTags(15, null, 'grass')).toEqual(['grass', 'grass', 'grass', 'grass'])
  })

  it('answers the exact tile for a corner, and nothing for a combination nobody tagged', () => {
    const set = groundSet()
    // mask 12 = SW + SE, at column 0, row 4 + 3 of the pair block.
    expect(exactTile(set, ['grass', 'grass', 'path', 'path'])).toBe(7 * 8 + 0)
    expect(exactTile(set, ['grass', 'grass', 'dirt', 'dirt'])).toBeNull()
    expect(exactTile(set, ['grass', 'path', 'dirt', 'grass'])).toBeNull()
  })

  it('finds a terrain\'s edge set, and knows which pairs are authored', () => {
    const set = groundSet()
    expect(edgeCoverage(set, 'grass')).toBe(16)
    expect(edgeCoverage(set, 'dirt')).toBe(16)
    expect(edgeTile(set, 'path', 1)).toBe(4 + 1)
    expect(pairAuthored(set, 'grass', 'path')).toBe(true)
    expect(pairAuthored(set, 'path', 'grass')).toBe(true)
    expect(pairAuthored(set, 'grass', 'dirt')).toBe(false)
  })

  it('tags one corner at a time, and forgets a tile tagged nothing everywhere', () => {
    let set = groundSet()
    set = tagCorner(set, 64, 0, 'dirt')
    expect(set.tiles.get(64)).toEqual(['dirt', null, null, null])
    set = tagCorner(set, 64, 0, null)
    expect(set.tiles.has(64)).toBe(false)
  })

  it('round-trips through the sidecar, and refuses a sidecar that lies', () => {
    const set = groundSet()
    const back = parseTerrainSet(JSON.parse(serializeTerrainSet(set)))
    expect(back.terrains).toEqual(set.terrains)
    expect([...back.tiles.entries()]).toEqual([...set.tiles.entries()].sort((a, b) => a[0] - b[0]))
    expect(() => parseTerrainSet({ version: 2 })).toThrow(TerrainSetError)
    expect(() => parseTerrainSet({ version: 1, sheet: 'x.png', tile: 4, columns: 2, rows: 2, terrains: [], tiles: { 9: [null, null, null, null] } })).toThrow(/not on a 2×2 sheet/)
    expect(() => parseTerrainSet({ version: 1, sheet: 'x.png', tile: 4, columns: 2, rows: 2, terrains: [], tiles: { 0: ['grass', null, null, null] } })).toThrow(/does not have/)
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

  it('removes a terrain with every corner it tagged, and refuses one it never had', () => {
    let set = groundSet()
    set = tagCorner(set, 64, 0, 'dirt')
    set = tagCorner(set, 64, 1, 'grass')
    set = removeTerrain(set, 'dirt')
    expect(set.terrains.map((t) => t.id)).toEqual(['grass', 'path'])
    expect(set.tiles.get(64)).toEqual([null, 'grass', null, null])
    // Dirt's edge set was sixteen tiles tagged dirt or nothing: every one that carried dirt is gone; the block's all-nothing tile never did, and stays.
    expect([...set.tiles.keys()].filter((i) => i % 8 >= 4 && i >= 32)).toEqual([36])
    expect(edgeCoverage(set, 'grass')).toBe(16)
    expect(() => removeTerrain(set, 'dirt')).toThrow(TerrainSetError)
  })

  it('refuses a template block that leaves the sheet', () => {
    expect(() => stampTemplate(createTerrainSet('x.png', T, 6, 6), 3, 0, null, 'grass')).toThrow(TerrainSetError)
  })
})

describe('the runtime atlas', () => {
  const grass = terrainKey('ground.png', 'grass')
  const path = terrainKey('ground.png', 'path')
  const dirt = terrainKey('ground.png', 'dirt')
  const priority = (key: string) => [grass, dirt, path].indexOf(key)
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
    const corner: CornerKeys = [grass, grass, path, path]
    const { tile, composite } = atlas.tileFor(corner)
    expect(composite).toBe(false)
    expect(atlas.version).toBe(before)
    // The atlas tile carries the sheet tile's pixels: its red channel is the sheet index.
    const [u0, , , v1] = atlas.uv(tile, -1)
    const px = Math.round(u0 * atlas.image.width)
    const py = Math.round((1 - v1) * atlas.image.height)
    expect(atlas.image.data[(py * atlas.image.width + px) * 4]).toBe(7 * 8 + 0)
  })

  it('bakes a composite for a pair nobody drew, from edge sets in priority order, once', () => {
    const atlas = new TerrainAtlas([{ set: groundSet(), image: image() }], priority)
    const corner: CornerKeys = [grass, grass, dirt, dirt]
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
    const atlas = new TerrainAtlas([{ set: groundSet(), image: image() }], priority)
    const authored = atlas.tileFor([grass, grass, path, path]).tile
    const uvBefore = atlas.uv(authored, 0)
    const { height, data } = atlas.image
    const used = atlas.used
    for (let i = 0; i < 40; i++) atlas.tileFor([grass, i % 2 ? path : dirt, dirt, null])
    // Two combinations composited: the image is the same buffer at the same size, so nothing meshed before moved.
    expect(atlas.used).toBe(used + 2)
    expect(atlas.image.height).toBe(height)
    expect(atlas.image.data).toBe(data)
    expect(atlas.uv(authored, 0)).toEqual(uvBefore)
    expect(atlas.tileFor([grass, grass, path, path]).tile).toBe(authored)
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
