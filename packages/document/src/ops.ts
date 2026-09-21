/**
 * Edit operations: functions from the document to patches. Nothing here
 * mutates; the store applies what these return and keeps the inverse.
 *
 * Terrain ops take the voxel structure they edit — patches carry its id —
 * so two volumes in one level never share an index. Object grounding asks
 * the whole level, since an object can stand on any structure.
 */

import type { Patch } from './edits'
import { DEFAULT_LAYERS, DIR_VECTORS, MATERIAL_LAYERS, NO_RAMP, NO_WATER, SHAPE_BLOCK, SHAPE_HALF_RAMP, SHAPE_SLAB, cellIndex, inBounds, newId, slotOf, tileSlot, worldHeight, type DeepReadonly, type EdgeEnd, type MapObject, type MaterialLayers, type ReadonlyMapDoc } from './document'
import { FACE_BOTTOM, FACE_TOP, edgeKey, faceKey, parseFaceKey, tintKey } from './paint'
import { descendantsOf, type Placement, type ProfilePoint, type QuarterTurn, type ReadonlySketch, type ReadonlyVoxel, type SketchStructure, type Structure } from './structure'
import { frameOf, groundHeight, toLocal, type Frame } from './terrain'
import { columnShapes, columnTopAt, exposedFacesOf, faceNear, wallStands, halfRampShape, halfRampUpShape, maxHeightOf, rampDirAt, rampShape, topHeight, topLayersAt, voxelIndex } from './voxels'

export type BrushShape = 'square' | 'circle'

export interface Brush {
  size: number
  shape: BrushShape
}

export type Cell = [number, number]

// --- cell selection ----------------------------------------------------------

export function brushCells(voxel: ReadonlyVoxel, cx: number, cy: number, brush: Brush): Cell[] {
  const cells: Cell[] = []
  const radius = Math.floor((brush.size - 1) / 2)
  const extra = (brush.size - 1) % 2
  for (let y = cy - radius; y <= cy + radius + extra; y++) {
    for (let x = cx - radius; x <= cx + radius + extra; x++) {
      if (!inBounds(voxel.size, x, y)) continue
      if (brush.shape === 'circle') {
        const dx = x - cx
        const dy = y - cy
        if (Math.hypot(dx, dy) > brush.size / 2) continue
      }
      cells.push([x, y])
    }
  }
  return cells
}

export function rectCells(voxel: ReadonlyVoxel, ax: number, ay: number, bx: number, by: number): Cell[] {
  const cells: Cell[] = []
  const x0 = Math.max(0, Math.min(ax, bx))
  const x1 = Math.min(voxel.size.width - 1, Math.max(ax, bx))
  const y0 = Math.max(0, Math.min(ay, by))
  const y1 = Math.min(voxel.size.height - 1, Math.max(ay, by))
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells.push([x, y])
  return cells
}

/** Flood fill over cells whose tops hold the same material layers at the same height, capped so a runaway fill stays interactive. */
export function fillCells(voxel: ReadonlyVoxel, sx: number, sy: number, limit = 4096): Cell[] {
  if (!inBounds(voxel.size, sx, sy)) return []
  const seed = cellIndex(voxel.size, sx, sy)
  const stackOf = (x: number, y: number) => JSON.stringify(topLayersAt(voxel, x, y) ?? null)
  const material = stackOf(sx, sy)
  const height = topHeight(voxel, sx, sy)
  const seen = new Set<number>([seed])
  const out: Cell[] = []
  const queue: Cell[] = [[sx, sy]]
  while (queue.length > 0 && out.length < limit) {
    const [x, y] = queue.shift() as Cell
    out.push([x, y])
    for (const [dx, dy] of DIR_VECTORS) {
      const nx = x + dx
      const ny = y + dy
      if (!inBounds(voxel.size, nx, ny)) continue
      const index = cellIndex(voxel.size, nx, ny)
      if (seen.has(index)) continue
      if (stackOf(nx, ny) !== material) continue
      if (topHeight(voxel, nx, ny) !== height) continue
      seen.add(index)
      queue.push([nx, ny])
    }
  }
  return out
}

// --- sculpt ------------------------------------------------------------------

export const MIN_HEIGHT = 0
/** The default ceiling in half-tiles; a volume's own is `maxHeightOf`. */
export const MAX_HEIGHT = DEFAULT_LAYERS * 2

