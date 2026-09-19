/**
 * Voxels: the ground as cubes, and everything derived from a column.
 *
 * A voxel volume is a box of cubes, one tile on every side, `layers` deep
 * along y. A voxel is a shape, or `AIR`; what it looks like lives on its
 * faces (`paint.ts`). Nothing stores a height: the top of a column is the highest voxel that is not air, and its
 * shape says how tall that voxel is and whether it slopes. Every height the
 * rest of the editor reads — `heightAt`, `cornerHeights`, the layer view's
 * cap — is derived from here, in half-tiles, so a cube is two and a slab is
 * one and nothing downstream had to learn a new unit (spec §1).
 *
 * The per-voxel arrays are flat `number[]` addressed by `voxelIndex`, and
 * water stays a flat `number[]` per column, because the patch applier and
 * the store's dirty-chunk derivation index a field's array generically and
 * recover the cell from the index.
 *
 * The shape constants live in `document.ts` beside `NO_RAMP`, so that
 * `createVoxel` can use them without this module importing the one that
 * imports it.
 */

import { AIR, DIR_VECTORS, NO_RAMP, SHAPE_BLOCK, SHAPE_HALF_RAMP, SHAPE_HALF_RAMP_UP, SHAPE_RAMP, SHAPE_SLAB, cellIndex, inBounds, layersOf, type DeepReadonly, type MapSize, type MaterialLayers } from './document'
import { FACE_BOTTOM, FACE_TOP, faceKey } from './paint'
import type { ReadonlyVoxel, VoxelStructure } from './structure'

export interface VoxelBox {
  readonly size: MapSize
  readonly layers: number
}

export function voxelIndex(box: VoxelBox, x: number, z: number, y: number): number {
  return (y * box.size.height + z) * box.size.width + x
}

export function rampShape(dir: number): number {
  return SHAPE_RAMP + dir
}

/** The half ramp that hugs the floor: rises from the middle of the cell to one half-tile at the high edge. */
export function halfRampShape(dir: number): number {
  return SHAPE_HALF_RAMP + dir
}

/** The half ramp that rides a slab: flat at one half-tile to the middle, then rises to two at the high edge. */
export function halfRampUpShape(dir: number): number {
  return SHAPE_HALF_RAMP_UP + dir
}

/** The direction a sloped shape descends toward, or NO_RAMP for a block or a slab. */
export function shapeRampDir(shape: number): number {
  if (shape >= SHAPE_RAMP && shape < SHAPE_RAMP + 4) return shape - SHAPE_RAMP
  if (shape >= SHAPE_HALF_RAMP && shape < SHAPE_HALF_RAMP + 4) return shape - SHAPE_HALF_RAMP
  if (shape >= SHAPE_HALF_RAMP_UP && shape < SHAPE_HALF_RAMP_UP + 4) return shape - SHAPE_HALF_RAMP_UP
  return NO_RAMP
}

/** A full 45° ramp. */
export function isRampShape(shape: number): boolean {
  return shape >= SHAPE_RAMP && shape < SHAPE_RAMP + 4
}

/** Either half ramp. */
export function isHalfRampShape(shape: number): boolean {
  return shape >= SHAPE_HALF_RAMP && shape < SHAPE_HALF_RAMP_UP + 4
}

/** Anything whose top is not level. */
export function isSlopedShape(shape: number): boolean {
  return shapeRampDir(shape) !== NO_RAMP
}

/** The height of a shape's top at its highest, in half-tiles above the voxel's floor. */
export function shapeHeight(shape: number): number {
  return shape === SHAPE_SLAB || (shape >= SHAPE_HALF_RAMP && shape < SHAPE_HALF_RAMP + 4) ? 1 : 2
}

/** The height of a sloped shape's top at its lowest, in half-tiles above the voxel's floor. */
export function shapeLowHeight(shape: number): number {
  return shape >= SHAPE_HALF_RAMP_UP && shape < SHAPE_HALF_RAMP_UP + 4 ? 1 : 0
}

/** The layer of the column's top voxel, or -1 for an empty column, whose top is the bedrock floor. */
export function columnTopAt(voxel: ReadonlyVoxel, x: number, z: number): number {
  const { width, height } = voxel.size
  const shape = voxel.voxels.shape
  for (let y = voxel.layers - 1; y >= 0; y--) if (shape[(y * height + z) * width + x] !== AIR) return y
  return -1
}

/** The top voxel's shape; a block for an empty column, whose top is the floor. */
export function topShapeAt(voxel: ReadonlyVoxel, x: number, z: number): number {
  const y = columnTopAt(voxel, x, z)
  return y < 0 ? SHAPE_BLOCK : voxel.voxels.shape[voxelIndex(voxel, x, z, y)]
}

