import { describe, expect, it } from 'vitest'

import { createMap, type MapDoc } from './document'
import { FACE_TOP, edgeKey, faceKey } from './paint'
import { combineRegions, contractRegion, describeRegion, elementAt, elementsUnder, matchRegion, pairRegion, expandRegion, invertRegion, pruneRegion, regionOf, voxelKey, widerMatch } from './region'
import type { VoxelStructure } from './structure'
import { SURFACE_CLIFF, SURFACE_TOP, type SurfaceAddress } from './surface'
import { fillColumn, rampShape } from './voxels'

/** A fresh map's ground is one tile up (layer 0); a 2 × 2 plateau stands two tiles over it at (3..4, 3..4), its top voxel on layer 2. */
function plateau(): { doc: MapDoc; voxel: VoxelStructure } {
  const doc = createMap(8, 8)
  const voxel = doc.structures.ground as VoxelStructure
  for (const [x, z] of [[3, 3], [4, 3], [3, 4], [4, 4]]) fillColumn(voxel, x, z, 6)
  return { doc, voxel }
}
const top = (x: number, y: number): SurfaceAddress => ({ structure: 'ground', kind: SURFACE_TOP, x, y, dir: 0, level: 0 })
const cliff = (x: number, y: number, dir: number, level: number): SurfaceAddress => ({ structure: 'ground', kind: SURFACE_CLIFF, x, y, dir, level })

describe('what a press selects', () => {
  it('takes the top of each cell of the footprint: its top face, its top voxel, or the edges round it', () => {
    const { voxel } = plateau()
    const cells = [[3, 3], [4, 3]] as const
    expect(elementsUnder(voxel, top(3, 3), cells, 'face', 'surface').sort()).toEqual([faceKey(3, 3, 2, FACE_TOP), faceKey(4, 3, 2, FACE_TOP)])
    expect(elementsUnder(voxel, top(3, 3), cells, 'voxel', 'surface').sort()).toEqual([voxelKey(3, 3, 2), voxelKey(4, 3, 2)])
    // Two cells on the plateau's north side: the wall each stands to the north, and one at each end of the pair.
    expect(elementsUnder(voxel, top(3, 3), cells, 'edge', 'surface').sort()).toEqual([edgeKey(3, 3, 2, 'top'), edgeKey(3, 3, 3, 'top'), edgeKey(4, 3, 0, 'top'), edgeKey(4, 3, 3, 'top')].sort())
  })

  it('takes the feet of the walls that stand on a cell of the ground', () => {
    const { voxel } = plateau()
    // (2, 3) is ground, west of the plateau: the plateau's west wall at (3, 3) has its foot here.
    expect(elementsUnder(voxel, top(2, 3), [[2, 3]], 'edge', 'surface')).toEqual([edgeKey(3, 3, 2, 'foot')])
  })

  it('takes one side of each cell at the pressed layer on a cliff, and the voxel behind it', () => {
    const { voxel } = plateau()
    // The plateau's east side at (4, 3), band 3, which is layer 1.
    expect(elementsUnder(voxel, cliff(4, 3, 0, 3), [[4, 3], [4, 4]], 'face', 'surface').sort()).toEqual([faceKey(4, 3, 1, 0), faceKey(4, 4, 1, 0)])
    expect(elementsUnder(voxel, cliff(4, 3, 0, 3), [[4, 3]], 'voxel', 'surface')).toEqual([voxelKey(4, 3, 1)])
    expect(elementsUnder(voxel, cliff(4, 3, 0, 3), [[4, 3]], 'edge', 'surface').sort()).toEqual([edgeKey(4, 3, 0, 'foot'), edgeKey(4, 3, 0, 'top')])
    // A cell of the footprint with no such side gives nothing.
    expect(elementsUnder(voxel, cliff(4, 3, 0, 3), [[3, 3]], 'face', 'surface')).toEqual([])
  })

  it('carries on through the volume, within the layers the layer view leaves drawn', () => {
    const { voxel } = plateau()
    expect(elementsUnder(voxel, top(3, 3), [[3, 3]], 'voxel', 'through').sort()).toEqual([voxelKey(3, 3, 0), voxelKey(3, 3, 1), voxelKey(3, 3, 2)])
    expect(elementsUnder(voxel, top(3, 3), [[3, 3]], 'voxel', 'through', { lo: 1, hi: 2 })).toEqual([voxelKey(3, 3, 1)])
    // Every layer of the pressed side; layer 0 of it is against the ground, which is a full block, so it is no face.
    expect(elementsUnder(voxel, cliff(4, 3, 0, 3), [[4, 3]], 'face', 'through').sort()).toEqual([faceKey(4, 3, 1, 0), faceKey(4, 3, 2, 0)])
  })
})