/**
 * The shape patches that stand one column's top at `height` half-tiles:
 * voxels it gains become blocks, voxels it keeps become blocks where a slab
 * or a ramp would now be buried, voxels above the new top become air.
 * `topShape` puts a sloped shape on the top voxel, for a ramp cell. Water at
 * or below the new top drains (ruling of 2026-09-12).
 *
 * This moves no paint. A sculpt runs its column patches through
 * `reconcileFaces`, which gives the faces that appear their stacks and takes
 * them off the faces that go.
 */
export function columnPatches(voxel: ReadonlyVoxel, x: number, z: number, height: number, topShape?: number): Patch[] {
  const clamped = Math.min(maxHeightOf(voxel), Math.max(MIN_HEIGHT, height))
  const wanted = columnShapes(voxel.layers, clamped, topShape)
  const patches: Patch[] = []
  for (let y = 0; y < voxel.layers; y++) {
    const index = voxelIndex(voxel, x, z, y)
    if (voxel.voxels.shape[index] !== wanted[y]) patches.push({ t: 'voxel', id: voxel.id, field: 'shape', index, value: wanted[y] })
  }
  return [...patches, ...drainedBy(voxel, cellIndex(voxel.size, x, z), clamped)]
}

/**
 * The paint patches that keep faces and stacks in step across a set of
 * pending shape patches: a face that stops drawing loses its stack, a face
 * that starts gets one. There is no dormant paint (ruling of 2026-09-18).
 *
 * Until the sculpt tools are redone, a stack moves with the surface: a
 * column's new top takes its old top's stack (or a neighbour's top, when it
 * had none); a new side takes the stack of the same side below it, above it,
 * or beside it along the wall, else any side of its column at that layer,
 * else the column's old top. Faces are settled bottom up, so a cliff raised
 * several layers carries its stack all the way. A face with nothing to copy
 * stays unpainted and draws the fallback.
 */
export function reconcileFaces(voxel: ReadonlyVoxel, pending: readonly Patch[]): Patch[] {
  const { width, height } = voxel.size
  const shape = voxel.voxels.shape.slice()
  const columns = new Set<number>()
  for (const patch of pending) {
    if (patch.t !== 'voxel' || patch.id !== voxel.id || patch.field !== 'shape') continue
    shape[patch.index] = patch.value
    columns.add(patch.index % (width * height))
  }
  if (columns.size === 0) return []
  const after: ReadonlyVoxel = { ...voxel, voxels: { shape } }
  const touched = new Set<number>()
  for (const column of columns) {
    const x = column % width
    const z = Math.floor(column / width)
    touched.add(column)
    for (const [dx, dz] of DIR_VECTORS) if (inBounds(voxel.size, x + dx, z + dz)) touched.add(column + dz * width + dx)
  }

  const removed: string[] = []
  const added: { x: number; z: number; y: number; dir: number }[] = []
  for (const column of touched) {
    const x = column % width
    const z = Math.floor(column / width)
    const before = new Set(exposedFacesOf(voxel, x, z))
    const now = exposedFacesOf(after, x, z)
    const nowSet = new Set(now)
    for (const key of before) if (!nowSet.has(key)) removed.push(key)
    for (const key of now) if (!before.has(key)) added.push(parseFaceKey(key))
  }

  // Writes so far win over the record, and a face on its way out still lends its stack.
  const written = new Map<string, MaterialLayers | undefined>()
  const read = (x: number, z: number, y: number, dir: number): DeepReadonly<MaterialLayers> | undefined => {
    const key = faceKey(x, z, y, dir)
    return written.has(key) ? written.get(key) : voxel.paint.faces[key]
  }
  const oldTop = (x: number, z: number) => read(x, z, columnTopAt(voxel, x, z), FACE_TOP)
  const source = ({ x, z, y, dir }: { x: number; z: number; y: number; dir: number }): DeepReadonly<MaterialLayers> | undefined => {
    if (dir === FACE_TOP) {
      const own = oldTop(x, z)
      if (own) return own
      for (const [dx, dz] of DIR_VECTORS) {
        if (!inBounds(voxel.size, x + dx, z + dz)) continue
        const theirs = oldTop(x + dx, z + dz)
        if (theirs) return theirs
      }
      return undefined
    }
    if (dir === FACE_BOTTOM) return oldTop(x, z)
    const along = [(dir + 1) % 4, (dir + 3) % 4].map((d) => DIR_VECTORS[d])
    return (
      read(x, z, y - 1, dir) ??
      read(x, z, y + 1, dir) ??
      along.map(([dx, dz]) => read(x + dx, z + dz, y, dir)).find(Boolean) ??
      [0, 1, 2, 3].map((d) => read(x, z, y, d)).find(Boolean) ??
      oldTop(x, z)
    )
  }

  added.sort((a, b) => a.y - b.y)
  for (const face of added) {
    const stack = source(face)
    if (stack) written.set(faceKey(face.x, face.z, face.y, face.dir), [...stack] as MaterialLayers)
  }
  for (const key of removed) written.set(key, undefined)
  const patches: Patch[] = []
  for (const [key, value] of written) if (value !== undefined || voxel.paint.faces[key] !== undefined) patches.push({ t: 'voxelPaint', id: voxel.id, layer: 'faces', key, value })
  // An edge switched off goes with its wall: nothing is kept for a wall that is not there.
  for (const column of touched) {
    const x = column % width
    const z = Math.floor(column / width)
    for (let dir = 0; dir < 4; dir++) {
      if (wallStands(after, x, z, dir)) continue
      for (const end of ['top', 'foot'] as const) {
        const key = edgeKey(x, z, dir, end)
        if (voxel.paint.edges[key] !== undefined) patches.push({ t: 'voxelPaint', id: voxel.id, layer: 'edges', key, value: undefined })
      }
    }
  }
  return patches
}

