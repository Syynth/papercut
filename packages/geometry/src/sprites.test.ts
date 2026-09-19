import { describe, expect, it } from 'vitest'

import { createTerrainSet, type LoadedSet } from './index'
import { projectSprites } from './sprites'

/** A 4×2-tile sheet of 2 px tiles whose red channel is each pixel's x and green its y. */
function sheet(): LoadedSet {
  const tile = 2
  const width = 4 * tile
  const height = 2 * tile
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([x, y, 0, 255], (y * width + x) * 4)
  return { set: createTerrainSet('props.png', tile, 4, 2), image: { width, height, data } }
}

describe('a project’s own sprites', () => {
  it('cuts each sprite from its image on the tile grid, footprint and all', () => {
    const { sprites, warnings } = projectSprites([{ name: 'tree', image: 'sheets/props.png', rect: { x: 1, y: 0, w: 2, h: 2 } }], [sheet()])
    expect(warnings).toEqual([])
    const tree = sprites.tree
    expect(tree).toMatchObject({ name: 'tree', widthTiles: 2, heightTiles: 2, emissive: false })
    expect([tree.facings[0].width, tree.facings[0].height]).toEqual([4, 4])
    // Its top-left pixel is the sheet's pixel at tile (1, 0).
    expect([...tree.facings[0].data.subarray(0, 2)]).toEqual([2, 0])
  })

  it('skips and reports a sprite whose image did not load, or whose rectangle leaves it', () => {
    const { sprites, warnings } = projectSprites(
      [
        { name: 'gone', image: 'sheets/missing.png', rect: { x: 0, y: 0, w: 1, h: 1 } },
        { name: 'wide', image: 'sheets/props.png', rect: { x: 3, y: 0, w: 2, h: 1 } },
      ],
      [sheet()],
    )
    expect(sprites).toEqual({})
    expect(warnings).toHaveLength(2)
  })
})
