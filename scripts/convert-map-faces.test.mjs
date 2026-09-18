import { deserialize, exposedFacesOf } from '@papercut/document'
import { describe, expect, it } from 'vitest'

import { convertMap, takeSides } from './convert-map-faces.mjs'

/**
 * A 2×1, three-layer format-4 map: (0,0) two cubes of Grass, (1,0) empty.
 * Its east face at layer 1 carries a Stone override; a face three layers up,
 * which no voxel has, carries a dormant one.
 */
const map = () => ({
  formatVersion: 4,
  id: 'm',
  name: 'Old',
  structures: {
    ground: {
      kind: 'voxel',
      id: 'ground',
      name: 'Ground',
      parent: null,
      placement: { x: 0, z: 0, yaw: 0 },
      size: { width: 2, height: 1 },
      layers: 3,
      voxels: {
        // Layer by layer, x fastest: (0,0) is Grass in layers 0 and 1, (1,0) is air throughout.
        material: [0, -1, 0, -1, -1, -1],
        shape: [0, 0, 0, 0, 0, 0],
      },
      water: [-32768, -32768],
      paint: { faces: { '0,0,1,0': 2, '0,0,2,0': 4 }, tint: {} },
    },
  },
  structureOrder: ['ground'],
  objects: {},
  objectOrder: [],
})

describe('converting a format-4 map to format 5', () => {
  it('moves air into the shape and paints every drawn face with what it drew', () => {
    const doc = map()
    const project = { materials: [{ id: 0, name: 'Grass', side: 1 }, { id: 1, name: 'Dirt' }, { id: 2, name: 'Stone' }] }
    const sides = takeSides(project)
    expect(project.materials.some((m) => 'side' in m)).toBe(false)

    const report = convertMap(doc, sides)
    const g = /** @type {any} */ (doc.structures.ground)
    expect(doc.formatVersion).toBe(5)
    expect(g.voxels).toEqual({ shape: [0, -1, 0, -1, -1, -1] })
    // The top is Grass; the east face with the override draws Stone; the one without draws Grass's side, Dirt.
    expect(g.paint.faces['0,0,1,4']).toEqual(['m:0', null, null, null])
    expect(g.paint.faces['0,0,1,0']).toEqual(['m:2', null, null, null])
    expect(g.paint.faces['0,0,0,0']).toEqual(['m:1', null, null, null])
    // The empty column's floor is material 0, as the old mesher drew it.
    expect(g.paint.faces['1,0,-1,4']).toEqual(['m:0', null, null, null])
    expect(report).toMatchObject({ overrides: 2, dropped: 1 })
    expect(g.paint.faces).not.toHaveProperty('0,0,2,0')
  })

  it('writes a map the strict loader reads, with exactly the faces that draw painted', () => {
    const doc = map()
    convertMap(doc, new Map())
    const loaded = deserialize(JSON.stringify(doc))
    const g = /** @type {import('@papercut/document').VoxelStructure} */ (loaded.structures.ground)
    const drawn = [...exposedFacesOf(g, 0, 0), ...exposedFacesOf(g, 1, 0)].sort()
    expect(Object.keys(g.paint.faces).sort()).toEqual(drawn)
  })

  it('refuses anything but format 4', () => {
    expect(() => convertMap({ ...map(), formatVersion: 5 }, new Map())).toThrow(/reads format 4/)
  })
})