/** Shape patches with the paint that keeps up with them and the objects that stand on them. */
function sculpted(doc: ReadonlyMapDoc, voxel: ReadonlyVoxel, cells: Cell[], shapes: Patch[]): Patch[] {
  return [...shapes, ...reconcileFaces(voxel, shapes), ...regroundObjects(doc, voxel, cells, shapes)]
}

export function raise(doc: ReadonlyMapDoc, voxel: ReadonlyVoxel, cells: Cell[], delta: number): Patch[] {
  return sculpted(doc, voxel, cells, cells.flatMap(([x, y]) => columnPatches(voxel, x, y, topHeight(voxel, x, y) + delta)))
}

/** Water cannot sit at or below the terrain under it (ruling of 2026-09-12): a column raised to its water line drains. */
function drainedBy(voxel: ReadonlyVoxel, index: number, height: number): Patch[] {
  const water = voxel.water[index]
  return water !== NO_WATER && height >= water ? [{ t: 'voxel', id: voxel.id, field: 'water', index, value: NO_WATER }] : []
}

export function flatten(doc: ReadonlyMapDoc, voxel: ReadonlyVoxel, cells: Cell[], height: number): Patch[] {
  return sculpted(doc, voxel, cells, cells.flatMap(([x, y]) => columnPatches(voxel, x, y, height)))
}

/** Each column moves toward the mean of its in-bounds neighbours' tops by at most `strength` half-tiles. */
export function smooth(doc: ReadonlyMapDoc, voxel: ReadonlyVoxel, cells: Cell[], strength: number): Patch[] {
  const patches = cells.flatMap(([x, y]) => {
    let sum = 0
    let count = 0
    for (const [dx, dy] of DIR_VECTORS) {
      if (!inBounds(voxel.size, x + dx, y + dy)) continue
      sum += topHeight(voxel, x + dx, y + dy)
      count += 1
    }
    if (count === 0) return []
    const current = topHeight(voxel, x, y)
    const step = Math.max(-strength, Math.min(strength, Math.round(sum / count) - current))
    return step === 0 ? [] : columnPatches(voxel, x, y, current + step)
  })
  return sculpted(doc, voxel, cells, patches)
}

/**
 * Put `material` on material layer `layer` of each column's top face — the floor, for an empty column; `null` empties
 * that layer. With `at`, the face pressed, it is each column's top nearest that layer, or its underside nearest it:
 * the ground under a ledge, or the ledge's ceiling, and not always the highest thing the column has.
 */
export function setMaterial(voxel: ReadonlyVoxel, cells: Cell[], material: number | null, layer = 0, at?: { y: number; dir: typeof FACE_TOP | typeof FACE_BOTTOM }): Patch[] {
  const faces = cells.flatMap(([x, z]) => {
    if (!at) return [{ x, z, y: columnTopAt(voxel, x, z), dir: FACE_TOP }]
    const y = inBounds(voxel.size, x, z) ? faceNear(voxel, x, z, at.y, at.dir) : null
    return y === null ? [] : [{ x, z, y, dir: at.dir }]
  })
  return paintFace(voxel, faces, material, layer)
}

/** The cliff edge a ramp is cut from: the cell whose side `dir` stands above its neighbour. */
export interface RampEdge {
  x: number
  z: number
  dir: number
}