describe('regions', () => {
  const a = regionOf('ground', 'voxel', [voxelKey(1, 1, 0), voxelKey(2, 1, 0)])
  const b = regionOf('ground', 'voxel', [voxelKey(2, 1, 0), voxelKey(3, 1, 0)])

  it('combine as sets, and are nothing when nothing is left', () => {
    expect(combineRegions(a, b, 'add')?.keys).toEqual([voxelKey(1, 1, 0), voxelKey(2, 1, 0), voxelKey(3, 1, 0)])
    expect(combineRegions(a, b, 'subtract')?.keys).toEqual([voxelKey(1, 1, 0)])
    expect(combineRegions(a, b, 'intersect')?.keys).toEqual([voxelKey(2, 1, 0)])
    expect(combineRegions(a, b, 'replace')).toEqual(b)
    expect(combineRegions(a, a, 'subtract')).toBeNull()
  })

  it('of another element replace on add, and leave nothing otherwise', () => {
    const faces = regionOf('ground', 'face', [faceKey(1, 1, 0, FACE_TOP)])
    expect(combineRegions(a, faces, 'add')).toEqual(faces)
    expect(combineRegions(a, faces, 'subtract')).toBeNull()
    expect(combineRegions(null, faces, 'add')).toEqual(faces)
  })

  it('grow to what is beside them and shrink by their rim', () => {
    const { voxel } = plateau()
    const one = regionOf('ground', 'face', [faceKey(3, 3, 2, FACE_TOP)])
    const grown = expandRegion(voxel, one)
    // On the plateau's top, in its own plane: the two cells beside it. The ground's tops are another layer.
    expect(grown.keys).toEqual([faceKey(3, 3, 2, FACE_TOP), faceKey(3, 4, 2, FACE_TOP), faceKey(4, 3, 2, FACE_TOP)].sort())
    const whole = expandRegion(voxel, grown)
    expect(whole.keys).toHaveLength(4)
    // The whole top has no neighbour outside it, so it has no rim to lose.
    expect(contractRegion(voxel, whole)?.keys).toHaveLength(4)
    expect(contractRegion(voxel, grown)?.keys).toEqual([faceKey(3, 3, 2, FACE_TOP)])
  })

  it('invert within their own kind, and say what they are', () => {
    const { voxel } = plateau()
    const topVoxels = regionOf('ground', 'voxel', [[3, 3], [4, 3], [3, 4], [4, 4]].map(([x, z]) => voxelKey(x, z, 2)))
    const rest = invertRegion(voxel, topVoxels)
    // 64 ground voxels, and the plateau's four on layer 1.
    expect(rest?.keys).toHaveLength(68)
    expect(invertRegion(voxel, topVoxels, { lo: 2, hi: 3 })).toBeNull()
    expect(describeRegion(topVoxels)).toBe('4 voxels')
    expect(describeRegion(regionOf('ground', 'edge', [edgeKey(3, 3, 2, 'top')]))).toBe('1 edge')
  })

  it('lose what the terrain no longer has', () => {
    const { voxel } = plateau()
    const region = regionOf('ground', 'voxel', [voxelKey(3, 3, 2), voxelKey(4, 3, 2)])
    fillColumn(voxel, 3, 3, 2)
    expect(pruneRegion(voxel, region)?.keys).toEqual([voxelKey(4, 3, 2)])
    fillColumn(voxel, 4, 3, 2)
    expect(pruneRegion(voxel, region)).toBeNull()
  })
})

