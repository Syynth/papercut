import type * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { NO_RAMP, createMap, createSketch, createVoxel, fillColumn, rampDirAt, slotMaterial, topLayersAt, rampShape, topHeight, type MapDoc, type VoxelStructure } from '@papercut/document'

import { TerrainGrid } from './grid'

const ground = (doc: MapDoc): VoxelStructure => doc.structures.ground as VoxelStructure

/** The y of every vertex in a chunk's buffer. */
function heights(grid: TerrainGrid, id: string, key: string): number[] {
  const array = grid.chunkLines(id, key)?.geometry.getAttribute('position').array as Float32Array
  return Array.from(array).filter((_, i) => i % 3 === 1)
}

describe('the terrain grid', () => {
  it('builds one line buffer per chunk of each voxel volume, four edges a cell, in the volume’s own space', () => {
    const doc = createMap(20, 17)
    const grid = new TerrainGrid()
    grid.rebuildAll(doc)
    // 20 × 17 at 16 cells a chunk: two across, two down.
    expect(grid.chunkCount('ground')).toBe(4)
    const corner = grid.chunkLines('ground', '1,1')
    expect(corner?.geometry.getAttribute('position').count).toBe(4 * 1 * 8)
    const flat = topHeight(ground(doc), 0, 0) * 0.5 + 0.025
    expect(new Set(heights(grid, 'ground', '0,0'))).toEqual(new Set([Math.fround(flat)]))
  })

  it('rewrites only the dirty chunk, in its existing buffer, and follows ramps', () => {
    const doc = createMap(32, 16)
    const grid = new TerrainGrid()
    grid.rebuildAll(doc)
    const left = grid.chunkLines('ground', '0,0')
    const right = grid.chunkLines('ground', '1,0')
    const leftArray = left?.geometry.getAttribute('position').array
    const rightVersion = (right?.geometry.getAttribute('position') as THREE.BufferAttribute | undefined)?.version

    const g = ground(doc)
    fillColumn(g, 2, 3, 10)
    // A ramp is the top voxel's shape: the column keeps its height and material, its top slopes east.
    fillColumn(g, 4, 3, topHeight(g, 4, 3), { material: slotMaterial(topLayersAt(g, 4, 3)?.[0]) ?? 0, shape: rampShape(0) })
    grid.update(doc, ['ground/0,0'], [])

    expect(grid.chunkLines('ground', '0,0')).toBe(left)
    expect(left?.geometry.getAttribute('position').array).toBe(leftArray)
    expect((right?.geometry.getAttribute('position') as THREE.BufferAttribute | undefined)?.version).toBe(rightVersion)
    expect(heights(grid, 'ground', '0,0')).toContain(Math.fround(10 * 0.5 + 0.025))
    // The ramp's low corners sit a whole drop below its high ones.
    const base = topHeight(g, 4, 3)
    expect(heights(grid, 'ground', '0,0')).toContain(Math.fround((base - 2) * 0.5 + 0.025))
    expect(rampDirAt(g, 0, 0)).toBe(NO_RAMP)
  })

  it('moves a volume by its group, rebuilds a resized one, and drops one that is gone or is not a voxel volume', () => {
    const doc = createMap(16, 16)
    const grid = new TerrainGrid()
    grid.rebuildAll(doc)
    const lines = grid.chunkLines('ground', '0,0')

    // A sketch is not a voxel volume: it has no grid of its own.
    const sketch = createSketch('ground', 'Island')
    doc.structures[sketch.id] = sketch
    doc.structureOrder.push(sketch.id)
    grid.update(doc, [], [sketch.id])
    expect(grid.chunkCount(sketch.id)).toBe(0)

    // A volume standing on the ground: moving its placement moves its group, and no buffer is touched.
    const shelf = createVoxel(8, 8, 'Shelf', 'ground')
    doc.structures[shelf.id] = shelf
    doc.structureOrder.push(shelf.id)
    grid.update(doc, [], [shelf.id])
    const shelfLines = grid.chunkLines(shelf.id, '0,0')
    const shelfArray = shelfLines?.geometry.getAttribute('position').array
    shelf.placement = { x: 3, z: 5, yaw: 1 }
    grid.update(doc, [], [])
    expect(grid.chunkLines(shelf.id, '0,0')).toBe(shelfLines)
    expect(shelfLines?.geometry.getAttribute('position').array).toBe(shelfArray)
    expect(shelfLines?.parent?.position.x).toBe(3)
    expect(shelfLines?.parent?.position.z).toBe(5)
    expect(shelfLines?.parent?.rotation.y).toBeCloseTo(-Math.PI / 2)

    // Resized: its buffers are made again at the new size.
    doc.structures[shelf.id] = { ...createVoxel(20, 8, 'Shelf', 'ground', shelf.id), placement: shelf.placement }
    grid.update(doc, [], [shelf.id])
    expect(grid.chunkCount(shelf.id)).toBe(2)
    expect(grid.chunkLines('ground', '0,0')).toBe(lines)

    // Gone: its buffers go with it.
    delete doc.structures.ground
    doc.structureOrder.splice(doc.structureOrder.indexOf('ground'), 1)
    grid.update(doc, [], ['ground'])
    expect(grid.chunkCount('ground')).toBe(0)
    grid.dispose()
  })
})
