import { describe, expect, it } from 'vitest'

import { applyPatches, History, inversePatch, patchAddress, type Patch, type StrokeRecord } from './edits'
import { createMap, defaultFacing, NO_RAMP, type MapDoc, type MapObject, type ReadonlyMapDoc } from './document'
import { childrenOf, descendantsOf, outlineOf, type VoxelStructure } from './structure'
import { deserialize, LoadError, serialize } from './io'
import { createProject, parseProject, serializeProject, sheetName, stemOf } from './project'
import { addObject, addSketchPoint, addStructure, brushCells, clearRampRun, closeSketch, columnPatches, createSketch, deleteSketchPoint, fillCells, flatten, paintFace, placeStructureOnto, raise, rampPlan, rampRun, rampRunBlocked, rampRunLength, removeObject, removeStructure, reparentStructure, setSketch, updateObject } from './ops'
import { FACE_TOP, countDormant, faceKey, parseFaceKey } from './paint'
import { EditorStore } from './store'
import { cornerHeights, frameOf, groundHeight, structureAt } from './terrain'
import { columnHeights, columnTopAt, faceExposed, fillColumn, halfRampShape, halfRampUpShape, materialAt, rampDirAt, rampShape, topHeight, voxelIndex } from './voxels'

function objectAt(id: string, x: number, z: number): MapObject {
  return {
    id,
    name: id,
    sprite: 'tree',
    position: [x, 0, z],
    rotationY: 0,
    scale: 1,
    display: 'auto',
    facing: defaultFacing(),
    anchorCell: [x, z],
    seed: 0,
    locked: false,
    hidden: false,
  }
}

/** The one voxel volume a fresh level has, as the mutable thing a test sets up. */
const ground = (doc: MapDoc | ReadonlyMapDoc): VoxelStructure => doc.structures.ground as VoxelStructure

/** Stand a column at `h` half-tiles by writing the voxels directly, as a fixture does. */
function setHeight(doc: MapDoc, x: number, y: number, h: number): void {
  fillColumn(ground(doc), x, y, h)
}

// `JSON.parse` returns `any` here on purpose: the whole point of these tests
// is to mangle the on-disk shape into something the loader must refuse, so
// typing it more tightly would just fight the tests. `OnDisk` used to pin this
// down for `no-unsafe-*`, but test files are now exempt from lint entirely
// (#38), so the type stopped earning its place.
function parseOnDisk(doc: MapDoc) {
  return JSON.parse(serialize(doc))
}

describe('edits', () => {
  it('derives an exact inverse without the tool writing one', () => {
    const doc = createMap(4, 4)
    const before = columnHeights(ground(doc))

    // Two columns re-stood: each is several voxel patches, and the inverse
    // covers all of them without the op describing any.
    const inverse = applyPatches(doc, [...columnPatches(ground(doc), 1, 1, 9), ...columnPatches(ground(doc), 2, 1, 7)])
    expect(topHeight(ground(doc), 1, 1)).toBe(9)
    expect(topHeight(ground(doc), 2, 1)).toBe(7)

    applyPatches(doc, inverse)
    expect(columnHeights(ground(doc))).toEqual(before)
  })

  it('inverts repeated writes to one address in the right order', () => {
    const doc = createMap(4, 4)
    fillColumn(ground(doc), 0, 0, 2, 1)
    const index = voxelIndex(ground(doc), 0, 0, 0)

    const inverse = applyPatches(doc, [
      { t: 'voxel', id: ground(doc).id, field: 'material', index, value: 2 },
      { t: 'voxel', id: ground(doc).id, field: 'material', index, value: 3 },
    ])
    expect(materialAt(ground(doc), 0, 0)).toBe(3)

    applyPatches(doc, inverse)
    expect(materialAt(ground(doc), 0, 0)).toBe(1)
  })

  it('undoes and redoes through the history', () => {
    const doc = createMap(4, 4)
    const history = new History()
    const patches = columnPatches(ground(doc), 3, 0, 11)
    history.push({ label: 'Raise', patches, inverse: applyPatches(doc, patches) })

    expect(topHeight(ground(doc), 3, 0)).toBe(11)
    history.undo(doc)
    expect(topHeight(ground(doc), 3, 0)).toBe(2)
    history.redo(doc)
    expect(topHeight(ground(doc), 3, 0)).toBe(11)
  })
})

describe('patch addresses and inverses', () => {
  it('keys a patch by the slot it writes, and nothing else', () => {
    expect(patchAddress({ t: 'voxel', id: 'g', field: 'material', index: 7, value: 1 })).toBe(patchAddress({ t: 'voxel', id: 'g', field: 'material', index: 7, value: 9 }))
    expect(patchAddress({ t: 'voxel', id: 'g', field: 'material', index: 7, value: 1 })).not.toBe(patchAddress({ t: 'voxel', id: 'g', field: 'shape', index: 7, value: 1 }))
    expect(patchAddress({ t: 'voxel', id: 'g', field: 'material', index: 7, value: 1 })).not.toBe(patchAddress({ t: 'voxel', id: 'g', field: 'water', index: 7, value: 1 }))
    expect(patchAddress({ t: 'voxelPaint', id: 'g', layer: 'faces', key: '1,2', value: 3 })).not.toBe(patchAddress({ t: 'voxelPaint', id: 'g', layer: 'tint', key: '1,2', value: 3 }))
    expect(patchAddress({ t: 'object', id: 'a', value: undefined })).toBe('object:a')
    expect(patchAddress({ t: 'doc', field: 'camera', value: null })).toBe('doc:camera')
  })

  it('reads the before-value the applier would have returned, without writing', () => {
    const doc = createMap(4, 4)
    // A three-block column in material 6: its top voxel sits in layer 2.
    fillColumn(ground(doc), 1, 1, 6, 6)
    const patch: Patch = { t: 'voxel', id: ground(doc).id, field: 'material', index: voxelIndex(ground(doc), 1, 1, 2), value: 9 }
    const before = inversePatch(doc, patch)
    expect(before).toEqual({ ...patch, value: 6 })
    expect(materialAt(ground(doc), 1, 1)).toBe(6)
    // Same answer as the applier, which is what makes the two paths agree.
    expect(applyPatches(doc, [patch])).toEqual([before])
    const face = faceKey(0, 0, 0, FACE_TOP)
    expect(inversePatch(doc, { t: 'voxelPaint', id: ground(doc).id, layer: 'faces', key: face, value: 1 })).toEqual({ t: 'voxelPaint', id: ground(doc).id, layer: 'faces', key: face, value: undefined })
  })
})

