import {
  FACE_TOP,
  NO_RAMP,
  SHAPE_BLOCK,
  SURFACE_CLIFF,
  SURFACE_TOP,
  createMap,
  faceKey,
  fillColumn,
  layersOf,
  rampDirAt,
  rampShape,
  topHeight,
  voxelIndex,
  type Patch,
  type ReadonlyMapDoc,
  type SurfaceAddress,
  type MapDoc,
  type VoxelStructure,
} from '@papercut/document'
import { describe, expect, it } from 'vitest'

import { terrainContract } from './stroke'
import type { FeatureDeps } from './deps'
import type { TerrainParams } from './verbs'

/** The root voxel volume a fresh level has, mutable for setup: `createMap` names it `ground`. */
const ground = (doc: ReadonlyMapDoc | MapDoc): VoxelStructure => doc.structures.ground as VoxelStructure

/** Every map in this file is 8 by 8. */
const SIZE = 8

/**
 * How many columns a tick edited. A sculpt patch addresses one voxel's
 * field, and a half-tile up from a whole cube is two of them (the new top
 * voxel's material and its shape) while the next half-tile is one (that
 * voxel's shape), so what a tick is asked about is the cells it touched.
 */
const cellsTouched = (patches: readonly Patch[] | undefined): number =>
  new Set((patches ?? []).flatMap((patch) => (patch.t === 'voxel' && patch.field !== 'water' ? [patch.index % (SIZE * SIZE)] : []))).size


/**
 * The contract on its own, with a stub for the deps the host supplies. That
 * this file needs no host, no actor and no React is the extraction's point:
 * #35 puts a feature beside the host rather than under it, so the behavior a
 * terrain stroke has must be testable from the feature alone.
 */
const defaults: TerrainParams = {
  terrainMode: 'sculpt',
  sculptVerb: 'raise',
  paintVerb: 'material',
  strokeShape: 'brush',
  brush: { size: 1, shape: 'square' },
  material: 0,
  materialLayer: 0,
  tint: 0xffffff,
  // One half-tile per pass here, so a raise reads as +1 throughout the file; the tool's default is a whole cube.
  strength: 1,
  height: 2,
  heightPinned: false,
  rampRun: null,
  sculptDeadZone: 0.2,
}

function stub(doc: ReadonlyMapDoc, overrides: Partial<TerrainParams> = {}) {
  let params: TerrainParams = { ...defaults, ...overrides }
  const applied: Array<{ label: string; patches: readonly Patch[] }> = []
  const deps: FeatureDeps = {
    doc: () => doc,
    params: () => params,
    setParams: (changes) => void (params = { ...params, ...changes }),
    apply: (label, patches) => void applied.push({ label, patches }),
    select: () => undefined,
  }
  return { deps, applied, current: () => params }
}

const top = (x: number, y: number): SurfaceAddress => ({ structure: 'ground', x, y, kind: SURFACE_TOP, dir: 0, level: 0 })
const sample = (address: SurfaceAddress | null, modifiers: Partial<{ shift: boolean; alt: boolean; ctrl: boolean }> = {}) => ({
  pick: { surface: address },
  modifiers: { shift: false, alt: false, ctrl: false, ...modifiers },
})
/** A mid-stroke tick with the pointer at `(x, z)` on the press plane; the ray hits `address`, which a sculpt stroke must ignore. */
const planeSample = (x: number, z: number, address: SurfaceAddress | null = null) => ({
  pick: { surface: address, plane: { x, z } },
  modifiers: { shift: false, alt: false, ctrl: false },
})

