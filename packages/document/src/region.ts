/**
 * A region: some of a voxel volume's edges, faces or voxels, selected
 * (rulings of 2026-09-12, "App frame", and of 2026-09-20).
 *
 * The selection drives the terrain tools, and it is of one ELEMENT at a time,
 * as a 3D modeller's is: voxels are what Move, Fill and Carve act on, faces
 * what paint and extrusion act on, edges what fringes, pickets and rails act
 * on. A region says which, and holds the elements by the keys the document
 * already addresses them with — a face by `faceKey`, an edge by `edgeKey`, a
 * voxel by `voxelKey` here — so a verb can hand them straight to the
 * operation that changes them.
 *
 * Everything here is pure: what a press and a footprint select, how two
 * regions combine, how one grows, shrinks and inverts. Nothing is stored in
 * the map. A region lives on the view actor, and because the terrain can
 * change under it, `pruneRegion` says what is left of it afterwards.
 */

import { AIR, DIR_VECTORS, SHAPE_BLOCK, inBounds, type EdgeEnd } from './document'
import { FACE_BOTTOM, FACE_TOP, edgeKey, faceKey, parseFaceKey } from './paint'
import type { ReadonlyVoxel } from './structure'
import { SURFACE_CLIFF, type SurfaceAddress } from './surface'
import { columnTopAt, topHeight, voxelAt, wallStands } from './voxels'

export type RegionElement = 'voxel' | 'face' | 'edge'
export const REGION_ELEMENTS: readonly RegionElement[] = ['voxel', 'face', 'edge']

/** How a flat footprint becomes a selection: what the press touches, or on through the volume along the pressed face's normal. */
export type RegionDepth = 'surface' | 'through'

/** How a new selection meets the one there already. */
export type RegionCombine = 'replace' | 'add' | 'subtract' | 'intersect'

export interface Region {
  /** The voxel volume its elements belong to. */
  readonly structure: string
  readonly element: RegionElement
  /** The elements, by key, sorted and unique: two regions of the same things are equal as data. */
  readonly keys: readonly string[]
}

export function voxelKey(x: number, z: number, y: number): string {
  return `${x},${z},${y}`
}

export function parseVoxelKey(key: string): { x: number; z: number; y: number } {
  const [x, z, y] = key.split(',').map(Number)
  return { x, z, y }
}

export function parseEdgeKey(key: string): { x: number; z: number; dir: number; end: EdgeEnd } {
  const [x, z, dir, end] = key.split(',')
  return { x: Number(x), z: Number(z), dir: Number(dir), end: end as EdgeEnd }
}

/** A half-open range of voxel layers, `lo` up to but not `hi`: what the layer view leaves drawn. */
export interface LayerSpan {
  readonly lo: number
  readonly hi: number
}

const within = (span: LayerSpan | null, y: number): boolean => span === null || (y >= span.lo && y < span.hi)

/** Whether a face draws, and so can be selected: what `exposedFacesOf` lists, asked of one face. */
function faceExists(voxel: ReadonlyVoxel, x: number, z: number, y: number, dir: number): boolean {
  if (!inBounds(voxel.size, x, z)) return false
  // An empty column's top is the bedrock floor, at layer -1.
  if (y === -1) return dir === FACE_TOP && columnTopAt(voxel, x, z) < 0
  if (voxelAt(voxel, x, z, y) === AIR) return false
  if (dir === FACE_TOP) return voxelAt(voxel, x, z, y + 1) === AIR
  if (dir === FACE_BOTTOM) return y > 0 && voxelAt(voxel, x, z, y - 1) === AIR
  const [dx, dz] = DIR_VECTORS[dir]
  return voxelAt(voxel, x + dx, z + dz, y) !== SHAPE_BLOCK
}

function exists(voxel: ReadonlyVoxel, element: RegionElement, key: string): boolean {
  if (element === 'voxel') {
    const { x, z, y } = parseVoxelKey(key)
    return voxelAt(voxel, x, z, y) !== AIR
  }
  if (element === 'face') {
    const { x, z, y, dir } = parseFaceKey(key)
    return faceExists(voxel, x, z, y, dir)
  }
  const { x, z, dir } = parseEdgeKey(key)
  return inBounds(voxel.size, x, z) && wallStands(voxel, x, z, dir)
}