/**
 * What the stroke actor does per tick, in miniature: read each patch's
 * before-value BEFORE applying it, keep the first inverse and the last forward
 * value per address, and hand the pair back on release.
 */
function compactingStroke(store: EditorStore, label: string): { apply(patches: Patch[]): void; end(): void } {
  const compaction = new Map<string, { first: Patch; last: Patch }>()
  store.beginStroke(label)
  return {
    apply(patches) {
      for (const patch of patches) {
        const key = patchAddress(patch)
        const entry = compaction.get(key)
        if (entry) entry.last = patch
        else compaction.set(key, { first: inversePatch(store.reader.doc, patch), last: patch })
      }
      store.applyStrokeTick(patches)
    },
    end() {
      const record: StrokeRecord = { patches: [], inverse: [] }
      for (const { first, last } of compaction.values()) {
        record.patches.push(last)
        record.inverse.push(first)
      }
      store.endStroke(record)
    },
  }
}

describe('store', () => {
  it('tells a structure that moved from one whose shape changed, and names nothing for a rename', () => {
    const store = new EditorStore(createMap(8, 8))
    const island = createSketch('ground', 'Island')
    const tier = createSketch(island.id, 'Tier')
    store.apply('Add', addStructure(store.reader.doc, island))
    store.apply('Add', addStructure(store.reader.doc, tier))
    store.reader.takeDirtyStructures()
    store.reader.takeMovedStructures()

    // Moving the island moves the tier with it; neither is reshaped.
    store.apply('Move', [{ t: 'structure.meta', id: island.id, field: 'placement', value: { x: 2, z: 1, yaw: 0 } }])
    expect(store.reader.takeDirtyStructures()).toEqual([])
    expect(store.reader.takeMovedStructures().sort()).toEqual([island.id, tier.id].sort())

    store.apply('Rename', [{ t: 'structure.meta', id: island.id, field: 'name', value: 'Isle' }])
    expect(store.reader.takeDirtyStructures()).toEqual([])
    expect(store.reader.takeMovedStructures()).toEqual([])

    // A new height reshapes the island and moves the tier standing on it.
    store.apply('Height', setSketch(store.reader.doc, island.id, { layers: island.layers + 3 }))
    expect(store.reader.takeDirtyStructures()).toEqual([island.id])
    expect(store.reader.takeMovedStructures()).toEqual([tier.id])

    // Moved and reshaped in the same breath is reshaped only.
    store.apply('Both', [
      { t: 'structure.meta', id: tier.id, field: 'placement', value: { x: 1, z: 1, yaw: 0 } },
      ...setSketch(store.reader.doc, tier.id, { layers: tier.layers + 1 }),
    ])
    expect(store.reader.takeDirtyStructures()).toEqual([tier.id])
    expect(store.reader.takeMovedStructures()).toEqual([])
  })

  it('rounds a sketch outline once per version of its points', () => {
    const points = [
      { x: 0, z: 0, smooth: true },
      { x: 4, z: 0, smooth: true },
      { x: 4, z: 4, smooth: false },
    ]
    expect(outlineOf(points)).toBe(outlineOf(points))
    expect(outlineOf(points, 1)).not.toBe(outlineOf(points))
    // An edit writes a new array, and the new array is rounded afresh.
    const edited = points.map((p, i) => (i === 0 ? { ...p, x: 1 } : p))
    expect(outlineOf(edited)).not.toBe(outlineOf(points))
    expect(outlineOf(edited).points).not.toEqual(outlineOf(points).points)
  })

  it('records a stroke as the one entry its record describes', () => {
    const store = new EditorStore(createMap(8, 8))
    const stroke = compactingStroke(store, 'Raise')
    for (let i = 0; i < 5; i++) stroke.apply(raise(store.reader.doc, ground(store.reader.doc), [[i, 0]], 1))
    stroke.end()

    expect(topHeight(ground(store.reader.doc), 0, 0)).toBe(3)
    expect(store.reader.undoLabel()).toBe('Raise')
    store.undo()
    for (let i = 0; i < 5; i++) expect(topHeight(ground(store.reader.doc), i, 0)).toBe(2)
    expect(store.reader.canUndo()).toBe(false)
  })

  it('applies every tick immediately but keeps no history until the record arrives', () => {
    const store = new EditorStore(createMap(8, 8))
    const stroke = compactingStroke(store, 'Raise')
    stroke.apply(raise(store.reader.doc, ground(store.reader.doc), [[0, 0]], 1))
    // The terrain moved mid-drag, and the drag is not an undo entry yet.
    expect(topHeight(ground(store.reader.doc), 0, 0)).toBe(3)
    expect(store.reader.canUndo()).toBe(false)
    expect(store.inStroke).toBe(true)

    // Undo mid-stroke is refused rather than closing the stroke early: the
    // old close-and-undo left the rest of the drag with no record at all.
    store.undo()
    expect(topHeight(ground(store.reader.doc), 0, 0)).toBe(3)

    stroke.end()
    expect(store.reader.canUndo()).toBe(true)
  })

  it('records an ordinary edit that lands mid-stroke, so one undo brings it back', () => {
    // The Delete keybinding is on `window` and fires during a pointer drag —
    // pointer capture does not stop it — so an app write concurrent with a
    // stroke is reachable, not hypothetical. It used to be folded into the
    // open stroke; for one commit it was recorded by nothing at all.
    const store = new EditorStore(createMap(8, 8))
    const stroke = compactingStroke(store, 'Raise')
    stroke.apply(raise(store.reader.doc, ground(store.reader.doc), [[0, 0]], 1))
    store.apply('Elsewhere', raise(store.reader.doc, ground(store.reader.doc), [[7, 7]], 1))
    expect(topHeight(ground(store.reader.doc), 7, 7)).toBe(3)

    stroke.end()
    // Two entries, innermost last: the mid-stroke edit unwinds on its own undo
    // and the drag unwinds on the next.
    expect(store.reader.undoLabel()).toBe('Raise')
    store.undo()
    expect(topHeight(ground(store.reader.doc), 0, 0)).toBe(2)
    expect(store.reader.undoLabel()).toBe('Elsewhere')
    store.undo()
    expect(topHeight(ground(store.reader.doc), 7, 7)).toBe(2)
    expect(store.reader.canUndo()).toBe(false)
  })

  it('refuses a mid-stroke edit at an address the stroke already wrote', () => {
    // The collision the previous test does NOT have: same address, two
    // entries. Recorded, they unwind in an order that never happened — the
    // stroke's entry sits ON TOP of the concurrent one but holds the older
    // before-value, so one undo restores a mid-drag state and the next
    // restores the state before the drag began, out of order.
    const store = new EditorStore(createMap(8, 8))
    const stroke = compactingStroke(store, 'Raise')
    stroke.apply(raise(store.reader.doc, ground(store.reader.doc), [[0, 0]], 1))

    // The stroke put a slab in layer 1; raising further turns that slab into
    // a block, which is a write to the same shape address.
    store.apply('Collides', raise(store.reader.doc, ground(store.reader.doc), [[0, 0]], 5))
    // Refused whole: not applied, and not an entry.
    expect(topHeight(ground(store.reader.doc), 0, 0)).toBe(3)

    stroke.end()
    expect(store.reader.undoLabel()).toBe('Raise')
    store.undo()
    expect(topHeight(ground(store.reader.doc), 0, 0)).toBe(2)
    expect(store.reader.canUndo()).toBe(false)
  })

  it('refuses the colliding edit whole, never the half of it that does not collide', () => {
    // `removeObject` is two patches — the object and the order — and the
    // stroke owns only the first. Applying the other half would drop the id
    // from `objectOrder` while `objects` kept it: the orphan, arrived at from
    // the other side.
    const store = new EditorStore(createMap(8, 8))
    const object = objectAt('a', 1, 1)
    store.apply('Add object', addObject(store.reader.doc, object))

    const stroke = compactingStroke(store, 'Edit object')
    stroke.apply(updateObject(store.reader.doc, 'a', { position: [4, 0, 4] }))
    store.apply('Delete object', removeObject(store.reader.doc, 'a'))
    expect(store.reader.doc.objectOrder).toEqual(['a'])
    expect(store.reader.doc.objects.a).toBeDefined()

    stroke.end()
    store.undo()
    expect(store.reader.doc.objects.a?.position).toEqual([1, 0, 1])
    expect(store.reader.doc.objectOrder).toEqual(['a'])
  })

  it('refuses a stroke tick with no stroke open, since it addresses a replaced document', () => {
    const store = new EditorStore(createMap(8, 8))
    store.applyStrokeTick(raise(store.reader.doc, ground(store.reader.doc), [[0, 0]], 1))
    expect(topHeight(ground(store.reader.doc), 0, 0)).toBe(2)
    expect(store.reader.canUndo()).toBe(false)
  })

  it('drops a record that arrives after the document was replaced', () => {
    const store = new EditorStore(createMap(8, 8, 'First'))
    const stroke = compactingStroke(store, 'Raise')
    stroke.apply(raise(store.reader.doc, ground(store.reader.doc), [[0, 0]], 1))
    store.replace(createMap(4, 4, 'Second'))
    stroke.end()
    expect(store.reader.canUndo()).toBe(false)
    expect(store.reader.doc.name).toBe('Second')
  })

  it('closes an empty stroke without an entry', () => {
    const store = new EditorStore(createMap(8, 8))
    store.beginStroke('Nothing')
    store.endStroke(null)
    expect(store.reader.canUndo()).toBe(false)
    expect(store.inStroke).toBe(false)
  })

  it('drops no-op patches so idle brushing does not fill the undo stack', () => {
    const store = new EditorStore(createMap(8, 8))
    store.apply('Flatten', flatten(store.reader.doc, ground(store.reader.doc), [[0, 0]], 2))
    expect(store.reader.canUndo()).toBe(false)
  })

  it('marks the neighbouring chunks dirty at a chunk border', () => {
    const store = new EditorStore(createMap(48, 48))
    store.takeDirtyChunks()
    store.apply('Raise', raise(store.reader.doc, ground(store.reader.doc), [[16, 16]], 1))
    const dirty = store.takeDirtyChunks()
    expect(dirty).toContain('ground/1,1')
    expect(dirty).toContain('ground/0,0')
  })
})

