/**
 * Moving voxels (design round of 2026-09-19, "Move"; the selection drives the
 * terrain tools, 2026-09-20): some of a volume's voxels carried by an offset,
 * with their paint, and the volume left honest behind them.
 *
 * A move is dragged, and a drag goes out and comes back, so it is never
 * computed from the volume as the last tick left it. It is computed from a
 * SNAPSHOT taken at the press: `movedVolume` says what the whole volume
 * should be for an offset from there, and `volumePatches` says what to change
 * in the document as it stands to make it so. Dragging back to where it
 * started therefore puts everything back exactly, and the stroke's patch
 * compaction makes the whole drag one undo step.
 *
 * What a move does:
 *   - the voxels go, leaving air, or a copy when asked;
 *   - they REPLACE whatever solid they land on, as a paste does;
 *   - their paint goes with them, face for face, pasted tiles and all;
 *   - faces that end up buried lose their stacks, and faces that become
 *     exposed and have none take one from beside them — there is no dormant
 *     paint (ruling of 2026-09-18);
 *   - an edge's switch goes with a column whose top moved, and one whose wall
 *     no longer stands is dropped;
 *   - what stands on a voxel that moves rides with it, and everything is set
 *     down on whatever is under it afterwards;
 *   - the offset is clamped so nothing leaves the volume.
 *
 * Pure: arrays and records in, arrays and records out.
 */

import { AIR, DIR_VECTORS, inBounds, type DeepReadonly, type EdgeSwitch, type MapObject, type MaterialLayers, type ReadonlyMapDoc } from './document'
import type { Patch } from './edits'
import { FACE_BOTTOM, FACE_TOP, edgeKey, faceKey, parseFaceKey } from './paint'
import { parseVoxelKey, voxelKey } from './region'
import type { ReadonlyVoxel } from './structure'
import { frameOf, groundHeight, toLocal, toWorld } from './terrain'
import { columnTopAt, exposedFacesOf, voxelIndex, wallStands } from './voxels'

/** A volume's solid and paint as they were at a press: what every tick of a move is computed from. */
export interface VolumeSnapshot {
  readonly shape: readonly number[]
  readonly faces: Readonly<Record<string, MaterialLayers>>
  readonly edges: Readonly<Record<string, EdgeSwitch>>
}

/** An offset in voxels: east, south, and up. Whole voxels each way; a voxel is a cube. */
export interface VoxelOffset {
  readonly dx: number
  readonly dz: number
  readonly dy: number
}

export function snapshotVolume(voxel: ReadonlyVoxel): VolumeSnapshot {
  const faces: Record<string, MaterialLayers> = {}
  for (const [key, stack] of Object.entries(voxel.paint.faces)) faces[key] = [...stack] as MaterialLayers
  return { shape: [...voxel.voxels.shape], faces, edges: { ...voxel.paint.edges } }
}

/** The offset nearest the one asked for that keeps every voxel of `keys` inside the volume. */
export function clampOffset(voxel: ReadonlyVoxel, keys: readonly string[], offset: VoxelOffset): VoxelOffset {
  if (keys.length === 0) return { dx: 0, dz: 0, dy: 0 }
  const cells = keys.map(parseVoxelKey)
  const span = (pick: (v: { x: number; z: number; y: number }) => number): [number, number] => [Math.min(...cells.map(pick)), Math.max(...cells.map(pick))]
  const within = (wanted: number, [lo, hi]: [number, number], size: number): number => Math.max(-lo, Math.min(size - 1 - hi, wanted))
  return {
    dx: within(offset.dx, span((v) => v.x), voxel.size.width),
    dz: within(offset.dz, span((v) => v.z), voxel.size.height),
    dy: within(offset.dy, span((v) => v.y), voxel.layers),
  }
}

/** The keys a selection has once it has moved: what is selected afterwards. */
export function offsetKeys(keys: readonly string[], offset: VoxelOffset): string[] {
  return keys.map((key) => {
    const v = parseVoxelKey(key)
    return voxelKey(v.x + offset.dx, v.z + offset.dz, v.y + offset.dy)
  })
}

/**
 * What the volume should be with `keys` moved by `offset` from how it was at the press. `offset` is taken as given:
 * clamp it first. `copy` leaves the voxels where they were as well.
 */
