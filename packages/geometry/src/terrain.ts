/**
 * The terrain mesher (spec §3).
 *
 * A pure function from document data to vertex buffers. No three.js, no DOM,
 * no globals: that is what keeps it unit-testable in node, benchmarkable on
 * its own and movable into a worker.
 *
 * Nothing about paint is per triangle: every face is a grid of tiles and the
 * tile at each corner of that grid is looked up from the terrains around it,
 * the dual grid. Per cell it emits:
 *   - one top face, flat or sloped by the top voxel's shape, as FOUR
 *     QUARTERS — each the quadrant of the corner tile that falls inside
 *     this cell, so a height edge between neighbours lands on the split and
 *     nothing stretches;
 *   - one side face per side where the cell stands above its neighbour,
 *     cut exactly to the slopes on either side and into courses, one cube
 *     tall so a wall's tiles are square like a floor's, each course again in
 *     quarters, its corner tiles looked up in face space: run along the side
 *     across, courses up;
 *   - one water quad if the column holds water.
 *
 * Every quarter is looked up once per MATERIAL LAYER (ruling of 2026-09-18):
 * each of a face's four layers is its own dual grid, where a cell whose
 * layer is empty is nothing, so a material alone on a layer draws its edge
 * tiles against nothing and whatever is under it shows through. The four
 * atlas rects ride on each vertex — `uvs` and `stackUvs` — and the shader
 * stacks them. A face with nothing on it draws the fallback on its first
 * layer, and a corner no tile answers draws the fallback on its own.
 *
 * What a top face sees at a corner, on each layer: the four cells around it, each by the
 * height of its own vertex there. A neighbour whose vertex is lower is
 * nothing (the cliff top draws its rim from the edge set); one level with it
 * is its own material (the same material continues, another meets it with
 * the pair's tile); one above it is its material only when that is this
 * cell's own, so there is no rim at the foot of a cliff of the same ground,
 * and nothing otherwise — the ground at the foot of a rock cliff is not a
 * transition to the ledge over its head (ruling in the decision log's
 * material entry: "a taller same-material neighbour as connected"). Off the
 * volume the ground continues.
 * Comparing vertex heights rather than cell tops is what lets a ramp's low
 * edge meet the ground it lands on.
 *
 * What a course sees: the courses above, below and beside it on the same side
 * of the same or adjacent cell. The top surface above and the ground below
 * are nothing; so is a bend in the face for now, which the spec means to
 * connect through the corner later.
 */

import {
  type ArchetypeId,
  type ReadonlyVoxel,
  CORNER_OFFSETS,
  DIR_VECTORS,
  FACE_TOP,
  HALF,
  NO_WATER,
  SURFACE_CLIFF,
  SURFACE_TOP,
  SURFACE_WATER,
  chunkBounds,
  cornerHeights,
  encodeExtra,
  edgeOff,
  faceLayers,
  inBounds,
  materialOfTag,
  slotMaterial,
  slotTile,
  tagOf,
  tintPaint,
  topHeight,
  type Tag,
} from '@papercut/document'

import { FRINGE, LANDING, PICKET, RAIL, SIDE } from './archetype'
import type { AtlasTile, CornerKeys } from './atlas'
import type { TerrainLook, TrimSettings } from './look'

export interface MeshBuffers {
  positions: Float32Array
  normals: Float32Array
  /** The atlas UV of each vertex; on terrain, of its first material layer. */
  uvs: Float32Array
  /**
   * On terrain, the atlas UVs of material layers 2, 3 and 4: six floats per
   * vertex. The shader stacks the four over each other (`stackLayers` in the
   * runtime). Absent on meshes that draw one texture, which is everything else.
   */
  stackUvs?: Float32Array
  colors: Float32Array
  indices: Uint32Array
  /** Four ints per triangle: kind, x, y, extra. See surface.ts. */
  faceAddr: Int32Array
  triangleCount: number
}

export interface TerrainChunkMesh {
  key: string
  solid: MeshBuffers
  water: MeshBuffers | null
  /** Fringes hung off cliff tops and pickets stood at wall feet: geometry of their own, one texture each, no stack. */
  trim: MeshBuffers | null
  /** Where a corner no tile answers drew the fallback: one xyz per such corner, for the editor to mark (spec §3). */
  marks: Float32Array
  /** The distinct combinations no tile answered in this chunk, by name — what is left to author, counted over the chunks on screen. */
  missing: string[]
}

/** Height treated as existing outside the map, so borders read as an island. */
const OUTSIDE_HEIGHT = 0

/**
 * How long a fringe flap or a picket is, in world units: half a tile, the
 * height of the half of an edge tile it carries, so it has the same texels
 * per unit as every floor (ruling of 2026-09-18). Never stretched to a length.
 */
const TRIM_LENGTH = 0.5

/** How far a picket stands out from its wall: enough not to fight the wall's own pixels for depth. */
const PICKET_GAP = 0.02

/** How far a rail stands out from the ramp's side: its body lies over the side's own wall, and must not fight it for depth. */
const RAIL_GAP = 0.02

/** How much each occluding neighbour darkens a corner. */
const AO_STRENGTH = 0.17

/** Quarter q of a face (0 NW, 1 NE, 2 SW, 3 SE in the face's own space) is this quadrant of the corner tile it sits on: the opposite one. */
const QUADRANT_OF_QUARTER = [3, 2, 1, 0]

/** An atlas UV rectangle, [u0, v0, u1, v1]. */
/** A tile's rectangle in the atlas, u0 v0 u1 v1; extents may run backwards, which flips it, and a fifth element of 1 swaps the axes first, which with a flip is a quarter turn. */
type Rect = readonly [number, number, number, number, number?]

/** How many material layers a face stacks, and so how many atlas rects each vertex carries. */
const STACK = 4

class BufferBuilder {
  positions: number[] = []
  normals: number[] = []
  uvs: number[] = []
  stackUvs: number[] = []
  colors: number[] = []
  indices: number[] = []
  faceAddr: number[] = []

  get vertexCount(): number {
    return this.positions.length / 3
  }

  constructor(private readonly stacked: boolean) {}

