import { describe, expect, it } from 'vitest'

import {
  DEFAULT_MATERIALS,
  CORNER_OFFSETS,
  FACE_TOP,
  DIR_VECTORS,
  HALF,
  NO_RAMP,
  PLACEHOLDER_SHEET,
  cornerHeights,
  createMap,
  faceKey,
  fillColumn,
  layersOf,
  slotMaterial,
  topLayersAt,
  rampShape,
  readAddress,
  tagOf,
  tileSlot,
  topHeight,
  AIR,
  SHAPE_BLOCK,
  SURFACE_CLIFF,
  SURFACE_TOP,
  SURFACE_UNDER,
  settleFaces,
  voxelIndex,
  type MapDoc,
  type ReadonlyMapDoc,
  type RgbaImage,
  type VoxelStructure,
} from '@papercut/document'
import { type LoadedSet } from './atlas'
import { createTerrainLook, type TerrainLook } from './look'
import { meshTerrainChunk, type MeshBuffers, type TerrainChunkMesh } from './terrain'
import { createTerrainSet, stampTemplate, tagCorner } from './terrainset'

/** The root voxel volume a fresh level has, mutable for setup: `createMap` names it `ground`. */
const ground = (doc: ReadonlyMapDoc | MapDoc): VoxelStructure => doc.structures.ground as VoxelStructure

const TILE = 4

function solid(width: number, height: number, rgba: [number, number, number, number]): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i)
  return { width, height, data }
}

/**
 * A stand-in for the placeholder terrain set the default materials draw from:
 * the five materials, each with an edge set stamped on its own 4×4 block
 * (four blocks per block-row on a 16-column sheet), over one flat colour.
 * A corner of one material and nothing resolves exactly; a pair is not
 * drawn, so it is the fallback.
 */
function placeholderSet(): LoadedSet {
  let set = createTerrainSet(PLACEHOLDER_SHEET, TILE, 16, 8)
  // A tag names a material of the project (ruling of 2026-09-17), so the blocks are the default materials by id.
  DEFAULT_MATERIALS.forEach((material, i) => {
    set = stampTemplate(set, (i % 4) * 4, Math.floor(i / 4) * 4, null, tagOf(material.id))
  })
  return { set, image: solid(16 * TILE, 8 * TILE, [0, 255, 0, 255]) }
}

/** Mesh one chunk of the ground through a fresh look over the default materials, the ones the sample paints with. */
function mesh(doc: MapDoc, key: string): TerrainChunkMesh {
  return meshTerrainChunk(ground(doc), key, createTerrainLook(DEFAULT_MATERIALS, [placeholderSet()]))
}

/**
 * The polygons a solid buffer was built from, each as its vertex range. The
 * builder fans every polygon from its first vertex, so a triangle whose first
 * index is new starts a polygon and the polygon's vertices run from there to
 * the highest index its triangles reach.
 */
function polygons(solid: MeshBuffers): Array<{ first: number; last: number }> {
  const out: Array<{ first: number; last: number }> = []
  for (let tri = 0; tri < solid.triangleCount; tri++) {
    const base = solid.indices[tri * 3]
    const end = Math.max(solid.indices[tri * 3 + 1], solid.indices[tri * 3 + 2])
    const current = out[out.length - 1]
    if (current && current.first === base) current.last = Math.max(current.last, end)
    else out.push({ first: base, last: end })
  }
  return out
}

/** Stand a column at `h` half-tiles, level on top: the voxel model's "set the height here". */
function setHeight(doc: MapDoc, x: number, y: number, h: number): void {
  fillColumn(ground(doc), x, y, h)
}

/** Make a column's top voxel a full ramp descending toward `dir`, keeping its height and material. */
function setRamp(doc: MapDoc, x: number, y: number, dir: number): void {
  const g = ground(doc)
  fillColumn(g, x, y, topHeight(g, x, y), { material: slotMaterial(topLayersAt(g, x, y)?.[0]) ?? 0, shape: rampShape(dir) })
}

/** The RGBA at the centroid of every triangle of cell (x, y)'s band at `level` on side `dir`. */
function bandTexels(chunk: TerrainChunkMesh, look: TerrainLook, x: number, y: number, dir: number, level: number): number[][] {
  const { solid } = chunk
  const { width, height, data } = look.atlas.image
  const out: number[][] = []
  for (let t = 0; t < solid.triangleCount; t++) {
    const address = readAddress(solid.faceAddr, t, 'ground')
    if (address.kind !== SURFACE_CLIFF || address.x !== x || address.y !== y || address.dir !== dir || address.level !== level) continue
    let u = 0
    let v = 0
    for (let k = 0; k < 3; k++) {
      const vertex = solid.indices[t * 3 + k]
      u += solid.uvs[vertex * 2] / 3
      v += solid.uvs[vertex * 2 + 1] / 3
    }
    const at = (Math.floor((1 - v) * height) * width + Math.floor(u * width)) * 4
    out.push([data[at], data[at + 1], data[at + 2], data[at + 3]])
  }
  return out
}

describe('what a face is drawn with', () => {
  it('draws a face with its first material layer, and one nobody painted as flat magenta', () => {
    // Built directly, and no store at all: this is a fact about the mesher and
    // the paint addressing, and a test may construct a document (#10).
    const doc = createMap(8, 8)
    setHeight(doc, 3, 3, 8)
    const look = createTerrainLook(DEFAULT_MATERIALS, [placeholderSet()])
    const magenta = (rgba: number[]): boolean => rgba[0] === 0xff && rgba[1] === 0 && rgba[2] === 0xff && rgba[3] === 255

    // Every side of the column in stone, so the band at level 6 (layer 3's lower band) meets only stone and
    // nothing, round the corners too: a stone band beside a grass one is a pair nobody drew, which is the fallback.
    for (let y = 0; y < 4; y++) for (let dir = 0; dir < 4; dir++) ground(doc).paint.faces[faceKey(3, 3, y, dir)] = layersOf(2)
    const painted = bandTexels(meshTerrainChunk(ground(doc), '0,0', look), look, 3, 3, 0, 6)
    expect(painted.length).toBeGreaterThan(0)
    expect(painted.some(magenta)).toBe(false)

    // Geometry does not ask paint whether to exist: the face still draws, as the fallback. Every east
    // face of the column goes, so the band's corners meet nothing painted above or below it either.
    for (let y = 0; y < 4; y++) delete ground(doc).paint.faces[faceKey(3, 3, y, 0)]
    const bare = bandTexels(meshTerrainChunk(ground(doc), '0,0', look), look, 3, 3, 0, 6)
    expect(bare.length).toBe(painted.length)
    expect(bare.every(magenta)).toBe(true)
  })
})