describe('a sculpt stroke steers by the press plane, with a dead zone', () => {
  it("does not re-fire on the cell it just raised when the ray now hits that cell's new face", () => {
    const doc = createMap(8, 8)
    const { deps } = stub(doc)
    const handler = terrainContract(deps).stroke(sample(top(1, 1)))
    expect(cellsTouched(handler?.begin(sample(top(1, 1))))).toBe(1)
    // The pointer has barely moved; the pick now says "cliff face of (1,1)".
    const face: SurfaceAddress = { structure: 'ground', x: 1, y: 1, kind: SURFACE_CLIFF, dir: 2, level: 1 }
    expect(handler?.move(planeSample(1.5, 1.6, face))).toEqual([])
    expect(handler?.move(planeSample(1.9, 1.9, face))).toEqual([])
  })

  it('moves to the next cell only once the pointer is the dead zone past the boundary', () => {
    const doc = createMap(8, 8)
    const { deps } = stub(doc, { sculptDeadZone: 0.2 })
    const handler = terrainContract(deps).stroke(sample(top(1, 1)))
    handler?.begin(sample(top(1, 1)))
    expect(handler?.move(planeSample(2.1, 1.5))).toEqual([]) // over the line, inside the dead zone
    expect(cellsTouched(handler?.move(planeSample(2.25, 1.5)))).toBe(1) // past it
    // Back across the same line: the dead zone applies in both directions.
    expect(handler?.move(planeSample(1.9, 1.5))).toEqual([])
    expect(cellsTouched(handler?.move(planeSample(1.7, 1.5)))).toBe(1)
  })

  it('a dead zone of zero is the exact boundary, and a corner crossing must clear both edges', () => {
    const doc = createMap(8, 8)
    const { deps } = stub(doc, { sculptDeadZone: 0 })
    const handler = terrainContract(deps).stroke(sample(top(1, 1)))
    handler?.begin(sample(top(1, 1)))
    expect(cellsTouched(handler?.move(planeSample(2.0, 1.5)))).toBe(1)
    const { deps: deps2 } = stub(createMap(8, 8), { sculptDeadZone: 0.25 })
    const handler2 = terrainContract(deps2).stroke(sample(top(1, 1)))
    handler2?.begin(sample(top(1, 1)))
    expect(handler2?.move(planeSample(2.3, 2.1))).toEqual([]) // past x's zone, not z's
    expect(cellsTouched(handler2?.move(planeSample(2.3, 2.3)))).toBe(1)
  })

  it('ramp and paint keep steering by the pick, since they target faces', () => {
    const doc = createMap(8, 8)
    const { deps } = stub(doc, { terrainMode: 'paint', paintVerb: 'material', material: 1 })
    const handler = terrainContract(deps).stroke(sample(top(1, 1)))
    handler?.begin(sample(top(1, 1)))
    // The plane says (1,1) still; the pick says (3,3). Paint follows the pick.
    const patches = handler?.move(planeSample(1.5, 1.5, top(3, 3)))
    expect(patches).toHaveLength(1)
    // The top face of a one-cube column is on the first layer.
    expect(patches?.[0]).toMatchObject({ t: 'voxelPaint', id: 'ground', layer: 'faces', key: faceKey(3, 3, 0, FACE_TOP), value: layersOf(1) })
  })
})