describe('paint survives sculpt', () => {
  it('never emits a paint patch from a sculpt op', () => {
    const doc = createMap(8, 8)
    // A cliff at (1,1) for the ramp to be cut from, and a ramp at (3,3) to clear.
    setHeight(doc, 1, 1, 4)
    fillColumn(ground(doc), 3, 3, 4, 0, rampShape(0))
    const edge = { x: 1, z: 1, dir: 0 }
    const ops = [
      raise(doc, ground(doc), [[1, 1]], 2),
      flatten(doc, ground(doc), [[1, 1]], 5),
      rampRun(doc, ground(doc), edge, rampRunLength(ground(doc), edge) ?? 0),
      clearRampRun(doc, ground(doc), 3, 3),
    ]
    for (const patches of ops) {
      expect(patches.length).toBeGreaterThan(0)
      expect(patches.some((patch) => patch.t === 'voxelPaint')).toBe(false)
    }
  })

  it('reports dormant paint as a diagnostic', () => {
    const doc = createMap(4, 4)
    const g = ground(doc)
    // An override on a face that is drawn — the top of the one-cube column at (1, 1) — and one on a face
    // no voxel has, off the volume. Only the second is dormant.
    g.paint.faces[faceKey(1, 1, 0, FACE_TOP)] = 3
    g.paint.faces[faceKey(9, 9, 0, 0)] = 4
    const exists = (key: string) => {
      const { x, z, y, dir } = parseFaceKey(key)
      return faceExposed(g, x, z, y, dir)
    }
    expect(countDormant(g.paint, exists)).toBe(1)
    // Lower the column to nothing and its top face goes too: the override stays, dormant now.
    setHeight(doc, 1, 1, 0)
    expect(countDormant(g.paint, exists)).toBe(2)
    expect(g.paint.faces[faceKey(1, 1, 0, FACE_TOP)]).toBe(3)
  })
})