describe('material layers, stacked', () => {
  it('gives every vertex a rect per layer: its own tile where a layer holds something, transparent where it is empty', () => {
    const doc = createMap(6, 6)
    const g = ground(doc)
    // (2,2)'s top holds grass under path; everything else is grass alone.
    g.paint.faces[faceKey(2, 2, 0, FACE_TOP)] = ['m:0', 'm:4', null, null]
    const look = createTerrainLook(DEFAULT_MATERIALS, [placeholderSet()])
    const { solid } = meshTerrainChunk(g, '0,0', look)
    const { width, height, data } = look.atlas.image
    expect(solid.stackUvs?.length).toBe((solid.positions.length / 3) * 6)
    /** The alpha at the centroid of triangle `t` on layer `layer` (0 is `uvs`, 1–3 are `stackUvs`). */
    const alpha = (t: number, layer: number): number => {
      let u = 0
      let v = 0
      for (let k = 0; k < 3; k++) {
        const vertex = solid.indices[t * 3 + k]
        const uv = layer === 0 ? solid.uvs.subarray(vertex * 2, vertex * 2 + 2) : (solid.stackUvs as Float32Array).subarray(vertex * 6 + (layer - 1) * 2, vertex * 6 + layer * 2)
        u += uv[0] / 3
        v += uv[1] / 3
      }
      return data[(Math.floor((1 - v) * height) * width + Math.floor(u * width)) * 4 + 3]
    }
    const tops = (x: number, y: number): number[] => {
      const out: number[] = []
      for (let t = 0; t < solid.triangleCount; t++) {
        const a = readAddress(solid.faceAddr, t, 'ground')
        if (a.kind === SURFACE_TOP && a.x === x && a.y === y) out.push(t)
      }
      return out
    }
    // The path cell draws something on its second layer; a far cell draws nothing there, and nobody draws on the top two.
    expect(tops(2, 2).some((t) => alpha(t, 1) > 0)).toBe(true)
    expect(tops(5, 5).every((t) => alpha(t, 1) === 0)).toBe(true)
    for (const t of tops(2, 2)) {
      expect(alpha(t, 0)).toBe(255)
      expect(alpha(t, 2)).toBe(0)
      expect(alpha(t, 3)).toBe(0)
    }
  })

  it('draws the fallback on the first layer of a face with nothing on it, and nothing for its neighbours', () => {
    const doc = createMap(6, 6)
    const g = ground(doc)
    g.paint.faces[faceKey(2, 2, 0, FACE_TOP)] = [null, null, null, null]
    const look = createTerrainLook(DEFAULT_MATERIALS, [placeholderSet()], 0x123456)
    const { solid, missing } = meshTerrainChunk(g, '0,0', look)
    const [u0, v0, u1, v1] = look.atlas.uv(look.atlas.fallbackTile(), -1)
    for (let t = 0; t < solid.triangleCount; t++) {
      const a = readAddress(solid.faceAddr, t, 'ground')
      if (a.kind !== SURFACE_TOP || a.x !== 2 || a.y !== 2) continue
      const vertex = solid.indices[t * 3]
      expect(solid.uvs[vertex * 2]).toBeGreaterThanOrEqual(u0 - 1e-6)
      expect(solid.uvs[vertex * 2]).toBeLessThanOrEqual(u1 + 1e-6)
      expect(solid.uvs[vertex * 2 + 1]).toBeGreaterThanOrEqual(v0 - 1e-6)
      expect(solid.uvs[vertex * 2 + 1]).toBeLessThanOrEqual(v1 + 1e-6)
    }
    // Grass around the hole meets nothing there, which its edge set draws: nothing is missing.
    expect(missing).toEqual([])
  })
})

/** The placeholder set with grass's bottom edge tagged as its fringe and its top edge as its picket. */
function trimmedSet(): LoadedSet {
  const loaded = placeholderSet()
  const grass = tagOf(0)
  const tiles = new Map(loaded.set.tiles)
  for (const [index, tags] of tiles) {
    if (tags.join('|') === [grass, grass, null, null].join('|')) tiles.set(index, [tagOf(0, 'fringe'), tagOf(0, 'fringe'), null, null])
    if (tags.join('|') === [null, null, grass, grass].join('|')) tiles.set(index, [null, null, tagOf(0, 'picket'), tagOf(0, 'picket')])
  }
  return { ...loaded, set: { ...loaded.set, tiles } }
}

describe('tiles pasted whole on a face', () => {
  /** A sheet of two 4 px tiles, id 7, that says where every pixel is: red is the tile's index, green its quadrant. */
  function propsSet(): LoadedSet {
    const width = 2 * TILE
    const data = new Uint8ClampedArray(width * TILE * 4)
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < width; x++) {
        const quadrant = (y >= TILE / 2 ? 2 : 0) + (x % TILE >= TILE / 2 ? 1 : 0)
        data.set([Math.floor(x / TILE) * 100, quadrant * 50 + 10, 0, 255], (y * width + x) * 4)
      }
    }
    return { set: createTerrainSet('props.png', TILE, 2, 1), image: { width, height: TILE, data }, imageId: 7 }
  }

  /** Per triangle of the top of (x, y): which quarter its centroid is in, and the texel its first layer samples there. */
  function topTexels(chunk: TerrainChunkMesh, look: TerrainLook, x: number, y: number): Array<{ quarter: number; rgba: number[] }> {
    const { solid } = chunk
    const { width, height, data } = look.atlas.image
    const out: Array<{ quarter: number; rgba: number[] }> = []
    for (let t = 0; t < solid.triangleCount; t++) {
      const address = readAddress(solid.faceAddr, t, 'ground')
      if (address.kind !== SURFACE_TOP || address.x !== x || address.y !== y) continue
      let u = 0
      let v = 0
      let px = 0
      let pz = 0
      for (let k = 0; k < 3; k++) {
        const vertex = solid.indices[t * 3 + k]
        u += solid.uvs[vertex * 2] / 3
        v += solid.uvs[vertex * 2 + 1] / 3
        px += solid.positions[vertex * 3] / 3
        pz += solid.positions[vertex * 3 + 2] / 3
      }
      const at = (Math.floor((1 - v) * height) * width + Math.floor(u * width)) * 4
      out.push({ quarter: (pz - y >= 0.5 ? 2 : 0) + (px - x >= 0.5 ? 1 : 0), rgba: [...data.subarray(at, at + 4)] })
    }
    return out
  }

  it('draws a pasted tile whole on a top, north up, each quarter its own quadrant', () => {
    const doc = createMap(6, 6)
    const g = ground(doc)
    g.paint.faces[faceKey(2, 2, 0, FACE_TOP)] = [tileSlot(7, 1), null, null, null]
    const look = createTerrainLook(DEFAULT_MATERIALS, [placeholderSet(), propsSet()])
    const texels = topTexels(meshTerrainChunk(g, '0,0', look), look, 2, 2)
    expect(texels.length).toBe(8)
    for (const { quarter, rgba } of texels) expect(rgba).toEqual([100, quarter * 50 + 10, 0, 255])
  })

  it('stands a pasted tile upright on a wall, and is nothing to the material auto-tiling around it', () => {
    const doc = createMap(8, 8)
    const g = ground(doc)
    setHeight(doc, 3, 3, 4)
    // The column's south side, the one course standing over the ground, pasted on the layer over its grass.
    g.paint.faces[faceKey(3, 3, 1, 1)] = ['m:0', tileSlot(7, 0), null, null]
    const look = createTerrainLook(DEFAULT_MATERIALS, [placeholderSet(), propsSet()])
    const chunk = meshTerrainChunk(g, '0,0', look)
    // The upper band is the tile's top half, the lower its bottom: read off the layer the tile is on.
    const { solid } = chunk
    const { width, height, data } = look.atlas.image
    const greens = (level: number): number[] => {
      const out = new Set<number>()
      for (let t = 0; t < solid.triangleCount; t++) {
        const address = readAddress(solid.faceAddr, t, 'ground')
        if (address.kind !== SURFACE_CLIFF || address.x !== 3 || address.y !== 3 || address.dir !== 1 || address.level !== level) continue
        let u = 0
        let v = 0
        for (let k = 0; k < 3; k++) {
          const vertex = solid.indices[t * 3 + k]
          u += (solid.stackUvs as Float32Array)[vertex * 6] / 3
          v += (solid.stackUvs as Float32Array)[vertex * 6 + 1] / 3
        }
        out.add(data[(Math.floor((1 - v) * height) * width + Math.floor(u * width)) * 4 + 1])
      }
      return [...out].sort((a, b) => a - b)
    }
    expect(greens(3)).toEqual([10, 60])
    expect(greens(2)).toEqual([110, 160])
    // The grass is drawn, and nothing about the pasted tile is a transition nobody drew.
    expect(chunk.missing).toEqual([])
  })

  it('draws the fallback, reported, for a tile whose image did not load', () => {
    const doc = createMap(6, 6)
    ground(doc).paint.faces[faceKey(2, 2, 0, FACE_TOP)] = [tileSlot(9, 0), null, null, null]
    const look = createTerrainLook(DEFAULT_MATERIALS, [placeholderSet()])
    const chunk = meshTerrainChunk(ground(doc), '0,0', look)
    expect(chunk.missing).toContain('pasted tile')
    for (const { rgba } of topTexels(chunk, look, 2, 2)) expect(rgba).toEqual([0xff, 0, 0xff, 255])
  })
})