/** One cell of a ramp run: where it is, the height it is stood at, and the sloped shape on top. */
export interface RampStep {
  x: number
  z: number
  height: number
  shape: number
}

/**
 * The run a ramp needs from a cliff edge, bottom cell first: at 45° a full
 * ramp takes one cell per tile of drop, and a half ramp finishes an odd
 * half-tile — hugging the floor at the top of the run when the low side sits
 * on a whole tile, riding a slab at the bottom when it sits on one, so every
 * full ramp in between has a whole-tile floor. `null` when there is no drop.
 */
export function rampPlan(voxel: ReadonlyVoxel, edge: RampEdge): RampStep[] | null {
  const [dx, dz] = DIR_VECTORS[edge.dir]
  if (!inBounds(voxel.size, edge.x, edge.z) || !inBounds(voxel.size, edge.x + dx, edge.z + dz)) return null
  const low = topHeight(voxel, edge.x + dx, edge.z + dz)
  const high = topHeight(voxel, edge.x, edge.z)
  if (high <= low) return null
  const plan: RampStep[] = []
  let h = low
  for (let k = 0; h < high; k++) {
    const x = edge.x - k * dx
    const z = edge.z - k * dz
    if (h % 2 === 1) plan.push({ x, z, height: h + 1, shape: halfRampUpShape(edge.dir) })
    else if (high - h >= 2) plan.push({ x, z, height: h + 2, shape: rampShape(edge.dir) })
    else plan.push({ x, z, height: h + 1, shape: halfRampShape(edge.dir) })
    h = plan[plan.length - 1].height
  }
  return plan
}

/** How many cells a ramp from this edge takes, or `null` when there is no drop to ramp. */
export function rampRunLength(voxel: ReadonlyVoxel, edge: RampEdge): number | null {
  return rampPlan(voxel, edge)?.length ?? null
}

/**
 * Why a ramp cannot be cut from `edge`, in the artist's words, or `null`
 * when it can. A run may only be cut through ground that stands level with
 * the edge cell and is not already sloped: anything else would be silently
 * re-stood at the ramp's height (spec §4, "a run that does not meet the drop
 * is refused").
 */
export function rampRunBlocked(voxel: ReadonlyVoxel, edge: RampEdge): string | null {
  const plan = rampPlan(voxel, edge)
  if (!plan) return 'no drop at this edge'
  const high = topHeight(voxel, edge.x, edge.z)
  for (const step of plan) {
    if (!inBounds(voxel.size, step.x, step.z)) return 'the run would leave the volume'
    if (step.x === edge.x && step.z === edge.z) continue
    if (topHeight(voxel, step.x, step.z) !== high) return 'the ground behind the edge is not level with it'
    if (rampDirAt(voxel, step.x, step.z) !== NO_RAMP) return 'the run crosses another ramp'
  }
  return null
}

/**
 * Cut a ramp of `run` cells back from a cliff edge, descending toward the
 * edge's side, every cell re-stood at the height a 45° slope needs there
 * with a sloped top voxel. Refused (empty) when `run` is not what the drop
 * needs, or when the run is blocked (`rampRunBlocked`).
 */
export function rampRun(doc: ReadonlyMapDoc, voxel: ReadonlyVoxel, edge: RampEdge, run: number): Patch[] {
  const plan = rampPlan(voxel, edge)
  if (!plan || run !== plan.length || rampRunBlocked(voxel, edge) !== null) return []
  const cells: Cell[] = plan.map((step) => [step.x, step.z])
  return sculpted(doc, voxel, cells, plan.flatMap((step) => columnPatches(voxel, step.x, step.z, step.height, step.shape)))
}

/**
 * Remove the ramp under a cell: the run it belongs to — the cells along its
 * own axis whose tops slope the same way — goes level, a full ramp to a
 * block and a half ramp to what it rode on, so the heights stay and only
 * the slope goes. A run is one cell wide, as it was cut; a ramp beside it
 * is another run and stays.
 */