describe('terrain queries', () => {
  it('interpolates a ramp instead of stepping it', () => {
    const doc = createMap(4, 4)
    // A two-cube column whose top voxel is a ramp descending east.
    fillColumn(ground(doc), 1, 1, 4, 0, rampShape(0))

    const high = groundHeight(doc, 1.01, 1.5)
    const low = groundHeight(doc, 1.99, 1.5)
    const mid = groundHeight(doc, 1.5, 1.5)
    expect(high).toBeGreaterThan(mid)
    expect(mid).toBeGreaterThan(low)
    expect(mid).toBeCloseTo(1.5, 2)
  })

  it('agrees with the mesher about a flat cell', () => {
    const doc = createMap(4, 4)
    setHeight(doc, 2, 2, 6)
    expect(groundHeight(doc, 2.5, 2.5)).toBeCloseTo(3, 6)
  })
})

describe('ramps', () => {
  it('cuts a ramp from a cliff edge and clears it back to a level top of the same height', () => {
    const doc = createMap(4, 4)
    setHeight(doc, 1, 1, 4)
    const edge = { x: 1, z: 1, dir: 0 }
    // One tile of drop to the east is one ramp cell.
    expect(rampRunLength(ground(doc), edge)).toBe(1)
    // No drop, no run.
    expect(rampRunLength(ground(doc), { x: 1, z: 1, dir: 2 })).toBe(1)
    expect(rampRunLength(ground(doc), { x: 0, z: 0, dir: 0 })).toBeNull()
    // The run must be what the drop needs.
    expect(rampRun(doc, ground(doc), edge, 2)).toEqual([])

    applyPatches(doc, rampRun(doc, ground(doc), edge, 1))
    expect(rampDirAt(ground(doc), 1, 1)).toBe(0)
    expect(topHeight(ground(doc), 1, 1)).toBe(4)
    expect(groundHeight(doc, 1.5, 1.5)).toBeCloseTo(1.5, 6)

    applyPatches(doc, clearRampRun(doc, ground(doc), 1, 1))
    expect(rampDirAt(ground(doc), 1, 1)).toBe(NO_RAMP)
    expect(topHeight(ground(doc), 1, 1)).toBe(4)
    expect(clearRampRun(doc, ground(doc), 1, 1)).toEqual([])
  })

  it('finishes an odd drop with a half ramp', () => {
    const doc = createMap(4, 4)
    // Three half-tiles of drop from a plateau two cells deep: a full ramp and a half ramp.
    setHeight(doc, 2, 1, 5)
    setHeight(doc, 1, 1, 5)
    const edge = { x: 2, z: 1, dir: 0 }
    expect(rampRunLength(ground(doc), edge)).toBe(2)
    expect(rampRunBlocked(ground(doc), edge)).toBeNull()
    applyPatches(doc, rampRun(doc, ground(doc), edge, 2))
    expect(rampDirAt(ground(doc), 2, 1)).toBe(0)
    expect(rampDirAt(ground(doc), 1, 1)).toBe(0)
    // The run keeps its high end at the top of the cliff and descends to the low side.
    expect(topHeight(ground(doc), 1, 1)).toBe(5)
    expect(groundHeight(doc, 3.5, 1.5)).toBeCloseTo(1, 6)
  })

  it('starts an odd drop from a slab with the half ramp that rides one, so every full ramp has a whole-tile floor', () => {
    const doc = createMap(4, 4)
    // The low side is a slab at 1; the plateau stands at 5: a drop of four, which a full ramp on an odd floor could not meet.
    setHeight(doc, 3, 1, 1)
    for (const x of [0, 1, 2]) setHeight(doc, x, 1, 5)
    const edge = { x: 2, z: 1, dir: 0 }
    const plan = rampPlan(ground(doc), edge)
    expect(plan?.map((step) => [step.height, step.shape])).toEqual([
      [2, halfRampUpShape(0)],
      [4, rampShape(0)],
      [5, halfRampShape(0)],
    ])
    applyPatches(doc, rampRun(doc, ground(doc), edge, 3))
    // Each cell's low edge meets the next cell's high edge, and the last meets the plateau.
    expect(cornerHeights(ground(doc), 2, 1)).toEqual([2, 2, 1, 1])
    expect(cornerHeights(ground(doc), 1, 1)).toEqual([4, 4, 2, 2])
    expect(cornerHeights(ground(doc), 0, 1)).toEqual([5, 5, 4, 4])
  })

  it('clears the run under a click and leaves the run beside it', () => {
    const doc = createMap(4, 4)
    for (const z of [1, 2]) for (const x of [1, 2]) setHeight(doc, x, z, 6)
    // Two runs cut side by side, both descending east from x = 2.
    for (const z of [1, 2]) applyPatches(doc, rampRun(doc, ground(doc), { x: 2, z, dir: 0 }, 2))
    expect([1, 2].map((z) => [rampDirAt(ground(doc), 1, z), rampDirAt(ground(doc), 2, z)])).toEqual([
      [0, 0],
      [0, 0],
    ])
    applyPatches(doc, clearRampRun(doc, ground(doc), 2, 1))
    expect([rampDirAt(ground(doc), 1, 1), rampDirAt(ground(doc), 2, 1)]).toEqual([NO_RAMP, NO_RAMP])
    expect([rampDirAt(ground(doc), 1, 2), rampDirAt(ground(doc), 2, 2)]).toEqual([0, 0])
  })

  it('refuses a run through ground that is not level with the edge, or that leaves the volume', () => {
    const doc = createMap(4, 4)
    setHeight(doc, 2, 1, 6)
    // Two cells of run wanted; the cell behind the edge stands at 2, not 6.
    expect(rampRunBlocked(ground(doc), { x: 2, z: 1, dir: 0 })).toBe('the ground behind the edge is not level with it')
    expect(rampRun(doc, ground(doc), { x: 2, z: 1, dir: 0 }, 2)).toEqual([])
    // A ramp already cut behind the edge blocks it too.
    setHeight(doc, 1, 1, 6)
    fillColumn(ground(doc), 1, 1, 6, 0, rampShape(1))
    expect(rampRunBlocked(ground(doc), { x: 2, z: 1, dir: 0 })).toBe('the run crosses another ramp')
    // And a run that would step off the volume: a drop of three tiles from a plateau only two cells deep.
    const small = createMap(3, 2)
    setHeight(small, 1, 0, 8)
    setHeight(small, 0, 0, 8)
    expect(rampRunBlocked(ground(small), { x: 1, z: 0, dir: 0 })).toBe('the run would leave the volume')
  })
})