export function movedVolume(voxel: ReadonlyVoxel, before: VolumeSnapshot, keys: readonly string[], offset: VoxelOffset, copy: boolean): VolumeSnapshot {
  const { dx, dz, dy } = offset
  if ((dx === 0 && dz === 0 && dy === 0) || keys.length === 0) return before
  const { width } = voxel.size
  const shape = [...before.shape]
  const faces: Record<string, MaterialLayers> = { ...before.faces }
  const moving = keys.map(parseVoxelKey).filter((v) => before.shape[voxelIndex(voxel, v.x, v.z, v.y)] !== AIR)
  const ALL_FACES = [0, 1, 2, 3, FACE_TOP, FACE_BOTTOM]

  // Lift them out, paint and all, then set them down: in two passes, so a voxel moving into the place another of the
  // selection is leaving does not find it gone.
  const carried: Array<{ x: number; z: number; y: number; shape: number; paint: Array<[number, MaterialLayers]> }> = []
  for (const v of moving) {
    const paint: Array<[number, MaterialLayers]> = []
    for (const dir of ALL_FACES) {
      const stack = before.faces[faceKey(v.x, v.z, v.y, dir)]
      if (stack) paint.push([dir, stack])
      if (!copy) delete faces[faceKey(v.x, v.z, v.y, dir)]
    }
    carried.push({ x: v.x + dx, z: v.z + dz, y: v.y + dy, shape: before.shape[voxelIndex(voxel, v.x, v.z, v.y)], paint })
    if (!copy) shape[voxelIndex(voxel, v.x, v.z, v.y)] = AIR
  }
  for (const c of carried) {
    shape[voxelIndex(voxel, c.x, c.z, c.y)] = c.shape
    // It replaces what was there, and what was there had paint of its own.
    for (const dir of ALL_FACES) delete faces[faceKey(c.x, c.z, c.y, dir)]
    for (const [dir, stack] of c.paint) faces[faceKey(c.x, c.z, c.y, dir)] = stack
  }

  const beforeVoxel = { ...voxel, voxels: { shape: before.shape } } as ReadonlyVoxel
  // Settle the columns the move touched, and the ones beside them, whose sides it may have bared or buried.
  const after: ReadonlyVoxel = { ...voxel, voxels: { shape } }
  const touched = new Set<number>()
  const touch = (x: number, z: number): void => {
    if (!inBounds(voxel.size, x, z)) return
    touched.add(z * width + x)
    for (const [ox, oz] of DIR_VECTORS) if (inBounds(voxel.size, x + ox, z + oz)) touched.add((z + oz) * width + x + ox)
  }
  for (const v of moving) {
    touch(v.x, v.z)
    touch(v.x + dx, v.z + dz)
  }
  /** A stack for a face that has come into the open with none: from the same side of the voxel under or over it, else any face of its voxel, else the top its column had. */
  const inherit = (x: number, z: number, y: number, dir: number): MaterialLayers | undefined => {
    const oldTop = before.faces[faceKey(x, z, columnTopAt(beforeVoxel, x, z), FACE_TOP)]
    const beside = dir < 4 ? [faces[faceKey(x, z, y - 1, dir)], faces[faceKey(x, z, y + 1, dir)]] : []
    return [...beside, ...ALL_FACES.map((d) => faces[faceKey(x, z, y, d)]), oldTop].find((stack) => stack !== undefined)
  }
  // One pass over the paint rather than one a column: a map holds thousands of faces and a move touches hundreds of columns.
  const exposed = new Map<number, Set<string>>()
  for (const column of touched) exposed.set(column, new Set(exposedFacesOf(after, column % width, Math.floor(column / width))))
  for (const key of Object.keys(faces)) {
    const f = parseFaceKey(key)
    const open = exposed.get(f.z * width + f.x)
    if (open && !open.has(key)) delete faces[key]
  }
  for (const open of exposed.values()) {
    // Bottom up, so a wall bared over several layers carries one stack all the way.
    for (const key of [...open].sort((a, b) => parseFaceKey(a).y - parseFaceKey(b).y)) {
      if (faces[key]) continue
      const f = parseFaceKey(key)
      const stack = inherit(f.x, f.z, f.y, f.dir)
      if (stack) faces[key] = [...stack] as MaterialLayers
    }
  }

  // An edge's switch belongs to a column's wall: it goes with a column whose top moved, and a wall that no longer stands keeps none.
  const edges: Record<string, EdgeSwitch> = { ...before.edges }
  if (!copy) {
    const moved = new Set(moving.map((v) => voxelKey(v.x, v.z, v.y)))
    const lifted: Array<[string, EdgeSwitch]> = []
    for (const v of moving) {
      if (columnTopAt(beforeVoxel, v.x, v.z) !== v.y || !moved.has(voxelKey(v.x, v.z, v.y))) continue
      for (let dir = 0; dir < 4; dir++) {
        for (const end of ['top', 'foot'] as const) {
          const state = before.edges[edgeKey(v.x, v.z, dir, end)]
          if (state === undefined) continue
          delete edges[edgeKey(v.x, v.z, dir, end)]
          lifted.push([edgeKey(v.x + dx, v.z + dz, dir, end), state])
        }
      }
    }
    for (const [key, state] of lifted) edges[key] = state
  }
  for (const key of Object.keys(edges)) {
    const [x, z, dir] = key.split(',').map(Number)
    if (touched.has(z * width + x) && !wallStands(after, x, z, dir)) delete edges[key]
  }
  return { shape, faces, edges }
}

