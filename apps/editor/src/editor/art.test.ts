import { describe, expect, it } from 'vitest'

import { createTerrainSet, type LoadedSet } from '@papercut/geometry'

import { drawableTerrain } from './art'

const set = (sheet: string, tile = 16): LoadedSet => ({ set: createTerrainSet(sheet, tile, 1, 1), image: { width: tile, height: tile, data: new Uint8ClampedArray(tile * tile * 4) } })

describe('what the terrain draws with', () => {
  const generated = [set('ground.png')]

  it('lets the placeholder stand in only for a project that lists it', () => {
    const loaded = [set('Outside_A2.png')]
    // A project that lists the placeholder sheet but has not supplied it draws the generated one first.
    expect(drawableTerrain(generated, loaded, 16, true).map((s) => s.set.sheet)).toEqual(['ground.png', 'Outside_A2.png'])
    // One that does not list it has materials of its own under the placeholder's ids: the placeholder stays out.
    expect(drawableTerrain(generated, loaded, 16, false).map((s) => s.set.sheet)).toEqual(['Outside_A2.png'])
  })

  it('takes the project’s own placeholder sheet over the generated one, and drops sheets at another tile size', () => {
    expect(drawableTerrain(generated, [set('ground.png'), set('big.png', 48)], 16, true).map((s) => s.set.sheet)).toEqual(['ground.png'])
    expect(drawableTerrain(generated, [], 16, false)).toEqual([])
  })
})