describe('object grounding', () => {
  it('carries an anchored object up with the terrain', () => {
    const store = new EditorStore(createMap(8, 8))
    const id = 'obj_test'
    store.apply('Add', [
      {
        t: 'object',
        id,
        value: {
          id,
          name: 'Tree',
          sprite: 'tree',
          position: [2.5, 1, 2.5],
          rotationY: 0,
          scale: 1,
          display: 'auto',
          facing: {
            facings: 1,
            mirror: true,
            back: 'mirror',
            transition: 'flip',
            durationMs: 200,
            hysteresisDeg: 8,
            hinge: 'center',
          },
          anchorCell: [2, 2],
          seed: 0,
          locked: false,
          hidden: false,
        },
      },
      { t: 'objectOrder', value: [id] },
    ])

    store.apply('Raise', raise(store.reader.doc, ground(store.reader.doc), [[2, 2]], 4))
    expect(store.reader.doc.objects[id].position[1]).toBeCloseTo(3, 6)

    store.undo()
    expect(store.reader.doc.objects[id].position[1]).toBeCloseTo(1, 6)
  })

  it('leaves unanchored objects where they are', () => {
    const doc = createMap(8, 8)
    const patches = raise(doc, ground(doc), [[2, 2]], 4)
    expect(patches.some((patch) => patch.t === 'object')).toBe(false)
  })
})

describe('brushes', () => {
  it('sizes a square brush correctly and clips at the map edge', () => {
    const doc = createMap(8, 8)
    expect(brushCells(ground(doc), 4, 4, { size: 3, shape: 'square' })).toHaveLength(9)
    expect(brushCells(ground(doc), 0, 0, { size: 3, shape: 'square' })).toHaveLength(4)
  })

  it('fills a region of matching cells', () => {
    const doc = createMap(8, 8)
    setHeight(doc, 4, 0, 9)
    for (let y = 0; y < 8; y++) setHeight(doc, 4, y, 9)
    const region = fillCells(ground(doc), 0, 0)
    expect(region.length).toBe(32)
  })
})