/** The patches that take the volume, as the document holds it now, to `wanted`. */
export function volumePatches(voxel: ReadonlyVoxel, wanted: VolumeSnapshot): Patch[] {
  const patches: Patch[] = []
  const now = voxel.voxels.shape
  for (let index = 0; index < wanted.shape.length; index++) if (now[index] !== wanted.shape[index]) patches.push({ t: 'voxel', id: voxel.id, field: 'shape', index, value: wanted.shape[index] })
  const same = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean => a === b || (a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => v === b[i]))
  for (const key of new Set([...Object.keys(voxel.paint.faces), ...Object.keys(wanted.faces)])) {
    if (!same(voxel.paint.faces[key], wanted.faces[key])) patches.push({ t: 'voxelPaint', id: voxel.id, layer: 'faces', key, value: wanted.faces[key] ? ([...wanted.faces[key]] as MaterialLayers) : undefined })
  }
  for (const key of new Set([...Object.keys(voxel.paint.edges), ...Object.keys(wanted.edges)])) {
    if (voxel.paint.edges[key] !== wanted.edges[key]) patches.push({ t: 'voxelPaint', id: voxel.id, layer: 'edges', key, value: wanted.edges[key] })
  }
  return patches
}

/** The objects of a map as they were at a press, by id: what a move's riders are carried from. */
export type ObjectsSnapshot = Readonly<Record<string, DeepReadonly<MapObject>>>

/** An object apart from the document's: this package has no DOM, and so no `structuredClone`. */
function cloneObject(object: DeepReadonly<MapObject>): MapObject {
  return { ...object, position: [...object.position], facing: { ...object.facing }, anchorCell: object.anchorCell ? [...object.anchorCell] : null }
}

export function snapshotObjects(doc: ReadonlyMapDoc): ObjectsSnapshot {
  return Object.fromEntries(Object.entries(doc.objects).map(([id, object]) => [id, cloneObject(object)]))
}

/**
 * The whole of a move as patches against the document as it stands: the volume taken to what `movedVolume` asks for,
 * and the objects with it. An object standing on a voxel that moves — its cell's top voxel, at the press, was one of
 * the selection — RIDES: it goes where the voxel goes. Every anchored object is then set on whatever is under it
 * afterwards, so one the move went under is lifted and one it left in the air comes down. A copy carries nothing: the
 * objects stay with the original.
 */
export function movePatches(doc: ReadonlyMapDoc, voxel: ReadonlyVoxel, before: VolumeSnapshot, objects: ObjectsSnapshot, keys: readonly string[], offset: VoxelOffset, copy: boolean): Patch[] {
  const wanted = movedVolume(voxel, before, keys, offset, copy)
  const patches = volumePatches(voxel, wanted)
  const beforeVoxel = { ...voxel, voxels: { shape: before.shape } } as ReadonlyVoxel
  const moving = new Set(keys)
  const after: ReadonlyMapDoc = { ...doc, structures: { ...doc.structures, [voxel.id]: { ...voxel, voxels: { shape: wanted.shape } } } }
  const frame = frameOf(doc, voxel.id)
  for (const [id, was] of Object.entries(objects)) {
    const now = doc.objects[id]
    if (!now || !was.anchorCell) continue
    const [lx, lz] = toLocal(frame, was.position[0], was.position[2])
    const [cx, cz] = [Math.floor(lx), Math.floor(lz)]
    const rides = !copy && inBounds(voxel.size, cx, cz) && moving.has(voxelKey(cx, cz, columnTopAt(beforeVoxel, cx, cz)))
    const [wx, wz] = rides ? toWorld(frame, lx + offset.dx, lz + offset.dz) : [was.position[0], was.position[2]]
    const position: [number, number, number] = [wx, groundHeight(after, wx, wz), wz]
    if (position.every((v, i) => Math.abs(v - now.position[i]) < 1e-6)) continue
    patches.push({ t: 'object', id, value: { ...cloneObject(now), position, anchorCell: [Math.floor(wx), Math.floor(wz)] } })
  }
  return patches
}