/** The edges that touch a cell: the tops of the walls it stands, and the feet of the walls that stand on it. */
function edgesOfCell(voxel: ReadonlyVoxel, x: number, z: number): string[] {
  const out: string[] = []
  for (let dir = 0; dir < 4; dir++) {
    if (wallStands(voxel, x, z, dir)) out.push(edgeKey(x, z, dir, 'top'))
    const [dx, dz] = DIR_VECTORS[dir]
    const opposite = (dir + 2) % 4
    if (inBounds(voxel.size, x + dx, z + dz) && wallStands(voxel, x + dx, z + dz, opposite)) out.push(edgeKey(x + dx, z + dz, opposite, 'foot'))
  }
  return out
}

/**
 * What a press selects: the elements of `element` under `cells`, the footprint, read from the face pressed.
 *
 * A press on a top takes each cell's top: its top face, its top voxel, the edges round it. A press on a cliff takes
 * that side of each cell at the pressed layer: the side face, the voxel behind it, the wall's two edges. `through`
 * carries on along the pressed face's normal as far as the volume goes: the whole column under a top, every layer of
 * the side under a cliff — within `span`, the layers the layer view leaves drawn.
 */
export function elementsUnder(voxel: ReadonlyVoxel, press: SurfaceAddress, cells: ReadonlyArray<readonly [number, number]>, element: RegionElement, depth: RegionDepth, span: LayerSpan | null = null): string[] {
  const out = new Set<string>()
  const onCliff = press.kind === SURFACE_CLIFF
  const pressedLayer = Math.floor(press.level / 2)
  for (const [x, z] of cells) {
    if (!inBounds(voxel.size, x, z)) continue
    const top = columnTopAt(voxel, x, z)
    if (element === 'edge') {
      // An edge has no depth: a wall has one top and one foot however tall it is.
      if (!onCliff) for (const key of edgesOfCell(voxel, x, z)) out.add(key)
      else if (wallStands(voxel, x, z, press.dir)) for (const end of ['top', 'foot'] as const) out.add(edgeKey(x, z, press.dir, end))
      continue
    }
    const layers = depth === 'through' ? Array.from({ length: voxel.layers }, (_, y) => y) : [onCliff ? pressedLayer : top]
    for (const y of layers) {
      if (!within(span, y)) continue
      if (element === 'voxel') {
        if (voxelAt(voxel, x, z, y) !== AIR) out.add(voxelKey(x, z, y))
      } else if (onCliff) {
        if (faceExists(voxel, x, z, y, press.dir)) out.add(faceKey(x, z, y, press.dir))
      } else if (depth === 'surface') {
        if (faceExists(voxel, x, z, y, FACE_TOP)) out.add(faceKey(x, z, y, FACE_TOP))
      } else {
        // Through a top: every face the column has at this layer.
        for (const dir of [0, 1, 2, 3, FACE_TOP, FACE_BOTTOM]) if (faceExists(voxel, x, z, y, dir)) out.add(faceKey(x, z, y, dir))
      }
    }
    // An empty column still has a top to select: the floor.
    if (element === 'face' && !onCliff && top < 0 && faceExists(voxel, x, z, -1, FACE_TOP)) out.add(faceKey(x, z, -1, FACE_TOP))
  }
  return [...out]
}

export function regionOf(structure: string, element: RegionElement, keys: Iterable<string>): Region {
  return { structure, element, keys: [...new Set(keys)].sort() }
}

/**
 * A new selection met with the one there already. One of another volume or another element cannot be added to or
 * taken from: adding replaces it, and the rest leave nothing, since nothing of the new kind was selected before.
 */
export function combineRegions(base: Region | null, next: Region, mode: RegionCombine): Region | null {
  const same = base !== null && base.structure === next.structure && base.element === next.element
  if (mode === 'replace' || (!same && mode === 'add')) return next.keys.length ? next : null
  if (!same) return null
  const incoming = new Set(next.keys)
  const keys = mode === 'add' ? [...base.keys, ...next.keys] : mode === 'subtract' ? base.keys.filter((k) => !incoming.has(k)) : base.keys.filter((k) => incoming.has(k))
  const out = regionOf(base.structure, base.element, keys)
  return out.keys.length ? out : null
}

/** What is left of a region once the terrain has changed under it; `null` when nothing is. */
export function pruneRegion(voxel: ReadonlyVoxel, region: Region): Region | null {
  const keys = region.keys.filter((key) => exists(voxel, region.element, key))
  return keys.length === 0 ? null : keys.length === region.keys.length ? region : { ...region, keys }
}