describe('io', () => {
  it('round-trips a document', () => {
    const store = new EditorStore(createMap(6, 6, 'Test Map'))
    store.apply('Raise', raise(store.reader.doc, ground(store.reader.doc), [[1, 1]], 3))
    // The top face of the column's top voxel, drawn with material 4 (path) instead of its own.
    const top = columnTopAt(ground(store.reader.doc), 1, 1)
    store.apply('Paint', paintFace(ground(store.reader.doc), [{ x: 1, z: 1, y: top, dir: FACE_TOP }], 4))

    const restored = deserialize(serialize(store.reader.doc))
    expect(restored.name).toBe('Test Map')
    expect(ground(restored).voxels).toEqual(ground(store.reader.doc).voxels)
    expect(columnHeights(ground(restored))).toEqual(columnHeights(ground(store.reader.doc)))
    expect(ground(restored).paint.faces).toEqual(ground(store.reader.doc).paint.faces)
    expect(ground(restored).paint.faces[faceKey(1, 1, top, FACE_TOP)]).toBe(4)
    expect(restored.formatVersion).toBe(4)
  })

  it('refuses an older format outright: no migrations until data exists', () => {
    const doc = createMap(4, 4)
    const raw = parseOnDisk(doc)
    raw.formatVersion = 2
    expect(() => deserialize(JSON.stringify(raw))).toThrow(/no migration/)
    delete raw.formatVersion
    expect(() => deserialize(JSON.stringify(raw))).toThrow(LoadError)
  })

  it('round-trips a sketch standing on the ground, and refuses a parent the map lacks', () => {
    const doc = createMap(4, 4)
    const sketch = createSketch(ground(doc).id, 'Island')
    sketch.points = [
      { x: 1, z: 1, smooth: true },
      { x: 3, z: 1, smooth: false },
      { x: 2, z: 3, smooth: true },
    ]
    sketch.closed = true
    applyPatches(doc, addStructure(doc, sketch))
    const restored = deserialize(serialize(doc))
    expect(restored.structureOrder).toEqual(doc.structureOrder)
    expect(restored.structures[sketch.id]).toEqual(sketch)

    const raw = parseOnDisk(doc)
    raw.structures[sketch.id].parent = 'nowhere'
    expect(() => deserialize(JSON.stringify(raw))).toThrow(LoadError)
  })

  it('refuses a document from a newer editor', () => {
    const doc = createMap(4, 4)
    const raw = parseOnDisk(doc)
    raw.formatVersion = 99
    expect(() => deserialize(JSON.stringify(raw))).toThrow(LoadError)
  })

  it('rejects a voxel array of the wrong length', () => {
    const doc = createMap(4, 4)
    const { layers } = ground(doc)
    const raw = parseOnDisk(doc)
    raw.structures[ground(doc).id].voxels.material = [1, 2, 3]
    expect(() => deserialize(JSON.stringify(raw))).toThrow(LoadError)
    expect(() => deserialize(JSON.stringify(raw))).toThrow(new RegExp(`should hold ${16 * layers} entries`))
  })

  it('rejects a water array of the wrong length', () => {
    const doc = createMap(4, 4)
    const raw = parseOnDisk(doc)
    raw.structures[ground(doc).id].water = [1, 2, 3]
    expect(() => deserialize(JSON.stringify(raw))).toThrow(/should hold 16 entries/)
  })

  it('preserves dormant paint across a save and load', () => {
    const doc = createMap(4, 4)
    // The east side of a voxel fifteen layers up a column that is one cube tall: no such face is drawn.
    ground(doc).paint.faces[faceKey(1, 1, 15, 0)] = 5
    const restored = deserialize(serialize(doc))
    expect(ground(restored).paint.faces[faceKey(1, 1, 15, 0)]).toBe(5)
  })
})

