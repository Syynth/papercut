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
import { FACE_BOTTOM, FACE_TOP, edgeKey, edgeOff, faceKey, faceLayers, parseFaceKey } from './paint'
import type { ReadonlyVoxel } from './structure'
import { SURFACE_CLIFF, type SurfaceAddress } from './surface'
import { cornerHeights } from './terrain'
import { columnTopAt, isHalfRampShape, isRampShape, shapeHeight, voxelAt, wallStands } from './voxels'

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

/**
 * A rule for "the whole an element belongs to" (design pass of 2026-09-20). A double-click takes the element's default,
 * a triple-click the next whole out.
 */
export type RegionMatch = 'run' | 'loop' | 'sameKind' | 'sameTrim' | 'flat' | 'material' | 'tile' | 'surface' | 'wall' | 'layer' | 'island' | 'column' | 'samePiece'

/** The rules an element offers, its default first: what the Match row in Select's bar lists. */
export const MATCH_RULES: Readonly<Record<RegionElement, readonly RegionMatch[]>> = {
  edge: ['run', 'loop', 'sameKind', 'sameTrim'],
  face: ['flat', 'material', 'tile', 'surface', 'wall'],
  voxel: ['layer', 'island', 'column', 'samePiece'],
}

/**
 * The default rule for an element, which a double-click takes: the full edge, the flat a face is part of, the layer a
 * voxel is part of. A voxel's was its island until 2026-09-21: a layer can never take more than one storey, where an
 * island on level ground is the whole map.
 */
export const DEFAULT_MATCH: Readonly<Record<RegionElement, RegionMatch>> = { edge: 'run', face: 'flat', voxel: 'layer' }

/** The next whole out, which a triple-click takes: an edge's loop, a voxel's island; a top's surface, and a side's wall. */
export function widerMatch(element: RegionElement, key: string): RegionMatch {
  if (element === 'edge') return 'loop'
  if (element === 'voxel') return 'island'
  const { dir } = parseFaceKey(key)
  return dir === FACE_TOP || dir === FACE_BOTTOM ? 'surface' : 'wall'
}

export interface MatchOptions {
  /** The layers the layer view leaves drawn. */
  readonly span?: LayerSpan | null
  /** Whether an edge's run or loop carries on down a ramp's side and picks up the rim below. Absent is on. */
  readonly followSlopes?: boolean
  /**
   * Take every element the rule's test passes, connected to the start or not: "select similar". It means something
   * only for a rule that is a test of one element against the start — the same material, the same layer, the same
   * trim — and is ignored by the rules that are about how elements join: a run, a loop, a surface, a wall, an island.
   */
  readonly everywhere?: boolean
  /** How big a change of height still counts as the same ground to Surface, in half-tiles. Absent is 1: a slab or a ramp joins, a cliff does not. */
  readonly step?: number
  /** On a side face, keep to the clicked layer: one course of a wall. */
  readonly band?: boolean
  /** Material and Tile look at every layer of a face's stack rather than the one that shows on top. */
  readonly anyLayer?: boolean
}

/** How many elements a match may take before it stops: a guard, not a limit anyone should meet. */
const MATCH_LIMIT = 50_000

/** How big a change of height still counts as the same ground to a Surface match unless the caller says, in half-tiles. */
const SURFACE_STEP = 1

/** Where each side of a cell starts, and which way it runs, as the mesher has them: east, south, west, north. */
const SIDE_LINES: ReadonlyArray<{ readonly o: readonly [number, number]; readonly u: readonly [number, number] }> = [
  { o: [1, 1], u: [0, -1] },
  { o: [0, 1], u: [1, 0] },
  { o: [0, 0], u: [0, 1] },
  { o: [1, 0], u: [-1, 0] },
]
/** Which of a cell's corner heights is the corner at cell-local (cx, cz). */
const CORNER_AT = [[0, 1], [3, 2]] as const

