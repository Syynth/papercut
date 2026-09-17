import { describe, expect, it } from 'vitest'

import { TerrainAtlas, edgeCoverage, exactTile, pairAuthored, terrainOf, terrainSetFrom, terrainKey } from '@papercut/geometry'

import { PLACEHOLDER_PAIRS, PLACEHOLDER_TERRAINS, generatePlaceholderTerrainSet } from './terrainset'

describe('the placeholder terrain set', () => {
  const { set, image } = generatePlaceholderTerrainSet()

  it('draws an edge set per terrain and a block per pair, sixteen tiles across', () => {
    const blocks = PLACEHOLDER_TERRAINS.length + PLACEHOLDER_PAIRS.length
    expect(set.columns).toBe(16)
    expect(set.rows).toBe(Math.ceil(blocks / 4) * 4)
    expect(image.width).toBe(set.columns * set.tile)
    expect(image.height).toBe(set.rows * set.tile)
    expect(set.tiles.size).toBe(blocks * 16)
    for (const t of PLACEHOLDER_TERRAINS) expect(edgeCoverage(set, t.id)).toBe(16)
    for (const [a, b] of PLACEHOLDER_PAIRS) expect(pairAuthored(set, a, b)).toBe(true)
    // Every pair of the sample's five terrains is authored; what is left to compose is a corner of three or more.
    expect(exactTile(set, ['stone', 'grass', 'sand', 'grass'])).toBeNull()
  })

  it('leaves an edge set transparent where it meets nothing, and fills a pair tile completely', () => {
    const at = (index: number, x: number, y: number) => {
      const px = (index % set.columns) * set.tile + x
      const py = Math.floor(index / set.columns) * set.tile + y
      return image.data[(py * image.width + px) * 4 + 3]
    }
    const grassOnly = exactTile(set, ['grass', null, null, null]) as number
    expect(at(grassOnly, 1, 1)).toBe(255)
    expect(at(grassOnly, set.tile - 1, set.tile - 1)).toBe(0)
    const half = exactTile(set, ['grass', 'grass', 'path', 'path']) as number
    for (const [x, y] of [[0, 0], [set.tile - 1, 0], [0, set.tile - 1], [set.tile - 1, set.tile - 1]]) expect(at(half, x, y)).toBe(255)
  })

  it('bleeds grass over the seam into a shared tile, by the pixels it declares', () => {
    // In the dirt·grass block, the tile with grass on top only: the seam is at half height, and grass runs 3 px past it.
    const tile = exactTile(set, ['grass', 'grass', 'dirt', 'dirt']) as number
    const px = (tile % set.columns) * set.tile + Math.floor(set.tile / 2)
    const py0 = Math.floor(tile / set.columns) * set.tile
    const grass = PLACEHOLDER_TERRAINS.find((t) => t.id === 'grass')
    const dirt = PLACEHOLDER_TERRAINS.find((t) => t.id === 'dirt')
    const red = (y: number) => image.data[((py0 + y) * image.width + px) * 4]
    const grassRed = (grass?.color as number) >> 16
    const dirtRed = (dirt?.color as number) >> 16
    // Just below the seam is still grass-ish (fill or its darker rim), well below it is dirt.
    expect(Math.abs(red(set.tile / 2 + 1) - grassRed)).toBeLessThan(Math.abs(red(set.tile / 2 + 1) - dirtRed))
    expect(Math.abs(red(set.tile - 1) - dirtRed)).toBeLessThan(Math.abs(red(set.tile - 1) - grassRed))
  })

  it('round-trips through the shape the project file holds and feeds the atlas as-is', () => {
    const { set: back, dropped } = terrainSetFrom(set.sheet, set.tile, set.columns, set.rows, terrainOf(set))
    expect(dropped).toEqual([])
    expect(back.tiles.size).toBe(set.tiles.size)
    const atlas = new TerrainAtlas([{ set: back, image }], (key) => PLACEHOLDER_TERRAINS.findIndex((t) => key === terrainKey('ground.png', t.id)))
    expect(atlas.tileFor([terrainKey('ground.png', 'grass'), terrainKey('ground.png', 'grass'), terrainKey('ground.png', 'path'), terrainKey('ground.png', 'path')]).composite).toBe(false)
    expect(atlas.tileFor([terrainKey('ground.png', 'stone'), terrainKey('ground.png', 'grass'), terrainKey('ground.png', 'sand'), terrainKey('ground.png', 'grass')]).composite).toBe(true)
    expect(atlas.compositeReport().map((c) => c.combo)).toEqual(['stone · sand · grass'])
  })
})