export function clearRampRun(doc: ReadonlyMapDoc, voxel: ReadonlyVoxel, x: number, z: number): Patch[] {
  const dir = rampDirAt(voxel, x, z)
  if (dir === NO_RAMP) return []
  const seen = new Set<number>([cellIndex(voxel.size, x, z)])
  const queue: Cell[] = [[x, z]]
  const cells: Cell[] = []
  const patches: Patch[] = []
  while (queue.length > 0) {
    const [cx, cz] = queue.shift() as Cell
    cells.push([cx, cz])
    const top = columnTopAt(voxel, cx, cz)
    const index = voxelIndex(voxel, cx, cz, top)
    const shape = voxel.voxels.shape[index]
    patches.push({ t: 'voxel', id: voxel.id, field: 'shape', index, value: shape >= SHAPE_HALF_RAMP && shape < SHAPE_HALF_RAMP + 4 ? SHAPE_SLAB : SHAPE_BLOCK })
    const [ax, az] = DIR_VECTORS[dir]
    for (const [dx, dz] of [
      [ax, az],
      [-ax, -az],
    ]) {
      const nx = cx + dx
      const nz = cz + dz
      if (!inBounds(voxel.size, nx, nz)) continue
      const key = cellIndex(voxel.size, nx, nz)
      if (seen.has(key) || rampDirAt(voxel, nx, nz) !== dir) continue
      seen.add(key)
      queue.push([nx, nz])
    }
  }
  return sculpted(doc, voxel, cells, patches)
}

/** Water at or below the terrain is not a state (ruling of 2026-09-12): such cells are left alone. */
export function setWater(voxel: ReadonlyVoxel, cells: Cell[], level: number | null): Patch[] {
  const patches: Patch[] = []
  for (const [x, y] of cells) {
    const index = cellIndex(voxel.size, x, y)
    if (level !== null && level <= topHeight(voxel, x, y)) continue
    patches.push({ t: 'voxel', id: voxel.id, field: 'water', index, value: level === null ? NO_WATER : level })
  }
  return patches
}

// --- paint -------------------------------------------------------------------

/** One face of one voxel: the cell, the layer, and the side (0–3, FACE_TOP, FACE_BOTTOM). */
export interface FaceRef {
  x: number
  z: number
  y: number
  dir: number
}

/**
 * Put `material` on material layer `layer` of each face, keeping its other
 * layers; `null` empties that layer. A face with no stack yet gets one.
 */
export function paintFace(voxel: ReadonlyVoxel, faces: readonly FaceRef[], material: number | null, layer = 0): Patch[] {
  const slot = material === null ? null : slotOf(material)
  const patches: Patch[] = []
  for (const face of faces) {
    const key = faceKey(face.x, face.z, face.y, face.dir)
    const stack = [...(voxel.paint.faces[key] ?? new Array(MATERIAL_LAYERS).fill(null))] as MaterialLayers
    if (stack[layer] === slot) continue
    stack[layer] = slot
    patches.push({ t: 'voxelPaint', id: voxel.id, layer: 'faces', key, value: stack })
  }
  return patches
}

/**
 * The faces a stamp `across` wide and `down` tall covers from `origin`, its top-left (ruling of 2026-09-18): on a top,
 * north up — across is +x, down is +z, each column's own top face whatever its height; on a side, upright as the wall
 * is seen from outside — across runs along the side left to right, down is a course lower. A cell of the stamp that
 * lands on no face (off the volume, past the wall's end, below the ground) is `null`: a stamp writes no dormant paint.
 */
export function stampFaces(voxel: ReadonlyVoxel, origin: FaceRef, across: number, down: number): (FaceRef | null)[][] {
  const rows: (FaceRef | null)[][] = []
  for (let r = 0; r < down; r++) {
    const row: (FaceRef | null)[] = []
    for (let c = 0; c < across; c++) {
      let face: FaceRef | null = null
      if (origin.dir === FACE_TOP) {
        const x = origin.x + c
        const z = origin.z + r
        if (inBounds(voxel.size, x, z)) face = { x, z, y: columnTopAt(voxel, x, z), dir: FACE_TOP }
      } else if (origin.dir !== FACE_BOTTOM) {
        const [nx, nz] = DIR_VECTORS[origin.dir]
        // Along the side left to right, seen from outside: the normal turned a quarter clockwise, looking down.
        face = { x: origin.x + nz * c, z: origin.z - nx * c, y: origin.y - r, dir: origin.dir }
      }
      row.push(face && inBounds(voxel.size, face.x, face.z) && exposedFacesOf(voxel, face.x, face.z).includes(faceKey(face.x, face.z, face.y, face.dir)) ? face : null)
    }
    rows.push(row)
  }
  return rows
}

/**
 * Paste an image's tiles whole across faces into material layer `layer`: `tiles` is the stamp, rows top to bottom, each
 * a tile's row-major index on the image's grid or `null` to clear that face's slot. It lands from `origin` as
 * `stampFaces` lays it out; what lands on no face is dropped.
 */
