import type { AsepriteFile, Layer, Tileset } from '@papercut/aseprite'
import { describe, expect, it } from 'vitest'
import { gridOf } from './index'

// Reading real files end to end is `tests/aseprite-golden.test.ts`'s job; this is the grid rule alone.

const base = (over: Partial<AsepriteFile>): AsepriteFile => ({
  width: 64,
  height: 64,
  colorMode: 'rgba',
  flags: { layerOpacity: true, groupBlending: false, layerUuids: false },
  transparentIndex: 0,
  colorCount: 0,
  pixelRatio: { width: 1, height: 1 },
  grid: null,
  speed: 100,
  layers: [],
  frames: [],
  tags: [],
  slices: [],
  tilesets: [],
  colorProfile: null,
  externalFiles: [],
  userData: null,
  warnings: [],
  ...over,
})

const tileset = (id: number, w: number, h: number): Tileset => ({ id, name: 't', tileWidth: w, tileHeight: h, tileCount: 1, baseIndex: 1, zeroIsEmpty: true, matchFlips: { x: false, y: false, diagonal: false }, external: null, pixels: null, userData: null, tileUserData: [] })

const tilemapLayer = (tilesetId: number): Layer => ({
  index: 0,
  name: 'map',
  type: 'tilemap',
  flags: { visible: true, editable: true, lockMovement: false, background: false, preferLinkedCels: false, collapsed: false, reference: false },
  childLevel: 0,
  parent: null,
  blendMode: 'normal',
  opacity: 255,
  tilesetId,
  uuid: null,
  userData: null,
})

describe('gridOf', () => {
  it('takes the sprite grid, its offset wrapped into a margin', () => {
    expect(gridOf(base({ grid: { x: -3, y: 20, width: 8, height: 8 } }))).toEqual({ grid: { tile: 8, margin: { x: 5, y: 4 }, spacing: { x: 0, y: 0 } }, from: 'grid' })
  })

  it('ignores a grid that is not square, and a file with none', () => {
    expect(gridOf(base({ grid: { x: 0, y: 0, width: 8, height: 16 } }))).toBeNull()
    expect(gridOf(base({}))).toBeNull()
  })

  it('prefers the tile size of a tileset a tilemap layer uses', () => {
    const file = base({ grid: { x: 0, y: 0, width: 16, height: 16 }, tilesets: [tileset(1, 10, 10), tileset(2, 24, 24)], layers: [tilemapLayer(2)] })
    expect(gridOf(file)).toEqual({ grid: { tile: 24, margin: { x: 0, y: 0 }, spacing: { x: 0, y: 0 } }, from: 'tileset' })
  })

  it('passes over a tileset with oblong tiles', () => {
    const file = base({ grid: { x: 0, y: 0, width: 16, height: 16 }, tilesets: [tileset(1, 8, 16)], layers: [tilemapLayer(1)] })
    expect(gridOf(file)?.from).toBe('grid')
  })
})