describe('the terrain tool contract', () => {
  it('applies nothing itself: every phase answers with patches', () => {
    const doc = createMap(8, 8)
    const { deps, applied } = stub(doc)
    const handler = terrainContract(deps).stroke(sample(top(1, 1)))

    expect(cellsTouched(handler?.begin(sample(top(1, 1))))).toBe(1)
    expect(applied).toEqual([])
    expect(topHeight(ground(doc), 1, 1)).toBe(2)
  })

  it('skips a move that stays on the cell the last tick edited', () => {
    const { deps } = stub(createMap(8, 8))
    const handler = terrainContract(deps).stroke(sample(top(1, 1)))
    handler?.begin(sample(top(1, 1)))

    expect(handler?.move(sample(top(1, 1)))).toEqual([])
    expect(cellsTouched(handler?.move(sample(top(2, 1))))).toBe(1)
  })

  it('holds a rectangle open until release, and grows it from the press', () => {
    const { deps } = stub(createMap(8, 8), { strokeShape: 'rect' })
    const handler = terrainContract(deps).stroke(sample(top(1, 1)))

    expect(handler?.begin(sample(top(1, 1)))).toEqual([])
    expect(handler?.move(sample(top(3, 2)))).toEqual([])
    // 3x2 cells, anchored where the press landed — the anchor is the
    // handler's, which is what makes it die with the stroke.
    expect(cellsTouched(handler?.end(sample(top(3, 2))))).toBe(6)
  })

  it('reads the brush width per tick, so widening mid-drag takes effect', () => {
    const { deps } = stub(createMap(8, 8))
    const handler = terrainContract(deps).stroke(sample(top(1, 1)))
    expect(cellsTouched(handler?.begin(sample(top(1, 1))))).toBe(1)

    deps.setParams({ brush: { size: 3, shape: 'square' } })

    expect(cellsTouched(handler?.move(sample(top(4, 4))))).toBe(9)
  })

  it('alt under Sculpt picks a height up and pins it, for Flatten', () => {
    const doc = createMap(8, 8)
    fillColumn(ground(doc), 2, 2, 6)
    const { deps, current } = stub(doc, { sculptVerb: 'flatten' })
    const handler = terrainContract(deps).stroke(sample(top(2, 2), { alt: true }))
    expect(handler?.begin(sample(top(2, 2), { alt: true }))).toEqual([])
    expect(current().height).toBe(6)
    expect(current().heightPinned).toBe(true)
  })

  it('shows why a ramp cannot be cut, and cuts nothing on release', () => {
    const cliff: SurfaceAddress = { structure: 'ground', x: 2, y: 2, kind: SURFACE_CLIFF, dir: 3, level: 1 }
    const doc = createMap(8, 8)
    // (2,2) stands two cubes above (2,1): a run of two, but (2,3) behind the edge stays at one cube.
    fillColumn(ground(doc), 2, 2, 6)
    const { deps, current } = stub(doc, { sculptVerb: 'ramp' })
    const handler = terrainContract(deps).stroke(sample(cliff))
    expect(handler?.begin(sample(cliff))).toEqual([])
    expect(current().rampRun).toMatchObject({ needed: 2, blocked: 'the ground behind the edge is not level with it' })
    expect(handler?.end(sample(cliff))).toEqual([])
    expect(current().rampRun).toBeNull()
    expect(rampDirAt(ground(doc), 2, 2)).toBe(NO_RAMP)
  })

  it('switches a wall\u2019s fringe off from its upper half and its picket from its lower, and shift switches back on', () => {
    const doc = createMap(8, 8)
    // (2,2) stands three cubes over the one-cube ground: its east wall runs from level 2 to level 6.
    fillColumn(ground(doc), 2, 2, 6)
    const band = (level: number): SurfaceAddress => ({ structure: 'ground', x: 2, y: 2, kind: SURFACE_CLIFF, dir: 0, level })
    const { deps } = stub(doc, { terrainMode: 'paint', paintVerb: 'fringe' })
    const upper = terrainContract(deps).stroke(sample(band(5)))?.begin(sample(band(5)))
    expect(upper).toEqual([{ t: 'voxelPaint', id: 'ground', layer: 'edges', key: '2,2,0,top', value: 'off' }])
    const lower = terrainContract(deps).stroke(sample(band(2)))?.begin(sample(band(2)))
    expect(lower).toEqual([{ t: 'voxelPaint', id: 'ground', layer: 'edges', key: '2,2,0,foot', value: 'off' }])
    ground(doc).paint.edges['2,2,0,top'] = 'off'
    const back = terrainContract(deps).stroke(sample(band(5), { shift: true }))?.begin(sample(band(5), { shift: true }))
    expect(back).toEqual([{ t: 'voxelPaint', id: 'ground', layer: 'edges', key: '2,2,0,top', value: undefined }])
    // A top has no wall to switch.
    expect(terrainContract(deps).stroke(sample(top(4, 4)))?.begin(sample(top(4, 4)))).toEqual([])
  })

  it('paints, empties and picks up the active material layer, leaving the others', () => {
    const doc = createMap(8, 8)
    // (1,1)'s top holds grass on its first layer, from the new map, and path on its third.
    ground(doc).paint.faces[faceKey(1, 1, 0, FACE_TOP)] = ['m:0', null, 'm:4', null]
    const { deps, current } = stub(doc, { terrainMode: 'paint', paintVerb: 'material', material: 1, materialLayer: 1 })
    const paint = terrainContract(deps).stroke(sample(top(1, 1)))?.begin(sample(top(1, 1)))
    expect(paint).toEqual([{ t: 'voxelPaint', id: 'ground', layer: 'faces', key: faceKey(1, 1, 0, FACE_TOP), value: ['m:0', 'm:1', 'm:4', null] }])
    // Shift empties the active layer only.
    deps.setParams({ materialLayer: 2 })
    const erase = terrainContract(deps).stroke(sample(top(1, 1), { shift: true }))?.begin(sample(top(1, 1), { shift: true }))
    expect(erase).toEqual([{ t: 'voxelPaint', id: 'ground', layer: 'faces', key: faceKey(1, 1, 0, FACE_TOP), value: ['m:0', null, null, null] }])
    // Alt picks up what the active layer holds, and nothing where it is empty.
    terrainContract(deps).stroke(sample(top(1, 1), { alt: true }))?.begin(sample(top(1, 1), { alt: true }))
    expect(current().material).toBe(4)
    deps.setParams({ materialLayer: 3, material: 2 })
    terrainContract(deps).stroke(sample(top(1, 1), { alt: true }))?.begin(sample(top(1, 1), { alt: true }))
    expect(current().material).toBe(2)
  })

  it('alt picks a material up instead of editing, and only on the press', () => {
    const doc = createMap(8, 8)
    // (2,2) stands two cubes tall; its upper cube's west face holds a
    // material, which is what a band is drawn with and so what alt picks up.
    fillColumn(ground(doc), 2, 2, 4)
    ground(doc).paint.faces[faceKey(2, 2, 1, 2)] = layersOf(2)
    const band: SurfaceAddress = { structure: 'ground', x: 2, y: 2, kind: SURFACE_CLIFF, dir: 2, level: 2 }
    const { deps, current } = stub(doc, { terrainMode: 'paint', paintVerb: 'material' })
    const handler = terrainContract(deps).stroke(sample(band, { alt: true }))

    expect(handler?.begin(sample(band, { alt: true }))).toEqual([])
    expect(current().material).toBe(2)

    // A move with alt still held changes nothing further: the eyedropper is a
    // click, not a drag. (3,3)'s top is a different material, and it
    // stays unpicked.
    fillColumn(ground(doc), 3, 3, 2, { material: 3 })
    expect(handler?.move(sample(top(3, 3), { alt: true }))).toEqual([])
    expect(current().material).toBe(2)
  })

  it('cuts a ramp back from a clicked cliff face, descending the way it points', () => {
    const cliff: SurfaceAddress = { structure: 'ground', x: 2, y: 2, kind: SURFACE_CLIFF, dir: 3, level: 1 }
    const doc = createMap(8, 8)
    // (2,2) stands one cube above (2,1), its neighbour to the north: a drop of
    // one tile, which a run of one full ramp cell takes.
    fillColumn(ground(doc), 2, 2, 4)
    const { deps } = stub(doc, { sculptVerb: 'ramp' })
    const handler = terrainContract(deps).stroke(sample(cliff))

    // A ramp is a drag: the press starts the run (previewed through the
    // parameters, applying nothing) and the release cuts it. A one-tile drop
    // needs a run of one, which the press already is, so the one cell is
    // re-stood at its own height with its top voxel sloped north.
    expect(handler?.begin(sample(cliff))).toEqual([])
    expect(handler?.end(sample(cliff))).toEqual([{ t: 'voxel', id: 'ground', field: 'shape', index: voxelIndex(ground(doc), 2, 2, 1), value: rampShape(3) }])
  })

  it('removes the run under a clicked ramp top', () => {
    const doc = createMap(8, 8)
    fillColumn(ground(doc), 2, 2, 4, { material: 0, shape: rampShape(3) })
    expect(rampDirAt(ground(doc), 2, 2)).toBe(3)
    const { deps } = stub(doc, { sculptVerb: 'ramp' })
    const handler = terrainContract(deps).stroke(sample(top(2, 2)))

    // The heights stay and only the slope goes: a full ramp back to a block.
    expect(handler?.begin(sample(top(2, 2)))).toEqual([{ t: 'voxel', id: 'ground', field: 'shape', index: voxelIndex(ground(doc), 2, 2, 1), value: SHAPE_BLOCK }])
    // And a flat top has no run to remove: the press declines, and falls through to a click.
    const flat = createMap(8, 8)
    expect(rampDirAt(ground(flat), 2, 2)).toBe(NO_RAMP)
    expect(terrainContract(stub(flat, { sculptVerb: 'ramp' }).deps).stroke(sample(top(2, 2)))).toBeUndefined()
  })

  it('declines a press that missed the terrain', () => {
    const { deps } = stub(createMap(8, 8))
    expect(terrainContract(deps).stroke(sample(null))).toBeUndefined()
  })
})
