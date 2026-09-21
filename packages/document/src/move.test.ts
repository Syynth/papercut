import { describe, expect, it } from 'vitest'

import { AIR, SHAPE_BLOCK, createMap, defaultFacing, slotOf, type MapDoc, type MapObject } from './document'
import { clampOffset, movePatches, movedVolume, offsetKeys, snapshotObjects, snapshotVolume, volumePatches } from './move'
import { FACE_TOP, edgeKey, faceKey } from './paint'
import { voxelKey } from './region'
import type { VoxelStructure } from './structure'
import { fillColumn, voxelAt, voxelIndex } from './voxels'

/** A 2 × 1 block two tiles over the ground at (3..4, 3), its top painted material 2 and its sides material 1. */
function block(): { doc: MapDoc; voxel: VoxelStructure; keys: string[] } {
  const doc = createMap(10, 10)
  const voxel = doc.structures.ground as VoxelStructure
  for (const x of [3, 4]) fillColumn(voxel, x, 3, 6, { material: 2, sides: 1 })
  return { doc, voxel, keys: [3, 4].flatMap((x) => [voxelKey(x, 3, 1), voxelKey(x, 3, 2)]) }
}

/** Put the volume in the state a move asks for, as the document actor would. */
function apply(voxel: VoxelStructure, wanted: ReturnType<typeof movedVolume>): void {
  for (const patch of volumePatches(voxel, wanted)) {
    if (patch.t === 'voxel') voxel.voxels.shape[patch.index] = patch.value
    else if (patch.t === 'voxelPaint' && patch.layer === 'faces') {
      if (patch.value === undefined) delete voxel.paint.faces[patch.key]
      else voxel.paint.faces[patch.key] = patch.value
    } else if (patch.t === 'voxelPaint' && patch.layer === 'edges') {
      if (patch.value === undefined) delete voxel.paint.edges[patch.key]
      else voxel.paint.edges[patch.key] = patch.value
    }
  }
}

