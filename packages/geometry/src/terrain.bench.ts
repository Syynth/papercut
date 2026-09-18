/**
 * Spike: is TypeScript meshing fast enough while brushing?
 *
 * The number that matters is not the whole map, it is one brush tick. A stroke
 * dirties the 3x3 neighbourhood of chunks around the cursor, and that work has
 * to fit comfortably inside a 16.7 ms frame. Whole-map timings only matter for
 * load and for the "convert to blocks" style bulk operations.
 *
 * Run with `npm run bench`.
 */
import { describe, test } from 'vitest'

import {
  DEFAULT_MATERIALS,
  PLACEHOLDER_SHEET,
  allChunkKeys,
  createMap,
  fillColumn,
  tagOf,
  type MapDoc,
  type ReadonlyMapDoc,
  type RgbaImage,
  type VoxelStructure,
} from '@papercut/document'
import type { LoadedSet } from './atlas'
import { createTerrainLook } from './look'
import { meshTerrainChunk } from './terrain'
import { createTerrainSet, stampTemplate } from './terrainset'

/** The root voxel volume a fresh level has, mutable for setup: `createMap` names it `ground`. */
const ground = (doc: ReadonlyMapDoc | MapDoc): VoxelStructure => doc.structures.ground as VoxelStructure

/** Pixels per tile, as the placeholder sheet has: the atlas the mesher reads UVs from is sized by it. */
const TILE = 16

/**
 * A stand-in for the placeholder terrain set the default materials draw from:
 * the five materials, each with an edge set on its own 4×4 block, over one
 * flat colour. The look is built once; a pair the mesher meets is baked
 * into its atlas on first sight and answered from cache after, so the
 * timings below are the mesher's, not the atlas's.
 */
function placeholderSet(): LoadedSet {
  let set = createTerrainSet(PLACEHOLDER_SHEET, TILE, 16, 8)
  // A tag names a material of the project (ruling of 2026-09-17), so the blocks are the default materials by id.
  DEFAULT_MATERIALS.forEach((material, i) => {
    set = stampTemplate(set, (i % 4) * 4, Math.floor(i / 4) * 4, null, tagOf(material.id))
  })
  const image: RgbaImage = { width: 16 * TILE, height: 8 * TILE, data: new Uint8ClampedArray(16 * TILE * 8 * TILE * 4).fill(255) }
  return { set, image }
}


function hilly(width: number, height: number): MapDoc {
  const doc = createMap(width, height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const h =
        4 +
        Math.round(3 * Math.sin(x * 0.22) + 3 * Math.cos(y * 0.19) + 2 * Math.sin((x + y) * 0.11))
      // Every face of the column takes the material: fillColumn paints them all.
      fillColumn(ground(doc), x, y, Math.max(0, h), { material: (x + y) % 4 })
    }
  }
  return doc
}

const map128 = hilly(128, 128)
const look = createTerrainLook(DEFAULT_MATERIALS, [placeholderSet()])
const keys128 = allChunkKeys(128, 128)
const middle = keys128[Math.floor(keys128.length / 2)]

// The 3x3 neighbourhood a brush tick actually dirties.
const brushChunks = ['3,3', '4,3', '5,3', '3,4', '4,4', '5,4', '3,5', '4,5', '5,5']

// Vitest 5 moved `bench` off the module exports and onto the test context: a
// benchmark is now a registration you await inside a test, so each timing below
// is one test that reports a benchmark rather than a top-level `bench()` call.
//
// Read the numbers as an upper bound, not a clean measurement. Vitest 5 prints a
// "accessed module export getters too many times" warning for all three cases
// here (tracking `cellIndex`, `inBounds`, `HALF`, `DIR_VECTORS` and friends from
// packages/document/src/document.ts): under the module runner every cross-module
// import is a getter call, and the mesher reads those in its innermost loops. The
// overhead is the harness's, not the mesher's, so real runtime work is somewhat
// faster than what prints. We do not suppress the warning — see
// https://vitest.dev/guide/benchmarking#module-runner-overhead. What the numbers
// are still good for is the comparison that matters: brush tick vs. 16.7 ms, and
// this run vs. the last one.
describe('terrain mesher', () => {
  test('one chunk (16x16 cells), hilly', async ({ bench }) => {
    await bench('one chunk (16x16 cells), hilly', () => {
      meshTerrainChunk(ground(map128), middle, look)
    }).run()
  })

  test('one brush tick (9 chunks)', async ({ bench }) => {
    await bench('one brush tick (9 chunks)', () => {
      for (const key of brushChunks) meshTerrainChunk(ground(map128), key, look)
    }).run()
  })

  // A load-time number, not a frame-time one, so a few samples say what it
  // needs to. At the dual-grid mesher's cost (see the report of 2026-09-13:
  // ~22 ms a chunk under the harness) tinybench's default 64 samples plus 16
  // warmups would run this case for well over a minute and trip the test
  // timeout before it reported anything.
  test('whole 128x128 map (64 chunks)', { timeout: 300_000 }, async ({ bench }) => {
    await bench('whole 128x128 map (64 chunks)', () => {
      for (const key of keys128) meshTerrainChunk(ground(map128), key, look)
    }).run({ iterations: 4, warmupIterations: 1 })
  })
})