describe('fringes and pickets', () => {
  it('finds a material\u2019s trim tiles, and keeps them serving as its ordinary edges', () => {
    const look = createTerrainLook(DEFAULT_MATERIALS, [trimmedSet()])
    const grass = tagOf(0)
    expect(look.atlas.trimTile(grass, 'fringe')).not.toBeNull()
    expect(look.atlas.trimTile(grass, 'picket')).not.toBeNull()
    expect(look.atlas.trimTile(tagOf(1), 'fringe')).toBeNull()
    // Tagging an edge as a fringe adds a use: grass meeting nothing below it still resolves, and to that same tile.
    const edge = look.atlas.tileFor([grass, grass, null, null])
    expect(edge.missing).toBe(false)
    expect(edge.tile).toBe(look.atlas.trimTile(grass, 'fringe'))
  })

  it('keeps the first-drawn tile answering its corner when it is tagged as trim, even with a later copy', () => {
    const loaded = trimmedSet()
    const fringe = [...loaded.set.tiles].find(([, tags]) => tags[0] === tagOf(0, 'fringe'))?.[0] as number
    // A later tile tagged as the same plain edge, as a kit with a duplicate block has.
    const later = loaded.set.columns * loaded.set.rows - 1
    const tiles = new Map(loaded.set.tiles)
    tiles.set(later, [tagOf(0), tagOf(0), null, null])
    const look = createTerrainLook(DEFAULT_MATERIALS, [{ ...loaded, set: { ...loaded.set, tiles } }])
    expect(look.atlas.tileFor([tagOf(0), tagOf(0), null, null]).tile).toBe(look.atlas.trimTile(tagOf(0), 'fringe'))
    expect(fringe).toBeLessThan(later)
  })

  it('hangs a flap half a tile long at 45\u00b0 off a grass cliff top, and none where the edge is switched off', () => {
    const doc = createMap(8, 8)
    setHeight(doc, 3, 3, 6)
    const look = createTerrainLook(DEFAULT_MATERIALS, [trimmedSet()])
    const { trim } = meshTerrainChunk(ground(doc), '0,0', look)
    expect(trim).not.toBeNull()
    const t = trim as MeshBuffers
    // The east wall's flap: every vertex with x past the column's east side is on it, and none reaches further than the flap's own reach.
    const reach = 0.5 / Math.SQRT2
    const top = 6 * HALF
    let east = 0
    for (let v = 0; v < t.positions.length / 3; v++) {
      const [x, y, z] = [t.positions[v * 3], t.positions[v * 3 + 1], t.positions[v * 3 + 2]]
      // The volume's own rim is a cliff too, with flaps of its own, and the wall's foot has its picket: only the raised column's east flap is looked at.
      if (x <= 4 + 1e-6 || x > 5 || z < 2.5 || z > 4.5 || y < top - 1) continue
      east += 1
      expect(x).toBeLessThanOrEqual(4 + reach + 1e-6)
      // Down as far as out: 45\u00b0, never stretched past half a tile along the slope.
      expect(top - y).toBeCloseTo(x - 4, 5)
    }
    expect(east).toBeGreaterThan(0)
    // Switched off, the east wall has none; the others keep theirs, their corner wings reaching past it but never along it.
    ground(doc).paint.edges['3,3,0,top'] = 'off'
    const off = meshTerrainChunk(ground(doc), '0,0', look).trim as MeshBuffers
    let still = 0
    for (let v = 0; v < off.positions.length / 3; v++) {
      const [x, y, z] = [off.positions[v * 3], off.positions[v * 3 + 1], off.positions[v * 3 + 2]]
      if (x > 4 + 1e-6 && x < 5 && y > top - 1 && z > 3.01 && z < 3.99) still += 1
    }
    expect(still).toBe(0)
    expect(off.triangleCount).toBeGreaterThan(0)
  })

  it('stands a picket half a tile tall at the foot of a wall, on the grass below it', () => {
    const doc = createMap(8, 8)
    setHeight(doc, 3, 3, 6)
    const look = createTerrainLook(DEFAULT_MATERIALS, [trimmedSet()])
    const t = meshTerrainChunk(ground(doc), '0,0', look).trim as MeshBuffers
    // The ground around stands at one cube: a picket's vertices sit at its height or half a tile above, a hair off the wall.
    const floor = 2 * HALF
    let picket = 0
    for (let v = 0; v < t.positions.length / 3; v++) {
      const [x, y, z] = [t.positions[v * 3], t.positions[v * 3 + 1], t.positions[v * 3 + 2]]
      // Around the raised column only: the volume's rim hangs flaps of its own below the floor.
      if (y > floor + 0.5 + 1e-6 || x < 2.5 || x > 4.5 || z < 2.5 || z > 4.5) continue
      picket += 1
      expect([floor, floor + 0.5].some((h) => Math.abs(h - y) < 1e-6)).toBe(true)
    }
    expect(picket).toBeGreaterThan(0)
  })

  it('hangs the flap at the material\u2019s angle and stands the picket at its distance, the flap never longer for it', () => {
    const doc = createMap(8, 8)
    setHeight(doc, 3, 3, 6)
    const top = 6 * HALF
    const floor = 2 * HALF
    const grass = { ...DEFAULT_MATERIALS[0], fringeAngle: 90, picketDistance: 1 }
    const look = createTerrainLook([grass, ...DEFAULT_MATERIALS.slice(1)], [trimmedSet()])
    const t = meshTerrainChunk(ground(doc), '0,0', look).trim as MeshBuffers
    let flap = 0
    let picket = 0
    for (let v = 0; v < t.positions.length / 3; v++) {
      const [x, y, z] = [t.positions[v * 3], t.positions[v * 3 + 1], t.positions[v * 3 + 2]]
      if (z < 3.01 || z > 3.99 || x < 3.9 || x > 5) continue
      // At 90\u00b0 the flap hangs flat against the east wall: no jut, and half a tile down, never more.
      if (y > top - 1) {
        flap += 1
        expect(x).toBeCloseTo(4, 5)
        expect(top - y).toBeLessThanOrEqual(0.5 + 1e-6)
      }
      // One pixel out from the wall, at one tile (TILE pixels) to the world unit.
      if (y < floor + 0.5 + 1e-6 && y > floor - 1e-6) {
        picket += 1
        expect(x).toBeCloseTo(4 + 0.02 + 1 / TILE, 5)
      }
    }
    expect(flap).toBeGreaterThan(0)
    expect(picket).toBeGreaterThan(0)
  })

  it('turns an outside corner with the material\u2019s corner fringe, when it has one', () => {
    const loaded = trimmedSet()
    const grass = tagOf(0)
    const f = tagOf(0, 'fringe')
    const tiles = new Map(loaded.set.tiles)
    for (const [index, tags] of tiles) {
      if (tags.join('|') === [grass, null, null, null].join('|')) tiles.set(index, [f, null, null, null])
      if (tags.join('|') === [null, grass, null, null].join('|')) tiles.set(index, [null, f, null, null])
    }
    const look = createTerrainLook(DEFAULT_MATERIALS, [{ ...loaded, set: { ...loaded.set, tiles } }])
    const fromLeft = look.atlas.trimTile(grass, 'fringe', 'from-left')
    const fromRight = look.atlas.trimTile(grass, 'fringe', 'from-right')
    expect(fromLeft).not.toBeNull()
    expect(fromRight).not.toBeNull()
    const doc = createMap(8, 8)
    setHeight(doc, 3, 3, 6)
    const t = meshTerrainChunk(ground(doc), '0,0', look).trim as MeshBuffers
    /** Whether any vertex samples inside tile `tile`'s rect. */
    const samples = (tile: number): boolean => {
      const [u0, v0, u1, v1] = look.atlas.uv(tile, -1)
      for (let v = 0; v < t.uvs.length / 2; v++) {
        const [u, w] = [t.uvs[v * 2], t.uvs[v * 2 + 1]]
        if (u > u0 + 1e-6 && u < u1 - 1e-6 && w > v0 + 1e-6 && w < v1 - 1e-6) return true
      }
      return false
    }
    // A single raised column has four outside corners: each side\u2019s flap turns both with a corner tile.
    expect(samples(fromLeft as number)).toBe(true)
    expect(samples(fromRight as number)).toBe(true)
  })

  it('draws no trim for a material with none tagged', () => {
    const doc = createMap(8, 8)
    setHeight(doc, 3, 3, 6)
    expect(meshTerrainChunk(ground(doc), '0,0', createTerrainLook(DEFAULT_MATERIALS, [placeholderSet()])).trim).toBeNull()
  })
})