/** An edge's two ends, as grid vertices, each with the height its line has there in half-tiles: the wall's own top, or the ground its foot stands on. */
function edgeEnds(voxel: ReadonlyVoxel, x: number, z: number, dir: number, end: EdgeEnd): Array<{ vx: number; vz: number; h: number }> {
  const { o, u } = SIDE_LINES[dir]
  const [nx, nz] = DIR_VECTORS[dir]
  return [o, [o[0] + u[0], o[1] + u[1]] as const].map(([cx, cz]) => {
    // A foot lies on the cell beside, where this cell's corner is that one's across the side.
    const [hx, hz, lx, lz] = end === 'top' ? [x, z, cx, cz] : [x + nx, z + nz, cx - nx, cz - nz]
    const h = inBounds(voxel.size, hx, hz) ? cornerHeights(voxel, hx, hz)[CORNER_AT[lx][lz]] : 0
    return { vx: x + cx, vz: z + cz, h }
  })
}

/**
 * An edge's run or its loop. Edges carry on from one to the next where they share an end AT THE SAME HEIGHT, which is
 * what makes a rim a rim. A run keeps to its own side, so it stops where the line turns; a loop goes round the corner,
 * outside or inside, until it comes back or runs out. Unless slopes are followed, it also keeps to level edges at the
 * height it started at, so it stops at a ramp; followed, it goes down the ramp's side and takes the rim it lands on.
 */
function matchEdges(voxel: ReadonlyVoxel, key: string, loop: boolean, followSlopes: boolean, keep: (other: string) => boolean = () => true, anyHeight = false): string[] {
  const start = parseEdgeKey(key)
  const startEnds = edgeEnds(voxel, start.x, start.z, start.dir, start.end)
  const level = (ends: ReadonlyArray<{ h: number }>): boolean => ends[0].h === ends[1].h
  const allowed = (ends: ReadonlyArray<{ h: number }>): boolean => anyHeight || followSlopes || (level(ends) && ends[0].h === startEnds[0].h)
  const seen = new Set([key])
  const queue = [key]
  while (queue.length > 0 && seen.size < MATCH_LIMIT) {
    const e = parseEdgeKey(queue.pop() as string)
    for (const at of edgeEnds(voxel, e.x, e.z, e.dir, e.end)) {
      // Every edge of the four cells round this vertex that ends here, at this height.
      for (const [cx, cz] of [[at.vx - 1, at.vz - 1], [at.vx, at.vz - 1], [at.vx - 1, at.vz], [at.vx, at.vz]]) {
        if (!inBounds(voxel.size, cx, cz)) continue
        for (let dir = 0; dir < 4; dir++) {
          if (!loop && dir !== start.dir) continue
          const other = edgeKey(cx, cz, dir, start.end)
          if (seen.has(other) || !wallStands(voxel, cx, cz, dir)) continue
          const ends = edgeEnds(voxel, cx, cz, dir, start.end)
          if (!ends.some((end) => end.vx === at.vx && end.vz === at.vz && (anyHeight || end.h === at.h)) || !allowed(ends) || !keep(other)) continue
          seen.add(other)
          queue.push(other)
        }
      }
    }
  }
  return [...seen]
}

/** The faces a Wall match carries on to from a side face: along the wall and up and down it, as a flat does, and round its corners, outside and inside. */
function besideOnWall(key: string): string[] {
  const { x, z, y, dir } = parseFaceKey(key)
  const [nx, nz] = DIR_VECTORS[dir]
  const out = beside('face', key)
  for (const turn of [1, 3]) {
    const along = (dir + turn) % 4
    const [ax, az] = DIR_VECTORS[along]
    // Outside: the same voxel's next side. Inside: the voxel diagonally ahead, facing back along the wall.
    out.push(faceKey(x, z, y, along), faceKey(x + nx + ax, z + nz + az, y, (along + 2) % 4))
  }
  return out
}

