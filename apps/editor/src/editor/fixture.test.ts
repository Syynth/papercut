import { describe, expect, it } from 'vitest'

import { FACE_TOP, cornerHeights, faceKey, slotMaterial, topHeight, type VoxelStructure } from '@papercut/document'

import { FIXTURE_SIZE, fixtureFor } from './fixture'

const ground = (doc: ReturnType<typeof fixtureFor>): VoxelStructure => doc.structures.ground as VoxelStructure
/** The material on the bottom layer of a face. */
const on = (voxel: VoxelStructure, x: number, z: number, y: number, dir: number): number | null => slotMaterial(voxel.paint.faces[faceKey(x, z, y, dir)]?.[0])

describe('the 3D view\'s fixture', () => {
  it('is a plateau on level ground with a ramp down its east side', () => {
    const voxel = ground(fixtureFor({ material: 3, other: null }))
    expect(voxel.size).toEqual({ width: FIXTURE_SIZE, height: FIXTURE_SIZE })
    expect(topHeight(voxel, 0, 0)).toBe(2)
    expect(topHeight(voxel, 4, 4)).toBe(6)
    // Two ramp cells for two tiles of drop: each slopes, high on the plateau's side.
    for (const x of [7, 8]) {
      const corners = cornerHeights(voxel, x, 4)
      expect(new Set(corners).size).toBeGreaterThan(1)
    }
    expect(Math.max(...cornerHeights(voxel, 7, 4))).toBe(6)
    expect(Math.min(...cornerHeights(voxel, 8, 4))).toBe(2)
  })

  it('makes everything of a material on its own', () => {
    const voxel = ground(fixtureFor({ material: 3, other: null }))
    const used = new Set(Object.values(voxel.paint.faces).map((layers) => slotMaterial(layers[0])))
    expect([...used]).toEqual([3])
  })

  it('tops the plateau and the ground with the material, and walls, ramps and patches them with the one it meets', () => {
    const voxel = ground(fixtureFor({ material: 0, other: 2 }))
    expect(on(voxel, 4, 4, 2, FACE_TOP)).toBe(0)
    expect(on(voxel, 0, 0, 0, FACE_TOP)).toBe(0)
    // The plateau's east wall, the ramp's top and the patch of ground off its near corner.
    expect(on(voxel, 6, 5, 2, 0)).toBe(2)
    expect(on(voxel, 7, 4, 2, FACE_TOP)).toBe(2)
    expect(on(voxel, 0, 8, 0, FACE_TOP)).toBe(2)
  })
})
