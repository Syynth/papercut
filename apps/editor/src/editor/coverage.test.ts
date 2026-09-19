import { describe, expect, it } from 'vitest'

import { tagOf, type Tag } from '@papercut/document'
import { CORNER_BLOCKS, templateTags, type CornerTags, type LoadedSet } from '@papercut/geometry'

import { coverageOf, cropOf, facesOf, pairingFace } from './coverage'

const T = 4

function sheet(name: string, columns: number, rows: number, tiles: ReadonlyArray<readonly [number, CornerTags]>): LoadedSet {
  return { set: { sheet: name, tile: T, columns, rows, tiles: new Map(tiles) }, image: { width: columns * T, height: rows * T, data: new Uint8ClampedArray(columns * rows * T * T * 4) } }
}

/** A pair block of the corner-blocks convention at (column, row), without the masks in `skip`. */
function pairBlock(columns: number, column: number, row: number, under: Tag, over: Tag, skip: readonly number[] = []): Array<readonly [number, CornerTags]> {
  const out: Array<readonly [number, CornerTags]> = []
  for (const cell of CORNER_BLOCKS.blockShape(2)?.cells ?? []) {
    const mask = cell.corners.reduce((m, v, k) => (v === 1 ? m | (1 << k) : m), 0)
    if (skip.includes(mask) || (under !== null && mask === 15) || mask === 0) continue
    out.push([(row + cell.row) * columns + column + cell.column, templateTags(mask, under, over)])
  }
  return out
}

describe('coverage', () => {
  it('counts fifteen arrangements for a material alone and fourteen for a pairing', () => {
    const sets = [sheet('a.png', 12, 8, [...pairBlock(12, 0, 0, null, tagOf(0)), ...pairBlock(12, 5, 0, tagOf(0), tagOf(1))])]
    expect(coverageOf(sets, { material: 0, other: null }, null)).toMatchObject({ drawn: 15 })
    const pairing = coverageOf(sets, { material: 1, other: 0 }, null)
    expect(pairing.masks).toHaveLength(14)
    expect(pairing.drawn).toBe(14)
  })

  it('answers a face with its own art before art for any, and gives wall art to nothing but walls', () => {
    const wall = tagOf(0, null, 'wall')
    const sets = [sheet('a.png', 12, 8, [...pairBlock(12, 0, 0, null, tagOf(0), [1]), [90, templateTags(1, null, wall)]])]
    // Mask 1 exists only as wall art: a wall has all fifteen, a floor fourteen, and the list counts it as drawn.
    expect(coverageOf(sets, { material: 0, other: null }, 'wall').drawn).toBe(15)
    expect(coverageOf(sets, { material: 0, other: null }, 'floor').drawn).toBe(14)
    expect(coverageOf(sets, { material: 0, other: null }, null).drawn).toBe(15)
  })

  it("reads the faces a material has art for off the tags", () => {
    const sets = [sheet('a.png', 12, 8, [[0, templateTags(15, null, tagOf(0))], [1, templateTags(15, null, tagOf(1, null, 'wall'))]])]
    expect(facesOf(sets, 0)).toEqual({ floor: 'any', wall: 'any', ramp: 'any' })
    expect(facesOf(sets, 1)).toEqual({ floor: 'none', wall: 'own', ramp: 'none' })
    expect(facesOf(sets, 2)).toEqual({ floor: 'none', wall: 'none', ramp: 'none' })
  })

  it('names the face a pairing is drawn for when its tiles agree on one', () => {
    const rock = tagOf(1, null, 'wall')
    const grass = tagOf(0, null, 'wall')
    const sets = [sheet('a.png', 12, 8, pairBlock(12, 0, 0, grass, rock))]
    expect(pairingFace(coverageOf(sets, { material: 1, other: 0 }, 'wall'))).toBe('wall')
    expect(pairingFace(coverageOf([sheet('b.png', 12, 8, pairBlock(12, 0, 0, tagOf(0), tagOf(1)))], { material: 1, other: 0 }, null))).toBeNull()
  })
})

describe('the crop of the sheet', () => {
  it('puts the missing arrangements where the layout says they go', () => {
    const sets = [sheet('a.png', 12, 8, pairBlock(12, 3, 2, null, tagOf(0), [6, 9]))]
    const crop = cropOf(coverageOf(sets, { material: 0, other: null }, null))
    expect(crop).toMatchObject({ column: 3, row: 2, columns: 5, rows: 3, unplaced: [] })
    expect(crop?.cells).toHaveLength(15)
    expect(crop?.cells.filter((c) => c.found === null).map((c) => c.mask).sort((a, b) => a - b)).toEqual([6, 9])
  })

  it('falls back to the rectangle that holds what is drawn when the tiles follow no layout', () => {
    const sets = [sheet('a.png', 12, 8, [[0, templateTags(3, null, tagOf(0))], [14, templateTags(12, null, tagOf(0))]])]
    const crop = cropOf(coverageOf(sets, { material: 0, other: null }, null))
    expect(crop).toMatchObject({ column: 0, row: 0, columns: 3, rows: 2 })
    expect(crop?.unplaced).toHaveLength(13)
  })

  it('is nothing when the tiles are spread over two sheets, or none is drawn', () => {
    const sets = [sheet('a.png', 12, 8, [[0, templateTags(3, null, tagOf(0))]]), sheet('b.png', 12, 8, [[0, templateTags(12, null, tagOf(0))]])]
    expect(cropOf(coverageOf(sets, { material: 0, other: null }, null))).toBeNull()
    expect(cropOf(coverageOf([], { material: 0, other: null }, null))).toBeNull()
  })
})
