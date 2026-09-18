import { describe, expect, it } from 'vitest'

import { tagOf, type Tag } from '@papercut/document'
import { TerrainAtlas, edgeCoverage, exactTile, pairAuthored, terrainOf, terrainSetFrom } from '@papercut/geometry'

import { PLACEHOLDER_PAIRS, PLACEHOLDER_TERRAINS, generatePlaceholderTerrainSet } from './terrainset'

/** The placeholder's art is tagged with material ids, which are `DEFAULT_MATERIALS`: 0 Grass, 1 Dirt, 2 Stone, 3 Sand, 4 Path. */
const GRASS = tagOf(0)
const DIRT = tagOf(1)
const STONE = tagOf(2)
const SAND = tagOf(3)
const PATH = tagOf(4)

describe('the placeholder terrain set', () => {
  const { set, image } = generatePlaceholderTerrainSet()

  it('draws an edge set per material and a block per pair, sixteen tiles across', () => {
    const blocks = PLACEHOLDER_TERRAINS.length + PLACEHOLDER_PAIRS.length
    expect(set.columns).toBe(16)
    expect(set.rows).toBe(Math.ceil(blocks / 4) * 4)
    expect(image.width).toBe(set.columns * set.tile)
    expect(image.height).toBe(set.rows * set.tile)
    expect(set.tiles.size).toBe(blocks * 16)
    for (const t of PLACEHOLDER_TERRAINS) expect(edgeCoverage(set, tagOf(t.id))).toBe(16)
    for (const [a, b] of PLACEHOLDER_PAIRS) expect(pairAuthored(set, tagOf(a), tagOf(b))).toBe(true)
    // Every pair of the sample's five materials is authored; what is left to compose is a corner of three or more.
    expect(exactTile(set, [STONE, GRASS, SAND, GRASS])).toBeNull()
  })

  it('leaves an edge set transparent where it meets nothing, and fills a pair tile completely', () => {
    const at = (index: number, x: number, y: number) => {
      const px = (index % set.columns) * set.tile + x
      const py = Math.floor(index / set.columns) * set.tile + y
      return image.data[(py * image.width + px) * 4 + 3]
    }
    const grassOnly = exactTile(set, [GRASS, null, null, null]) as number
    expect(at(grassOnly, 1, 1)).toBe(255)
    expect(at(grassOnly, set.tile - 1, set.tile - 1)).toBe(0)
    const half = exactTile(set, [GRASS, GRASS, PATH, PATH]) as number
    for (const [x, y] of [[0, 0], [set.tile - 1, 0], [0, set.tile - 1], [set.tile - 1, set.tile - 1]]) expect(at(half, x, y)).toBe(255)
  })

  it('bleeds grass over the seam into a shared tile, by the pixels it declares', () => {
    // In the dirt·grass block, the tile with grass on top only: the seam is at half height, and grass runs 3 px past it.
    const tile = exactTile(set, [GRASS, GRASS, DIRT, DIRT]) as number
    const px = (tile % set.columns) * set.tile + Math.floor(set.tile / 2)
    const py0 = Math.floor(tile / set.columns) * set.tile
    const grass = PLACEHOLDER_TERRAINS.find((t) => tagOf(t.id) === GRASS)
    const dirt = PLACEHOLDER_TERRAINS.find((t) => tagOf(t.id) === DIRT)
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
    const of = (key: Tag) => PLACEHOLDER_TERRAINS.find((t) => tagOf(t.id) === key)
    const atlas = new TerrainAtlas([{ set: back, image }], (key) => PLACEHOLDER_TERRAINS.findIndex((t) => tagOf(t.id) === key), () => null, (key) => of(key)?.name ?? String(key))
    expect(atlas.tileFor([GRASS, GRASS, PATH, PATH]).composite).toBe(false)
    expect(atlas.tileFor([STONE, GRASS, SAND, GRASS]).composite).toBe(true)
    expect(atlas.compositeReport().map((c) => c.combo)).toEqual(['Stone · Sand · Grass'])
  })
})
