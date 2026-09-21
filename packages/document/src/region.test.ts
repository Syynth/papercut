import { describe, expect, it } from 'vitest'

import { setMaterial } from './ops'
import { AIR, createMap, slotOf, tileSlot, type MapDoc } from './document'
import { FACE_BOTTOM, FACE_TOP, edgeKey, faceKey } from './paint'
import { combineRegions, contractRegion, describeRegion, elementAt, elementsUnder, matchApplies, matchRegion, pairRegion, expandRegion, invertRegion, pruneRegion, regionOf, voxelKey, widerMatch } from './region'
import type { VoxelStructure } from './structure'
import { SURFACE_CLIFF, SURFACE_TOP, SURFACE_UNDER, decodeExtra, type SurfaceAddress } from './surface'
import { exposedFacesOf, faceNear, fillColumn, rampShape, settleFaces, voxelIndex } from './voxels'

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

describe('the rest of the Match rules (design pass of 2026-09-20)', () => {
  it('takes faces showing the same material, across heights but staying on the kind of face clicked; and anywhere with Everywhere', () => {
    const { voxel } = plateau()
    // A path of material 4 across the ground, up onto the plateau and down the other side: five tops in a line.
    for (const [x, y] of [[1, 3, 0], [2, 3, 0], [3, 3, 2], [4, 3, 2], [5, 3, 0]].map(([x, , y]) => [x, y])) voxel.paint.faces[faceKey(x, 3, y, FACE_TOP)] = [slotOf(4), null, null, null]
    // And one more, apart from the rest.
    voxel.paint.faces[faceKey(7, 7, 0, FACE_TOP)] = [slotOf(4), null, null, null]
    expect(matchRegion(voxel, 'face', faceKey(1, 3, 0, FACE_TOP), 'material')).toHaveLength(5)
    expect(matchRegion(voxel, 'face', faceKey(1, 3, 0, FACE_TOP), 'material', { everywhere: true })).toHaveLength(6)
    // What shows is the top of the stack: grass over the path hides it, unless every layer is looked at.
    voxel.paint.faces[faceKey(2, 3, 0, FACE_TOP)] = [slotOf(4), slotOf(0), null, null]
    expect(matchRegion(voxel, 'face', faceKey(1, 3, 0, FACE_TOP), 'material')).toEqual([faceKey(1, 3, 0, FACE_TOP)])
    expect(matchRegion(voxel, 'face', faceKey(1, 3, 0, FACE_TOP), 'material', { anyLayer: true })).toHaveLength(5)
    // A wall painted the same is another kind of face, and stays out of it.
    voxel.paint.faces[faceKey(3, 3, 2, 3)] = [slotOf(4), null, null, null]
    expect(matchRegion(voxel, 'face', faceKey(3, 3, 2, FACE_TOP), 'material', { everywhere: true }).every((key) => key.endsWith(`,${FACE_TOP}`))).toBe(true)
  })

  it('takes faces holding the same pasted tile, and only itself when the face holds none', () => {
    const { voxel } = plateau()
    for (const x of [1, 2]) voxel.paint.faces[faceKey(x, 1, 0, FACE_TOP)] = [slotOf(0), tileSlot(1, 7), null, null]
    voxel.paint.faces[faceKey(3, 1, 0, FACE_TOP)] = [slotOf(0), tileSlot(1, 8), null, null]
    expect(matchRegion(voxel, 'face', faceKey(1, 1, 0, FACE_TOP), 'tile').sort()).toEqual([faceKey(1, 1, 0, FACE_TOP), faceKey(2, 1, 0, FACE_TOP)])
    expect(matchRegion(voxel, 'face', faceKey(6, 6, 0, FACE_TOP), 'tile')).toEqual([faceKey(6, 6, 0, FACE_TOP)])
  })

  it("sets how big a step is still the same surface, and keeps a wall to one course with Band", () => {
    const { voxel } = plateau()
    // The plateau stands four half-tiles over the ground: a step of four joins them, and then the surface is every top.
    expect(matchRegion(voxel, 'face', faceKey(3, 3, 2, FACE_TOP), 'surface', { step: 3 })).toHaveLength(4)
    expect(matchRegion(voxel, 'face', faceKey(3, 3, 2, FACE_TOP), 'surface', { step: 4 })).toHaveLength(64)
    expect(matchRegion(voxel, 'face', faceKey(3, 3, 2, FACE_TOP), 'surface', { step: 0 })).toHaveLength(4)
    expect(matchRegion(voxel, 'face', faceKey(4, 3, 1, 0), 'wall', { band: true })).toHaveLength(8)
    expect(matchRegion(voxel, 'face', faceKey(4, 3, 1, 0), 'flat', { band: true }).sort()).toEqual([faceKey(4, 3, 1, 0), faceKey(4, 4, 1, 0)])
  })

  it('takes a column down to the floor or the first gap, and connected voxels of the same piece', () => {
    const { voxel } = plateau()
    expect(matchRegion(voxel, 'voxel', voxelKey(3, 3, 2), 'column').sort()).toEqual([voxelKey(3, 3, 0), voxelKey(3, 3, 1), voxelKey(3, 3, 2)])
    voxel.voxels.shape[voxelIndex(voxel, 3, 3, 1)] = AIR
    expect(matchRegion(voxel, 'voxel', voxelKey(3, 3, 2), 'column')).toEqual([voxelKey(3, 3, 2)])
    // Two ramps in a run, whatever way each faces, are the same piece; the cubes beside them are not.
    const fresh = plateau().voxel
    fillColumn(fresh, 5, 3, 6, { material: 0, shape: rampShape(0) })
    fillColumn(fresh, 6, 3, 4, { material: 0, shape: rampShape(0) })
    expect(matchRegion(fresh, 'voxel', voxelKey(5, 3, 2), 'samePiece').sort()).toEqual([voxelKey(5, 3, 2), voxelKey(6, 3, 1)])
    // Everywhere, a layer is every voxel on it, connected or not: the plateau's four and the ramp against it, and a pillar apart.
    fillColumn(fresh, 0, 0, 6)
    expect(matchRegion(fresh, 'voxel', voxelKey(3, 3, 2), 'layer')).toHaveLength(5)
    expect(matchRegion(fresh, 'voxel', voxelKey(3, 3, 2), 'layer', { everywhere: true })).toHaveLength(6)
  })

  it('takes connected edges of the same kind whatever their height, and those in the same trim state', () => {
    const { voxel } = plateau()
    // A taller cell on the plateau's corner: its rim is at another height, which stops a loop and not Same kind.
    fillColumn(voxel, 4, 4, 8)
    const loop = matchRegion(voxel, 'edge', edgeKey(3, 3, 3, 'top'), 'loop', { followSlopes: false })
    const kind = matchRegion(voxel, 'edge', edgeKey(3, 3, 3, 'top'), 'sameKind')
    expect(kind.length).toBeGreaterThan(loop.length)
    expect(kind).toContain(edgeKey(4, 4, 0, 'top'))
    expect(kind.every((key) => key.endsWith('top'))).toBe(true)
    // Two edges switched off: connected, the same trim is the two of them; everywhere, every top that is off.
    voxel.paint.edges[edgeKey(3, 3, 3, 'top')] = 'off'
    voxel.paint.edges[edgeKey(4, 3, 3, 'top')] = 'off'
    voxel.paint.edges[edgeKey(0, 0, 3, 'top')] = 'off'
    expect(matchRegion(voxel, 'edge', edgeKey(3, 3, 3, 'top'), 'sameTrim').sort()).toEqual([edgeKey(3, 3, 3, 'top'), edgeKey(4, 3, 3, 'top')])
    expect(matchRegion(voxel, 'edge', edgeKey(3, 3, 3, 'top'), 'sameTrim', { everywhere: true })).toHaveLength(3)
  })

  it('says which rules mean anything for what was clicked', () => {
    expect(matchApplies('face', faceKey(1, 1, 0, FACE_TOP), 'surface')).toBe(true)
    expect(matchApplies('face', faceKey(1, 1, 0, 2), 'surface')).toBe(false)
    expect(matchApplies('face', faceKey(1, 1, 0, 2), 'wall')).toBe(true)
    expect(matchApplies('face', faceKey(1, 1, 0, FACE_TOP), 'wall')).toBe(false)
    expect(matchApplies('voxel', voxelKey(1, 1, 0), 'run')).toBe(false)
    expect(matchRegion(plateau().voxel, 'voxel', voxelKey(3, 3, 2), 'run')).toEqual([])
  })
})