  /**
   * Emit a convex polygon as a fan of triangles, corners in winding order
   * p0, p1, p2, … such that (p1-p0) x (p2-p0) points outwards. Wall bands are
   * clipped to arbitrary convex shapes — a slope crossing a band leaves a
   * triangle or a pentagon, not a quad — and a top quarter is a quad.
   *
   * `local` places each corner inside the texture, 0–1 across and up; `rects`
   * are the atlas rectangles it is drawn from, one per material layer on a
   * stacked builder (one on any other), so every layer is sampled at the same
   * place in its own tile.
   */
  polygon(
    corners: ReadonlyArray<readonly [number, number, number]>,
    local: ReadonlyArray<readonly [number, number]>,
    rects: readonly Rect[],
    shade: readonly number[],
    tint: readonly [number, number, number],
    address: readonly [number, number, number, number],
  ): void {
    if (corners.length < 3) return
    const base = this.vertexCount
    // The normal of the fan's widest turn, so a sliver at the first corner cannot zero it out.
    let nx = 0
    let ny = 0
    let nz = 0
    const [p0] = corners
    for (let i = 1; i + 1 < corners.length; i++) {
      const p1 = corners[i]
      const p2 = corners[i + 1]
      const ax = p1[0] - p0[0]
      const ay = p1[1] - p0[1]
      const az = p1[2] - p0[2]
      const bx = p2[0] - p0[0]
      const by = p2[1] - p0[1]
      const bz = p2[2] - p0[2]
      nx += ay * bz - az * by
      ny += az * bx - ax * bz
      nz += ax * by - ay * bx
    }
    const len = Math.hypot(nx, ny, nz) || 1
    nx /= len
    ny /= len
    nz /= len
    for (let i = 0; i < corners.length; i++) {
      this.positions.push(corners[i][0], corners[i][1], corners[i][2])
      this.normals.push(nx, ny, nz)
      const [s0, t0] = local[i]
      const [u0, v0, u1, v1, turned0] = rects[0]
      this.uvs.push(u0 + (turned0 ? t0 : s0) * (u1 - u0), v0 + (turned0 ? s0 : t0) * (v1 - v0))
      if (this.stacked) {
        for (let l = 1; l < STACK; l++) {
          const [lu0, lv0, lu1, lv1, turned] = rects[l]
          this.stackUvs.push(lu0 + (turned ? t0 : s0) * (lu1 - lu0), lv0 + (turned ? s0 : t0) * (lv1 - lv0))
        }
      }
      const s = shade[i]
      this.colors.push(tint[0] * s, tint[1] * s, tint[2] * s)
    }
    for (let i = 1; i + 1 < corners.length; i++) {
      this.indices.push(base, base + i, base + i + 1)
      this.faceAddr.push(...address)
    }
  }

  finish(): MeshBuffers {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      ...(this.stacked ? { stackUvs: new Float32Array(this.stackUvs) } : {}),
      colors: new Float32Array(this.colors),
      indices: new Uint32Array(this.indices),
      faceAddr: new Int32Array(this.faceAddr),
      triangleCount: this.indices.length / 3,
    }
  }

  get isEmpty(): boolean {
    return this.indices.length === 0
  }
}

// --- heights ------------------------------------------------------------------

/**
 * The neighbour's own edge along one of this cell's sides, corner for
 * corner: the heights at this cell's start and end corners of that side as
 * the NEIGHBOUR has them — level for a flat cell, sloped for a ramp. A side
 * face is drawn wherever this cell's edge stands above it, so a flat cell
 * beside a ramp walls off the triangle between the ramp's sloped edge and
 * its own level one, which comparing flat heights never saw (the ramp
 * keeps its height and lowers corners). Outside the volume the edge is at
 * the floor.
 */
function neighbourEdge(cells: Cells, voxel: ReadonlyVoxel, x: number, y: number, dir: number): [number, number] {
  const [dx, dy] = DIR_VECTORS[dir]
  const nx = x + dx
  const ny = y + dy
  if (!inBounds(voxel.size, nx, ny)) return [OUTSIDE_HEIGHT, OUTSIDE_HEIGHT]
  const corners = cells.at(nx, ny).corners
  const [start, end] = NEIGHBOUR_CORNERS[dir]
  return [corners[start], corners[end]]
}

/** Which of `CORNER_OFFSETS` a vertex offset (dx, dy) from the cell's origin is. */
const CORNER_AT = [
  [0, 1],
  [3, 2],
]

/** A face's tags, one per material layer, and whether it holds nothing at all. */
interface FaceKeys {
  /** One tag per material layer, bottom first: `null` where that layer is empty or holds a pasted tile. */
  readonly keys: readonly Tag[]
  /**
   * The tile pasted whole on each layer (ruling of 2026-09-18), as an atlas tile, `-1` where the pasted tile cannot
   * draw — its image did not load, or it is off the image's grid — and `null` where the layer pastes nothing.
   */
  readonly tiles: readonly (number | null)[]
  /** No layer holds anything, or nobody painted it: it draws the fallback, and is nothing to its neighbours. */
  readonly empty: boolean
}

const NO_TILES: readonly (number | null)[] = [null, null, null, null]
const NOTHING: FaceKeys = { keys: [null, null, null, null], tiles: NO_TILES, empty: true }

/**
 * What one build of a chunk asks about a cell over and over — its corner
 * heights, its top, the terrains its top is drawn with — answered once per
 * cell and kept for the build. A chunk build touches every cell of its own
 * and a ring of neighbours several times per quarter; recomputing a column
 * from its voxels each time is what made the first cut of this mesher ten
 * times slower than the heightmap's.
 */
class Cells {
  private cells = new Map<number, CellInfo>()
  private bands = new Map<number, FaceKeys>()

  constructor(
    private readonly voxel: ReadonlyVoxel,
    private readonly look: TerrainLook,
  ) {}

  /** For a cell inside the volume. */
  at(x: number, y: number): CellInfo {
    const key = y * this.voxel.size.width + x
    let info = this.cells.get(key)
    if (info) return info
    const corners = cornerHeights(this.voxel, x, y)
    const top = topHeight(this.voxel, x, y)
    // The top face is the top voxel's; an empty column's is the bedrock floor's, at layer -1.
    info = { corners, top, face: this.faceKeys(x, y, Math.ceil(top / 2) - 1, FACE_TOP) }
    this.cells.set(key, info)
    return info
  }

  /** The column's top, or the floor outside the volume. */
  top(x: number, y: number): number {
    return inBounds(this.voxel.size, x, y) ? this.at(x, y).top : OUTSIDE_HEIGHT
  }

  /** A cell's height at grid vertex (vx, vy), one of its four corners, in half-tiles; the floor outside the volume. */
  vertex(x: number, y: number, vx: number, vy: number): number {
    if (!inBounds(this.voxel.size, x, y)) return OUTSIDE_HEIGHT
    return this.at(x, y).corners[CORNER_AT[vx - x][vy - y]]
  }

  /** The terrains a course of a side is drawn with: the face of the voxel whose layer the course is. */
  course(x: number, y: number, dir: number, course: number): FaceKeys {
    const key = ((y * this.voxel.size.width + x) * 4 + dir) * 256 + course
    const known = this.bands.get(key)
    if (known !== undefined) return known
    const answer = this.faceKeys(x, y, course, dir)
    this.bands.set(key, answer)
    return answer
  }

