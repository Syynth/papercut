import { describe, expect, it } from 'vitest'

import { createMap, type MapDoc } from './document'
import { FACE_TOP, edgeKey, faceKey } from './paint'
import { combineRegions, contractRegion, describeRegion, elementsUnder, expandRegion, invertRegion, pruneRegion, regionOf, voxelKey } from './region'
import type { VoxelStructure } from './structure'
import { SURFACE_CLIFF, SURFACE_TOP, type SurfaceAddress } from './surface'
import { fillColumn } from './voxels'

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
