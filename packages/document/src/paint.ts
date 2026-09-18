/**
 * Paint addressing.
 *
 * THE ADDRESS
 * -----------
 * Paint is addressed in stable grid coordinates that describe *where on the
 * map* a surface is, never *which triangle* it came out as:
 *
 *   - a face is keyed by voxel and side:  (x, z, y, dir)
 *   - tint is keyed by cell:              (x, z)
 *
 * `y` is the LAYER of the voxel the face belongs to and `dir` its side: 0–3
 * east, south, west, north, `FACE_TOP` and `FACE_BOTTOM`. A column with no
 * voxels at all still has a floor, at the height the volume starts from: its
 * top face is addressed at `y = -1`, the bedrock under layer 0, so a column
 * lowered all the way keeps its paint.
 *
 * Keying by voxel rather than by triangle is what keeps paint independent of
 * geometry detail: a cliff profile swept along an edge (brief section 5) can
 * change how a face is shaped, and how many triangles it takes, without
 * changing which voxels exist.
 *
 * WHAT A FACE HOLDS
 * -----------------
 * Every face a viewer can see carries a stack of four MATERIAL LAYERS, bottom
 * to top (ruling of 2026-09-18). Each is `"m:<id>"` or `null`; the tile drawn
 * at any corner follows from the materials around it on the same layer (spec
 * §3). A face with no entry is unpainted and draws the fallback.
 *
 * NO DORMANT PAINT
 * ----------------
 * This file used to call the opposite "the most important data decision in
 * the project": paint on a face that stopped existing stayed in the record,
 * dormant, and came back if the terrain did. That was reversed on 2026-09-18.
 * An operation that creates or removes faces now writes or removes their
 * stacks (`reconcileFaces` in `ops.ts`), so what is in the record is exactly
 * what draws, and nothing is hidden waiting for the ground to come back.
 */

import type { DeepReadonly, MaterialLayers, SurfacePaint } from './document'

/** The side ids beyond the four compass sides. */
export const FACE_TOP = 4
export const FACE_BOTTOM = 5

export function faceKey(x: number, z: number, y: number, dir: number): string {
  return `${x},${z},${y},${dir}`
}

export function tintKey(x: number, z: number): string {
  return `${x},${z}`
}

export function parseFaceKey(key: string): { x: number; z: number; y: number; dir: number } {
  const [x, z, y, dir] = key.split(',').map(Number)
  return { x, z, y, dir }
}

/** A face's material layers, or `undefined` for a face that is unpainted. */
export function faceLayers(paint: DeepReadonly<SurfacePaint>, x: number, z: number, y: number, dir: number): DeepReadonly<MaterialLayers> | undefined {
  return paint.faces[faceKey(x, z, y, dir)]
}

export function tintPaint(paint: DeepReadonly<SurfacePaint>, x: number, z: number): number | undefined {
  return paint.tint[tintKey(x, z)]
}