  private faceKeys(x: number, y: number, layer: number, dir: number): FaceKeys {
    const stack = faceLayers(this.voxel.paint, x, y, layer, dir)
    if (!stack) return NOTHING
    // A pasted tile is nothing to a material on its layer: its tag there is null, so what auto-tiles around it edges off.
    const keys = stack.map((slot) => this.look.keyOf(slotMaterial(slot)))
    const pasted = stack.map((slot) => slotTile(slot))
    const tiles = pasted.some((t) => t !== null) ? pasted.map((t) => (t === null ? null : (this.look.atlas.pastedTile(t.image, t.index) ?? -1))) : NO_TILES
    return keys.every((k) => k === null) && tiles.every((t) => t === null) ? NOTHING : { keys, tiles, empty: false }
  }
}

interface CellInfo {
  readonly corners: readonly [number, number, number, number]
  readonly top: number
  /** The terrains the top is drawn with: its top face's. */
  readonly face: FaceKeys
}

/** A value at a point inside the cell, bilinear across its corners in `CORNER_OFFSETS` order. */
function bilinear(corners: readonly number[], fx: number, fy: number): number {
  const [c00, c01, c11, c10] = corners
  const north = c00 + (c10 - c00) * fx
  const south = c01 + (c11 - c01) * fx
  return north + (south - north) * fy
}

// --- walls --------------------------------------------------------------------

/** A point on a wall: `t` along the side from its start corner (0) to its end corner (1), `h` its height in half-tiles. */
type WallPoint = readonly [t: number, h: number]

/**
 * The wall on one side of a cell, exactly: the region between the
 * neighbour's edge below and this cell's edge above, both straight lines
 * along the side, where this cell's stands higher. Where the two lines cross
 * — a slope beside a level, or two slopes — the wall is the triangle on this
 * cell's side of the crossing; the neighbour walls the other side.
 */
function wallRegion(lowStart: number, lowEnd: number, topStart: number, topEnd: number): WallPoint[] {
  const start = topStart - lowStart
  const end = topEnd - lowEnd
  if (start <= 0 && end <= 0) return []
  if (start >= 0 && end >= 0) return [[0, lowStart], [1, lowEnd], [1, topEnd], [0, topStart]]
  const t = start / (start - end)
  const h = lowStart + (lowEnd - lowStart) * t
  return start > 0 ? [[0, lowStart], [t, h], [0, topStart]] : [[t, h], [1, lowEnd], [1, topEnd]]
}

/**
 * A convex wall region cut to the rectangle [t0, t1] × [bottom, top]
 * (Sutherland–Hodgman, one edge at a time). Clamping a sloped edge's ends
 * into the band and joining them straight is only right when the slope stays
 * inside the band; clipping follows the slope across it, which is what
 * closed the gaps beside ramps.
 */
function clipToRect(polygon: readonly WallPoint[], t0: number, t1: number, bottom: number, top: number): WallPoint[] {
  let out = clipAgainst(polygon, (p) => p[1] - bottom)
  out = clipAgainst(out, (p) => top - p[1])
  out = clipAgainst(out, (p) => p[0] - t0)
  return clipAgainst(out, (p) => t1 - p[0])
}

/** Keep the part of a convex polygon where `inside` is non-negative. */
function clipAgainst(polygon: readonly WallPoint[], inside: (p: WallPoint) => number): WallPoint[] {
  const out: WallPoint[] = []
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]
    const b = polygon[(i + 1) % polygon.length]
    const da = inside(a)
    const db = inside(b)
    if (da >= 0) out.push(a)
    if ((da >= 0) !== (db >= 0)) {
      const s = da / (da - db)
      out.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s])
    }
  }
  // Points the clip produced twice, or a band the region only touches, would make zero-area triangles.
  const unique = out.filter((p, i) => {
    const q = out[(i + 1) % out.length]
    return Math.abs(p[0] - q[0]) > 1e-9 || Math.abs(p[1] - q[1]) > 1e-9
  })
  return unique.length >= 3 && area(unique) > 1e-9 ? unique : []
}

function area(polygon: readonly WallPoint[]): number {
  let sum = 0
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]
    const b = polygon[(i + 1) % polygon.length]
    sum += a[0] * b[1] - b[0] * a[1]
  }
  return Math.abs(sum) / 2
}

function unpackTint(packed: number | undefined): [number, number, number] {
  if (packed === undefined) return [1, 1, 1]
  return [((packed >> 16) & 0xff) / 255, ((packed >> 8) & 0xff) / 255, (packed & 0xff) / 255]
}

/**
 * Corner occlusion for a top-surface vertex. Looks at the three cells that
 * share the grid vertex with this cell and counts the ones standing above it.
 */
function cornerShade(cells: Cells, x: number, y: number, vx: number, vy: number, h: number): number {
  let occluders = 0
  for (let dy = -1; dy <= 0; dy++) {
    for (let dx = -1; dx <= 0; dx++) {
      const nx = vx + dx
      const ny = vy + dy
      if (nx === x && ny === y) continue
      if (cells.top(nx, ny) > h) occluders += 1
    }
  }
  return 1 - AO_STRENGTH * occluders
}

/** [startCorner, endCorner] walked by each side, matching its u axis. */
const SIDE_CORNERS: ReadonlyArray<readonly [number, number]> = [
  [2, 3],
  [1, 2],
  [0, 1],
  [3, 0],
]

/**
 * For each side, the neighbour's corner indices that coincide with this
 * cell's start and end corners of that side (`SIDE_CORNERS`): a corner
 * offset `(ox, oy)` here is `(ox - dx, oy - dy)` in the neighbour.
 */
const NEIGHBOUR_CORNERS: ReadonlyArray<readonly [number, number]> = SIDE_CORNERS.map(([start, end], dir) => {
  const [dx, dy] = DIR_VECTORS[dir]
  const across = (corner: number): number => {
    const [ox, oy] = CORNER_OFFSETS[corner]
    return CORNER_OFFSETS.findIndex(([nx, ny]) => nx === ox - dx && ny === oy - dy)
  }
  return [across(start), across(end)]
})

/** Face origin and u axis per side, chosen so u x +Y is the outward normal. */
const SIDE_GEOMETRY: ReadonlyArray<{
  origin: readonly [number, number]
  u: readonly [number, number]
}> = [
  { origin: [1, 1], u: [0, -1] },
  { origin: [0, 1], u: [1, 0] },
  { origin: [0, 0], u: [0, 1] },
  { origin: [1, 0], u: [-1, 0] },
]