/**
 * The whole an element belongs to (design pass of 2026-09-20): what a double-click takes by the element's default rule,
 * and a triple-click by the next one out.
 *
 *   an edge's RUN      the straight line of edges of its kind — one side of a plateau, one wall's foot;
 *   an edge's LOOP     the same, round the corners: a plateau's whole rim;
 *   a face's FLAT      the connected faces in its own plane: tops at its height and of its shape, or the wall it is
 *                      part of, every layer of it, whatever they are painted with;
 *   a top's SURFACE    connected tops across steps of half a tile: the ground you could walk;
 *   a side's WALL      connected side faces, round corners and up and down: the whole cliff;
 *   a face's MATERIAL  connected faces of its kind showing the same material, across planes and heights; TILE, the
 *                      same pasted tile;
 *   a voxel's LAYER    the connected voxels of its own layer: one storey; COLUMN, straight down from it; SAME
 *                      PIECE, connected voxels of its shape: a run of ramps;
 *   an edge's SAME KIND and SAME TRIM   connected edges that are tops or feet like it, or switched on or off like it;
 *   a voxel's ISLAND   everything connected to it without going below its layer, so a hill leaves its ground behind.
 *
 * An element that does not exist matches nothing, as does a rule that is not its element's.
 */
export function matchRegion(voxel: ReadonlyVoxel, element: RegionElement, key: string, rule: RegionMatch = DEFAULT_MATCH[element], options: MatchOptions = {}): string[] {
  if (!exists(voxel, element, key) || !MATCH_RULES[element].includes(rule)) return []
  const span = options.span ?? null
  const everywhere = options.everywhere ?? false
  /** A rule that is a test of one element against the start can be asked of every element, connected or not. */
  const similar = (test: (other: string) => boolean): string[] => [...new Set([key, ...allElements(voxel, element, span).filter(test)])]

  if (element === 'edge') {
    if (rule === 'run' || rule === 'loop') return matchEdges(voxel, key, rule === 'loop', options.followSlopes ?? true)
    const start = parseEdgeKey(key)
    // An edge's trim is on unless someone switched it off; that is the state there is to share so far.
    const off = (e: { x: number; z: number; dir: number; end: EdgeEnd }): boolean => edgeOff(voxel.paint, e.x, e.z, e.dir, e.end)
    const test = (other: string): boolean => {
      const e = parseEdgeKey(other)
      return e.end === start.end && (rule === 'sameKind' || off(e) === off(start))
    }
    // Connected whatever way they turn and whatever their height: round corners, and across the steps of a terraced rim.
    return everywhere ? similar(test) : matchEdges(voxel, key, true, true, test, true)
  }

  // A flood over what is beside, kept to what belongs with the start.
  let next: (from: string) => string[]
  let belongs: (other: string, from: string) => boolean
  if (element === 'voxel') {
    const start = parseVoxelKey(key)
    const family = (shape: number): number => (isRampShape(shape) ? 2 : isHalfRampShape(shape) ? 3 : shape)
    const piece = family(voxelAt(voxel, start.x, start.z, start.y))
    if (rule === 'column') {
      // Straight down from the click, to the floor or to the first gap.
      const out = [key]
      for (let y = start.y - 1; y >= 0 && within(span, y) && voxelAt(voxel, start.x, start.z, y) !== AIR; y--) out.push(voxelKey(start.x, start.z, y))
      return out
    }
    // The pieces of a staircase never share a face: each ramp is a cell along and a layer down from the last. So Same
    // piece also steps along-and-up and along-and-down, which is how a run of ramps is connected.
    const stepped = (from: string): string[] => {
      const v = parseVoxelKey(from)
      return DIR_VECTORS.flatMap(([dx, dz]) => [voxelKey(v.x + dx, v.z + dz, v.y + 1), voxelKey(v.x + dx, v.z + dz, v.y - 1)])
    }
    next = (from) => (rule === 'samePiece' ? [...beside('voxel', from), ...stepped(from)] : beside('voxel', from))
    belongs = (other) => {
      const v = parseVoxelKey(other)
      if (!within(span, v.y)) return false
      if (rule === 'layer') return v.y === start.y
      if (rule === 'samePiece') return family(voxelAt(voxel, v.x, v.z, v.y)) === piece
      return v.y >= start.y
    }
    if (everywhere && (rule === 'layer' || rule === 'samePiece')) return similar((other) => belongs(other, key))
  } else {
    const start = parseFaceKey(key)
    const flatTop = start.dir === FACE_TOP || start.dir === FACE_BOTTOM
    const shape = (f: { x: number; z: number; y: number }): number => (f.y < 0 ? AIR : voxelAt(voxel, f.x, f.z, f.y))
    const height = (f: { x: number; z: number; y: number }): number => (f.y < 0 ? 0 : f.y * 2 + shapeHeight(shape(f)))
    const inSpan = (f: { y: number }): boolean => f.y < 0 || within(span, f.y)
    /** On a side face with Band on, only the clicked layer: one course of the wall. */
    const inBand = (f: { y: number; dir: number }): boolean => !(options.band ?? false) || flatTop || f.y === start.y
    /** The tops of the four cells beside, at any layer, or for a side the wall round its corners: how faces of one kind join across heights. */
    const across = (from: string): string[] => {
      const f = parseFaceKey(from)
      if (f.dir !== FACE_TOP) return f.dir === FACE_BOTTOM ? beside('face', from) : besideOnWall(from)
      return DIR_VECTORS.flatMap(([dx, dz]) => Array.from({ length: voxel.layers + 1 }, (_, i) => faceKey(f.x + dx, f.z + dz, i - 1, FACE_TOP)))
    }
    /** The kind of face the start is, which Material and Tile stay on: tops with tops, sides with sides. */
    const sameKindOfFace = (f: { dir: number }): boolean => (start.dir < 4 ? f.dir < 4 : f.dir === start.dir)
    if (rule === 'flat') {
      next = (from) => beside('face', from)
      // A top's plane is its layer and its shape: a slab's top is not a cube's, and a ramp's is its own.
      const test = (f: { x: number; z: number; y: number; dir: number }): boolean => inSpan(f) && inBand(f) && (!flatTop || shape(f) === shape(start))
      belongs = (other) => test(parseFaceKey(other))
      // Everywhere, a flat is every face in the start's plane: the same way up at the same height, or the same wall plane.
      if (everywhere) {
        const plane = (f: { x: number; z: number; y: number; dir: number }): number => (f.dir === FACE_TOP || f.dir === FACE_BOTTOM ? height(f) : f.dir % 2 === 0 ? f.x : f.z)
        return similar((other) => {
          const f = parseFaceKey(other)
          return f.dir === start.dir && plane(f) === plane(start) && test(f)
        })
      }
    } else if (rule === 'material' || rule === 'tile') {
      // What a face shows is the topmost slot it holds; the stack under it counts only when asked.
      const prefix = rule === 'material' ? 'm:' : 't:'
      const slotsOf = (f: { x: number; z: number; y: number; dir: number }): string[] => [...(faceLayers(voxel.paint, f.x, f.z, f.y, f.dir) ?? [])].filter((slot): slot is string => slot !== null)
      const wanted = slotsOf(start).filter((slot) => slot.startsWith(prefix)).pop()
      if (wanted === undefined) return [key]
      const test = (f: { x: number; z: number; y: number; dir: number }): boolean => {
        const slots = slotsOf(f)
        return inSpan(f) && inBand(f) && sameKindOfFace(f) && ((options.anyLayer ?? false) ? slots.includes(wanted) : slots[slots.length - 1] === wanted)
      }
      next = across
      belongs = (other) => test(parseFaceKey(other))
      if (everywhere) return similar((other) => test(parseFaceKey(other)))
    } else if (rule === 'surface' && start.dir === FACE_TOP) {
      const step = options.step ?? SURFACE_STEP
      next = across
      belongs = (other, from) => inSpan(parseFaceKey(other)) && Math.abs(height(parseFaceKey(other)) - height(parseFaceKey(from))) <= step
    } else if (rule === 'wall' && !flatTop) {
      next = besideOnWall
      belongs = (other) => {
        const f = parseFaceKey(other)
        return inSpan(f) && inBand(f) && f.dir < 4
      }
    } else return []
  }
  const seen = new Set([key])
  const queue = [key]
  while (queue.length > 0 && seen.size < MATCH_LIMIT) {
    const from = queue.pop() as string
    for (const other of next(from)) {
      if (seen.has(other) || !exists(voxel, element, other) || !belongs(other, from)) continue
      seen.add(other)
      queue.push(other)
    }
  }
  return [...seen]
}