describe('mesher', () => {
  it('emits a top face per cell as four quarters, every one addressed back to the cell', () => {
    const doc = createMap(4, 4)
    const { solid } = mesh(doc, '0,0')
    // Four quarter quads, two triangles each: eight top triangles per cell.
    const tops = new Map<string, number>()
    for (let tri = 0; tri < solid.triangleCount; tri++) {
      const address = readAddress(solid.faceAddr, tri, 'ground')
      if (address.kind !== SURFACE_TOP) continue
      const cell = `${address.x},${address.y}`
      tops.set(cell, (tops.get(cell) ?? 0) + 1)
    }
    expect(tops.size).toBe(16)
    expect([...tops.values()].every((count) => count === 8)).toBe(true)
  })

  it('emits one cliff band per half-tile level of the drop, however many pieces each band is cut into', () => {
    const doc = createMap(4, 4)
    setHeight(doc, 1, 1, 6)
    const { solid } = mesh(doc, '0,0')
    // A band is up to four quarter pieces; what is counted is the distinct (side, level) addresses.
    const east = new Set<number>()
    for (let tri = 0; tri < solid.triangleCount; tri++) {
      const address = readAddress(solid.faceAddr, tri, 'ground')
      if (address.kind === SURFACE_CLIFF && address.x === 1 && address.y === 1 && address.dir === 0) {
        east.add(address.level)
      }
    }
    // Neighbour sits at 2, this cell at 6: bands at 2, 3, 4, 5.
    expect([...east].sort((a, b) => a - b)).toEqual([2, 3, 4, 5])
  })

  it('suppresses the cliff on a ramp’s descending side', () => {
    const doc = createMap(4, 4)
    setHeight(doc, 1, 1, 4)
    setRamp(doc, 1, 1, 0)
    const { solid } = mesh(doc, '0,0')
    for (let tri = 0; tri < solid.triangleCount; tri++) {
      const address = readAddress(solid.faceAddr, tri, 'ground')
      if (address.kind === SURFACE_CLIFF && address.x === 1 && address.y === 1) {
        expect(address.dir).not.toBe(0)
      }
    }
  })

  it('a flat cell beside a ramp walls off the triangle under the ramp’s sloped edge', () => {
    // Cell (1, 1) at 4 ramps down to the east, so its north edge runs from 4 at the
    // west corner to 2 at the east. Its north neighbour (1, 0) is flat at 4: along the
    // shared edge it stands above the ramp by a triangle, which it must wall — before,
    // both cells compared flat heights, saw 4 against 4, and drew nothing there.
    const doc = createMap(4, 4)
    setHeight(doc, 1, 1, 4)
    setHeight(doc, 1, 0, 4)
    setRamp(doc, 1, 1, 0)
    const { solid } = mesh(doc, '0,0')
    const south = new Set<number>()
    let rampNorth = 0
    for (let tri = 0; tri < solid.triangleCount; tri++) {
      const address = readAddress(solid.faceAddr, tri, 'ground')
      if (address.kind !== SURFACE_CLIFF) continue
      if (address.x === 1 && address.y === 0 && address.dir === 1) south.add(address.level)
      if (address.x === 1 && address.y === 1 && address.dir === 3) rampNorth++
    }
    // The flat cell walls the bands the sloped edge crosses, 2 up to 4; the ramp, lower, walls nothing back.
    expect([...south].sort((a, b) => a - b)).toEqual([2, 3])
    expect(rampNorth).toBe(0)
  })

  it('a ramp descending over a drop walls the drop below its low edge', () => {
    const doc = createMap(4, 4)
    setHeight(doc, 1, 1, 4)
    setHeight(doc, 2, 1, 0)
    setRamp(doc, 1, 1, 0)
    const { solid } = mesh(doc, '0,0')
    const east = new Set<number>()
    for (let tri = 0; tri < solid.triangleCount; tri++) {
      const address = readAddress(solid.faceAddr, tri, 'ground')
      if (address.kind === SURFACE_CLIFF && address.x === 1 && address.y === 1 && address.dir === 0) east.add(address.level)
    }
    // The low edge is at 2; the neighbour at 0: bands 0 and 1, and nothing above the edge.
    expect([...east].sort((a, b) => a - b)).toEqual([0, 1])
  })

  it('gives every polygon a non-degenerate UV rectangle', () => {
    // Regression: top quads and side faces walk their corners along different
    // axes, and a shared rectangle-to-corner mapping collapsed the top quad's
    // UVs onto two points, which streaked the whole terrain. A top quarter is a
    // quad; a wall piece clipped by a slope may be a triangle or a pentagon,
    // and the same must hold of each.
    const doc = createMap(4, 4)
    setHeight(doc, 1, 1, 6)
    const { solid } = mesh(doc, '0,0')
    const found = polygons(solid)
    expect(found.length).toBeGreaterThan(0)

    for (const { first, last } of found) {
      const us: number[] = []
      const vs: number[] = []
      for (let vertex = first; vertex <= last; vertex++) {
        us.push(solid.uvs[vertex * 2])
        vs.push(solid.uvs[vertex * 2 + 1])
      }
      // A tile occupies a rectangle, so both axes must actually vary.
      expect(Math.max(...us) - Math.min(...us)).toBeGreaterThan(1e-6)
      expect(Math.max(...vs) - Math.min(...vs)).toBeGreaterThan(1e-6)
      // And every corner must be a distinct point in UV space.
      const unique = new Set(us.map((u, i) => `${u.toFixed(6)},${vs[i].toFixed(6)}`))
      expect(unique.size).toBe(us.length)
    }
  })

  it('maps the atlas the right way up on a top quarter', () => {
    const doc = createMap(4, 4)
    const { solid } = mesh(doc, '0,0')
    // The first polygon is the north-west quarter of cell (0, 0), corners in
    // order c00, c01, c11, c10. Sheets are authored top-down, so walking +Z
    // down the map (c00 to c01) walks down the atlas, which is decreasing v;
    // walking +X (c01 to c11) is increasing u.
    const v00 = solid.uvs[1]
    const v01 = solid.uvs[3]
    const u01 = solid.uvs[2]
    const u11 = solid.uvs[4]
    expect(v00).toBeGreaterThan(v01)
    expect(u11).toBeGreaterThan(u01)
  })

  it('produces finite, consistent buffers', () => {
    const doc = createMap(8, 8)
    setHeight(doc, 2, 2, 7)
    setRamp(doc, 3, 2, 1)
    const { solid } = mesh(doc, '0,0')
    expect(solid.positions.length / 3).toBe(solid.normals.length / 3)
    expect(solid.positions.length / 3).toBe(solid.uvs.length / 2)
    expect(solid.positions.length / 3).toBe(solid.colors.length / 3)
    expect(solid.faceAddr.length / 4).toBe(solid.triangleCount)
    expect([...solid.positions].every(Number.isFinite)).toBe(true)
    expect([...solid.normals].every(Number.isFinite)).toBe(true)
  })
})

