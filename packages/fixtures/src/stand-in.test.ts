import { describe, expect, it } from 'vitest'

import { renderCornerBlock } from './terrainset'

const GRASS = { id: 0, name: 'Grass', color: 0x6aa84f }
const DIRT = { id: 1, name: 'Dirt', color: 0x8b6b45 }

/** The alpha of a tile's pixel at (x, y), in block pixels. */
const alphaAt = (image: { width: number; data: Uint8ClampedArray }, x: number, y: number): number => image.data[(y * image.width + x) * 4 + 3]

describe('a stand-in block, drawn in the placeholder style (the face inspector, 2026-10-21)', () => {
  it('leaves nothing where the edge is and fills what a material covers', () => {
    // One cell: grass in its north-east quadrant only, against the edge everywhere else.
    const image = renderCornerBlock([null, GRASS], [{ column: 0, row: 0, corners: [0, 1, 0, 0] }], 1, 1, 16)
    expect(image.width).toBe(16)
    expect(alphaAt(image, 13, 2)).toBe(255)
    expect(alphaAt(image, 2, 13)).toBe(0)
  })

  it('fills the whole tile with the lowest value when it is a material, and draws the next over it', () => {
    const image = renderCornerBlock([DIRT, GRASS], [{ column: 1, row: 0, corners: [1, 1, 0, 0] }], 2, 1, 8)
    expect(image.width).toBe(16)
    // The cell is the second column: every pixel of it is drawn, dirt below and grass along its top half.
    for (let y = 0; y < 8; y++) for (let x = 8; x < 16; x++) expect(alphaAt(image, x, y)).toBe(255)
    // The first column has no cell and stays empty.
    expect(alphaAt(image, 2, 2)).toBe(0)
  })
})
