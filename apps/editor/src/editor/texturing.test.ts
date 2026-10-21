import { describe, expect, it } from 'vitest'

import { DEFAULT_MATERIALS, tagOf } from '@papercut/document'
import { conventionOf, type CornerKeys } from '@papercut/geometry'

import { cellOfArrangement, templateFor } from './texturing'

// DEFAULT_MATERIALS by id: 0 Grass, 1 Dirt, 2 Stone, 3 Sand, 4 Path.
const [GRASS, DIRT, PATH] = [tagOf(0), tagOf(1), tagOf(4)]
const keys = (...tags: (string | null)[]): CornerKeys => tags as unknown as CornerKeys

describe('the template block a missing corner needs (the face inspector, 2026-10-21)', () => {
  it('names the triple block for two materials and the edge, nothing first, then by priority, and finds the corner in it', () => {
    const arrangement = keys(null, DIRT, PATH, DIRT)
    const template = templateFor(arrangement, DEFAULT_MATERIALS)
    if (template === null || template === 'four') throw new Error('expected a block')
    expect(template.values).toEqual([null, 1, 4])
    expect(template.columns).toBe(6)
    const cell = cellOfArrangement(template, arrangement)
    // The cell's corners, read back through the layout, are the arrangement asked for.
    const shape = conventionOf('corner-blocks')?.blockShape(3)
    expect(shape?.cells[cell].corners.map((v) => template.values[v])).toEqual([null, 1, 4, 1])
  })

  it('names the pair block for one material against the edge, and for two materials meeting', () => {
    expect(templateFor(keys(null, null, GRASS, GRASS), DEFAULT_MATERIALS)).toMatchObject({ values: [null, 0], columns: 5 })
    expect(templateFor(keys(DIRT, GRASS, GRASS, GRASS), DEFAULT_MATERIALS)).toMatchObject({ values: [0, 1] })
  })

  it('has no block for four things at one corner, which the layout does not draw', () => {
    expect(templateFor(keys(null, GRASS, DIRT, PATH), DEFAULT_MATERIALS)).toBe('four')
  })

  it('has none for corners naming different slots', () => {
    expect(templateFor(keys(tagOf(0, 'convex'), GRASS, null, null), DEFAULT_MATERIALS)).toBeNull()
  })
})
