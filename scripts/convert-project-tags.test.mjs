import { describe, expect, it } from 'vitest'

import { convert } from './convert-project-tags.mjs'

const project = () => ({
  formatVersion: 2,
  images: [
    {
      path: 'sheets/ground.png',
      layout: { convention: 'corner-blocks', origin: { x: 0, y: 0 }, terrains: ['grass', 'dirt'], unauthored: ['0+2'] },
      terrain: {
        terrains: [
          { id: 'grass', name: 'Grass', color: '#6aa84f' },
          { id: 'dirt', name: 'Dirt', color: '#8b6b45' },
          { id: 'moss', name: 'Blue grass', color: '#4f8a8a' },
        ],
        tiles: { 0: ['grass', 'grass', null, null], 7: ['moss', 'dirt', 'grass', null], 9: ['ghost', null, null, null] },
      },
    },
  ],
  materials: [
    { id: 0, name: 'Grass', color: 0x6aa84f, archetype: 'floor', top: { sheet: 'ground.png', terrain: 'grass' }, side: { sheet: 'ground.png', terrain: 'dirt' } },
    { id: 1, name: 'Dirt', color: 0x8b6b45, archetype: 'floor', top: { sheet: 'ground.png', terrain: 'dirt' } },
  ],
})

describe('converting a format-2 project to format 3', () => {
  it('rewrites every tag to the material that claimed its terrain', () => {
    const doc = project()
    convert(doc)

    expect(doc.formatVersion).toBe(3)
    expect(doc.images[0].terrain.tiles[0]).toEqual(['0', '0', null, null])
    // The terrain layer itself is gone; a tag is all that is left of it.
    expect(doc.images[0].terrain.terrains).toBeUndefined()
  })

  it('invents a material for a terrain no material claimed, rather than throwing its art away', () => {
    const doc = project()
    const { invented } = convert(doc)

    // Blue grass was tagged on the sheet but nothing in the library drew with it. Dropping its tags
    // would silently lose art an artist made, so it becomes a material and keeps its name and colour.
    expect(invented).toHaveLength(1)
    const moss = doc.materials.find((m) => m.name === 'Blue grass')
    expect(moss).toMatchObject({ id: 2, color: 0x4f8a8a, archetype: 'floor' })
    expect(doc.images[0].terrain.tiles[7]).toEqual(['2', '1', '0', null])
  })

  it("turns a material's side reference into the material that draws it", () => {
    const doc = project()
    convert(doc)

    // `side` was never art indirection: it says what a voxel of this cuts its cliffs with, which
    // under the new model is another material.
    expect(doc.materials[0]).toEqual({ id: 0, name: 'Grass', color: 0x6aa84f, archetype: 'floor', side: 1 })
    expect(doc.materials[0].top).toBeUndefined()
  })

  it('converts a layout to material ids and drops the list of blocks nobody drew', () => {
    const doc = project()
    convert(doc)

    // What is still to author is a query over the tags now, so there is nothing to keep beside them.
    expect(doc.images[0].layout).toEqual({ convention: 'corner-blocks', origin: { x: 0, y: 0 }, materials: [0, 1] })
  })

  it('reports a tag naming a terrain the file never defined instead of writing a dangling id', () => {
    const doc = project()
    const { orphaned } = convert(doc)

    // A format-3 file is refused outright if a tag names a material the project lacks, so a tag
    // that cannot be mapped has to become nothing here rather than becoming unopenable there.
    expect(orphaned).toBe(1)
    expect(doc.images[0].terrain.tiles[9]).toEqual([null, null, null, null])
  })
})