// --- what a face sees ---------------------------------------------------------

/**
 * The four terrains around grid vertex (vx, vy) on material layer `layer`,
 * seen from cell (x, y): the cells NW, NE, SW, SE of the vertex, each by the
 * height of its own corner there against this cell's. Each material layer is
 * its own dual grid: a cell whose layer is empty is nothing on it.
 */
function topCorner(cells: Cells, voxel: ReadonlyVoxel, x: number, y: number, vx: number, vy: number, layer: number): CornerKeys {
  const mine = cells.vertex(x, y, vx, vy)
  const own = cells.at(x, y).face.keys[layer]
  const at = (cx: number, cy: number): Tag => {
    if (!inBounds(voxel.size, cx, cy)) return own
    if (cx === x && cy === y) return own
    const theirs = cells.vertex(cx, cy, vx, vy)
    if (theirs < mine) return null
    const key = cells.at(cx, cy).face.keys[layer]
    return theirs === mine || key === own ? key : null
  }
  return [at(vx - 1, vy - 1), at(vx, vy - 1), at(vx - 1, vy), at(vx, vy)]
}

/**
 * Whether cell (x, y)'s side `dir` has wall in course `course`, the cube-tall
 * row of its face at that voxel layer: the wall the mesher emits there —
 * between this cell's edge and the neighbour's, corner for corner — reaches
 * into it. Judged from the same edges the wall is cut from, so a slope beside
 * a level of the same top, whose wall is the triangle under the slope, still
 * sees its own courses.
 */
function courseExists(cells: Cells, voxel: ReadonlyVoxel, x: number, y: number, dir: number, course: number): boolean {
  if (!inBounds(voxel.size, x, y)) return false
  const corners = cells.at(x, y).corners
  const [startCorner, endCorner] = SIDE_CORNERS[dir]
  const [lowStart, lowEnd] = neighbourEdge(cells, voxel, x, y, dir)
  return Math.max(corners[startCorner], corners[endCorner]) > course * 2 && Math.min(lowStart, lowEnd) < course * 2 + 2
}

/** Whether cell (x, y)'s top edge along side `dir` slopes: the side under it is a ramp's side, the triangle under the slope. */
function slopesAlong(cells: Cells, x: number, y: number, dir: number): boolean {
  const corners = cells.at(x, y).corners
  const [start, end] = SIDE_CORNERS[dir]
  return corners[start] !== corners[end]
}

/**
 * The four terrains around a corner of a course on material layer `layer`, in face space: `atEnd` picks
 * the corner at the side's end (u = 1) rather than its start, `atTop` the
 * corner at the course's top rather than its bottom. Courses beside are on the
 * cell before or after this one along the side; off the volume continues.
 */
function courseCorner(cells: Cells, voxel: ReadonlyVoxel, x: number, y: number, dir: number, course: number, atEnd: boolean, atTop: boolean, layer: number, asSide = false): CornerKeys {
  const [ux, uy] = SIDE_GEOMETRY[dir].u
  // Read as a ramp's side (ruling of 2026-09-19), a course under a slope is that material's SIDE, and one under a
  // level edge stays the wall it is: so side art meets the wall beside it as two things, and can blend with it.
  const slotted = (tag: Tag, cx: number, cy: number): Tag => {
    const material = asSide && slopesAlong(cells, cx, cy, dir) ? materialOfTag(tag) : null
    return material === null ? tag : tagOf(material, SIDE)
  }
  const own = slotted(cells.course(x, y, dir, course).keys[layer], x, y)
  const at = (along: number, c: number): Tag => {
    const cx = x + along * ux
    const cy = y + along * uy
    if (!inBounds(voxel.size, cx, cy)) return own
    return courseExists(cells, voxel, cx, cy, dir, c) ? slotted(cells.course(cx, cy, dir, c).keys[layer], cx, cy) : null
  }
  const before = atEnd ? 0 : -1
  const upper = atTop ? course + 1 : course
  return [at(before, upper), at(before + 1, upper), at(before, upper - 1), at(before + 1, upper - 1)]
}

// --- the chunk ------------------------------------------------------------------

