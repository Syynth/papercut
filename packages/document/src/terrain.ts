/**
 * Height queries over the level.
 *
 * "What is under this point" is answered per structure kind and taken
 * top-most: a voxel column's bilinear top, a closed sketch's cap. Each
 * structure is asked in its own frame — its parent's origin, turned by its
 * yaw, lifted to its parent's top where it stands — so a tier on an island
 * on a voxel volume reports the height the artist sees.
 */

import { HALF, NO_RAMP, inBounds, type ReadonlyMapDoc } from './document'
import { ancestorsOf, outlineOf, pointInOutline, type QuarterTurn, type ReadonlyStructure, type ReadonlyVoxel } from './structure'
import { columnTopAt, shapeHeight, shapeLowHeight, shapeRampDir, voxelIndex } from './voxels'

export const CORNER_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0, 1],
  [1, 1],
  [1, 0],
]

/** For each ramp direction, which two corners (indices into CORNER_OFFSETS) drop. */
export const RAMP_LOW_CORNERS: ReadonlyArray<readonly [number, number]> = [
  [3, 2],
  [1, 2],
  [0, 1],
  [3, 0],
]

/** A full ramp's drop, in half-tiles: one tile over one cell, 45°. */
export const RAMP_DROP = 2

/**
 * The four corner heights of a column's top, in half-tiles: level for a
 * block or a slab, the two corners facing the ramp's direction dropped for a
 * sloped shape. A half ramp is a wedge over half the cell and then flat; as
 * corners it is the plane through its high and low edges, which the mesher
 * refines when it draws shapes itself.
 */
export function cornerHeights(voxel: ReadonlyVoxel, x: number, y: number): [number, number, number, number] {
  return cornerHeightsAt(voxel, x, y, columnTopAt(voxel, x, y))
}

/**
 * The corner heights of the top of ONE voxel, the one at `layer`, in `CORNER_OFFSETS` order: what a column's top is
 * when that voxel is its highest, and what a lower top is where the column has air above it and more ground over that
 * (an overhang's floor, a cave's). Layer -1 is the bedrock floor.
 */
export function cornerHeightsAt(voxel: ReadonlyVoxel, x: number, y: number, layer: number): [number, number, number, number] {
  if (layer < 0) return [0, 0, 0, 0]
  const shape = voxel.voxels.shape[voxelIndex(voxel, x, y, layer)]
  const base = layer * 2
  const h = base + shapeHeight(shape)
  const corners: [number, number, number, number] = [h, h, h, h]
  const dir = shapeRampDir(shape)
  if (dir !== NO_RAMP) {
    for (const corner of RAMP_LOW_CORNERS[dir]) corners[corner] = base + shapeLowHeight(shape)
  }
  return corners
}

/** The top of a voxel volume at a local point, bilinear across the cell, in world units; `null` outside it. */
export function voxelTop(voxel: ReadonlyVoxel, localX: number, localZ: number): number | null {
  const cx = Math.floor(localX)
  const cy = Math.floor(localZ)
  if (!inBounds(voxel.size, cx, cy)) return null
  const [c00, c01, c11, c10] = cornerHeights(voxel, cx, cy)
  const fx = localX - cx
  const fz = localZ - cy
  // Bilinear across the cell. c00 at (0,0), c10 at (1,0), c01 at (0,1), c11 at (1,1).
  const north = c00 + (c10 - c00) * fx
  const south = c01 + (c11 - c01) * fx
  return (north + (south - north) * fz) * HALF
}

/** A structure's frame in world space: where its origin is, which way it faces, and the height of the plane it stands on. */
export interface Frame {
  x: number
  z: number
  yaw: QuarterTurn
  y: number
}

const ROOT: Frame = { x: 0, z: 0, yaw: 0, y: 0 }

function turn(x: number, z: number, yaw: QuarterTurn): [number, number] {
  switch (yaw) {
    case 0:
      return [x, z]
    case 1:
      return [-z, x]
    case 2:
      return [-x, -z]
    case 3:
      return [z, -x]
  }
}

export function toWorld(frame: Frame, localX: number, localZ: number): [number, number] {
  const [x, z] = turn(localX, localZ, frame.yaw)
  return [frame.x + x, frame.z + z]
}

export function toLocal(frame: Frame, worldX: number, worldZ: number): [number, number] {
  return turn(worldX - frame.x, worldZ - frame.z, ((4 - frame.yaw) % 4) as QuarterTurn)
}

/** The height of a structure's top at one of its own local points; what a child standing there sits on. */
function topAt(structure: ReadonlyStructure, localX: number, localZ: number): number {
  if (structure.kind === 'voxel') return voxelTop(structure, localX, localZ) ?? 0
  return structure.closed && structure.points.length >= 3 ? structure.layers * HALF : 0
}

