import { describe, expect, it } from 'vitest'

import { tagOf } from '@papercut/document'
import { TerrainAtlas, exactTile } from '@papercut/geometry'

import { RAIL_MATERIALS, generateRailSet } from './rails'

describe('the placeholder rail sheet', () => {
  const { set, image } = generateRailSet()
  const alpha = (index: number, x: number, y: number): number => image.data[((Math.floor(index / set.columns) * set.tile + y) * image.width + (index % set.columns) * set.tile + x) * 4 + 3]

  it('tags a rail block, a side block and the two bends for each material that has a rail', () => {
    expect(image.width).toBe(set.columns * set.tile)
    expect(image.height).toBe(set.rows * set.tile)
    for (const material of RAIL_MATERIALS) {
      const rail = tagOf(material, 'rail')
      const landing = tagOf(material, 'landing')
      const side = tagOf(material, 'side', 'ramp', 'e')
      for (const tags of [[null, null, rail, rail], [null, null, null, rail], [null, null, rail, null], [rail, rail, rail, rail], [null, rail, null, rail], [rail, null, rail, null]] as const) expect(exactTile(set, tags)).not.toBeNull()
      expect(exactTile(set, [null, null, landing, rail])).not.toBeNull()
      expect(exactTile(set, [null, null, rail, landing])).not.toBeNull()
      expect(exactTile(set, [side, side, side, side])).not.toBeNull()
    }
  })

  it('stands each cap\'s newel in the half of the tile the map draws, and leaves a banister open between its balusters', () => {
    const rail = tagOf(RAIL_MATERIALS[0], 'rail')
    const start = exactTile(set, [null, null, null, rail]) as number
    const end = exactTile(set, [null, null, rail, null]) as number
    const middle = exactTile(set, [null, null, rail, rail]) as number
    const low = set.tile - 1
    // A start cap is drawn from its right half only, an end cap from its left: nothing of either is in the other half.
    for (let y = 0; y < set.tile; y++) {
      for (let x = 0; x < set.tile / 2; x++) {
        expect(alpha(start, x, y)).toBe(0)
        expect(alpha(end, set.tile / 2 + x, y)).toBe(0)
      }
    }
    expect(alpha(start, set.tile / 2, low)).toBe(255)
    expect(alpha(end, set.tile / 2 - 1, low)).toBe(255)
    const row = Array.from({ length: set.tile }, (_, x) => alpha(middle, x, low))
    expect(row.includes(0) && row.includes(255)).toBe(true)
    // It repeats at the half tile, so any half can follow any other.
    expect(row.slice(0, set.tile / 2)).toEqual(row.slice(set.tile / 2))
  })

  it('goes into an atlas beside the ground sheet', () => {
    expect(() => new TerrainAtlas([{ set, image }])).not.toThrow()
  })
})