describe('the whole an element belongs to (design pass of 2026-09-20)', () => {
  it("is an edge's run: the straight line of its kind at its height, stopping where it turns", () => {
    const { voxel } = plateau()
    // The plateau's north side is two cells long; its east side is another run, and the foot below is its own.
    expect(matchRegion(voxel, 'edge', edgeKey(3, 3, 3, 'top')).sort()).toEqual([edgeKey(3, 3, 3, 'top'), edgeKey(4, 3, 3, 'top')])
    expect(matchRegion(voxel, 'edge', edgeKey(4, 3, 3, 'foot')).sort()).toEqual([edgeKey(3, 3, 3, 'foot'), edgeKey(4, 3, 3, 'foot')])
    // A taller cell in the line ends the run: its lip is at another height.
    fillColumn(voxel, 4, 3, 8)
    expect(matchRegion(voxel, 'edge', edgeKey(3, 3, 3, 'top'))).toEqual([edgeKey(3, 3, 3, 'top')])
    expect(matchRegion(voxel, 'edge', edgeKey(0, 0, 0, 'top'))).toEqual([])
  })

  it("is a face's flat: the connected faces in its plane, whatever they are painted with", () => {
    const { voxel } = plateau()
    expect(matchRegion(voxel, 'face', faceKey(3, 3, 2, FACE_TOP))).toHaveLength(4)
    // The ground's top is another flat: every cell of it but the four the plateau stands on.
    expect(matchRegion(voxel, 'face', faceKey(0, 0, 0, FACE_TOP))).toHaveLength(60)
    // A wall in its own plane, every layer of it: two cells wide, two layers clear of the ground.
    expect(matchRegion(voxel, 'face', faceKey(4, 3, 1, 0)).sort()).toEqual([faceKey(4, 3, 1, 0), faceKey(4, 3, 2, 0), faceKey(4, 4, 1, 0), faceKey(4, 4, 2, 0)])
    // A slab's top is not a cube's, though both are tops of the same layer.
    fillColumn(voxel, 3, 3, 5)
    expect(matchRegion(voxel, 'face', faceKey(4, 3, 2, FACE_TOP))).toHaveLength(3)
  })

  it("is a voxel's layer by default, which can never take more than one storey; its island is the next whole out", () => {
    const { voxel } = plateau()
    expect(matchRegion(voxel, 'voxel', voxelKey(3, 3, 2))).toHaveLength(4)
    expect(matchRegion(voxel, 'voxel', voxelKey(3, 3, 1))).toHaveLength(4)
    expect(widerMatch('voxel', voxelKey(3, 3, 1))).toBe('island')
    // An island is what is connected without going below its layer, so a hill leaves its ground behind.
    expect(matchRegion(voxel, 'voxel', voxelKey(3, 3, 1), 'island')).toHaveLength(8)
    expect(matchRegion(voxel, 'voxel', voxelKey(0, 0, 0), 'island')).toHaveLength(64 + 8)
    expect(matchRegion(voxel, 'voxel', voxelKey(0, 0, 0))).toHaveLength(64)
    expect(matchRegion(voxel, 'voxel', voxelKey(3, 3, 1), 'island', { span: { lo: 0, hi: 2 } })).toHaveLength(4)
  })

  it("is an edge's loop on a triple-click: the run, round the corners, until it comes back", () => {
    const { voxel } = plateau()
    expect(widerMatch('edge', edgeKey(3, 3, 3, 'top'))).toBe('loop')
    // A 2 x 2 plateau's rim: two edges a side. Its foot is another loop of eight.
    expect(matchRegion(voxel, 'edge', edgeKey(3, 3, 3, 'top'), 'loop')).toHaveLength(8)
    const foot = matchRegion(voxel, 'edge', edgeKey(3, 3, 3, 'foot'), 'loop')
    expect(foot).toHaveLength(8)
    expect(foot.every((key) => key.endsWith('foot'))).toBe(true)
    // A notch is followed inside as well as out: an L of three cells has a rim of eight.
    fillColumn(voxel, 4, 4, 2)
    expect(matchRegion(voxel, 'edge', edgeKey(3, 3, 3, 'top'), 'loop')).toHaveLength(8)
    // A taller cell is another rim at another height, and the loop goes round it rather than over it.
    fillColumn(voxel, 4, 4, 8)
    const lower = matchRegion(voxel, 'edge', edgeKey(3, 3, 3, 'top'), 'loop')
    expect(lower).toContain(edgeKey(3, 3, 2, 'top'))
    expect(lower).not.toContain(edgeKey(4, 4, 0, 'top'))
  })

  it('follows a slope when asked: down a ramp\'s side and onto the rim below, and stops at the ramp when not', () => {
    const { voxel } = plateau()
    // A ramp off the plateau's east side, descending east from its height to a tile lower, then a lower plateau beyond it.
    fillColumn(voxel, 5, 3, 6, { material: 0, shape: rampShape(0) })
    fillColumn(voxel, 6, 3, 4)
    const following = matchRegion(voxel, 'edge', edgeKey(4, 3, 3, 'top'), 'run', { followSlopes: true })
    expect(following).toEqual(expect.arrayContaining([edgeKey(3, 3, 3, 'top'), edgeKey(4, 3, 3, 'top'), edgeKey(5, 3, 3, 'top'), edgeKey(6, 3, 3, 'top')]))
    const level = matchRegion(voxel, 'edge', edgeKey(4, 3, 3, 'top'), 'run', { followSlopes: false })
    expect(level.sort()).toEqual([edgeKey(3, 3, 3, 'top'), edgeKey(4, 3, 3, 'top')])
  })

  it("is a top's surface and a side's wall on a triple-click", () => {
    const { voxel } = plateau()
    expect(widerMatch('face', faceKey(3, 3, 2, FACE_TOP))).toBe('surface')
    expect(widerMatch('face', faceKey(4, 3, 1, 0))).toBe('wall')
    // The plateau stands two tiles over the ground: a cliff, so its surface is its own four tops.
    expect(matchRegion(voxel, 'face', faceKey(3, 3, 2, FACE_TOP), 'surface')).toHaveLength(4)
    // A slab beside it, half a tile down, is the same ground; so is the next, another half down.
    fillColumn(voxel, 5, 3, 5)
    fillColumn(voxel, 6, 3, 4)
    expect(matchRegion(voxel, 'face', faceKey(3, 3, 2, FACE_TOP), 'surface')).toHaveLength(6)
    // The wall goes round the plateau's corners: a lone 2 x 2 plateau has eight side faces a layer, two layers clear of the ground.
    const lone = plateau().voxel
    expect(matchRegion(lone, 'face', faceKey(4, 3, 1, 0), 'wall')).toHaveLength(16)
    expect(matchRegion(lone, 'face', faceKey(4, 3, 1, 0), 'surface')).toEqual([])
  })

  it('pairs every edge with its other end', () => {
    const rim = regionOf('ground', 'edge', [edgeKey(3, 3, 3, 'top'), edgeKey(4, 3, 3, 'foot')])
    expect(pairRegion(rim).keys).toEqual([edgeKey(3, 3, 3, 'foot'), edgeKey(3, 3, 3, 'top'), edgeKey(4, 3, 3, 'foot'), edgeKey(4, 3, 3, 'top')].sort())
    const faces = regionOf('ground', 'face', [faceKey(1, 1, 0, FACE_TOP)])
    expect(pairRegion(faces)).toBe(faces)
  })

  it('takes one edge for a press, the nearest of those round the cell, and the nearer end of a wall', () => {
    const { voxel } = plateau()
    // (4, 3) is the plateau's north-east corner: a wall to the east and one to the north.
    expect(elementAt(voxel, top(4, 3), 'edge', { fx: 0.9, fz: 0.5, upper: true })).toBe(edgeKey(4, 3, 0, 'top'))
    expect(elementAt(voxel, top(4, 3), 'edge', { fx: 0.5, fz: 0.1, upper: true })).toBe(edgeKey(4, 3, 3, 'top'))
    expect(elementAt(voxel, cliff(4, 3, 0, 3), 'edge', { fx: 0, fz: 0, upper: false })).toBe(edgeKey(4, 3, 0, 'foot'))
    expect(elementAt(voxel, top(3, 3), 'voxel', { fx: 0.5, fz: 0.5, upper: true })).toBe(voxelKey(3, 3, 2))
    // Level ground away from the map's rim stands no wall, so it has no edge to take.
    expect(elementAt(voxel, top(1, 1), 'edge', { fx: 0.5, fz: 0.5, upper: true })).toBeNull()
  })
})