/** The frame a structure's own coordinates are measured in, composed down from the root. */
export function frameOf(doc: ReadonlyMapDoc, id: string): Frame {
  const chain = [...ancestorsOf(doc, id)].reverse()
  chain.push(id)
  let frame = ROOT
  let parent: ReadonlyStructure | undefined
  for (const current of chain) {
    const s = doc.structures[current]
    if (!s) break
    if (parent) {
      const [x, z] = toWorld(frame, s.placement.x, s.placement.z)
      const y = frame.y + topAt(parent, s.placement.x, s.placement.z)
      frame = { x, z, yaw: ((frame.yaw + s.placement.yaw) % 4) as QuarterTurn, y }
    }
    parent = s
  }
  return frame
}

/** Height of whatever is under a world point: the top-most structure there, or the ground at 0. */
export function groundHeight(doc: ReadonlyMapDoc, worldX: number, worldZ: number): number {
  let best = 0
  for (const id of doc.structureOrder) {
    const top = topOfAt(doc, id, worldX, worldZ)
    if (top !== null) best = Math.max(best, top)
  }
  return best
}

/** The world height of a structure's top under a world point, or `null` when the point is outside its footprint. */
function topOfAt(doc: ReadonlyMapDoc, id: string, worldX: number, worldZ: number): number | null {
  const s = doc.structures[id]
  if (!s) return null
  const frame = frameOf(doc, id)
  const [lx, lz] = toLocal(frame, worldX, worldZ)
  if (s.kind === 'voxel') {
    const top = voxelTop(s, lx, lz)
    return top === null ? null : frame.y + top
  }
  return s.closed && s.points.length >= 3 && pointInOutline(outlineOf(s.points), lx, lz) ? frame.y + s.layers * HALF : null
}

/**
 * The structure whose top is under a world point — the highest of those
 * whose footprint contains it, a later one winning a tie so a child beats
 * the parent it stands on. `exclude` leaves out ids that must not answer:
 * the structure being dragged and its descendants, which would otherwise
 * find themselves. `null` when nothing is there (off every volume).
 */
export function structureAt(doc: ReadonlyMapDoc, worldX: number, worldZ: number, exclude: ReadonlySet<string> = new Set()): string | null {
  let best: { id: string; top: number } | null = null
  for (const id of doc.structureOrder) {
    if (exclude.has(id)) continue
    const top = topOfAt(doc, id, worldX, worldZ)
    if (top !== null && (best === null || top >= best.top)) best = { id, top }
  }
  return best?.id ?? null
}

/** The world position of the centre of one of a voxel volume's cells, on its top. */
export function cellCentreWorld(doc: ReadonlyMapDoc, voxel: ReadonlyVoxel, x: number, y: number): [number, number, number] {
  const frame = frameOf(doc, voxel.id)
  const [wx, wz] = toWorld(frame, x + 0.5, y + 0.5)
  return [wx, frame.y + (voxelTop(voxel, x + 0.5, y + 0.5) ?? 0), wz]
}

/** The level's extent, derived: the union of what its structures cover, in world units. `null` for an empty level. */
export interface Bounds {
  minX: number
  minZ: number
  maxX: number
  maxZ: number
}

export function levelBounds(doc: ReadonlyMapDoc): Bounds | null {
  let out: Bounds | null = null
  const grow = (x: number, z: number) => {
    if (!out) out = { minX: x, minZ: z, maxX: x, maxZ: z }
    else {
      out.minX = Math.min(out.minX, x)
      out.minZ = Math.min(out.minZ, z)
      out.maxX = Math.max(out.maxX, x)
      out.maxZ = Math.max(out.maxZ, z)
    }
  }
  for (const id of doc.structureOrder) {
    const s = doc.structures[id]
    if (!s) continue
    const frame = frameOf(doc, id)
    if (s.kind === 'voxel') {
      for (const [lx, lz] of [
        [0, 0],
        [s.size.width, 0],
        [0, s.size.height],
        [s.size.width, s.size.height],
      ]) {
        const [x, z] = toWorld(frame, lx, lz)
        grow(x, z)
      }
    } else {
      for (const p of s.points) {
        const [x, z] = toWorld(frame, p.x, p.z)
        grow(x, z)
      }
    }
  }
  return out
}

/** The middle of the level's extent, on the ground; the origin for an empty level. */
export function levelCentre(doc: ReadonlyMapDoc): [number, number, number] {
  const b = levelBounds(doc)
  if (!b) return [0, 0, 0]
  const x = (b.minX + b.maxX) / 2
  const z = (b.minZ + b.maxZ) / 2
  return [x, groundHeight(doc, x, z), z]
}