/** The column's top at its highest, in half-tiles from the volume's floor. */
export function topHeight(voxel: ReadonlyVoxel, x: number, z: number): number {
  const y = columnTopAt(voxel, x, z)
  if (y < 0) return 0
  return y * 2 + shapeHeight(voxel.voxels.shape[voxelIndex(voxel, x, z, y)])
}

/** The tallest a column in this volume can be, in half-tiles. */
export function maxHeightOf(box: VoxelBox): number {
  return box.layers * 2
}

function clampX(voxel: ReadonlyVoxel, x: number): number {
  return Math.min(Math.max(x, 0), voxel.size.width - 1)
}

function clampZ(voxel: ReadonlyVoxel, z: number): number {
  return Math.min(Math.max(z, 0), voxel.size.height - 1)
}

/** Height in half-tiles, or the edge value clamped, for out-of-bounds reads. */
export function heightAt(voxel: ReadonlyVoxel, x: number, z: number): number {
  return topHeight(voxel, clampX(voxel, x), clampZ(voxel, z))
}

/** The column's top face's material layers, clamped at the edges; `undefined` when that face is unpainted. */
export function topLayersAt(voxel: ReadonlyVoxel, x: number, z: number): DeepReadonly<MaterialLayers> | undefined {
  const cx = clampX(voxel, x)
  const cz = clampZ(voxel, z)
  return voxel.paint.faces[faceKey(cx, cz, columnTopAt(voxel, cx, cz), FACE_TOP)]
}

/** The direction the column's top descends toward, or NO_RAMP. */
export function rampDirAt(voxel: ReadonlyVoxel, x: number, z: number): number {
  return shapeRampDir(topShapeAt(voxel, x, z))
}

/** The shape of the voxel at (x, z, y), or AIR off the volume. */
export function voxelAt(voxel: ReadonlyVoxel, x: number, z: number, y: number): number {
  if (!inBounds(voxel.size, x, z) || y < 0 || y >= voxel.layers) return AIR
  return voxel.voxels.shape[voxelIndex(voxel, x, z, y)]
}

/**
 * Whether a face of a voxel is drawn: the voxel is not air and nothing
 * stands against that side of it. The edge of the volume counts as open.
 * Slopes do not enter into it — a wall clipped by a ramp is still that face.
 */
export function faceExposed(voxel: ReadonlyVoxel, x: number, z: number, y: number, dir: number): boolean {
  if (voxelAt(voxel, x, z, y) === AIR) return false
  if (dir === FACE_TOP) return voxelAt(voxel, x, z, y + 1) === AIR
  if (dir === FACE_BOTTOM) return y > 0 && voxelAt(voxel, x, z, y - 1) === AIR
  const [dx, dz] = DIR_VECTORS[dir]
  return voxelAt(voxel, x + dx, z + dz, y) === AIR
}

/**
 * Whether column (x, z) walls its side `dir`: its top stands above the
 * neighbour's, the floor off the volume. What a fringe hangs from and a
 * picket stands against, and what an edge switch in `SurfacePaint.edges` is
 * kept for.
 */
export function wallStands(voxel: ReadonlyVoxel, x: number, z: number, dir: number): boolean {
  const [dx, dz] = DIR_VECTORS[dir]
  const beside = inBounds(voxel.size, x + dx, z + dz) ? topHeight(voxel, x + dx, z + dz) : 0
  return topHeight(voxel, x, z) > beside
}

/** Every column's top height, in half-tiles, indexed by cell — what the layer view's cap and slider read. */
export function columnHeights(voxel: ReadonlyVoxel): number[] {
  const out = new Array<number>(voxel.size.width * voxel.size.height)
  for (let z = 0; z < voxel.size.height; z++) for (let x = 0; x < voxel.size.width; x++) out[cellIndex(voxel.size, x, z)] = topHeight(voxel, x, z)
  return out
}

/**
 * Every face of one column that can draw, and so carries material layers:
 * each top with air above it — on an empty column, the bedrock floor at
 * `y = -1` — each exposed bottom, and each side whose neighbour at that
 * layer is not a full block. That last is wider than `faceExposed` on
 * purpose: a ramp or a slab beside a voxel leaves part of its side showing,
 * and the mesher draws that part. What `reconcileFaces` in `ops.ts` compares
 * before and after an edit, and what `settleFaces` keeps.
 */