describe('structures', () => {
  const island = (): MapDoc => {
    const doc = createMap(6, 6)
    const sketch = createSketch(ground(doc).id, 'Island', { x: 0, z: 0, yaw: 0 })
    applyPatches(doc, addStructure(doc, sketch))
    for (const p of [
      { x: 1, z: 1, smooth: false },
      { x: 5, z: 1, smooth: false },
      { x: 5, z: 5, smooth: false },
      { x: 1, z: 5, smooth: false },
    ])
      applyPatches(doc, addSketchPoint(doc, sketch.id, p))
    applyPatches(doc, closeSketch(doc, sketch.id))
    return doc
  }
  const sketchId = (doc: MapDoc) => doc.structureOrder[1]

  it('a closed sketch on the ground raises the height under it by its layers', () => {
    const doc = island()
    // Ground is 2 half-tiles (1 unit); the sketch adds 3 layers (1.5 units) on top of the cap it stands on.
    expect(groundHeight(doc, 3, 3)).toBeCloseTo(1 + 1.5, 6)
    expect(groundHeight(doc, 0.5, 0.5)).toBeCloseTo(1, 6)
  })

  it('an open sketch has no height, and closing needs three points', () => {
    const doc = createMap(6, 6)
    const sketch = createSketch(ground(doc).id)
    applyPatches(doc, addStructure(doc, sketch))
    applyPatches(doc, addSketchPoint(doc, sketch.id, { x: 1, z: 1, smooth: true }))
    applyPatches(doc, addSketchPoint(doc, sketch.id, { x: 4, z: 1, smooth: true }))
    expect(closeSketch(doc, sketch.id)).toEqual([])
    expect(groundHeight(doc, 2, 1)).toBeCloseTo(1, 6)
  })

  it("a tier stands on its parent: its base is the parent's cap, its placement relative to it", () => {
    const doc = island()
    const tier = createSketch(sketchId(doc), 'Tier', { x: 2, z: 2, yaw: 0 })
    tier.points = [
      { x: 0, z: 0, smooth: false },
      { x: 2, z: 0, smooth: false },
      { x: 2, z: 2, smooth: false },
      { x: 0, z: 2, smooth: false },
    ]
    tier.closed = true
    tier.layers = 2
    applyPatches(doc, addStructure(doc, tier))
    // World (3, 3) is inside the tier (local 1, 1): ground 1 + island 1.5 + tier 1.
    expect(groundHeight(doc, 3, 3)).toBeCloseTo(3.5, 6)
    // World (1.5, 1.5) is on the island but outside the tier.
    expect(groundHeight(doc, 1.5, 1.5)).toBeCloseTo(2.5, 6)
  })

  it('a quarter turn turns the child with it', () => {
    const doc = island()
    const tier = createSketch(sketchId(doc), 'Tier', { x: 3, z: 3, yaw: 1 })
    // A 2×1 bar along local +x; turned a quarter it lies along world +z.
    tier.points = [
      { x: 0, z: -0.5, smooth: false },
      { x: 2, z: -0.5, smooth: false },
      { x: 2, z: 0.5, smooth: false },
      { x: 0, z: 0.5, smooth: false },
    ]
    tier.closed = true
    tier.layers = 2
    applyPatches(doc, addStructure(doc, tier))
    expect(groundHeight(doc, 3, 4.5)).toBeCloseTo(3.5, 6)
    expect(groundHeight(doc, 4.5, 3)).toBeCloseTo(2.5, 6)
  })

  it('deleting a structure takes everything standing on it, and undo brings all of it back', () => {
    const doc = island()
    const islandId = sketchId(doc)
    const tier = createSketch(islandId, 'Tier')
    applyPatches(doc, addStructure(doc, tier))
    expect(descendantsOf(doc, islandId)).toEqual([tier.id])
    const inverse = applyPatches(doc, removeStructure(doc, islandId))
    expect(doc.structures[islandId]).toBeUndefined()
    expect(doc.structures[tier.id]).toBeUndefined()
    expect(doc.structureOrder).toEqual([ground(doc).id])
    applyPatches(doc, inverse)
    expect(doc.structures[tier.id]?.parent).toBe(islandId)
    expect(childrenOf(doc, islandId).map((s) => s.id)).toEqual([tier.id])
  })

  it('structureAt answers the highest structure under a point, a child over its parent, and leaves out what is excluded', () => {
    const doc = island()
    const islandId = sketchId(doc)
    const tier = createSketch(islandId, 'Tier', { x: 2, z: 2, yaw: 0 })
    tier.points = [
      { x: 0, z: 0, smooth: false },
      { x: 2, z: 0, smooth: false },
      { x: 2, z: 2, smooth: false },
      { x: 0, z: 2, smooth: false },
    ]
    tier.closed = true
    applyPatches(doc, addStructure(doc, tier))

    expect(structureAt(doc, 0.5, 0.5)).toBe('ground')
    expect(structureAt(doc, 1.5, 1.5)).toBe(islandId)
    expect(structureAt(doc, 3, 3)).toBe(tier.id)
    expect(structureAt(doc, 3, 3, new Set([tier.id]))).toBe(islandId)
    expect(structureAt(doc, 3, 3, new Set([tier.id, islandId]))).toBe('ground')
    expect(structureAt(doc, -1, -1)).toBeNull()
  })

  it('placeStructureOnto keeps where a structure is in the world while it changes parent, and re-measures its placement', () => {
    const doc = island()
    const islandId = sketchId(doc)
    applyPatches(doc, [{ t: 'structure.meta', id: islandId, field: 'placement', value: { x: 1, z: 1, yaw: 1 } }])
    const tier = createSketch(islandId, 'Tier', { x: 2, z: 1, yaw: 1 })
    applyPatches(doc, addStructure(doc, tier))
    const before = frameOf(doc, tier.id)

    // Onto the ground at the same world point: a different placement, the same frame (but for the height it stands at).
    applyPatches(doc, placeStructureOnto(doc, tier.id, 'ground', { x: before.x, z: before.z }))
    expect(doc.structures[tier.id]?.parent).toBe('ground')
    expect(doc.structures[tier.id]?.placement).toEqual({ x: before.x, z: before.z, yaw: 2 })
    const after = frameOf(doc, tier.id)
    expect([after.x, after.z, after.yaw]).toEqual([before.x, before.z, before.yaw])

    // Back onto the island, snapped in the island's frame.
    applyPatches(doc, placeStructureOnto(doc, tier.id, islandId, { x: before.x + 0.4, z: before.z }, Math.round))
    expect(doc.structures[tier.id]?.parent).toBe(islandId)
    expect(doc.structures[tier.id]?.placement).toEqual({ x: 2, z: 1, yaw: 1 })

    // Refused for the root, for a cycle, and for a parent that is not there.
    expect(placeStructureOnto(doc, 'ground', null, { x: 0, z: 0 })).toEqual([])
    expect(placeStructureOnto(doc, islandId, tier.id, { x: 0, z: 0 })).toEqual([])
    expect(placeStructureOnto(doc, tier.id, 'nope', { x: 0, z: 0 })).toEqual([])
    // Nothing changes: nothing to write.
    expect(placeStructureOnto(doc, tier.id, islandId, { x: before.x, z: before.z }, Math.round)).toEqual([])
  })

  it('refuses to make a structure its own ancestor', () => {
    const doc = island()
    const islandId = sketchId(doc)
    const tier = createSketch(islandId, 'Tier')
    applyPatches(doc, addStructure(doc, tier))
    expect(reparentStructure(doc, islandId, tier.id)).toEqual([])
    expect(reparentStructure(doc, islandId, islandId)).toEqual([])
    expect(reparentStructure(doc, tier.id, null)).toHaveLength(1)
  })

  it("a sketch edit's inverse is a copy, not the live points", () => {
    const doc = island()
    const id = sketchId(doc)
    const inverse = applyPatches(doc, setSketch(doc, id, { layers: 7 }))
    expect(inverse).toEqual([{ t: 'sketch', id, field: 'layers', value: 3 }])
    const beforePoints = applyPatches(doc, deleteSketchPoint(doc, id, 0))
    // Mutating the document after the fact must not reach into the recorded inverse.
    applyPatches(doc, addSketchPoint(doc, id, { x: 9, z: 9, smooth: true }))
    const kept = beforePoints[0]
    expect(kept.t === 'sketch' && kept.field === 'points' ? kept.value.length : -1).toBe(4)
  })

  it('a closed sketch that loses a point below three opens again', () => {
    const doc = island()
    const id = sketchId(doc)
    applyPatches(doc, deleteSketchPoint(doc, id, 0))
    applyPatches(doc, deleteSketchPoint(doc, id, 0))
    expect((doc.structures[id] as { closed: boolean }).closed).toBe(false)
  })
})