/**
 * The elements beside one, of its own kind: a voxel's six neighbours; a face's four in its own plane; an edge's two
 * along its wall. Whether they exist is the caller's question.
 */
function beside(element: RegionElement, key: string): string[] {
  if (element === 'voxel') {
    const { x, z, y } = parseVoxelKey(key)
    return [voxelKey(x + 1, z, y), voxelKey(x - 1, z, y), voxelKey(x, z + 1, y), voxelKey(x, z - 1, y), voxelKey(x, z, y + 1), voxelKey(x, z, y - 1)]
  }
  if (element === 'face') {
    const { x, z, y, dir } = parseFaceKey(key)
    if (dir === FACE_TOP || dir === FACE_BOTTOM) return DIR_VECTORS.map(([dx, dz]) => faceKey(x + dx, z + dz, y, dir))
    // Along the wall, and up and down it.
    const [ax, az] = DIR_VECTORS[(dir + 1) % 4]
    return [faceKey(x + ax, z + az, y, dir), faceKey(x - ax, z - az, y, dir), faceKey(x, z, y + 1, dir), faceKey(x, z, y - 1, dir)]
  }
  const { x, z, dir, end } = parseEdgeKey(key)
  const [ax, az] = DIR_VECTORS[(dir + 1) % 4]
  return [edgeKey(x + ax, z + az, dir, end), edgeKey(x - ax, z - az, dir, end)]
}

/** The rule a double-click takes "the whole" by (design pass of 2026-09-20). One per element so far, each the element's default. */
export type RegionMatch = 'run' | 'flat' | 'island'

/** The default rule for an element: the full edge, the flat a face is part of, the island a voxel is part of. */
export const DEFAULT_MATCH: Readonly<Record<RegionElement, RegionMatch>> = { edge: 'run', face: 'flat', voxel: 'island' }

/** How many elements a match may take before it stops: a guard, not a limit anyone should meet. */
const MATCH_LIMIT = 50_000

/** The height an edge's line lies at, in half-tiles: the wall's own top, or the top of the ground its foot stands on. */
function edgeHeight(voxel: ReadonlyVoxel, x: number, z: number, dir: number, end: EdgeEnd): number {
  if (end === 'top') return topHeight(voxel, x, z)
  const [dx, dz] = DIR_VECTORS[dir]
  return inBounds(voxel.size, x + dx, z + dz) ? topHeight(voxel, x + dx, z + dz) : 0
}

/**
 * The whole an element belongs to (design pass of 2026-09-20), which is what a double-click takes:
 *
 *   an edge's RUN     the straight line of edges of its kind at its height — one side of a plateau, one wall's foot —
 *                     stopping where the line turns or the height changes;
 *   a face's FLAT     the connected faces in its own plane: tops at its height and of its shape, or the wall it is
 *                     part of, every layer of it, whatever they are painted with;
 *   a voxel's ISLAND  everything connected to it without going below its layer, so a hill comes away from the
 *                     ground it stands on.
 *
 * Within `span`, the layers the layer view leaves drawn. An element that does not exist matches nothing.
 */
export function matchRegion(voxel: ReadonlyVoxel, element: RegionElement, key: string, span: LayerSpan | null = null): string[] {
  if (!exists(voxel, element, key)) return []
  if (element === 'edge') {
    const { x, z, dir, end } = parseEdgeKey(key)
    const height = edgeHeight(voxel, x, z, dir, end)
    const [ax, az] = DIR_VECTORS[(dir + 1) % 4]
    const out = [key]
    for (const step of [1, -1]) {
      for (let i = 1; i < MATCH_LIMIT; i++) {
        const [cx, cz] = [x + ax * i * step, z + az * i * step]
        if (!inBounds(voxel.size, cx, cz) || !wallStands(voxel, cx, cz, dir) || edgeHeight(voxel, cx, cz, dir, end) !== height) break
        out.push(edgeKey(cx, cz, dir, end))
      }
    }
    return out
  }
  // A flood over what is beside, kept to what belongs with the start.
  const start = element === 'voxel' ? parseVoxelKey(key) : parseFaceKey(key)
  const level = (f: { x: number; z: number; y: number }): number => (f.y < 0 ? AIR : voxelAt(voxel, f.x, f.z, f.y))
  const belongs = (other: string): boolean => {
    if (element === 'voxel') {
      const v = parseVoxelKey(other)
      return v.y >= start.y && within(span, v.y)
    }
    const f = parseFaceKey(other)
    // A top's plane is its layer and its shape: a slab's top is not a cube's, and a ramp's is its own.
    const flat = 'dir' in start && (start.dir === FACE_TOP || start.dir === FACE_BOTTOM)
    return (f.y < 0 || within(span, f.y)) && (!flat || level(f) === level(start))
  }
  const seen = new Set([key])
  const queue = [key]
  while (queue.length > 0 && seen.size < MATCH_LIMIT) {
    for (const other of beside(element, queue.pop() as string)) {
      if (seen.has(other) || !exists(voxel, element, other) || !belongs(other)) continue
      seen.add(other)
      queue.push(other)
    }
  }
  return [...seen]
}

