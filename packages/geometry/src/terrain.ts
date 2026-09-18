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
 *     cut exactly to the slopes on either side and into half-tile bands,
 *     each band again in quarters, its corner tiles looked up in face space:
 *     run along the side across, layers up;
 *   - one water quad if the column holds water.
 *
 * What a top face sees at a corner: the four cells around it, each by the
 * height of its own vertex there. A neighbour whose vertex is lower is
 * nothing (the cliff top draws its rim from the edge set); one level with
 * or above it is its own material (the same material continues, another
 * meets it with the pair's tile); off the volume the ground continues.
 * Comparing vertex heights rather than cell tops is what lets a ramp's low
 * edge meet the ground it lands on.
 *
 * What a band sees: the bands above, below and beside it on the same side
 * of the same or adjacent cell. The top surface above and the ground below
 * are nothing; so is a bend in the face for now, which the spec means to
 * connect through the corner later.
 */

import {
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
  faceLayers,
  inBounds,
  slotMaterial,
  tintPaint,
  topHeight,
  type Tag,
} from '@papercut/document'

import type { CornerKeys } from './atlas'
import type { TerrainLook } from './look'

export interface MeshBuffers {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array
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
  /** Where the atlas had to compose a tile nobody drew: one xyz per composited corner, for the editor to mark (spec §3). */
  marks: Float32Array
  /** The distinct combinations composed in this chunk, by name — what is left to author, counted over the chunks on screen. */
  composites: string[]
}

/** Height treated as existing outside the map, so borders read as an island. */
const OUTSIDE_HEIGHT = 0

/** How much each occluding neighbour darkens a corner. */
const AO_STRENGTH = 0.17

/** Quarter q of a face (0 NW, 1 NE, 2 SW, 3 SE in the face's own space) is this quadrant of the corner tile it sits on: the opposite one. */
const QUADRANT_OF_QUARTER = [3, 2, 1, 0]

class BufferBuilder {
  positions: number[] = []
  normals: number[] = []
  uvs: number[] = []
  colors: number[] = []
  indices: number[] = []
  faceAddr: number[] = []

  get vertexCount(): number {
    return this.positions.length / 3
  }

  /**
   * Emit a convex polygon as a fan of triangles, corners in winding order
   * p0, p1, p2, … such that (p1-p0) x (p2-p0) points outwards. Wall bands are
   * clipped to arbitrary convex shapes — a slope crossing a band leaves a
   * triangle or a pentagon, not a quad — and a top quarter is a quad.
   */
  polygon(
    corners: ReadonlyArray<readonly [number, number, number]>,
    cornerUvs: ReadonlyArray<readonly [number, number]>,
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
      this.uvs.push(cornerUvs[i][0], cornerUvs[i][1])
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

/**
 * What one build of a chunk asks about a cell over and over — its corner
 * heights, its top, the terrain its top is drawn with — answered once per
 * cell and kept for the build. A chunk build touches every cell of its own
 * and a ring of neighbours several times per quarter; recomputing a column
 * from its voxels each time is what made the first cut of this mesher ten
 * times slower than the heightmap's.
 */
class Cells {
  private cells = new Map<number, CellInfo>()
  private bands = new Map<number, Tag>()

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
    info = { corners, top, topKey: this.faceKey(x, y, Math.ceil(top / 2) - 1, FACE_TOP) }
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

  /** The terrain a band of a side is drawn with: the face of the voxel the band belongs to. */
  bandKey(x: number, y: number, dir: number, level: number): Tag {
    const key = ((y * this.voxel.size.width + x) * 4 + dir) * 256 + level
    const known = this.bands.get(key)
    if (known !== undefined) return known
    const answer = this.faceKey(x, y, Math.floor(level / 2), dir)
    this.bands.set(key, answer)
    return answer
  }

  /** A face's tag: its first material layer's, until the layers above it are drawn (stage two of the material layers work). */
  private faceKey(x: number, y: number, layer: number, dir: number): Tag {
    return this.look.keyOf(slotMaterial(faceLayers(this.voxel.paint, x, y, layer, dir)?.[0]))
  }
}

interface CellInfo {
  readonly corners: readonly [number, number, number, number]
  readonly top: number
  /** The terrain the top is drawn with: its top face's. */
  readonly topKey: Tag
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
 * The four terrains around grid vertex (vx, vy), seen from cell (x, y): the
 * cells NW, NE, SW, SE of the vertex, each by the height of its own corner
 * there against this cell's.
 */
function topCorner(cells: Cells, voxel: ReadonlyVoxel, x: number, y: number, vx: number, vy: number): CornerKeys {
  const mine = cells.vertex(x, y, vx, vy)
  const own = cells.at(x, y).topKey
  const at = (cx: number, cy: number): Tag => {
    if (!inBounds(voxel.size, cx, cy)) return own
    if (cx === x && cy === y) return own
    return cells.vertex(cx, cy, vx, vy) < mine ? null : cells.at(cx, cy).topKey
  }
  return [at(vx - 1, vy - 1), at(vx, vy - 1), at(vx - 1, vy), at(vx, vy)]
}

/**
 * Whether cell (x, y)'s side `dir` has a band at half-tile `level`: the wall
 * the mesher emits there — between this cell's edge and the neighbour's,
 * corner for corner — reaches into that band. Judged from the same edges
 * the wall is cut from, so a slope beside a level of the same top, whose
 * wall is the triangle under the slope, still sees its own bands.
 */
function bandExists(cells: Cells, voxel: ReadonlyVoxel, x: number, y: number, dir: number, level: number): boolean {
  if (!inBounds(voxel.size, x, y)) return false
  const corners = cells.at(x, y).corners
  const [startCorner, endCorner] = SIDE_CORNERS[dir]
  const [lowStart, lowEnd] = neighbourEdge(cells, voxel, x, y, dir)
  return Math.max(corners[startCorner], corners[endCorner]) > level && Math.min(lowStart, lowEnd) < level + 1
}

/**
 * The four terrains around a corner of a band, in face space: `atEnd` picks
 * the corner at the side's end (u = 1) rather than its start, `atTop` the
 * corner at the band's top rather than its bottom. Bands beside are on the
 * cell before or after this one along the side; off the volume continues.
 */
function bandCorner(cells: Cells, voxel: ReadonlyVoxel, x: number, y: number, dir: number, level: number, atEnd: boolean, atTop: boolean): CornerKeys {
  const [ux, uy] = SIDE_GEOMETRY[dir].u
  const own = cells.bandKey(x, y, dir, level)
  const at = (along: number, l: number): Tag => {
    const cx = x + along * ux
    const cy = y + along * uy
    if (!inBounds(voxel.size, cx, cy)) return own
    return bandExists(cells, voxel, cx, cy, dir, l) ? cells.bandKey(cx, cy, dir, l) : null
  }
  const before = atEnd ? 0 : -1
  const upper = atTop ? level + 1 : level
  return [at(before, upper), at(before + 1, upper), at(before, upper - 1), at(before + 1, upper - 1)]
}

// --- the chunk ------------------------------------------------------------------

export function meshTerrainChunk(voxel: ReadonlyVoxel, key: string, look: TerrainLook): TerrainChunkMesh {
  const bounds = chunkBounds(key, voxel.size.width, voxel.size.height)
  const solid = new BufferBuilder()
  const water = new BufferBuilder()
  const { atlas } = look
  const cells = new Cells(voxel, look)
  const marks: number[] = []
  const marked = new Set<string>()
  const composites = new Set<string>()
  const mark = (x: number, y: number, z: number): void => {
    const id = `${x},${y},${z}`
    if (marked.has(id)) return
    marked.add(id)
    marks.push(x, y, z)
  }

  if (!bounds) {
    return { key, solid: solid.finish(), water: null, marks: new Float32Array(0), composites: [] }
  }

  for (let y = bounds.y0; y < bounds.y1; y++) {
    for (let x = bounds.x0; x < bounds.x1; x++) {
      const index = y * voxel.size.width + x
      const tint = unpackTint(tintPaint(voxel.paint, x, y))
      const cornerH = cells.at(x, y).corners

      // --- top face, in quarters ---------------------------------------------
      {
        const shadeAt = CORNER_OFFSETS.map((offset, i) => cornerShade(cells, x, y, x + offset[0], y + offset[1], cornerH[i]))
        const at = (fx: number, fy: number): [number, number, number] => [x + fx, bilinear(cornerH, fx, fy) * HALF, y + fy]
        for (let q = 0; q < 4; q++) {
          const fx0 = (q % 2) * 0.5
          const fy0 = q > 1 ? 0.5 : 0
          const { tile, composite, combo } = atlas.tileFor(topCorner(cells, voxel, x, y, x + (q % 2), y + (q > 1 ? 1 : 0)))
          if (composite) {
            mark(x + (q % 2), bilinear(cornerH, q % 2, q > 1 ? 1 : 0) * HALF, y + (q > 1 ? 1 : 0))
            if (combo) composites.add(combo)
          }
          const [u0, v0, u1, v1] = atlas.uv(tile, QUADRANT_OF_QUARTER[q])
          // Corner order c00, c01, c11, c10 within the quarter. Sheets are authored top-down, so increasing map +Z walks down the sheet, which is decreasing v.
          solid.polygon(
            [at(fx0, fy0), at(fx0, fy0 + 0.5), at(fx0 + 0.5, fy0 + 0.5), at(fx0 + 0.5, fy0)],
            [
              [u0, v1],
              [u0, v0],
              [u1, v0],
              [u1, v1],
            ],
            [bilinear(shadeAt, fx0, fy0), bilinear(shadeAt, fx0, fy0 + 0.5), bilinear(shadeAt, fx0 + 0.5, fy0 + 0.5), bilinear(shadeAt, fx0 + 0.5, fy0)],
            tint,
            [SURFACE_TOP, x, y, 0],
          )
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
        for (let level = bottomLevel; level <= topLevel; level++) {
          // Bands sitting in a pit read darker at the bottom.
          const deep = 1 - AO_STRENGTH * Math.min(2, topLevel - level) * 0.5
          for (let q = 0; q < 4; q++) {
            const atEnd = q % 2 === 1
            const atTop = q < 2
            const t0 = atEnd ? 0.5 : 0
            const h0 = atTop ? level + 0.5 : level
            // The wall region cut to this quarter of this band, exactly: a slope crossing it is followed, not approximated.
            const piece = clipToRect(region, t0, t0 + 0.5, h0, h0 + 0.5)
            if (piece.length === 0) continue
            const { tile, composite, combo } = atlas.tileFor(bandCorner(cells, voxel, x, y, dir, level, atEnd, atTop))
            if (composite) {
              mark(ox + u[0] * (atEnd ? 1 : 0), (atTop ? level + 1 : level) * HALF, oz + u[1] * (atEnd ? 1 : 0))
              if (combo) composites.add(combo)
            }
            const [u0, v0, u1, v1] = atlas.uv(tile, QUADRANT_OF_QUARTER[q])
            solid.polygon(
              piece.map(([t, h]) => [ox + u[0] * t, h * HALF, oz + u[1] * t] as const),
              // The texture keeps its scale however the piece is cut: u along the side, v up the band.
              piece.map(([t, h]) => [u0 + ((t - t0) / 0.5) * (u1 - u0), v0 + ((h - h0) / 0.5) * (v1 - v0)] as const),
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
    marks: new Float32Array(marks),
    composites: [...composites],
  }
}