export function meshTerrainChunk(voxel: ReadonlyVoxel, key: string, look: TerrainLook): TerrainChunkMesh {
  const bounds = chunkBounds(key, voxel.size.width, voxel.size.height)
  const solid = new BufferBuilder(true)
  const water = new BufferBuilder(false)
  const trim = new BufferBuilder(false)
  /** The trim tile a face's material has, and that material's settings, from its topmost layer that has one; `null` when none does. */
  const trimOf = (face: FaceKeys, slot: typeof FRINGE | typeof PICKET): { tile: number; tag: Tag; settings: TrimSettings } | null => {
    if (face.empty) return null
    for (let layer = face.keys.length - 1; layer >= 0; layer--) {
      const tag = face.keys[layer]
      if (tag === null) continue
      const tile = atlas.trimTile(tag, slot)
      if (tile !== null) return { tile, tag, settings: look.trimOf(tag) }
    }
    return null
  }
  /**
   * Emit a strip of trim along one side, drawn in (t, s): t along the side
   * from its start corner, s across the strip from its fixed edge. The strip
   * is cut at every half cell so each piece samples one tile centred on a
   * corner of the grid, like the floor beside it; `local` places a point in
   * that tile's rect.
   */
  const strip = (outline: WallPoint[], rectFor: (k: number) => readonly [number, number, number, number], place: (t: number, s: number) => [number, number, number], local: (s: number) => number, reverse: boolean, tint: readonly [number, number, number], address: readonly [number, number, number, number]): void => {
    const lo = Math.floor(Math.min(...outline.map((p) => p[0])) + 0.5)
    const hi = Math.ceil(Math.max(...outline.map((p) => p[0])) + 0.5)
    for (let k = lo; k < hi; k++) {
      const piece = clipToRect(outline, k - 0.5, k + 0.5, 0, TRIM_LENGTH)
      if (piece.length === 0) continue
      const ordered = reverse ? [...piece].reverse() : piece
      trim.polygon(
        ordered.map(([t, sv]) => place(t, sv)),
        ordered.map(([t, sv]) => [t - (k - 0.5), local(sv)] as const),
        [rectFor(k)],
        ordered.map(() => 1),
        tint,
        address,
      )
    }
  }
  const { atlas } = look
  /**
   * The rail cell (cx, cy) carries along side `d`, as the tag its tiles spell, or `null` (rulings of 2026-09-19). A
   * rail stands on a ramp's OPEN side: the side runs with the slope, nothing beside it stands above it, and the
   * material on top has rail art — its top edge at least. The switch that takes a fringe off an edge takes this off too.
   */
  const railOf = (cx: number, cy: number, d: number): string | null => {
    if (!inBounds(voxel.size, cx, cy) || !slopesAlong(cells, cx, cy, d)) return null
    const corners = cells.at(cx, cy).corners
    const [start, end] = SIDE_CORNERS[d]
    const [lowStart, lowEnd] = neighbourEdge(cells, voxel, cx, cy, d)
    if (corners[start] < lowStart || corners[end] < lowEnd || edgeOff(voxel.paint, cx, cy, d, 'top')) return null
    const face = cells.at(cx, cy).face
    if (face.empty) return null
    for (let layer = face.keys.length - 1; layer >= 0; layer--) {
      const material = materialOfTag(face.keys[layer])
      if (material === null) continue
      const rail = tagOf(material, RAIL) as string
      if (atlas.slotTile([null, null, rail, rail], 'ramp') !== null) return rail
    }
    return null
  }
  /** Part of a tile as a rect: across from `a0` to `a1` of its width, and from `b0` to `b1` of its height, measured up from its bottom. */
  const partOf = (tile: number, a0: number, a1: number, b0: number, b1: number): Rect => {
    // To the texel: a part is a whole number of texels, and every piece of a rail has to show them the same size
    // and in step with the piece beside it. A sixteenth of a texel is kept off each edge: a GPU places a sample to
    // about a 256th of a texel, and with less of a guard than that allows for, the odd pixel along a piece's edge
    // took the texel beyond it and drew as a dotted hairline (seen 2026-09-19). Under one percent of a piece's width.
    const [u0, v0, u1, v1] = atlas.bounds(tile)
    const [eu, ev] = [(u1 - u0) / (atlas.tile * 16), (v1 - v0) / (atlas.tile * 16)]
    return [u0 + (u1 - u0) * a0 + eu, v0 + (v1 - v0) * b0 + ev, u0 + (u1 - u0) * a1 - eu, v0 + (v1 - v0) * b1 - ev]
  }
  const cells = new Cells(voxel, look)
  const marks: number[] = []
  const marked = new Set<string>()
  const missing = new Set<string>()
  const fallback = atlas.uv(atlas.fallbackTile(), -1)
  /**
   * The atlas rects one quarter draws, a rect per material layer: each
   * layer's corner tile, the quadrant of it that falls in this quarter. A
   * face with nothing on it draws the fallback under whatever its
   * neighbours' layers bring onto it. A corner no tile answers is marked.
   *
   * A layer holding a pasted tile draws that tile whole over the face
   * instead: quarter q is the tile's own quadrant q, not the opposite one of
   * a corner tile, and nothing auto-tiles onto it on that layer.
   */
  /** A tile's quadrant as a rect, laid the way the atlas says the tile goes on this face: another quadrant of it, flipped or turned, when it was drawn for another direction. */
  const oriented = (answer: AtlasTile, quadrant: number): Rect => {
    const orient = answer.orient
    if (!orient) return atlas.uv(answer.tile, quadrant)
    const [u0, v0, u1, v1] = atlas.uv(answer.tile, orient.corners[quadrant])
    return [orient.flipU ? u1 : u0, orient.flipV ? v1 : v0, orient.flipU ? u0 : u1, orient.flipV ? v0 : v1, orient.transpose ? 1 : 0]
  }
  const quarterRects = (face: FaceKeys, archetype: ArchetypeId, quarter: number, cornerOf: (layer: number) => CornerKeys, markAt: () => void, piece?: { quadrant: number; pasted: (tile: number) => Rect; direction: number | null }, first?: (layer: number) => AtlasTile | null): Rect[] => {
    const rects: Rect[] = []
    const quadrant = piece ? piece.quadrant : QUADRANT_OF_QUARTER[quarter]
    for (let layer = 0; layer < STACK; layer++) {
      const pasted = face.tiles[layer]
      if (pasted !== null) {
        if (pasted === -1) {
          markAt()
          missing.add('pasted tile')
        }
        rects.push(pasted === -1 ? fallback : piece ? piece.pasted(pasted) : atlas.uv(pasted, quarter))
        continue
      }
      // Optional art that answers first, when the face has some: a ramp's side, before the wall art it otherwise takes.
      const answer = first?.(layer) ?? atlas.tileFor(cornerOf(layer), archetype, piece?.direction ?? null)
      if (answer.missing) {
        markAt()
        if (answer.combo) missing.add(answer.combo)
      }
      rects.push(layer === 0 && face.empty ? fallback : oriented(answer, quadrant))
    }
    return rects
  }
  const mark = (x: number, y: number, z: number): void => {
    const id = `${x},${y},${z}`
    if (marked.has(id)) return
    marked.add(id)
    marks.push(x, y, z)
  }

  if (!bounds) {
    return { key, solid: solid.finish(), water: null, trim: null, marks: new Float32Array(0), missing: [] }
  }

  for (let y = bounds.y0; y < bounds.y1; y++) {
    for (let x = bounds.x0; x < bounds.x1; x++) {
      const index = y * voxel.size.width + x
      const tint = unpackTint(tintPaint(voxel.paint, x, y))
      const cornerH = cells.at(x, y).corners

      // --- top face, in quarters ---------------------------------------------
      {
        const shadeAt = CORNER_OFFSETS.map((offset, i) => cornerShade(cells, x, y, x + offset[0], y + offset[1], cornerH[i]))
        // A face's archetype comes from its geometry (ruling of 2026-09-18): a level top is a floor, a sloped one a ramp.
        const topArchetype: ArchetypeId = cornerH.every((h) => h === cornerH[0]) ? 'floor' : 'ramp'
        const at = (fx: number, fy: number): [number, number, number] => [x + fx, bilinear(cornerH, fx, fy) * HALF, y + fy]
        // A full ramp's surface is 1½ long along its run and drawn from quarter tiles (decision of 2026-09-19): two
        // quarters wide and THREE long, so the slope, which is √2 long, carries a tile and a half of art with 6 % to
        // take up rather than one tile pulled 1.41×. The rows at its head and foot come from the corner tiles, as on
        // any face. The middle row is cut from the tile at a corner that is not on the grid: the middle of the edge
        // beside it, where what is on this side and what is on that side are the same above as below — the plain edge
        // arrangement along the run, or the solid tile where both sides are one thing.
        const hNW = cornerH[0]
        const hSW = cornerH[1]
        const hSE = cornerH[2]
        const hNE = cornerH[3]
        /** The way a full ramp descends, in the map's direction order: what its art may be drawn for (ruling of 2026-09-19). */
        const descends = (r: 'x' | 'y'): number => (r === 'y' ? (hNW > hSW ? 1 : 3) : hNW > hNE ? 0 : 2)
        const run: 'x' | 'y' | null = hNW === hNE && hSW === hSE && Math.abs(hNW - hSW) === 2 ? 'y' : hNW === hSW && hNE === hSE && Math.abs(hNW - hNE) === 2 ? 'x' : null
        const emit = (fx0: number, fy0: number, fx1: number, fy1: number, rects: Rect[]): void => {
          // Corner order c00, c01, c11, c10 within the piece. Sheets are authored top-down, so increasing map +Z walks down the sheet, which is decreasing v.
          solid.polygon(
            [at(fx0, fy0), at(fx0, fy1), at(fx1, fy1), at(fx1, fy0)],
            [
              [0, 1],
              [0, 0],
              [1, 0],
              [1, 1],
            ],
            rects,
            [bilinear(shadeAt, fx0, fy0), bilinear(shadeAt, fx0, fy1), bilinear(shadeAt, fx1, fy1), bilinear(shadeAt, fx1, fy0)],
            tint,
            [SURFACE_TOP, x, y, 0],
          )
        }
        const face = cells.at(x, y).face
        /** The part of a pasted tile, which is a picture of the whole face, that falls in a piece of it. */
        const pastedPart = (fx0: number, fy0: number, fx1: number, fy1: number) => (tile: number): Rect => {
          const [u0, v0, u1, v1] = atlas.uv(tile, -1)
          return [u0 + (u1 - u0) * fx0, v1 - (v1 - v0) * fy1, u0 + (u1 - u0) * fx1, v1 - (v1 - v0) * fy0]
        }
        for (let q = 0; q < 4; q++) {
          const cx = q % 2
          const cy = q > 1 ? 1 : 0
          const vx = x + cx
          const vy = y + cy
          const cornerOf = (layer: number): CornerKeys => topCorner(cells, voxel, x, y, vx, vy, layer)
          const markAt = (): void => mark(vx, bilinear(cornerH, cx, cy) * HALF, vy)
          if (run === null) {
            emit(cx * 0.5, cy * 0.5, cx * 0.5 + 0.5, cy * 0.5 + 0.5, quarterRects(face, topArchetype, q, cornerOf, markAt))
            continue
          }
          // The quarter at a corner, a third of the run long instead of a half.
          const along0 = (run === 'y' ? cy : cx) * (2 / 3)
          const [fx0, fy0, fx1, fy1] = run === 'y' ? [cx * 0.5, along0, cx * 0.5 + 0.5, along0 + 1 / 3] : [along0, cy * 0.5, along0 + 1 / 3, cy * 0.5 + 0.5]
          emit(fx0, fy0, fx1, fy1, quarterRects(face, topArchetype, q, cornerOf, markAt, { quadrant: QUADRANT_OF_QUARTER[q], pasted: pastedPart(fx0, fy0, fx1, fy1), direction: descends(run) }))
        }
        if (run !== null) {
          // The middle row: one piece on each side of the run's centre line.
          for (let side = 0; side < 2; side++) {
            const [fx0, fy0, fx1, fy1] = run === 'y' ? [side * 0.5, 1 / 3, side * 0.5 + 0.5, 2 / 3] : [1 / 3, side * 0.5, 2 / 3, side * 0.5 + 0.5]
            // The two grid vertices at the ends of the edge this piece lies along, and which of their corners is the cell beside us.
            const [ax, ay, bx, by] = run === 'y' ? [x + side, y, x + side, y + 1] : [x, y + side, x + 1, y + side]
            const besideAtA = run === 'y' ? (side === 0 ? 2 : 3) : side === 0 ? 1 : 3
            const besideAtB = run === 'y' ? (side === 0 ? 0 : 1) : side === 0 ? 0 : 2
            const cornerOf = (layer: number): CornerKeys => {
              const own = face.keys[layer]
              const a = topCorner(cells, voxel, x, y, ax, ay, layer)[besideAtA]
              const b = topCorner(cells, voxel, x, y, bx, by, layer)[besideAtB]
              // What is beside the run is what is beside both its ends; a neighbour that joins at one end only, a level
              // at the ramp's foot, is across a wall for most of the way and counts as nothing.
              const beside = a === b ? a : null
              return run === 'y' ? (side === 0 ? [beside, own, beside, own] : [own, beside, own, beside]) : side === 0 ? [beside, beside, own, own] : [own, own, beside, beside]
            }
            // The half of that tile on our side of the edge, and of that half the part nearer its start.
            const quadrant = run === 'y' ? (side === 0 ? 1 : 0) : side === 0 ? 2 : 0
            const markAt = (): void => mark((ax + bx) / 2, bilinear(cornerH, (ax + bx) / 2 - x, (ay + by) / 2 - y) * HALF, (ay + by) / 2)
            emit(fx0, fy0, fx1, fy1, quarterRects(face, topArchetype, 0, cornerOf, markAt, { quadrant, pasted: pastedPart(fx0, fy0, fx1, fy1), direction: descends(run) }))
          }
        }
      }

      // --- side faces ----------------------------------------------------------
      // A side is walled wherever this cell's edge stands above the
      // neighbour's edge along it, both taken corner for corner, so a ramp's
      // sloped edge and a flat neighbour's level one leave no triangle open
      // between them. A ramp's descending edge meets a neighbour at the same
      // height and draws nothing; over a drop it walls the drop.
      for (let dir = 0; dir < 4; dir++) {
        const [startCorner, endCorner] = SIDE_CORNERS[dir]
        const topStart = cornerH[startCorner]
        const topEnd = cornerH[endCorner]
        const [lowStart, lowEnd] = neighbourEdge(cells, voxel, x, y, dir)
        const region = wallRegion(lowStart, lowEnd, topStart, topEnd)
        if (region.length === 0) continue

        const { origin, u } = SIDE_GEOMETRY[dir]
        const ox = x + origin[0]
        const oz = y + origin[1]

        const topLevel = Math.ceil(Math.max(topStart, topEnd)) - 1
        const bottomLevel = Math.floor(Math.min(lowStart, lowEnd))

        // --- trim: a fringe off the top, a picket at the foot (rulings of 2026-09-18) ---
        // Only a wall standing the whole length of the side takes trim; a sliver beside a slope does not.
        if (topStart > lowStart && topEnd > lowEnd) {
          const [nx, nz] = DIR_VECTORS[dir]
          const lerp = (a: number, b: number, t: number): number => (t <= 0 ? a : t >= 1 ? b : a + (b - a) * t)
          const fringe = edgeOff(voxel.paint, x, y, dir, 'top') ? null : trimOf(cells.at(x, y).face, FRINGE)
          if (fringe !== null) {
            // The tile's lower half, the edge that hangs: the hinge at its middle, the tip at its bottom.
            const hanging = (tile: number): [number, number, number, number] => {
              const [u0, v0, u1, v1] = atlas.uv(tile, -1)
              return [u0, v0, u1, (v0 + v1) / 2]
            }
            const edge = hanging(fringe.tile)
            // The material's angle below horizontal: it sets how far the flap juts and drops, never how long it is.
            const angle = (fringe.settings.fringeAngle * Math.PI) / 180
            const out = Math.cos(angle)
            const down = Math.sin(angle)
            // An outside corner of the plateau: this cell walls the side round the corner too, so the flap reaches out to meet that one's.
            const walls = (vx: number, vz: number): boolean => cells.top(x, y) > cells.top(x + vx, y + vz)
            const reach = TRIM_LENGTH * out
            const e0 = walls(-u[0], -u[1]) ? reach : 0
            const e1 = walls(u[0], u[1]) ? reach : 0
            // At an outside corner the piece centred on it draws the material's corner fringe, when it has one: the rim
            // runs in from the right at the side's start (t = 0) and from the left at its end (t = 1).
            const tag = fringe.tag
            const fromRight = e0 > 0 ? atlas.trimTile(tag, FRINGE, 'from-right') : null
            const fromLeft = e1 > 0 ? atlas.trimTile(tag, FRINGE, 'from-left') : null
            const startRect = fromRight === null ? edge : hanging(fromRight)
            const endRect = fromLeft === null ? edge : hanging(fromLeft)
            strip(
              [[0, 0], [1, 0], [1 + e1, TRIM_LENGTH], [-e0, TRIM_LENGTH]],
              (k) => (k === 0 ? startRect : k === 1 ? endRect : edge),
              (t, sv) => [ox + u[0] * t + nx * sv * out, lerp(topStart, topEnd, t) * HALF - sv * down, oz + u[1] * t + nz * sv * out],
              (sv) => 1 - sv / TRIM_LENGTH,
              true,
              tint,
              [SURFACE_CLIFF, x, y, encodeExtra(dir, topLevel)],
            )
          }
          const bx = x + nx
          const bz = y + nz
          const picket = inBounds(voxel.size, bx, bz) && !edgeOff(voxel.paint, x, y, dir, 'foot') ? trimOf(cells.at(bx, bz).face, PICKET) : null
          if (picket !== null) {
            const [u0, v0, u1, v1] = atlas.uv(picket.tile, -1)
            const upright: [number, number, number, number] = [u0, (v0 + v1) / 2, u1, v1]
            // The material's distance, in pixels of art, is world units at one tile to the unit; the gap keeps it off the wall's own pixels.
            const off = PICKET_GAP + picket.settings.picketDistance / atlas.tile
            strip(
              [[0, 0], [1, 0], [1, TRIM_LENGTH], [0, TRIM_LENGTH]],
              // The tile's upper half, the edge that pokes up: its middle on the ground, its top edge in the air.
              () => upright,
              (t, sv) => [ox + u[0] * t + nx * off, lerp(lowStart, lowEnd, t) * HALF + sv, oz + u[1] * t + nz * off],
              (sv) => sv / TRIM_LENGTH,
              false,
              unpackTint(tintPaint(voxel.paint, bx, bz)),
              [SURFACE_CLIFF, x, y, encodeExtra(dir, bottomLevel)],
            )
          }
        }
        // --- a rail along a ramp's open side (rulings of 2026-09-19) ---
        // Drawn in (s, height): s runs DOWNHILL along the side from the ramp's head, which is how the art is drawn —
        // head on the left, falling to the right. Where the side runs the other way the same pieces are laid
        // mirrored. A tile sits on each end of the cell, as on any dual grid, picked by what the rail does past it:
        // carries on, stops (a cap), or, for an upright rail whose material asks, runs out onto level ground (a bend).
        const rail = topStart !== topEnd ? railOf(x, y, dir) : null
        if (rail !== null) {
          const settings = look.trimOf(tagOf(materialOfTag(rail) as number))
          const upright = settings.railStyle === 'upright'
          const down = topStart > topEnd
          const head = Math.max(topStart, topEnd)
          const drop = head - Math.min(topStart, topEnd)
          const [nx, nz] = DIR_VECTORS[dir]
          const landing = tagOf(materialOfTag(rail) as number, LANDING) as string
          /** What the rail is past one of this cell's ends: itself, a landing, or nothing. */
          const past = (uphill: boolean): string | null => {
            const step = uphill === down ? -1 : 1
            const cx = x + step * u[0]
            const cy = y + step * u[1]
            if (!inBounds(voxel.size, cx, cy)) return null
            const c = cells.at(cx, cy).corners
            const [cs, ce] = [c[startCorner], c[endCorner]]
            const meets = uphill ? head : head - drop
            if (railOf(cx, cy, dir) === rail && cs > ce === down && (uphill ? Math.min(cs, ce) : Math.max(cs, ce)) === meets) return rail
            // A landing wants level ground to stand on, at the height the rail reaches it, and the bend that joins them drawn.
            if (!upright || !settings.landings || !c.every((h) => h === meets)) return null
            return atlas.slotTile(uphill ? [null, null, landing, rail] : [null, null, rail, landing], 'ramp') === null ? null : landing
          }
          const above = past(true)
          const below = past(false)
          const middle = atlas.slotTile([null, null, rail, rail], 'ramp') as AtlasTile
          const topTile = (l: string | null, r: string | null): number => (atlas.slotTile([null, null, l, r], 'ramp') ?? middle).tile
          const bodyTile = (l: string | null, r: string | null): number | null => {
            const [bl, br] = [l === rail ? rail : null, r === rail ? rail : null]
            return (atlas.slotTile([bl, br, bl, br], 'ramp') ?? atlas.slotTile([rail, rail, rail, rail], 'ramp'))?.tile ?? null
          }
          const atHead = topTile(above, rail)
          const atFoot = topTile(rail, below)
          const address = [SURFACE_CLIFF, x, y, encodeExtra(dir, topLevel)] as const
          const emit = (points: ReadonlyArray<readonly [number, number]>, local: ReadonlyArray<readonly [number, number]>, rect: Rect): void => {
            const order = points.map((_, i) => (down ? i : points.length - 1 - i))
            trim.polygon(
              order.map((i) => {
                const t = down ? points[i][0] : 1 - points[i][0]
                return [ox + u[0] * t + nx * RAIL_GAP, points[i][1], oz + u[1] * t + nz * RAIL_GAP] as const
              }),
              order.map((i) => local[i]),
              [rect],
              order.map(() => 1),
              tint,
              address,
            )
          }
          const SQUARE = [[0, 0], [1, 0], [1, 1], [0, 1]] as const
          if (upright) {
            // Two columns to a cell, each standing on the high side of its half tile, so the rail's foot is a
            // staircase over the slope; below the top row its body repeats, half a tile at a time, to the ground.
            const lowAt = (sv: number): number => lowStart + (lowEnd - lowStart) * (down ? sv : 1 - sv)
            const column = (s0: number, base: number, tile: number, a0: number, body: number | null): void => {
              const y0 = base * HALF
              emit([[s0, y0], [s0 + 0.5, y0], [s0 + 0.5, y0 + 1], [s0, y0 + 1]], SQUARE, partOf(tile, a0, a0 + 0.5, 0, 1))
              if (body === null) return
              const under: WallPoint[] = [[s0, lowAt(s0)], [s0 + 0.5, lowAt(s0 + 0.5)], [s0 + 0.5, base], [s0, base]]
              const floor = Math.min(lowAt(s0), lowAt(s0 + 0.5))
              for (let n = 0; base - n > floor; n++) {
                const piece = clipToRect(under, s0, s0 + 0.5, base - n - 1, base - n)
                if (piece.length === 0) continue
                // The body's upper half is its shoulder, the row under the rail, where the slope crosses the half tile corner
                // to corner and a stringer is cut along it; its lower half is what repeats from there to the ground.
                emit(piece.map(([sv, h]) => [sv, h * HALF] as const), piece.map(([sv, h]) => [(sv - s0) / 0.5, h - (base - n - 1)] as const), partOf(body, a0, a0 + 0.5, n === 0 ? 0.5 : 0, n === 0 ? 1 : 0.5))
              }
            }
            column(0, head, atHead, 0.5, bodyTile(above, rail))
            column(0.5, head - drop / 2, atFoot, 0, bodyTile(rail, below))
            // A landing is the far half of the bend, on the level ground past the ramp's end.
            if (above === landing) column(-0.5, head, atHead, 0, null)
            if (below === landing) column(1, head - drop, atFoot, 0.5, null)
          } else {
            // Laid along the slope, turned and never skewed: each piece a rectangle square to it, a tile tall. Three
            // pieces to a full ramp, like its surface: the slope is √2 long and carries a tile and a half of art.
            const rise = drop * HALF
            const length = Math.hypot(1, rise)
            const [lean, up] = [rise / length, 1 / length]
            const pieces = drop >= 2 ? 3 : 2
            for (let k = 0; k < pieces; k++) {
              const [s0, s1] = [k / pieces, (k + 1) / pieces]
              const [y0, y1] = [head * HALF - rise * s0, head * HALF - rise * s1]
              const rect = k === 0 ? partOf(atHead, 0.5, 1, 0, 1) : k === pieces - 1 ? partOf(atFoot, 0, 0.5, 0, 1) : partOf(middle.tile, 0, 0.5, 0, 1)
              emit([[s0, y0], [s1, y1], [s1 + lean, y1 + up], [s0 + lean, y0 + up]], SQUARE, rect)
            }
          }
        }

        // A wall is tiled a COURSE at a time: one cube tall, the height of the voxel it belongs to, so its tiles are
        // square in the world like a floor's, one tile to a world unit each way (ruling of 2026-09-18: every surface
        // shares one texel scale). A course is two half-tile bands, and each band is still its own pick address.
        const sloped = topStart !== topEnd
        const topCourse = Math.ceil(Math.max(topStart, topEnd) / 2) - 1
        const bottomCourse = Math.floor(Math.min(lowStart, lowEnd) / 2)
        for (let course = bottomCourse; course <= topCourse; course++) {
          for (let q = 0; q < 4; q++) {
            const atEnd = q % 2 === 1
            const atTop = q < 2
            const t0 = atEnd ? 0.5 : 0
            // A quarter of a course is one band tall: half a tile of art on half a world unit.
            const level = atTop ? course * 2 + 1 : course * 2
            // Bands sitting in a pit read darker at the bottom.
            const deep = 1 - AO_STRENGTH * Math.min(2, topLevel - level) * 0.5
            // The wall region cut to this quarter, exactly: a slope crossing it is followed, not approximated.
            const piece = clipToRect(region, t0, t0 + 0.5, level, level + 1)
            if (piece.length === 0) continue
            const rects = quarterRects(
              cells.course(x, y, dir, course),
              'wall',
              q,
              (layer) => courseCorner(cells, voxel, x, y, dir, course, atEnd, atTop, layer),
              () => mark(ox + u[0] * (atEnd ? 1 : 0), (atTop ? course + 1 : course) * 2 * HALF, oz + u[1] * (atEnd ? 1 : 0)),
              undefined,
              // Under a slope the face is the ramp's SIDE: its own art when the material has some, drawn for the way
              // the slope runs across the face — east when it falls toward the side's end, west toward its start — so
              // art for one is mirrored for the other; the wall art above when it has none.
              sloped ? (layer) => atlas.slotTile(courseCorner(cells, voxel, x, y, dir, course, atEnd, atTop, layer, true), 'ramp', topStart > topEnd ? 0 : 2) : undefined,
            )
            solid.polygon(
              piece.map(([t, h]) => [ox + u[0] * t, h * HALF, oz + u[1] * t] as const),
              // The texture keeps its scale however the piece is cut: u along the side, v up the course.
              piece.map(([t, h]) => [(t - t0) / 0.5, h - level] as const),
              rects,
              piece.map(([, h]) => deep + (1 - deep) * (h - level)),
              tint,
              [SURFACE_CLIFF, x, y, encodeExtra(dir, level)],
            )
          }
        }
      }

      // --- water ------------------------------------------------------------
      const waterLevel = voxel.water[index]
      if (waterLevel !== NO_WATER) {
        const wy = waterLevel * HALF
        water.polygon(
          [
            [x, wy, y],
            [x, wy, y + 1],
            [x + 1, wy, y + 1],
            [x + 1, wy, y],
          ],
          [
            [0, 1],
            [0, 0],
            [1, 0],
            [1, 1],
          ],
          [[0, 0, 1, 1]],
          [1, 1, 1, 1],
          [1, 1, 1],
          [SURFACE_WATER, x, y, 0],
        )
      }
    }
  }

  return {
    key,
    solid: solid.finish(),
    water: water.isEmpty ? null : water.finish(),
    trim: trim.isEmpty ? null : trim.finish(),
    marks: new Float32Array(marks),
    missing: [...missing],
  }
}