/**
 * The one element under a press, where a footprint would take several: of the edges round a cell, the one nearest
 * the pointer — `fx`, `fz` are where in the cell it is, 0 to 1 — and of a wall's two, the top when the pointer is in
 * the wall's upper half (`upper`). Faces and voxels are already one to a press.
 */
export function elementAt(voxel: ReadonlyVoxel, press: SurfaceAddress, element: RegionElement, at: { fx: number; fz: number; upper: boolean }): string | null {
  const keys = elementsUnder(voxel, press, [[press.x, press.y]], element, 'surface')
  if (element !== 'edge' || keys.length <= 1) return keys[0] ?? null
  if (press.kind === SURFACE_CLIFF) return keys.find((key) => parseEdgeKey(key).end === (at.upper ? 'top' : 'foot')) ?? keys[0]
  // Which side of the pressed cell each edge lies along: a top's own side, or for a foot the side its wall stands on.
  const sideOf = (key: string): number => {
    const e = parseEdgeKey(key)
    return e.end === 'top' ? e.dir : (e.dir + 2) % 4
  }
  const distance = [1 - at.fx, 1 - at.fz, at.fx, at.fz]
  return [...keys].sort((a, b) => distance[sideOf(a)] - distance[sideOf(b)])[0]
}

/** The region and everything beside it. */
export function expandRegion(voxel: ReadonlyVoxel, region: Region): Region {
  const grown = region.keys.flatMap((key) => beside(region.element, key)).filter((key) => exists(voxel, region.element, key))
  return regionOf(region.structure, region.element, [...region.keys, ...grown])
}

/** The region without its rim: what is left when every element with an unselected neighbour goes. */
export function contractRegion(voxel: ReadonlyVoxel, region: Region): Region | null {
  const held = new Set(region.keys)
  const keys = region.keys.filter((key) => beside(region.element, key).every((other) => held.has(other) || !exists(voxel, region.element, other)))
  return keys.length ? { ...region, keys } : null
}

/** Every element of the region's kind that it does not hold, within `span`. */
export function invertRegion(voxel: ReadonlyVoxel, region: Region, span: LayerSpan | null = null): Region | null {
  const held = new Set(region.keys)
  const all: string[] = []
  for (let z = 0; z < voxel.size.height; z++) {
    for (let x = 0; x < voxel.size.width; x++) {
      if (region.element === 'edge') {
        for (let dir = 0; dir < 4; dir++) if (wallStands(voxel, x, z, dir)) all.push(edgeKey(x, z, dir, 'top'), edgeKey(x, z, dir, 'foot'))
        continue
      }
      for (let y = region.element === 'face' ? -1 : 0; y < voxel.layers; y++) {
        if (y >= 0 && !within(span, y)) continue
        if (region.element === 'voxel') {
          if (voxelAt(voxel, x, z, y) !== AIR) all.push(voxelKey(x, z, y))
        } else for (const dir of [0, 1, 2, 3, FACE_TOP, FACE_BOTTOM]) if (faceExists(voxel, x, z, y, dir)) all.push(faceKey(x, z, y, dir))
      }
    }
  }
  const keys = all.filter((key) => !held.has(key))
  return keys.length ? regionOf(region.structure, region.element, keys) : null
}

/** A region in words, for a bar: how many of what. */
export function describeRegion(region: Region): string {
  const n = region.keys.length
  const noun = region.element === 'voxel' ? 'voxel' : region.element
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}