export function pasteTiles(voxel: ReadonlyVoxel, origin: FaceRef, image: number, tiles: readonly (readonly (number | null)[])[], layer = 0): Patch[] {
  const across = Math.max(0, ...tiles.map((row) => row.length))
  const faces = stampFaces(voxel, origin, across, tiles.length)
  const patches: Patch[] = []
  tiles.forEach((row, r) => {
    row.forEach((index, c) => {
      const face = faces[r][c]
      if (!face) return
      const slot = index === null ? null : tileSlot(image, index)
      const key = faceKey(face.x, face.z, face.y, face.dir)
      const stack = [...(voxel.paint.faces[key] ?? new Array(MATERIAL_LAYERS).fill(null))] as MaterialLayers
      if (stack[layer] === slot) return
      stack[layer] = slot
      patches.push({ t: 'voxelPaint', id: voxel.id, layer: 'faces', key, value: stack })
    })
  })
  return patches
}

/** One end of one wall: column (x, z)'s side `dir`, at its top (the fringe) or its foot (the picket). */
export interface EdgeRef {
  x: number
  z: number
  dir: number
  end: EdgeEnd
}

/** Switch these walls' fringes or pickets off, or back on to what the art does. Only a wall that stands takes a switch. */
export function setEdges(voxel: ReadonlyVoxel, edges: readonly EdgeRef[], on: boolean): Patch[] {
  const patches: Patch[] = []
  for (const edge of edges) {
    if (!inBounds(voxel.size, edge.x, edge.z) || !wallStands(voxel, edge.x, edge.z, edge.dir)) continue
    const key = edgeKey(edge.x, edge.z, edge.dir, edge.end)
    if ((voxel.paint.edges[key] === 'off') === !on) continue
    patches.push({ t: 'voxelPaint', id: voxel.id, layer: 'edges', key, value: on ? undefined : 'off' })
  }
  return patches
}

export function paintTint(voxel: ReadonlyVoxel, cells: Cell[], color: number | undefined): Patch[] {
  return cells.map(([x, y]) => ({ t: 'voxelPaint', id: voxel.id, layer: 'tint', key: tintKey(x, y), value: color }))
}

// --- objects -----------------------------------------------------------------

export function addObject(doc: ReadonlyMapDoc, object: MapObject): Patch[] {
  return [
    { t: 'object', id: object.id, value: object },
    { t: 'objectOrder', value: [...doc.objectOrder, object.id] },
  ]
}

export function removeObject(doc: ReadonlyMapDoc, id: string): Patch[] {
  return [
    { t: 'object', id, value: undefined },
    { t: 'objectOrder', value: doc.objectOrder.filter((other) => other !== id) },
  ]
}

export function removeObjects(doc: ReadonlyMapDoc, ids: readonly string[]): Patch[] {
  const doomed = new Set(ids.filter((id) => doc.objects[id]))
  if (doomed.size === 0) return []
  return [
    ...[...doomed].map((id): Patch => ({ t: 'object', id, value: undefined })),
    { t: 'objectOrder', value: doc.objectOrder.filter((id) => !doomed.has(id)) },
  ]
}

export function updateObject(doc: ReadonlyMapDoc, id: string, changes: Partial<MapObject>): Patch[] {
  const existing = doc.objects[id]
  if (!existing) return []
  return [{ t: 'object', id, value: { ...cloneObject(existing), ...changes, id } }]
}

function cloneObject(object: DeepReadonly<MapObject>): MapObject {
  return {
    ...object,
    position: [...object.position],
    facing: { ...object.facing },
    anchorCell: object.anchorCell ? [...object.anchorCell] : null,
  }
}

/**
 * Objects anchored to cells a sculpt is about to change follow the ground:
 * the pending voxel patches are applied to a scratch copy of the volume and
 * every anchored object on a touched cell is re-grounded against the level
 * as it will be.
 */
