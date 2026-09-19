/**
 * The fixture the Materials section's 3D view draws a subject on (decision of
 * 2026-09-19): a small map, generated from the subject and never stored.
 *
 * One shape serves every subject, because what it has to show is the same: a
 * level top, the walls under it and the fold between them, a rim for a fringe
 * to hang from, a foot for a picket to stand at, a slope, and ground around
 * it where two materials can meet on a floor. What changes is what each part
 * is made of.
 *
 *   A material on its own     everything is it.
 *   A material meeting another  the plateau's top and the ground are the
 *                             material; its walls, its ramp and a patch of
 *                             the ground are the other — so the two meet on a
 *                             floor, across the fold, and at the wall's foot.
 *
 * Pure: a map document and nothing else, so it can be tested without a GPU.
 */

import { createMap, fillColumn, rampShape, settleFaces, type MapDoc, type VoxelStructure } from '@papercut/document'

import type { Subject } from './coverage'

export const FIXTURE_SIZE = 10
/** Heights in half-tiles: the ground is one tile tall, the plateau two more. */
const GROUND = 2
const PLATEAU = 6
/** East: the direction the ramp descends toward, in the map's direction order. */
const EAST = 0

export function fixtureFor(subject: Subject): MapDoc {
  const doc = createMap(FIXTURE_SIZE, FIXTURE_SIZE, 'Fixture')
  const voxel = doc.structures.ground as VoxelStructure
  const mine = subject.material
  const theirs = subject.other ?? subject.material

  for (let z = 0; z < FIXTURE_SIZE; z++) {
    for (let x = 0; x < FIXTURE_SIZE; x++) {
      // A patch of the other material on the ground, off the plateau's near corner, for the floor's own transition.
      const patch = x <= 2 && z >= 6 && !(x === 2 && z === 6)
      fillColumn(voxel, x, z, GROUND, { material: patch ? theirs : mine })
    }
  }
  for (let z = 3; z < 7; z++) for (let x = 3; x < 7; x++) fillColumn(voxel, x, z, PLATEAU, { material: mine, sides: theirs })
  // A ramp off the plateau's east side, two cells for its two tiles of drop (ramps are 45°).
  fillColumn(voxel, 7, 4, PLATEAU, { material: theirs, shape: rampShape(EAST) })
  fillColumn(voxel, 8, 4, PLATEAU - 2, { material: theirs, shape: rampShape(EAST) })
  settleFaces(voxel)

  // Seen from the south-east, a little above: the fold, the ramp and the ground patch are all in view.
  doc.camera = { ...doc.camera, yaw: 35, pitch: 38, distance: 14, projection: 'perspective' }
  return doc
}