describe('a map file is checked before it is believed', () => {
  const raw = () => JSON.parse(serialize(createMap(2, 2))) as { structures: Record<string, { voxels: { material: number[]; shape: number[] }; layers: number }> }

  it('refuses a voxel whose material or shape is not one', () => {
    const material = raw()
    material.structures.ground.voxels.material[0] = -5
    expect(() => deserialize(JSON.stringify(material))).toThrow(/material\[0\] is -5/)
    const shape = raw()
    shape.structures.ground.voxels.shape[1] = 99
    expect(() => deserialize(JSON.stringify(shape))).toThrow(/shape\[1\] is 99/)
  })

  it('refuses a volume taller than a band level can name', () => {
    const tall = raw()
    tall.structures.ground.layers = 129
    expect(() => deserialize(JSON.stringify(tall))).toThrow(/at most 128/)
  })
})

describe('a project file is checked before it is believed', () => {
  const raw = () => JSON.parse(serializeProject(createProject('Harbour Town'))) as Record<string, unknown>

  it('round-trips, and starts with the placeholder image, the default materials and no maps', () => {
    const project = createProject('Harbour Town', 32, { terrains: [{ id: 'grass', name: 'Grass', color: '#4f8a46' }], tiles: { 3: ['grass', 'grass', null, null] } })
    expect(project.resolution).toEqual({ texelDensity: 32, filtering: 'nearest' })
    expect(project.images).toEqual([{ path: 'sheets/ground.png', name: 'Ground', kind: 'tileset', hash: null, grid: { tile: 32, margin: { x: 0, y: 0 }, spacing: { x: 0, y: 0 } }, layout: null, terrain: { terrains: [{ id: 'grass', name: 'Grass', color: '#4f8a46' }], tiles: { 3: ['grass', 'grass', null, null] } } }])
    expect(project.maps).toEqual([])
    expect(parseProject(serializeProject(project))).toEqual(project)
    expect(sheetName('sheets/ground.png')).toBe('ground.png')
    expect(stemOf('sheets/mz/Outside_A2.png')).toBe('Outside_A2')
  })

  it('refuses another format, an empty material list, a shared id and a path outside the folder', () => {
    const version = raw()
    version.formatVersion = 1
    expect(() => parseProject(JSON.stringify(version))).toThrow(/format 1/)
    const bare = raw()
    bare.materials = []
    expect(() => parseProject(JSON.stringify(bare))).toThrow(/at least one material/)
    const shared = raw()
    shared.materials = [{ id: 1, top: { sheet: 'g.png', terrain: 'a' } }, { id: 1, top: { sheet: 'g.png', terrain: 'b' } }]
    expect(() => parseProject(JSON.stringify(shared))).toThrow(/share the id 1/)
    const outside = raw()
    outside.maps = ['../elsewhere.map.json']
    expect(() => parseProject(JSON.stringify(outside))).toThrow(/inside the project/)
    const twice = raw()
    twice.images = [{ path: 'sheets/a.png', grid: { tile: 16 } }, { path: 'other/a.png', grid: { tile: 16 } }]
    expect(() => parseProject(JSON.stringify(twice))).toThrow(/both called a.png/)
    expect(() => parseProject('nope')).toThrow(LoadError)
  })

  it('defaults what a sparse file leaves out — an image gets its stem as a name and a plain grid — and never an image without a tile size', () => {
    const sparse = parseProject(JSON.stringify({ formatVersion: 2, name: 'Sparse' }))
    expect(sparse.resolution).toEqual({ texelDensity: 16, filtering: 'nearest' })
    expect(sparse.materials.length).toBeGreaterThan(0)
    expect(sparse.images).toEqual([])
    expect(sparse.maps).toEqual([])
    expect(() => parseProject(JSON.stringify({ formatVersion: 2, images: [{ path: 'sheets/a.png' }] }))).toThrow(/no tile size/)
    const terse = parseProject(JSON.stringify({ formatVersion: 2, images: [{ path: 'sheets/mz/Outside_A2.png', grid: { tile: 48, margin: 2, spacing: { x: 1, y: 0 } } }] }))
    expect(terse.images[0]).toEqual({ path: 'sheets/mz/Outside_A2.png', name: 'Outside_A2', kind: 'tileset', hash: null, grid: { tile: 48, margin: { x: 2, y: 2 }, spacing: { x: 1, y: 0 } }, layout: null, terrain: { terrains: [], tiles: {} } })
  })

  it('checks a terrain set as the image carries it: unique ids, four tags a tile, tags that name a terrain the image has', () => {
    const image = (terrain: unknown) => JSON.stringify({ formatVersion: 2, images: [{ path: 'sheets/a.png', grid: { tile: 16 }, terrain }] })
    expect(() => parseProject(image({ terrains: [{ id: 'g' }, { id: 'g' }] }))).toThrow(/lists the terrain g twice/)
    expect(() => parseProject(image({ terrains: [{ id: 'g' }], tiles: { 0: ['g', null, null] } }))).toThrow(/four corner tags/)
    expect(() => parseProject(image({ terrains: [{ id: 'g' }], tiles: { 0: ['g', 'x', null, null] } }))).toThrow(/names a terrain the image does not have/)
    expect(() => parseProject(image({ terrains: [{ id: 'g' }], tiles: { '-1': ['g', 'g', 'g', 'g'] } }))).toThrow(/not a tile index/)
    const ok = parseProject(image({ terrains: [{ id: 'g' }], tiles: { 5: ['g', null, null, null], 0: [null, null, null, null] } }))
    expect(ok.images[0].terrain).toEqual({ terrains: [{ id: 'g', name: 'g', color: '#808080' }], tiles: { 5: ['g', null, null, null], 0: [null, null, null, null] } })
  })
})