export function regroundObjects(doc: ReadonlyMapDoc, voxel: ReadonlyVoxel, cells: Cell[], pending: Patch[]): Patch[] {
  if (doc.objectOrder.length === 0) return []
  const touched = new Set(cells.map(([x, y]) => `${x},${y}`))
  const shape = voxel.voxels.shape.slice()
  let changed = false
  for (const patch of pending) {
    if (patch.t !== 'voxel' || patch.id !== voxel.id || patch.field !== 'shape') continue
    shape[patch.index] = patch.value
    changed = true
  }
  if (!changed) return []
  const after: ReadonlyMapDoc = {
    ...doc,
    structures: { ...doc.structures, [voxel.id]: { ...voxel, voxels: { shape } } },
  }
  const patches: Patch[] = []
  for (const id of doc.objectOrder) {
    const object = doc.objects[id]
    if (!object?.anchorCell) continue
    const [ax, ay] = object.anchorCell
    if (!touched.has(`${ax},${ay}`)) continue
    const y = groundHeight(after, object.position[0], object.position[2])
    if (Math.abs(y - object.position[1]) < 1e-6) continue
    patches.push({
      t: 'object',
      id,
      value: { ...cloneObject(object), position: [object.position[0], y, object.position[2]] },
    })
  }
  return patches
}

/** Drop an object onto whatever is under it. */
export function groundedPosition(doc: ReadonlyMapDoc, worldX: number, worldZ: number): [number, number, number] {
  return [worldX, groundHeight(doc, worldX, worldZ), worldZ]
}

export function heightToWorld(halfTiles: number): number {
  return worldHeight(halfTiles)
}

// --- structures --------------------------------------------------------------

export function addStructure(doc: ReadonlyMapDoc, structure: Structure): Patch[] {
  return [
    { t: 'structure', id: structure.id, value: structure },
    { t: 'structureOrder', value: [...doc.structureOrder, structure.id] },
  ]
}

/** A structure and everything standing on it. */
export function removeStructure(doc: ReadonlyMapDoc, id: string): Patch[] {
  if (!doc.structures[id]) return []
  const doomed = new Set([id, ...descendantsOf(doc, id)])
  return [
    ...[...doomed].map((each): Patch => ({ t: 'structure', id: each, value: undefined })),
    { t: 'structureOrder', value: doc.structureOrder.filter((each) => !doomed.has(each)) },
  ]
}

export function renameStructure(doc: ReadonlyMapDoc, id: string, name: string): Patch[] {
  return doc.structures[id] ? [{ t: 'structure.meta', id, field: 'name', value: name }] : []
}

export function placeStructure(doc: ReadonlyMapDoc, id: string, placement: Placement): Patch[] {
  return doc.structures[id] ? [{ t: 'structure.meta', id, field: 'placement', value: { ...placement } }] : []
}

/**
 * Put a structure's origin at a world point, standing on `parent` (or the
 * root), with the placement re-measured in that parent's frame so where it
 * is and which way it faces in the world do not change with the parent —
 * a drag that carries a tier off its island and onto the ground. `snap`
 * rounds the placement in the new frame. Refused (empty) for the root, for
 * a parent that would make a cycle, and for one that is not there.
 */
export function placeStructureOnto(
  doc: ReadonlyMapDoc,
  id: string,
  parent: string | null,
  world: { readonly x: number; readonly z: number },
  snap: (value: number) => number = (value) => value,
): Patch[] {
  const structure = doc.structures[id]
  if (!structure || structure.parent === null) return []
  if (parent !== null && (parent === id || !doc.structures[parent] || descendantsOf(doc, id).includes(parent))) return []
  const from = frameOf(doc, structure.parent)
  const to = parent === null ? ROOT_FRAME : frameOf(doc, parent)
  const [lx, lz] = toLocal(to, world.x, world.z)
  const worldYaw = (from.yaw + structure.placement.yaw) % 4
  const placement: Placement = { x: snap(lx), z: snap(lz), yaw: ((worldYaw - to.yaw + 4) % 4) as QuarterTurn }
  const patches: Patch[] = []
  if (parent !== structure.parent) patches.push({ t: 'structure.meta', id, field: 'parent', value: parent })
  if (placement.x !== structure.placement.x || placement.z !== structure.placement.z || placement.yaw !== structure.placement.yaw || parent !== structure.parent)
    patches.push({ t: 'structure.meta', id, field: 'placement', value: placement })
  return patches
}

const ROOT_FRAME: Frame = { x: 0, z: 0, yaw: 0, y: 0 }

/** Move a structure under another (or to the root), keeping its placement as measured; refused when that would make a cycle. */
export function reparentStructure(doc: ReadonlyMapDoc, id: string, parent: string | null): Patch[] {
  if (!doc.structures[id]) return []
  if (parent !== null && (parent === id || !doc.structures[parent] || descendantsOf(doc, id).includes(parent))) return []
  return [{ t: 'structure.meta', id, field: 'parent', value: parent }]
}