describe('walls are watertight', () => {
  /** Which corners each side walks, start to end (as the mesher's SIDE_CORNERS). */
  const SIDE_CORNERS = [
    [2, 3],
    [1, 2],
    [0, 1],
    [3, 0],
  ] as const

  /**
   * A 16 × 16 map of random heights with a ramp on a third of the cells, from a fixed seed. A ramp is the top voxel's
   * shape, so a ramp cell is stood at an even height of at least one cube: its high edge is then the drawn height and
   * its low corners sit RAMP_DROP below, as the heightmap's ramps did.
   */
  function rampy(seed: number): MapDoc {
    const doc = createMap(16, 16)
    const g = ground(doc)
    let state = seed
    const next = () => {
      state = (state * 1664525 + 1013904223) % 4294967296
      return state / 4294967296
    }
    for (let y = 0; y < g.size.height; y++) {
      for (let x = 0; x < g.size.width; x++) {
        const h = Math.floor(next() * 10)
        const dir = next() < 0.35 ? Math.floor(next() * 4) : NO_RAMP
        if (dir === NO_RAMP) fillColumn(g, x, y, h)
        else fillColumn(g, x, y, Math.max(2, h - (h % 2)), { material: 0, shape: rampShape(dir) })
      }
    }
    return doc
  }

  /**
   * Along every side of every cell, sampled on a grid of positions and heights: a point strictly between the two
   * cells' edges must be covered by a wall triangle from one side or the other, and a point outside that span must not
   * be (a fin standing proud of a surface).
   */
  function gaps(doc: MapDoc): string[] {
    const g = ground(doc)
    const { positions, indices, faceAddr } = mesh(doc, '0,0').solid
    const walls = new Map<string, Array<[[number, number, number], [number, number, number], [number, number, number]]>>()
    for (let tri = 0; tri < indices.length / 3; tri++) {
      const address = readAddress(faceAddr, tri, 'ground')
      if (address.kind !== SURFACE_CLIFF) continue
      const corner = (k: number): [number, number, number] => {
        const v = indices[tri * 3 + k] * 3
        return [positions[v], positions[v + 1], positions[v + 2]]
      }
      const key = `${address.x},${address.y},${address.dir}`
      const list = walls.get(key) ?? []
      list.push([corner(0), corner(1), corner(2)])
      walls.set(key, list)
    }
    const origins = [[1, 1], [0, 1], [0, 0], [1, 0]] as const
    const axes = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const
    const problems: string[] = []
    const { width, height } = g.size
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        for (let dir = 0; dir < 4; dir++) {
          const [dx, dy] = DIR_VECTORS[dir]
          const nx = x + dx
          const ny = y + dy
          const here = cornerHeights(g, x, y)
          const [sc, ec] = SIDE_CORNERS[dir]
          const top = [here[sc], here[ec]]
          let low = [0, 0]
          const outside = !(nx >= 0 && ny >= 0 && nx < width && ny < height)
          if (!outside) {
            const there = cornerHeights(g, nx, ny)
            const across = (c: number) => {
              const [ox, oy] = CORNER_OFFSETS[c]
              return CORNER_OFFSETS.findIndex(([px, py]) => px === ox - dx && py === oy - dy)
            }
            low = [there[across(sc)], there[across(ec)]]
          }
          const ox = x + origins[dir][0]
          const oz = y + origins[dir][1]
          const [ux, uz] = axes[dir]
          // Walls on this side from this cell, and from the neighbour on its facing side.
          const tris = [...(walls.get(`${x},${y},${dir}`) ?? []), ...(walls.get(`${nx},${ny},${(dir + 2) % 4}`) ?? [])]
          const flat = tris.map((t) => t.map(([px, py, pz]) => [(px - ox) * ux + (pz - oz) * uz, py / HALF] as const))
          const covered = (t: number, h: number) =>
            flat.some(([a, b, c]) => {
              const d1 = (t - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (h - b[1])
              const d2 = (t - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (h - c[1])
              const d3 = (t - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (h - a[1])
              const negative = d1 < -1e-9 || d2 < -1e-9 || d3 < -1e-9
              const positive = d1 > 1e-9 || d2 > 1e-9 || d3 > 1e-9
              return !(negative && positive)
            })
          // Twelve positions along the side and quarter-band heights: a hole or fin is at least a triangle half a band tall.
          for (let i = 1; i < 12; i++) {
            const t = i / 12
            const hTop = top[0] + (top[1] - top[0]) * t
            const hLow = low[0] + (low[1] - low[0]) * t
            // Past the map's edge there is nothing to meet below the floor: only the wall above it is owed.
            const lo = outside ? Math.max(0, Math.min(hTop, hLow)) : Math.min(hTop, hLow)
            const hi = outside ? Math.max(0, hTop) : Math.max(hTop, hLow)
            if (hi <= lo) continue
            for (let h = Math.floor(lo) - 1; h <= hi + 1; h += 0.25) {
              const within = h > lo + 0.02 && h < hi - 0.02
              const beyond = h < lo - 0.02 || h > hi + 0.02
              if (within && !covered(t, h)) problems.push(`hole at cell ${x},${y} side ${dir}, t ${t.toFixed(2)}, h ${h.toFixed(2)}`)
              if (beyond && covered(t, h)) problems.push(`fin at cell ${x},${y} side ${dir}, t ${t.toFixed(2)}, h ${h.toFixed(2)}`)
            }
          }
        }
      }
    }
    return problems
  }

  it('beside a ramp that drops across a band boundary — the gap on the sample map — the wall follows the slope', () => {
    // (9, 19) on the sample map: a 5 ramping south to 3, a flat 3 to its east.
    const doc = createMap(4, 4)
    const g = ground(doc)
    for (let y = 0; y < g.size.height; y++) for (let x = 0; x < g.size.width; x++) fillColumn(g, x, y, 3)
    setHeight(doc, 1, 1, 5)
    setRamp(doc, 1, 1, 1)
    expect(gaps(doc).slice(0, 5)).toEqual([])
  })

  it('has no hole and no fin anywhere on maps of random heights and ramps', () => {
    // Two maps of 256 cells, a third of them ramps, already meet every pairing of ramp and neighbour many times over.
    for (const seed of [7, 42]) expect(gaps(rampy(seed)).slice(0, 5)).toEqual([])
  })
})

describe('the foot of a cliff', () => {
  it('does not blend the ground with a different material standing over it', () => {
    // A stone plateau on grass. The grass at its foot used to take the stone above it as a neighbour, asking for a
    // stone and grass transition nobody would draw; only the same material over it counts as connected.
    const doc = createMap(8, 8)
    for (let z = 2; z < 5; z++) for (let x = 2; x < 5; x++) setHeight(doc, x, z, 6)
    for (let z = 2; z < 5; z++) for (let x = 2; x < 5; x++) ground(doc).paint.faces[faceKey(x, z, 2, FACE_TOP)] = layersOf(2)
    const { missing } = mesh(doc, '0,0')
    expect(missing).toEqual([])
  })
})

describe('a wall at the map’s rim', () => {
  it('keeps its top and foot as edges out to the corner, rather than reading the air off the map as more wall', () => {
    // Found 2026-09-21: ground raised to the map's edge asked for an inside corner at each end of every rim wall — the
    // course above and below off the map counted as wall — and drew whatever answered that, a floor's inside corner.
    const doc = createMap(4, 4)
    for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) setHeight(doc, x, z, 2)
    const look = createTerrainLook(DEFAULT_MATERIALS, [placeholderSet()])
    const asked: (string | null)[][] = []
    const tileFor = look.atlas.tileFor.bind(look.atlas)
    look.atlas.tileFor = (keys, archetype, direction) => {
      if (archetype === 'wall') asked.push([...keys])
      return tileFor(keys, archetype, direction)
    }
    meshTerrainChunk(ground(doc), '0,0', look)
    expect(asked.length).toBeGreaterThan(0)
    // A wall one course tall is all top band and foot: nothing above it, nothing below it, at every corner it has.
    for (const [nw, ne, sw, se] of asked) expect((nw === null && ne === null) || (sw === null && se === null)).toBe(true)
  })
})

describe('a wall turning a corner (decision of 2026-09-21)', () => {
  /** Every corner a wall asks the atlas for while `doc` is meshed through `look`. */
  const wallCorners = (doc: MapDoc, look: TerrainLook): (string | null)[][] => {
    const asked: (string | null)[][] = []
    const tileFor = look.atlas.tileFor.bind(look.atlas)
    look.atlas.tileFor = (keys, archetype, direction) => {
      if (archetype === 'wall') asked.push([...keys])
      return tileFor(keys, archetype, direction)
    }
    meshTerrainChunk(ground(doc), '0,0', look)
    return asked
  }
  /** Whether a corner is a wall ending: something on one side of it and nothing on the other, in a row. */
  const ends = ([nw, ne, sw, se]: (string | null)[]): boolean => (nw === null) !== (ne === null) || (sw === null) !== (se === null)

  it('carries a wall on round an outside corner and an inside one, with no end drawn at either', () => {
    // An L of columns a course above the ground: five outside corners, and the inside one in the crook of the L.
    const doc = createMap(8, 8)
    for (const [x, z] of [[2, 2], [3, 2], [2, 3]]) setHeight(doc, x, z, 4)
    const asked = wallCorners(doc, createTerrainLook(DEFAULT_MATERIALS, [placeholderSet()]))
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.filter(ends)).toEqual([])
  })

  it('folds the material’s seam art across a turn, and draws its ordinary wall there without it', () => {
    // A pillar a course above the ground: each end of each face is at an outside corner. Grass's convex seam is a cap
    // and a foot, in red.
    const doc = createMap(8, 8)
    setHeight(doc, 3, 3, 4)
    const seam = tagOf(DEFAULT_MATERIALS[0].id, 'convex')
    let set = placeholderSet().set
    const image = solid(16 * TILE, 8 * TILE, [0, 255, 0, 255])
    const paint = (column: number, row: number): void => {
      for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) image.data.set([255, 0, 0, 255], ((row * TILE + y) * 16 * TILE + column * TILE + x) * 4)
    }
    const tag = (column: number, row: number, corners: (string | null)[]): void => {
      corners.forEach((corner, i) => (set = tagCorner(set, row * 16 + column, i, corner)))
      paint(column, row)
    }
    tag(15, 6, [null, null, seam, seam])
    tag(15, 7, [seam, seam, null, null])
    const red = (rgba: number[]): boolean => rgba[0] === 255 && rgba[1] === 0
    const withSeam = createTerrainLook(DEFAULT_MATERIALS, [{ set, image }])
    const seamed = [2, 3].flatMap((level) => bandTexels(meshTerrainChunk(ground(doc), '0,0', withSeam), withSeam, 3, 3, 1, level))
    expect(seamed.length).toBeGreaterThan(0)
    expect(seamed.every(red)).toBe(true)
    const plain = createTerrainLook(DEFAULT_MATERIALS, [placeholderSet()])
    const unseamed = [2, 3].flatMap((level) => bandTexels(meshTerrainChunk(ground(doc), '0,0', plain), plain, 3, 3, 1, level))
    expect(unseamed.length).toBe(seamed.length)
    expect(unseamed.some(red)).toBe(false)
  })
})