export function exposedFacesOf(voxel: ReadonlyVoxel, x: number, z: number): string[] {
  const out: string[] = []
  if (columnTopAt(voxel, x, z) < 0) out.push(faceKey(x, z, -1, FACE_TOP))
  for (let y = 0; y < voxel.layers; y++) {
    if (voxelAt(voxel, x, z, y) === AIR) continue
    for (let dir = 0; dir < 4; dir++) {
      const [dx, dz] = DIR_VECTORS[dir]
      if (voxelAt(voxel, x + dx, z + dz, y) !== SHAPE_BLOCK) out.push(faceKey(x, z, y, dir))
    }
    if (faceExposed(voxel, x, z, y, FACE_TOP)) out.push(faceKey(x, z, y, FACE_TOP))
    if (faceExposed(voxel, x, z, y, FACE_BOTTOM)) out.push(faceKey(x, z, y, FACE_BOTTOM))
  }
  return out
}

/** How `fillColumn` paints the column it stands: its top, its sides (the top's material when absent), and a sloped top shape. */
export interface ColumnFill {
  material: number
  sides?: number
  shape?: number
}

/**
 * Stand a column at `height` half-tiles by writing the volume directly: for
 * building a map before it has a store — a fixture, a test. It paints the
 * column's top and every side of every voxel it holds, hidden or not, and
 * any side of a neighbour it uncovers that has no paint; call `settleFaces`
 * once the volume is built to drop the faces nothing can see.
 * An edit goes through `columnPatches` and `reconcileFaces` in `ops.ts`
 * instead, and the document actor.
 */
export function fillColumn(voxel: VoxelStructure, x: number, z: number, height: number, fill: ColumnFill = { material: 0 }): void {
  const shapes = columnShapes(voxel.layers, height, fill.shape)
  for (let y = -1; y < voxel.layers; y++) for (let dir = 0; dir < 6; dir++) delete voxel.paint.faces[faceKey(x, z, y, dir)]
  let top = -1
  for (let y = 0; y < voxel.layers; y++) {
    voxel.voxels.shape[voxelIndex(voxel, x, z, y)] = shapes[y]
    if (shapes[y] === AIR) continue
    top = y
    for (let dir = 0; dir < 4; dir++) voxel.paint.faces[faceKey(x, z, y, dir)] = layersOf(fill.sides ?? fill.material)
  }
  voxel.paint.faces[faceKey(x, z, top, FACE_TOP)] = layersOf(fill.material)
  // A neighbour's side this column no longer covers shows now: it takes the neighbour's top, so a hole is not magenta.
  for (let dir = 0; dir < 4; dir++) {
    const [dx, dz] = DIR_VECTORS[dir]
    const nx = x + dx
    const nz = z + dz
    if (!inBounds(voxel.size, nx, nz)) continue
    const theirs = voxel.paint.faces[faceKey(nx, nz, columnTopAt(voxel, nx, nz), FACE_TOP)] ?? layersOf(fill.material)
    for (let y = 0; y < voxel.layers; y++) {
      const key = faceKey(nx, nz, y, (dir + 2) % 4)
      if (voxelAt(voxel, nx, nz, y) !== AIR && shapes[y] !== SHAPE_BLOCK && !voxel.paint.faces[key]) voxel.paint.faces[key] = [...theirs]
    }
  }
}

/**
 * Bring a hand-built volume's paint in line with its faces: drop the stack of
 * every face nothing can see, and give every face that can be seen and has
 * none `material` on its first layer — or leave it unpainted, when no
 * material is given.
 */
export function settleFaces(voxel: VoxelStructure, material?: number): void {
  const faces: Record<string, MaterialLayers> = {}
  for (let z = 0; z < voxel.size.height; z++) {
    for (let x = 0; x < voxel.size.width; x++) {
      for (const key of exposedFacesOf(voxel, x, z)) {
        const stack = voxel.paint.faces[key] ?? (material === undefined ? undefined : layersOf(material))
        if (stack) faces[key] = stack
      }
    }
  }
  voxel.paint.faces = faces
}

/**
 * The voxels a column holds when its top stands at `height` half-tiles: a
 * block per full cube, a slab for an odd half-tile, `topShape` for the top
 * voxel when given (a ramp cell is a column whose top voxel slopes). Returned
 * as one shape per layer, AIR above the top, so a caller can diff it against
 * the column as it is.
 */
export function columnShapes(layers: number, height: number, topShape?: number): number[] {
  const out = new Array<number>(layers).fill(AIR)
  const full = Math.floor(height / 2)
  for (let y = 0; y < Math.min(full, layers); y++) out[y] = SHAPE_BLOCK
  if (height % 2 === 1 && full < layers) out[full] = SHAPE_SLAB
  const top = height % 2 === 1 ? full : full - 1
  if (topShape !== undefined && top >= 0 && top < layers) out[top] = topShape
  return out
}