// --- sketches ----------------------------------------------------------------

export const DEFAULT_WALL_PROFILE: SketchStructure['wall'] = {
  points: [
    { out: 0.8, t: 0 },
    { out: 0.44, t: 0.2 },
    { out: 0.18, t: 0.45 },
    { out: 0.04, t: 0.75 },
    { out: 0, t: 1 },
  ],
  smooth: true,
}

/** A fresh, open sketch on `parent` (or the ground), ready for its first point. */
export function createSketch(parent: string | null, name = 'Sketch', placement: Placement = { x: 0, z: 0, yaw: 0 }): SketchStructure {
  return {
    id: newId('sk'),
    kind: 'sketch',
    name,
    parent,
    placement,
    points: [],
    closed: false,
    layers: 3,
    wall: { points: DEFAULT_WALL_PROFILE.points.map((p) => ({ ...p })), smooth: DEFAULT_WALL_PROFILE.smooth },
    lip: 'skirt',
    capMaterial: 'grass',
    wallMaterial: 'earth',
  }
}

export type SketchChanges = Partial<Pick<SketchStructure, 'points' | 'closed' | 'layers' | 'wall' | 'lip' | 'capMaterial' | 'wallMaterial'>>

function sketchAt(doc: ReadonlyMapDoc, id: string): ReadonlySketch | undefined {
  const s = doc.structures[id]
  return s && s.kind === 'sketch' ? s : undefined
}

export function setSketch(doc: ReadonlyMapDoc, id: string, changes: SketchChanges): Patch[] {
  if (!sketchAt(doc, id)) return []
  const patches: Patch[] = []
  if (changes.points !== undefined) patches.push({ t: 'sketch', id, field: 'points', value: changes.points.map((p) => ({ ...p })) })
  if (changes.closed !== undefined) patches.push({ t: 'sketch', id, field: 'closed', value: changes.closed })
  if (changes.layers !== undefined) patches.push({ t: 'sketch', id, field: 'layers', value: changes.layers })
  if (changes.wall !== undefined) patches.push({ t: 'sketch', id, field: 'wall', value: { points: changes.wall.points.map((p) => ({ ...p })), smooth: changes.wall.smooth } })
  if (changes.lip !== undefined) patches.push({ t: 'sketch', id, field: 'lip', value: changes.lip })
  if (changes.capMaterial !== undefined) patches.push({ t: 'sketch', id, field: 'capMaterial', value: changes.capMaterial })
  if (changes.wallMaterial !== undefined) patches.push({ t: 'sketch', id, field: 'wallMaterial', value: changes.wallMaterial })
  return patches
}

function points(sketch: ReadonlySketch): ProfilePoint[] {
  return sketch.points.map((p) => ({ ...p }))
}

/** Append a point, or insert it before `at`. */
export function addSketchPoint(doc: ReadonlyMapDoc, id: string, point: ProfilePoint, at?: number): Patch[] {
  const sketch = sketchAt(doc, id)
  if (!sketch) return []
  const next = points(sketch)
  next.splice(at === undefined ? next.length : Math.max(0, Math.min(next.length, at)), 0, { ...point })
  return [{ t: 'sketch', id, field: 'points', value: next }]
}

export function updateSketchPoint(doc: ReadonlyMapDoc, id: string, index: number, changes: Partial<ProfilePoint>): Patch[] {
  const sketch = sketchAt(doc, id)
  if (!sketch || !sketch.points[index]) return []
  const next = points(sketch)
  next[index] = { ...next[index], ...changes }
  return [{ t: 'sketch', id, field: 'points', value: next }]
}

/** Remove a point; a closed sketch left with fewer than three opens again. */
export function deleteSketchPoint(doc: ReadonlyMapDoc, id: string, index: number): Patch[] {
  const sketch = sketchAt(doc, id)
  if (!sketch || !sketch.points[index]) return []
  const next = points(sketch)
  next.splice(index, 1)
  const patches: Patch[] = [{ t: 'sketch', id, field: 'points', value: next }]
  if (sketch.closed && next.length < 3) patches.push({ t: 'sketch', id, field: 'closed', value: false })
  return patches
}

/** Close an open sketch: three points make an outline. */
export function closeSketch(doc: ReadonlyMapDoc, id: string): Patch[] {
  const sketch = sketchAt(doc, id)
  if (!sketch || sketch.closed || sketch.points.length < 3) return []
  return [{ t: 'sketch', id, field: 'closed', value: true }]
}