describe('texel scale', () => {
  it('draws a wall with as many texels per world unit, up it, as a floor has across it', () => {
    const doc = createMap(8, 8)
    setHeight(doc, 3, 3, 6)
    const { solid } = mesh(doc, '0,0')
    /** Texture change per world unit between two vertices of one triangle, along the axis `axis` (1 = y, 2 = z). */
    const rates = (kind: number, axis: number): number[] => {
      const out: number[] = []
      for (let t = 0; t < solid.triangleCount; t++) {
        if (solid.faceAddr[t * 4] !== kind) continue
        const [a, b, c] = [0, 1, 2].map((k) => solid.indices[t * 3 + k])
        for (const [p, q] of [[a, b], [b, c], [a, c]]) {
          const d = solid.positions[q * 3 + axis] - solid.positions[p * 3 + axis]
          if (Math.abs(d) < 0.2) continue
          out.push(Math.abs((solid.uvs[q * 2 + 1] - solid.uvs[p * 2 + 1]) / d))
        }
      }
      return out
    }
    const floor = rates(SURFACE_TOP, 2)
    const wall = rates(SURFACE_CLIFF, 1)
    expect(floor.length).toBeGreaterThan(0)
    expect(wall.length).toBeGreaterThan(0)
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    expect(mean(wall) / mean(floor)).toBeCloseTo(1, 1)
  })
})

describe('walls beside slopes', () => {
  it('textures the wall between a level cell and a ramp of the same top, rather than sampling nothing', () => {
    // (0,0) and (0,1) both top out at 4; (0,1) is a ramp descending east, so its edge toward (0,0) slopes from 4 to 2.
    // The wall the mesher emits under that slope belongs to (0,0)'s south side, and it must find its own bands there.
    const doc = createMap(4, 4)
    setHeight(doc, 0, 0, 4)
    setHeight(doc, 0, 1, 4)
    setRamp(doc, 0, 1, 0)
    const look = createTerrainLook(DEFAULT_MATERIALS, [placeholderSet()])
    const { solid } = meshTerrainChunk(ground(doc), '0,0', look)
    const { width, height, data } = look.atlas.image
    let walls = 0
    for (let t = 0; t < solid.triangleCount; t++) {
      if (solid.faceAddr[t * 4] !== SURFACE_CLIFF || solid.faceAddr[t * 4 + 1] !== 0 || solid.faceAddr[t * 4 + 2] !== 0) continue
      walls += 1
      // Every triangle of the wall samples an opaque texel at its centroid: no piece fell on the blank tile.
      let u = 0
      let v = 0
      for (let k = 0; k < 3; k++) {
        const vertex = solid.indices[t * 3 + k]
        u += solid.uvs[vertex * 2] / 3
        v += solid.uvs[vertex * 2 + 1] / 3
      }
      const px = Math.floor(u * width)
      const py = Math.floor((1 - v) * height)
      expect(data[(py * width + px) * 4 + 3]).toBe(255)
    }
    expect(walls).toBeGreaterThan(0)
  })
})

describe('a material nothing is tagged with', () => {
  it('draws the fallback: nothing is made up for art nobody drew', () => {
    // A material no longer points at a sheet, so the only way it can have no art is that no tile anywhere is
    // tagged with it. Moss is such a material. It used to draw its swatch; with nothing composited
    // (ruling of 2026-09-18) a corner no tile answers is the fallback, and it is on the list to author.
    const materials = [{ id: 0, name: 'Grass', color: 0x6aa84f, archetype: 'floor' as const }, { id: 9, name: 'Moss', color: 0x336633, archetype: 'floor' as const }]
    const look = createTerrainLook(materials, [placeholderSet()], 0x102030)
    const moss = tagOf(9)
    const answer = look.atlas.tileFor([moss, moss, moss, moss])
    expect(answer.missing).toBe(true)
    expect(answer.combo).toBe('Moss')
    const [u0, v0] = look.atlas.uv(answer.tile, 0)
    const { width, height, data } = look.atlas.image
    const x = Math.floor(u0 * width) + 1
    const y = Math.floor((1 - v0) * height) - 1
    const at = (y * width + x) * 4
    expect([data[at], data[at + 1], data[at + 2], data[at + 3]]).toEqual([0x10, 0x20, 0x30, 255])
  })
})