describe('a press in a column with air in it (2026-09-21)', () => {
  /** The plateau with the middle layer of (3, 3) taken out: ground at layer 0, a gap, a block floating at layer 2. */
  function carved(): VoxelStructure {
    const { voxel } = plateau()
    voxel.voxels.shape[voxelIndex(voxel, 3, 3, 1)] = AIR
    settleFaces(voxel, 0)
    return voxel
  }
  const at = (kind: SurfaceAddress['kind'], layer: number): SurfaceAddress => ({ structure: 'ground', kind, x: 3, y: 3, dir: 0, level: layer * 2 })

  it('finds the top or the underside nearest a layer, and the highest for an address that names none', () => {
    const voxel = carved()
    expect(faceNear(voxel, 3, 3, 0, FACE_TOP)).toBe(0)
    expect(faceNear(voxel, 3, 3, 2, FACE_TOP)).toBe(2)
    expect(faceNear(voxel, 3, 3, 2, FACE_BOTTOM)).toBe(2)
    expect(faceNear(voxel, 4, 4, 0, FACE_BOTTOM)).toBeNull()
    expect(faceNear(voxel, 3, 3, Math.floor(decodeExtra(0).level / 2), FACE_TOP)).toBe(2)
  })

  it('selects the ground under the ledge, the ledge, or its ceiling, by what was pressed', () => {
    const voxel = carved()
    expect(elementsUnder(voxel, at(SURFACE_TOP, 0), [[3, 3]], 'face', 'surface')).toEqual([faceKey(3, 3, 0, FACE_TOP)])
    expect(elementsUnder(voxel, at(SURFACE_TOP, 2), [[3, 3]], 'voxel', 'surface')).toEqual([voxelKey(3, 3, 2)])
    expect(elementsUnder(voxel, at(SURFACE_UNDER, 2), [[3, 3]], 'face', 'surface')).toEqual([faceKey(3, 3, 2, FACE_BOTTOM)])
    expect(elementsUnder(voxel, at(SURFACE_UNDER, 2), [[3, 3]], 'voxel', 'surface')).toEqual([voxelKey(3, 3, 2)])
  })

  it('paints the face pressed, and lists the floor under a column that floats', () => {
    const voxel = carved()
    const under = setMaterial(voxel, [[3, 3]], 2, 0, { y: 2, dir: FACE_BOTTOM })
    expect(under.map((p) => (p.t === 'voxelPaint' ? p.key : null))).toEqual([faceKey(3, 3, 2, FACE_BOTTOM)])
    const low = setMaterial(voxel, [[3, 3]], 2, 0, { y: 0, dir: FACE_TOP })
    expect(low.map((p) => (p.t === 'voxelPaint' ? p.key : null))).toEqual([faceKey(3, 3, 0, FACE_TOP)])
    voxel.voxels.shape[voxelIndex(voxel, 3, 3, 0)] = AIR
    expect(exposedFacesOf(voxel, 3, 3)).toContain(faceKey(3, 3, -1, FACE_TOP))
  })
})