/** Whether a rule means anything for the element clicked: Surface is a top's, Wall a side's. The rest are any element's of their kind. */
export function matchApplies(element: RegionElement, key: string, rule: RegionMatch): boolean {
  if (!MATCH_RULES[element].includes(rule)) return false
  if (element !== 'face') return true
  const { dir } = parseFaceKey(key)
  return rule === 'surface' ? dir === FACE_TOP : rule === 'wall' ? dir < 4 : true
}

/** Every selected edge's other end as well: a top takes its wall's foot, a foot its top — from "this rim" to "this cliff's trims". */
export function pairRegion(region: Region): Region {
  if (region.element !== 'edge') return region
  const others = region.keys.map((key) => {
    const e = parseEdgeKey(key)
    return edgeKey(e.x, e.z, e.dir, e.end === 'top' ? 'foot' : 'top')
  })
  return regionOf(region.structure, 'edge', [...region.keys, ...others])
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

/** Every element of a kind the volume has, within `span`. */
function allElements(voxel: ReadonlyVoxel, element: RegionElement, span: LayerSpan | null): string[] {
  const all: string[] = []
  for (let z = 0; z < voxel.size.height; z++) {
    for (let x = 0; x < voxel.size.width; x++) {
      if (element === 'edge') {
        for (let dir = 0; dir < 4; dir++) if (wallStands(voxel, x, z, dir)) all.push(edgeKey(x, z, dir, 'top'), edgeKey(x, z, dir, 'foot'))
        continue
      }
      for (let y = element === 'face' ? -1 : 0; y < voxel.layers; y++) {
        if (y >= 0 && !within(span, y)) continue
        if (element === 'voxel') {
          if (voxelAt(voxel, x, z, y) !== AIR) all.push(voxelKey(x, z, y))
        } else for (const dir of [0, 1, 2, 3, FACE_TOP, FACE_BOTTOM]) if (faceExists(voxel, x, z, y, dir)) all.push(faceKey(x, z, y, dir))
      }
    }
  }
  return all
}

/** Every element of the region's kind that it does not hold, within `span`. */
export function invertRegion(voxel: ReadonlyVoxel, region: Region, span: LayerSpan | null = null): Region | null {
  const held = new Set(region.keys)
  const keys = allElements(voxel, region.element, span).filter((key) => !held.has(key))
  return keys.length ? regionOf(region.structure, region.element, keys) : null
}

/**
 * Where a region of voxels is held from: the middle of its footprint, on top of its highest layer, in the volume's own
 * cells and layers. What Move's axis handles stand on, and the line each of them drags along.
 */
export function regionAnchor(keys: readonly string[]): [number, number, number] | null {
  if (keys.length === 0) return null
  const cells = keys.map(parseVoxelKey)
  const mid = (pick: (v: { x: number; z: number; y: number }) => number): number => (Math.min(...cells.map(pick)) + Math.max(...cells.map(pick)) + 1) / 2
  return [mid((v) => v.x), Math.max(...cells.map((v) => v.y)) + 1, mid((v) => v.z)]
}

/** A region in words, for a bar: how many of what. */
export function describeRegion(region: Region): string {
  const n = region.keys.length
  const noun = region.element === 'voxel' ? 'voxel' : region.element
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}