describe("a ramp's surface is a tile and a half long, drawn from quarters (decision of 2026-09-19)", () => {
  /** The triangles of cell (x, y)'s top, each with the centroid of its UVs. */
  function topTriangles(chunk: TerrainChunkMesh, x: number, y: number): Array<{ u: number; v: number }> {
    const { solid } = chunk
    const out: Array<{ u: number; v: number }> = []
    for (let t = 0; t < solid.triangleCount; t++) {
      const address = readAddress(solid.faceAddr, t, 'ground')
      if (address.kind !== SURFACE_TOP || address.x !== x || address.y !== y) continue
      let u = 0
      let v = 0
      for (let k = 0; k < 3; k++) {
        const vertex = solid.indices[t * 3 + k]
        u += solid.uvs[vertex * 2] / 3
        v += solid.uvs[vertex * 2 + 1] / 3
      }
      out.push({ u, v })
    }
    return out
  }

  it('cuts a full ramp into six pieces, and leaves a level top at four', () => {
    const doc = createMap(8, 8)
    setHeight(doc, 3, 3, 4)
    setHeight(doc, 5, 5, 4)
    setRamp(doc, 3, 3, 1)
    const chunk = mesh(doc, '0,0')
    expect(topTriangles(chunk, 3, 3)).toHaveLength(12)
    expect(topTriangles(chunk, 5, 5)).toHaveLength(8)
  })

  it('cuts the middle row from the plain edge arrangement along the run', () => {
    const doc = createMap(8, 8)
    setHeight(doc, 3, 3, 4)
    // Descending south: its sides, west and east, stand over level ground that joins it only at its foot.
    setRamp(doc, 3, 3, 1)
    const look = createTerrainLook(DEFAULT_MATERIALS, [placeholderSet()])
    const chunk = meshTerrainChunk(ground(doc), '0,0', look)
    const grass = tagOf(0)
    const inside = (rect: readonly [number, number, number, number]) => (t: { u: number; v: number }): boolean => t.u > rect[0] && t.u < rect[2] && t.v > rect[1] && t.v < rect[3]
    // West of the centre line: nothing to the west, grass to the east, the same above as below; its north-east quadrant.
    const west = look.atlas.tileFor([null, grass, null, grass], 'ramp')
    const east = look.atlas.tileFor([grass, null, grass, null], 'ramp')
    expect(west.missing || east.missing).toBe(false)
    const triangles = topTriangles(chunk, 3, 3)
    expect(triangles.filter(inside(look.atlas.uv(west.tile, 1)))).toHaveLength(2)
    expect(triangles.filter(inside(look.atlas.uv(east.tile, 0)))).toHaveLength(2)
  })

  it('draws a ramp that runs east with art drawn for south, turned, rather than falling back (ruling of 2026-09-19)', () => {
    // A lone ramp on level ground: every corner of it meets nothing at a lower neighbour or grass at its foot. Give it
    // art for ONE direction only, every arrangement of grass against nothing drawn for a run to the south.
    const south = tagOf(0, null, 'ramp', 's')
    const set = stampTemplate(createTerrainSet('runs.png', TILE, 16, 8), 0, 0, null, south)
    const look = createTerrainLook(DEFAULT_MATERIALS, [placeholderSet(), { set, image: solid(16 * TILE, 8 * TILE, [200, 0, 0, 255]) }])
    const texelsOf = (dir: number): number[][] => {
      const doc = createMap(8, 8)
      setHeight(doc, 3, 3, 4)
      setRamp(doc, 3, 3, dir)
      const chunk = meshTerrainChunk(ground(doc), '0,0', look)
      const { width, data } = look.atlas.image
      const height = look.atlas.image.height
      return topTriangles(chunk, 3, 3).map((t) => {
        const at = (Math.floor((1 - t.v) * height) * width + Math.floor(t.u * width)) * 4
        return [data[at], data[at + 1], data[at + 2], data[at + 3]]
      })
    }
    // Red is the directed sheet; the placeholder is green. South is the art as drawn, north its mirror, east and west turned.
    for (const dir of [0, 1, 2, 3]) {
      const reds = texelsOf(dir).filter((rgba) => rgba[0] === 200 && rgba[3] === 255)
      expect(reds.length, `direction ${dir}`).toBeGreaterThan(0)
    }
  })

  it('stretches a pasted tile over the whole slope rather than repeating a row of it', () => {
    const doc = createMap(8, 8)
    setHeight(doc, 3, 3, 4)
    setRamp(doc, 3, 3, 1)
    const g = ground(doc)
    const key = faceKey(3, 3, 1, FACE_TOP)
    g.paint.faces[key] = [tileSlot(1, 5), null, null, null]
    const look = createTerrainLook(DEFAULT_MATERIALS, [{ ...placeholderSet(), imageId: 1 }])
    const chunk = meshTerrainChunk(g, '0,0', look)
    const tile = look.atlas.pastedTile(1, 5)
    expect(tile).not.toBeNull()
    const [u0, v0, u1, v1] = look.atlas.uv(tile as number, -1)
    const triangles = topTriangles(chunk, 3, 3)
    expect(triangles).toHaveLength(12)
    // Every piece samples the pasted tile, and between them they reach its top third and its bottom third.
    for (const t of triangles) expect(t.u > u0 && t.u < u1 && t.v > v0 && t.v < v1).toBe(true)
    expect(triangles.some((t) => t.v > v0 + ((v1 - v0) * 2) / 3)).toBe(true)
    expect(triangles.some((t) => t.v < v0 + (v1 - v0) / 3)).toBe(true)
  })
})

describe("a ramp's rail, side and landings (decisions of 2026-09-19)", () => {
  const RAIL = tagOf(0, 'rail')
  const LANDING = tagOf(0, 'landing')
  /** Every arrangement of grass's rail against nothing, which is what a rail's tiles are; red, so it can be told from the green placeholder. */
  function railSet(bends = false): LoadedSet {
    let set = stampTemplate(createTerrainSet('rails.png', TILE, 16, 8), 0, 0, null, RAIL)
    if (bends) {
      set = tagCorner(tagCorner(set, 64, 2, LANDING), 64, 3, RAIL)
      set = tagCorner(tagCorner(set, 65, 2, RAIL), 65, 3, LANDING)
    }
    return { set, image: solid(16 * TILE, 8 * TILE, [200, 0, 0, 255]) }
  }
  const upright = (landings = false): typeof DEFAULT_MATERIALS => DEFAULT_MATERIALS.map((m) => (m.id === 0 ? { ...m, railStyle: 'upright' as const, ...(landings ? { landings: true } : {}) } : m))
  /** A lone full ramp descending south from two tiles up, on ground one tile up: its west and east sides are open. */
  function loneRamp(): MapDoc {
    const doc = createMap(8, 8)
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) setHeight(doc, x, y, 2)
    setHeight(doc, 3, 3, 4)
    setRamp(doc, 3, 3, 1)
    return doc
  }
  const corner = (buffers: MeshBuffers, vertex: number): [number, number, number] => [buffers.positions[vertex * 3], buffers.positions[vertex * 3 + 1], buffers.positions[vertex * 3 + 2]]

  it('stands no rail where the material has no rail art', () => {
    expect(mesh(loneRamp(), '0,0').trim).toBeNull()
  })

  it('lays a sloped rail along the slope in three pieces a side, each a rectangle a tile tall, turned and never skewed', () => {
    const chunk = meshTerrainChunk(ground(loneRamp()), '0,0', createTerrainLook(DEFAULT_MATERIALS, [placeholderSet(), railSet()]))
    const trim = chunk.trim as MeshBuffers
    const pieces = polygons(trim)
    expect(pieces).toHaveLength(6)
    for (const { first } of pieces) {
      const [a, b, , d] = [0, 1, 2, 3].map((i) => corner(trim, first + i))
      const along = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
      const up = [d[0] - a[0], d[1] - a[1], d[2] - a[2]]
      // Square to the slope, a tile tall, and a third of the slope long.
      expect(along[0] * up[0] + along[1] * up[1] + along[2] * up[2]).toBeCloseTo(0, 6)
      expect(Math.hypot(...up)).toBeCloseTo(1, 6)
      expect(Math.hypot(...along)).toBeCloseTo(Math.SQRT2 / 3, 6)
    }
  })

  it('stands an upright rail in two columns a side, stepping down half a tile, with its body down to the ground', () => {
    const chunk = meshTerrainChunk(ground(loneRamp()), '0,0', createTerrainLook(upright(), [placeholderSet(), railSet()]))
    const trim = chunk.trim as MeshBuffers
    // A side: two columns of the top row, and under them the body, half a tile a piece: two under the first, which
    // stands a tile over the ground, and one under the second.
    expect(polygons(trim)).toHaveLength(2 * (2 + 2 + 1))
    // The top row's pieces are a tile tall; where they stand is the step. A side that runs the other way lists its corners the other way round.
    const tops = polygons(trim).filter(({ first }) => Math.abs(Math.abs(corner(trim, first + 3)[1] - corner(trim, first)[1]) - 1) < 1e-6)
    expect(tops.map(({ first }) => Math.min(corner(trim, first + 3)[1], corner(trim, first)[1])).sort()).toEqual([1.5, 1.5, 2, 2])
    // Every piece is upright: it has no extent across the side it stands on.
    for (const { first, last } of polygons(trim)) {
      const xs = Array.from({ length: last - first + 1 }, (_, i) => corner(trim, first + i)[0])
      expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0, 6)
    }
  })

  it('shows every piece of a rail exactly half a tile of texels, so a line drawn across two pieces keeps its thickness (found 2026-09-19)', () => {
    const look = createTerrainLook(upright(), [placeholderSet(), railSet()])
    const trim = meshTerrainChunk(ground(loneRamp()), '0,0', look).trim as MeshBuffers
    // The atlas is 64 tiles across: a tile is a sixty-fourth of it, and a piece half of that, but for a sliver at each edge.
    const half = 1 / 64 / 2
    for (const { first, last } of polygons(trim)) {
      const us = Array.from({ length: last - first + 1 }, (_, i) => trim.uvs[(first + i) * 2])
      const span = Math.max(...us) - Math.min(...us)
      expect(span).toBeLessThanOrEqual(half)
      expect(span).toBeGreaterThan(half * 0.93)
    }
  })

  it('caps a run at its head and foot only: the tile between two ramps of a run is the rail carrying on', () => {
    // A fresh map's ground is a tile up: two ramps in a row, from three tiles up down to it.
    const doc = createMap(8, 8)
    setHeight(doc, 3, 3, 6)
    setHeight(doc, 3, 4, 4)
    setRamp(doc, 3, 3, 1)
    setRamp(doc, 3, 4, 1)
    const look = createTerrainLook(DEFAULT_MATERIALS, [placeholderSet(), railSet()])
    const trim = meshTerrainChunk(ground(doc), '0,0', look).trim as MeshBuffers
    const tileOf = (l: string | null, r: string | null): number => (look.atlas.slotTile([null, null, l, r], 'ramp') as { tile: number }).tile
    const count = (tile: number): number => {
      const [u0, v0, u1, v1] = look.atlas.uv(tile, -1)
      return polygons(trim).filter(({ first }) => {
        const u = (trim.uvs[first * 2] + trim.uvs[(first + 2) * 2]) / 2
        const v = (trim.uvs[first * 2 + 1] + trim.uvs[(first + 2) * 2 + 1]) / 2
        return u > u0 && u < u1 && v > v0 && v < v1
      }).length
    }
    // Two sides: a start cap and an end cap each, and everything between from the tile with rail on both sides.
    expect(count(tileOf(null, RAIL as string))).toBe(2)
    expect(count(tileOf(RAIL as string, null))).toBe(2)
    expect(count(tileOf(RAIL as string, RAIL as string))).toBe(2 * 4)
  })

  it('runs an upright rail half a tile onto level ground at its head and foot when the material asks and the bends are drawn', () => {
    const doc = loneRamp()
    // Level ground at the height of its head, uphill of it; the ground at its foot is level already.
    setHeight(doc, 3, 2, 4)
    const pieces = (materials: typeof DEFAULT_MATERIALS, bends: boolean): number => polygons(meshTerrainChunk(ground(doc), '0,0', createTerrainLook(materials, [placeholderSet(), railSet(bends)])).trim as MeshBuffers).length
    const without = pieces(upright(), true)
    expect(pieces(upright(true), true)).toBe(without + 4)
    // Not without the bends drawn, and never for a sloped rail.
    expect(pieces(upright(true), false)).toBe(without)
    expect(pieces(DEFAULT_MATERIALS.map((m) => (m.id === 0 ? { ...m, landings: true } : m)), true)).toBe(6)
  })

  it("draws the triangle under the slope from the ramp's side art, mirrored for a slope that falls the other way, and from wall art without it", () => {
    // Side art for a slope that falls toward the side's end only: red. The placeholder's wall art is green.
    const side = stampTemplate(createTerrainSet('sides.png', TILE, 16, 8), 0, 0, null, tagOf(0, 'side', 'ramp', 'e'))
    const look = createTerrainLook(DEFAULT_MATERIALS, [placeholderSet(), { set: side, image: solid(16 * TILE, 8 * TILE, [200, 0, 0, 255]) }])
    const chunk = meshTerrainChunk(ground(loneRamp()), '0,0', look)
    const reds = (dir: number): number => bandTexels(chunk, look, 3, 3, dir, 2).filter((rgba) => rgba[0] === 200).length
    // The ramp descends south: its east side falls toward its end and its west side toward its start.
    expect(reds(0)).toBeGreaterThan(0)
    expect(reds(2)).toBeGreaterThan(0)
    // Its foot is no slope, and a level cell's wall is no ramp's side.
    const plain = mesh(loneRamp(), '0,0')
    expect(bandTexels(plain, createTerrainLook(DEFAULT_MATERIALS, [placeholderSet()]), 3, 3, 0, 2).every((rgba) => rgba[0] !== 200)).toBe(true)
  })
})