describe('moving voxels (design round of 2026-09-19)', () => {
  it('carries the voxels and their paint, leaves air, and gives the ground it bares a top again', () => {
    const { voxel, keys } = block()
    const before = snapshotVolume(voxel)
    apply(voxel, movedVolume(voxel, before, keys, { dx: 3, dz: 0, dy: 0 }, false))
    expect(voxelAt(voxel, 3, 3, 2)).toBe(AIR)
    expect(voxelAt(voxel, 6, 3, 2)).toBe(SHAPE_BLOCK)
    // Its top went with it, and so did a side; the ground where it stood is a top again, painted as ground.
    expect(voxel.paint.faces[faceKey(6, 3, 2, FACE_TOP)]?.[0]).toBe(slotOf(2))
    expect(voxel.paint.faces[faceKey(7, 3, 2, 0)]?.[0]).toBe(slotOf(1))
    expect(voxel.paint.faces[faceKey(3, 3, 2, FACE_TOP)]).toBeUndefined()
    expect(voxel.paint.faces[faceKey(3, 3, 0, FACE_TOP)]).toBeDefined()
    // Under where it landed the ground's top is buried, and keeps nothing.
    expect(voxel.paint.faces[faceKey(6, 3, 0, FACE_TOP)]).toBeUndefined()
  })

  it('puts everything back exactly when the drag comes back to where it started', () => {
    const { voxel, keys } = block()
    const before = snapshotVolume(voxel)
    const shape = [...voxel.voxels.shape]
    const faces = JSON.stringify(voxel.paint.faces)
    for (const offset of [{ dx: 2, dz: 1, dy: 0 }, { dx: 5, dz: 1, dy: 1 }, { dx: 0, dz: 0, dy: 0 }]) apply(voxel, movedVolume(voxel, before, keys, offset, false))
    expect(voxel.voxels.shape).toEqual(shape)
    expect(JSON.parse(JSON.stringify(voxel.paint.faces))).toEqual(JSON.parse(faces))
  })

  it('moves up and leaves a gap under it, which is an overhang the verbs could never make', () => {
    const { voxel, keys } = block()
    apply(voxel, movedVolume(voxel, snapshotVolume(voxel), keys, { dx: 0, dz: 0, dy: 2 }, false))
    expect([0, 1, 2, 3, 4].map((y) => voxelAt(voxel, 3, 3, y) !== AIR)).toEqual([true, false, false, true, true])
    // The underside that came into the open has paint, and so does the ground under it.
    expect(voxel.paint.faces[faceKey(3, 3, 3, 5)]).toBeDefined()
    expect(voxel.paint.faces[faceKey(3, 3, 0, FACE_TOP)]).toBeDefined()
  })

  it('leaves a copy when asked, and replaces what it lands on', () => {
    const { voxel, keys } = block()
    fillColumn(voxel, 7, 3, 8, { material: 3 })
    apply(voxel, movedVolume(voxel, snapshotVolume(voxel), keys, { dx: 3, dz: 0, dy: 0 }, true))
    expect(voxelAt(voxel, 3, 3, 2)).toBe(SHAPE_BLOCK)
    expect(voxelAt(voxel, 7, 3, 2)).toBe(SHAPE_BLOCK)
    // (7, 3) was a taller pillar of material 3: the layers the copy landed in are the copy's now, the layer above still the pillar's.
    expect(voxel.paint.faces[faceKey(7, 3, 3, FACE_TOP)]?.[0]).toBe(slotOf(3))
    expect(voxel.paint.faces[faceKey(7, 3, 2, 0)]?.[0]).toBe(slotOf(1))
  })

  it('keeps a selection that overlaps its own landing whole', () => {
    const { voxel, keys } = block()
    apply(voxel, movedVolume(voxel, snapshotVolume(voxel), keys, { dx: 1, dz: 0, dy: 0 }, false))
    expect([3, 4, 5].map((x) => voxelAt(voxel, x, 3, 2) !== AIR)).toEqual([false, true, true])
    expect(voxel.paint.faces[faceKey(4, 3, 2, FACE_TOP)]?.[0]).toBe(slotOf(2))
  })

  it('takes an edge switch along with a column whose top moved, and drops one whose wall is gone', () => {
    const { voxel, keys } = block()
    voxel.paint.edges[edgeKey(3, 3, 3, 'top')] = 'off'
    apply(voxel, movedVolume(voxel, snapshotVolume(voxel), keys, { dx: 0, dz: 3, dy: 0 }, false))
    expect(voxel.paint.edges[edgeKey(3, 6, 3, 'top')]).toBe('off')
    expect(voxel.paint.edges[edgeKey(3, 3, 3, 'top')]).toBeUndefined()
  })

  it('clamps an offset so nothing leaves the volume, and says where a selection ends up', () => {
    const { voxel, keys } = block()
    expect(clampOffset(voxel, keys, { dx: 50, dz: -50, dy: 50 })).toEqual({ dx: 5, dz: -3, dy: voxel.layers - 3 })
    expect(clampOffset(voxel, [], { dx: 1, dz: 1, dy: 1 })).toEqual({ dx: 0, dz: 0, dy: 0 })
    expect(offsetKeys([voxelKey(1, 2, 3)], { dx: 1, dz: -1, dy: 2 })).toEqual([voxelKey(2, 1, 5)])
    // Moving nothing, or by nothing, asks for the volume as it was.
    const before = snapshotVolume(voxel)
    expect(movedVolume(voxel, before, keys, { dx: 0, dz: 0, dy: 0 }, false)).toBe(before)
    expect(voxel.voxels.shape[voxelIndex(voxel, 3, 3, 2)]).toBe(SHAPE_BLOCK)
  })

  it('carries what stands on the voxels, and sets everything down on what is under it afterwards', () => {
    const { doc, voxel, keys } = block()
    const object = (id: string, x: number, z: number, y: number): MapObject => ({ id, name: id, sprite: 'tree', position: [x, y, z], rotationY: 0, scale: 1, display: 'auto', facing: defaultFacing(), anchorCell: [Math.floor(x), Math.floor(z)], seed: 1, locked: false, hidden: false })
    // One on the block, which stands three tiles up; one on the ground where the block will land.
    doc.objects.rider = object('rider', 3.5, 3.5, 3)
    doc.objects.bystander = object('bystander', 6.5, 3.5, 1)
    doc.objectOrder.push('rider', 'bystander')
    const patches = movePatches(doc, voxel, snapshotVolume(voxel), snapshotObjects(doc), keys, { dx: 3, dz: 0, dy: 0 }, false)
    const moved = Object.fromEntries(patches.flatMap((p) => (p.t === 'object' && p.value ? [[p.id, p.value]] : [])))
    expect(moved.rider.position).toEqual([6.5, 3, 3.5])
    expect(moved.rider.anchorCell).toEqual([6, 3])
    // The block came down over it: it is lifted onto the block's top rather than left inside it.
    expect(moved.bystander.position).toEqual([6.5, 3, 3.5])
    // A copy carries nothing: the rider stays with the original.
    const copied = movePatches(doc, voxel, snapshotVolume(voxel), snapshotObjects(doc), keys, { dx: 0, dz: 4, dy: 0 }, true)
    expect(copied.some((p) => p.t === 'object' && p.id === 'rider')).toBe(false)
  })
})