describe('a column read as spans: overhangs, gaps and blocks that float (2026-09-21)', () => {
  /** Every triangle of cell (x, y): its surface kind, side, level, the height of its centroid and which way it faces up or down. */
  function faces(chunk: TerrainChunkMesh, x: number, y: number): Array<{ kind: number; dir: number; level: number; height: number; ny: number }> {
    const { solid } = chunk
    const out = []
    for (let t = 0; t < solid.triangleCount; t++) {
      const address = readAddress(solid.faceAddr, t, 'ground')
      if (address.x !== x || address.y !== y) continue
      const vertices = [0, 1, 2].map((k) => solid.indices[t * 3 + k])
      out.push({ kind: address.kind, dir: address.dir, level: address.level, height: vertices.reduce((sum, v) => sum + solid.positions[v * 3 + 1] / 3, 0), ny: solid.normals[vertices[0] * 3 + 1] })
    }
    return out
  }
  const levels = (list: ReturnType<typeof faces>, kind: number, dir?: number): number[] => [...new Set(list.filter((f) => f.kind === kind && (dir === undefined || f.dir === dir)).map((f) => f.level))].sort((a, b) => a - b)
  /** Take one voxel out, and bring the paint in line with the faces that show now. */
  function carve(doc: MapDoc, x: number, z: number, y: number): void {
    const g = ground(doc)
    g.voxels.shape[voxelIndex(g, x, z, y)] = AIR
    settleFaces(g, 0)
  }

  it('draws a gap in a column as a lower top, an underside, and walls only where there are voxels', () => {
    const doc = createMap(8, 8)
    setHeight(doc, 4, 4, 6)
    carve(doc, 4, 4, 1)
    const chunk = mesh(doc, '0,0')
    const cell = faces(chunk, 4, 4)
    // Two tops: the voxel left on the ground, level with the ground round it, and the block over the gap.
    expect(levels(cell, SURFACE_TOP)).toEqual([0, 4])
    expect(cell.filter((f) => f.kind === SURFACE_TOP).every((f) => f.ny > 0.99)).toBe(true)
    expect([...new Set(cell.filter((f) => f.kind === SURFACE_TOP).map((f) => f.height))].sort()).toEqual([1, 3])
    // One underside, the floating block's, two tiles up and facing down.
    const under = cell.filter((f) => f.kind === SURFACE_UNDER)
    expect(under).toHaveLength(8)
    expect(under.every((f) => f.level === 4 && f.height === 2 && f.ny < -0.99)).toBe(true)
    // Walls round the floating block only: nothing is drawn across the gap.
    for (let dir = 0; dir < 4; dir++) expect(levels(cell, SURFACE_CLIFF, dir)).toEqual([4, 5])
    expect(chunk.missing).toEqual([])
  })

  it('walls a neighbour only where the column beside it has air: across the gap, not above or below it', () => {
    const doc = createMap(8, 8)
    setHeight(doc, 4, 4, 6)
    setHeight(doc, 5, 4, 6)
    carve(doc, 4, 4, 1)
    const chunk = mesh(doc, '0,0')
    // Side 2 of (5, 4) faces west, into (4, 4): it shows through the gap, and the other sides stand their whole height.
    expect(levels(faces(chunk, 5, 4), SURFACE_CLIFF, 2)).toEqual([2, 3])
    expect(levels(faces(chunk, 5, 4), SURFACE_CLIFF, 0)).toEqual([2, 3, 4, 5])
    // And the carved column's own east side has nothing to show: the neighbour covers both its spans.
    expect(levels(faces(chunk, 4, 4), SURFACE_CLIFF, 0)).toEqual([])
  })

  it('draws the floor under a block that floats, and the walls of the hole it floats over', () => {
    const doc = createMap(8, 8)
    setHeight(doc, 4, 4, 6)
    carve(doc, 4, 4, 1)
    carve(doc, 4, 4, 0)
    const chunk = mesh(doc, '0,0')
    const cell = faces(chunk, 4, 4)
    // The bedrock floor is a top at layer -1.
    expect(levels(cell, SURFACE_TOP)).toEqual([-2, 4])
    expect(levels(cell, SURFACE_UNDER)).toEqual([4])
    // The ground beside it stands a voxel over the floor, and walls the hole.
    expect(levels(faces(chunk, 5, 4), SURFACE_CLIFF, 2)).toEqual([0, 1])
    expect(chunk.missing).toEqual([])
  })

  it('keeps a ledge over a ramp apart from the ramp: the slope is a top of its own under it', () => {
    const doc = createMap(8, 8)
    setHeight(doc, 4, 4, 4)
    setRamp(doc, 4, 4, 0)
    const g = ground(doc)
    // A block two layers over the ramp, with a layer of air between.
    g.voxels.shape[voxelIndex(g, 4, 4, 3)] = SHAPE_BLOCK
    settleFaces(g, 0)
    const cell = faces(mesh(doc, '0,0'), 4, 4)
    expect(levels(cell, SURFACE_TOP)).toEqual([2, 6])
    expect(levels(cell, SURFACE_UNDER)).toEqual([6])
    // The ramp's top still slopes.
    expect(cell.filter((f) => f.kind === SURFACE_TOP && f.level === 2).every((f) => f.ny < 0.99 && f.ny > 0)).toBe(true)
  })
})
