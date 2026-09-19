import { describe, expect, it } from 'vitest'

import { applyPatches, History, inversePatch, patchAddress, type Patch, type StrokeRecord } from './edits'
import { createMap, defaultFacing, layersOf, NO_RAMP, SHAPE_BLOCK, SHAPE_SLAB, type MapDoc, type MapObject, type ReadonlyMapDoc } from './document'
import { childrenOf, descendantsOf, outlineOf, type VoxelStructure } from './structure'
import { deserialize, LoadError, serialize } from './io'
import { PROJECT_FORMAT_VERSION, createProject, parseProject, serializeProject, sheetName, stemOf, tagOf } from './project'
import { addObject, addSketchPoint, addStructure, brushCells, clearRampRun, closeSketch, columnPatches, createSketch, deleteSketchPoint, fillCells, flatten, paintFace, pasteTiles, placeStructureOnto, raise, rampPlan, rampRun, rampRunBlocked, rampRunLength, removeObject, stampFaces, removeStructure, reparentStructure, setEdges, setMaterial, setSketch, updateObject } from './ops'
import { FACE_TOP, faceKey } from './paint'
import { EditorStore } from './store'
import { cornerHeights, frameOf, groundHeight, structureAt } from './terrain'
import { columnHeights, columnTopAt, exposedFacesOf, fillColumn, halfRampShape, halfRampUpShape, rampDirAt, rampShape, settleFaces, topHeight, topLayersAt, voxelIndex } from './voxels'

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
    fillColumn(ground(doc), 0, 0, 2, { material: 1 })
    const key = faceKey(0, 0, 0, FACE_TOP)

    const inverse = applyPatches(doc, [
      { t: 'voxelPaint', id: ground(doc).id, layer: 'faces', key, value: layersOf(2) },
      { t: 'voxelPaint', id: ground(doc).id, layer: 'faces', key, value: layersOf(3) },
    ])
    expect(topLayersAt(ground(doc), 0, 0)).toEqual(layersOf(3))

    applyPatches(doc, inverse)
    expect(topLayersAt(ground(doc), 0, 0)).toEqual(layersOf(1))
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
    expect(patchAddress({ t: 'voxel', id: 'g', field: 'shape', index: 7, value: 1 })).toBe(patchAddress({ t: 'voxel', id: 'g', field: 'shape', index: 7, value: 9 }))
    expect(patchAddress({ t: 'voxel', id: 'g', field: 'shape', index: 7, value: 1 })).not.toBe(patchAddress({ t: 'voxel', id: 'g', field: 'water', index: 7, value: 1 }))
    expect(patchAddress({ t: 'voxelPaint', id: 'g', layer: 'faces', key: '1,2', value: layersOf(3) })).not.toBe(patchAddress({ t: 'voxelPaint', id: 'g', layer: 'tint', key: '1,2', value: 3 }))
    expect(patchAddress({ t: 'object', id: 'a', value: undefined })).toBe('object:a')
    expect(patchAddress({ t: 'doc', field: 'camera', value: null })).toBe('doc:camera')
  })

  it('reads the before-value the applier would have returned, without writing', () => {
    const doc = createMap(4, 4)
    // A three-block column: its top voxel sits in layer 2.
    fillColumn(ground(doc), 1, 1, 6, { material: 4 })
    const patch: Patch = { t: 'voxel', id: ground(doc).id, field: 'shape', index: voxelIndex(ground(doc), 1, 1, 2), value: SHAPE_SLAB }
    const before = inversePatch(doc, patch)
    expect(before).toEqual({ ...patch, value: SHAPE_BLOCK })
    // Same answer as the applier, which is what makes the two paths agree.
    expect(applyPatches(doc, [patch])).toEqual([before])
    // A face's layers come back as they were, and a copy: the next forward write must not edit the inverse too.
    const face = faceKey(1, 1, 2, FACE_TOP)
    const inverse = inversePatch(doc, { t: 'voxelPaint', id: ground(doc).id, layer: 'faces', key: face, value: layersOf(1) })
    expect(inverse).toEqual({ t: 'voxelPaint', id: ground(doc).id, layer: 'faces', key: face, value: layersOf(4) })
    expect(inverse.t === 'voxelPaint' && inverse.value).not.toBe(ground(doc).paint.faces[face])
    const bare = faceKey(1, 1, 5, FACE_TOP)
    expect(inversePatch(doc, { t: 'voxelPaint', id: ground(doc).id, layer: 'faces', key: bare, value: layersOf(1) })).toEqual({ t: 'voxelPaint', id: ground(doc).id, layer: 'faces', key: bare, value: undefined })
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

/** Every face of the volume that draws, as keys: what the paint record should hold exactly. */
function drawnFaces(voxel: VoxelStructure): string[] {
  const out: string[] = []
  for (let z = 0; z < voxel.size.height; z++) for (let x = 0; x < voxel.size.width; x++) out.push(...exposedFacesOf(voxel, x, z))
  return out.sort()
}

describe('a stack moves with the surface (no dormant paint)', () => {
  it('leaves exactly the faces that draw painted after every sculpt op, and undoes to the paint it started with', () => {
    const doc = createMap(8, 8)
    // A cliff at (1,1) for the ramp to be cut from, and a ramp at (3,3) to clear.
    setHeight(doc, 1, 1, 4)
    fillColumn(ground(doc), 3, 3, 4, { material: 0, shape: rampShape(0) })
    settleFaces(ground(doc))
    expect(Object.keys(ground(doc).paint.faces).sort()).toEqual(drawnFaces(ground(doc)))
    const start: unknown = JSON.parse(JSON.stringify(ground(doc).paint.faces))
    // Cut west, toward (0,1) at one cube, once (1,1) stands two.
    const edge = { x: 1, z: 1, dir: 2 }
    const steps = [
      () => raise(doc, ground(doc), [[1, 1], [2, 1]], 3),
      () => flatten(doc, ground(doc), [[1, 1]], 0),
      () => raise(doc, ground(doc), [[1, 1]], 4),
      () => rampRun(doc, ground(doc), edge, rampRunLength(ground(doc), edge) ?? 0),
      () => clearRampRun(doc, ground(doc), 3, 3),
    ]
    const inverses: Patch[][] = []
    for (const step of steps) {
      const patches = step()
      expect(patches.length).toBeGreaterThan(0)
      inverses.push(applyPatches(doc, patches))
      expect(Object.keys(ground(doc).paint.faces).sort()).toEqual(drawnFaces(ground(doc)))
    }
    for (const inverse of inverses.reverse()) applyPatches(doc, inverse)
    expect(ground(doc).paint.faces).toEqual(start)
  })

  it("gives a raised top its old top's stack, and a new cliff the stack of the face below it", () => {
    const doc = createMap(6, 6)
    const g = ground(doc)
    // A two-cube column whose top holds two layers and whose east side at the bottom is stone.
    fillColumn(g, 2, 2, 4, { material: 3, sides: 1 })
    settleFaces(g)
    g.paint.faces[faceKey(2, 2, 1, FACE_TOP)] = ['m:3', 'm:4', null, null]
    g.paint.faces[faceKey(2, 2, 1, 0)] = layersOf(2)

    applyPatches(doc, raise(doc, g, [[2, 2]], 4))
    expect(g.paint.faces[faceKey(2, 2, 1, FACE_TOP)]).toBeUndefined()
    expect(g.paint.faces[faceKey(2, 2, 3, FACE_TOP)]).toEqual(['m:3', 'm:4', null, null])
    // The new east face two layers up copies up from the one below it, stone all the way.
    expect(g.paint.faces[faceKey(2, 2, 2, 0)]).toEqual(layersOf(2))
    expect(g.paint.faces[faceKey(2, 2, 3, 0)]).toEqual(layersOf(2))
    // The other sides carry their own.
    expect(g.paint.faces[faceKey(2, 2, 3, 2)]).toEqual(layersOf(1))
  })

  it('keeps an emptied column painted: its floor takes the old top, and the sides it uncovers take theirs', () => {
    const doc = createMap(6, 6)
    const g = ground(doc)
    for (let z = 0; z < 6; z++) for (let x = 0; x < 6; x++) fillColumn(g, x, z, 4, { material: 3, sides: 1 })
    settleFaces(g)
    applyPatches(doc, flatten(doc, g, [[2, 2]], 0))
    expect(columnTopAt(g, 2, 2)).toBe(-1)
    expect(g.paint.faces[faceKey(2, 2, -1, FACE_TOP)]).toEqual(layersOf(3))
    // (3,2)'s west side, now a wall over the hole: no side of it was painted, so it takes its column's top.
    expect(g.paint.faces[faceKey(3, 2, 0, 2)]).toEqual(layersOf(3))
    expect(Object.keys(g.paint.faces).sort()).toEqual(drawnFaces(g))
  })

  it('takes an edge switch off with its wall, and refuses one where no wall stands', () => {
    const doc = createMap(6, 6)
    const g = ground(doc)
    setHeight(doc, 2, 2, 6)
    settleFaces(g)
    // Flat ground has no wall to switch.
    expect(setEdges(g, [{ x: 0, z: 0, dir: 0, end: 'top' }], false)).toEqual([])
    applyPatches(doc, setEdges(g, [{ x: 2, z: 2, dir: 0, end: 'top' }, { x: 2, z: 2, dir: 1, end: 'foot' }], false))
    expect(g.paint.edges).toEqual({ '2,2,0,top': 'off', '2,2,1,foot': 'off' })
    // Already off: nothing to write.
    expect(setEdges(g, [{ x: 2, z: 2, dir: 0, end: 'top' }], false)).toEqual([])
    // Lowered level with its neighbours, the walls go, and their switches with them; undo brings both back.
    const undo = applyPatches(doc, flatten(doc, g, [[2, 2]], 2))
    expect(g.paint.edges).toEqual({})
    applyPatches(doc, undo)
    expect(g.paint.edges).toEqual({ '2,2,0,top': 'off', '2,2,1,foot': 'off' })
    // A wall that stays, at a new height, keeps its switch.
    applyPatches(doc, raise(doc, g, [[2, 2]], 2))
    expect(g.paint.edges['2,2,0,top']).toBe('off')
  })

  it("paints one material layer of a face and leaves the others", () => {
    const doc = createMap(4, 4)
    const g = ground(doc)
    applyPatches(doc, setMaterial(g, [[1, 1]], 2, 2))
    expect(topLayersAt(g, 1, 1)).toEqual(['m:0', null, 'm:2', null])
    applyPatches(doc, setMaterial(g, [[1, 1]], null))
    expect(topLayersAt(g, 1, 1)).toEqual([null, null, 'm:2', null])
    // A face with no stack yet gets one.
    applyPatches(doc, paintFace(g, [{ x: 1, z: 1, y: 3, dir: 0 }], 1, 3))
    expect(g.paint.faces[faceKey(1, 1, 3, 0)]).toEqual([null, null, null, 'm:1'])
    // Painting what is already there is no patch at all.
    expect(setMaterial(g, [[1, 1]], 2, 2)).toEqual([])
  })
})

describe('terrain queries', () => {
  it('interpolates a ramp instead of stepping it', () => {
    const doc = createMap(4, 4)
    // A two-cube column whose top voxel is a ramp descending east.
    fillColumn(ground(doc), 1, 1, 4, { material: 0, shape: rampShape(0) })

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
    fillColumn(ground(doc), 1, 1, 6, { material: 0, shape: rampShape(1) })
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
    // The top face of the column's top voxel, drawn with material 4 (path).
    const top = columnTopAt(ground(store.reader.doc), 1, 1)
    store.apply('Paint', paintFace(ground(store.reader.doc), [{ x: 1, z: 1, y: top, dir: FACE_TOP }], 4))

    const restored = deserialize(serialize(store.reader.doc))
    expect(restored.name).toBe('Test Map')
    expect(ground(restored).voxels).toEqual(ground(store.reader.doc).voxels)
    expect(columnHeights(ground(restored))).toEqual(columnHeights(ground(store.reader.doc)))
    expect(ground(restored).paint.faces).toEqual(ground(store.reader.doc).paint.faces)
    expect(ground(restored).paint.faces[faceKey(1, 1, top, FACE_TOP)]).toEqual(layersOf(4))
    expect(restored.formatVersion).toBe(5)
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
    raw.structures[ground(doc).id].voxels.shape = [1, 2, 3]
    expect(() => deserialize(JSON.stringify(raw))).toThrow(LoadError)
    expect(() => deserialize(JSON.stringify(raw))).toThrow(new RegExp(`should hold ${16 * layers} entries`))
  })

  it('rejects a water array of the wrong length', () => {
    const doc = createMap(4, 4)
    const raw = parseOnDisk(doc)
    raw.structures[ground(doc).id].water = [1, 2, 3]
    expect(() => deserialize(JSON.stringify(raw))).toThrow(/should hold 16 entries/)
  })

  it('round-trips an edge switched off, and refuses one it cannot read', () => {
    const doc = createMap(4, 4)
    ground(doc).paint.edges['1,1,2,foot'] = 'off'
    expect(ground(deserialize(serialize(doc))).paint.edges).toEqual({ '1,1,2,foot': 'off' })
    const raw = parseOnDisk(doc)
    raw.structures[ground(doc).id].paint.edges['1,1,2,side'] = 'off'
    expect(() => deserialize(JSON.stringify(raw))).toThrow(/not an edge switched off/)
    // A file written before edges existed reads with none.
    delete raw.structures[ground(doc).id].paint.edges
    expect(ground(deserialize(JSON.stringify(raw))).paint.edges).toEqual({})
  })

  it('refuses a face that is not four material layers, or a key that names no face', () => {
    const doc = createMap(4, 4)
    const raw = parseOnDisk(doc)
    raw.structures[ground(doc).id].paint.faces[faceKey(1, 1, 0, FACE_TOP)] = 5
    expect(() => deserialize(JSON.stringify(raw))).toThrow(/should be 4 material layers/)
    raw.structures[ground(doc).id].paint.faces[faceKey(1, 1, 0, FACE_TOP)] = ['t:12', null, null, null]
    expect(() => deserialize(JSON.stringify(raw))).toThrow(/should be 4 material layers/)
    raw.structures[ground(doc).id].paint.faces[faceKey(1, 1, 0, FACE_TOP)] = ['m:1', null, null, 'm:2']
    raw.structures[ground(doc).id].paint.faces['1,1'] = layersOf(1)
    expect(() => deserialize(JSON.stringify(raw))).toThrow(/does not name a face/)
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
  const raw = () => JSON.parse(serialize(createMap(2, 2))) as { structures: Record<string, { voxels: { shape: number[] }; layers: number }> }

  it('refuses a voxel whose shape is not one', () => {
    const air = raw()
    air.structures.ground.voxels.shape[0] = -5
    expect(() => deserialize(JSON.stringify(air))).toThrow(/shape\[0\] is -5/)
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
    const project = createProject('Harbour Town', 32, { tiles: { 3: ['0', '0', null, null] } })
    expect(project.resolution).toEqual({ texelDensity: 32, filtering: 'nearest' })
    expect(project.images).toEqual([{ id: 1, path: 'sheets/ground.png', name: 'Ground', kind: 'tileset', hash: null, grid: { tile: 32, margin: { x: 0, y: 0 }, spacing: { x: 0, y: 0 } }, layout: null, terrain: { tiles: { 3: ['0', '0', null, null] } } }])
    expect(project.maps).toEqual([])
    expect(parseProject(serializeProject(project))).toEqual(project)
    expect(sheetName('sheets/ground.png')).toBe('ground.png')
    expect(stemOf('sheets/mz/Outside_A2.png')).toBe('Outside_A2')
  })

  it('refuses another format, an empty material list, a shared id and a path outside the folder', () => {
    const version = raw()
    version.formatVersion = 1
    expect(() => parseProject(JSON.stringify(version))).toThrow(/format 1/)
    // An empty library is allowed (ruling of 2026-09-19); a missing one gets the defaults.
    const bare = raw()
    bare.materials = []
    expect(parseProject(JSON.stringify(bare)).materials).toEqual([])
    const shared = raw()
    shared.materials = [{ id: 1, name: 'A' }, { id: 1, name: 'B' }]
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
    const sparse = parseProject(JSON.stringify({ formatVersion: PROJECT_FORMAT_VERSION, name: 'Sparse' }))
    expect(sparse.resolution).toEqual({ texelDensity: 16, filtering: 'nearest' })
    expect(sparse.materials.length).toBeGreaterThan(0)
    expect(sparse.images).toEqual([])
    expect(sparse.maps).toEqual([])
    expect(() => parseProject(JSON.stringify({ formatVersion: PROJECT_FORMAT_VERSION, images: [{ path: 'sheets/a.png' }] }))).toThrow(/no tile size/)
    const terse = parseProject(JSON.stringify({ formatVersion: PROJECT_FORMAT_VERSION, images: [{ path: 'sheets/mz/Outside_A2.png', grid: { tile: 48, margin: 2, spacing: { x: 1, y: 0 } } }] }))
    expect(terse.images[0]).toEqual({ id: 1, path: 'sheets/mz/Outside_A2.png', name: 'Outside_A2', kind: 'tileset', hash: null, grid: { tile: 48, margin: { x: 2, y: 2 }, spacing: { x: 1, y: 0 } }, layout: null, terrain: { tiles: {} } })
  })

  it('checks the tags as the image carries them: four a tile, each naming a material, on a real tile index', () => {
    const image = (terrain: unknown) => JSON.stringify({ formatVersion: PROJECT_FORMAT_VERSION, materials: [{ id: 0, name: 'Grass' }], images: [{ path: 'sheets/a.png', grid: { tile: 16 }, terrain }] })
    const g = tagOf(0)
    expect(() => parseProject(image({ tiles: { 0: [g, null, null] } }))).toThrow(/four corner tags/)
    expect(() => parseProject(image({ tiles: { 0: [g, 'grass', null, null] } }))).toThrow(/names no material/)
    expect(() => parseProject(image({ tiles: { '-1': [g, g, g, g] } }))).toThrow(/not a tile index/)
    const ok = parseProject(image({ tiles: { 5: [g, null, null, null], 0: [null, null, null, null] } }))
    expect(ok.images[0].terrain).toEqual({ tiles: { 5: [g, null, null, null], 0: [null, null, null, null] } })
    // A slot rides on the tag, and the material it names is what has to exist.
    expect(parseProject(image({ tiles: { 1: [tagOf(0, 'convex'), null, null, null] } })).images[0].terrain.tiles['1']).toEqual([tagOf(0, 'convex'), null, null, null])
  })

  it('refuses a tag, a layout or a side naming a material the project does not have', () => {
    // A tag names a material of the project (ruling of 2026-09-17), so an id nothing defines would send the
    // atlas looking for art that cannot exist, silently, one corner at a time. The file is refused by name instead.
    const project = (materials: unknown[], image: Record<string, unknown>) => JSON.stringify({ formatVersion: PROJECT_FORMAT_VERSION, materials, images: [{ path: 'sheets/a.png', grid: { tile: 16 }, ...image }] })
    expect(() => parseProject(project([{ id: 0, name: 'Grass' }], { terrain: { tiles: { 0: [tagOf(7), null, null, null] } } }))).toThrow(/tagged with material 7, which the project does not have/)
    expect(() => parseProject(project([{ id: 0, name: 'Grass' }], { layout: { convention: 'corner-blocks', materials: [0, 7] } }))).toThrow(/lays out material 7/)
    // A material's trim settings are read when in range, and dropped, to their defaults, when not.
    const trimmed = parseProject(project([{ id: 0, name: 'Grass', fringeAngle: 30, picketDistance: 2 }, { id: 1, name: 'Dirt', fringeAngle: 200, picketDistance: -1 }], {}))
    expect(trimmed.materials[0]).toMatchObject({ fringeAngle: 30, picketDistance: 2 })
    expect(trimmed.materials[1]).not.toHaveProperty('fringeAngle')
    expect(trimmed.materials[1]).not.toHaveProperty('picketDistance')
    // Sprites are named regions of listed images; one cut from an unlisted image, or without whole tiles, refuses the file.
    const withSprites = (sprites: unknown) => {
      const raw = JSON.parse(project([{ id: 0, name: 'Grass' }], {})) as Record<string, unknown>
      raw.sprites = sprites
      return JSON.stringify(raw)
    }
    const listed = (JSON.parse(project([{ id: 0, name: 'Grass' }], {})) as { images: { path: string }[] }).images[0].path
    // A sprite names its image by id; one written before ids named it by path, and is read as that image's id.
    expect(parseProject(withSprites([{ name: 'tree', image: 1, rect: { x: 0, y: 1, w: 2, h: 3 } }])).sprites).toEqual([{ name: 'tree', image: 1, rect: { x: 0, y: 1, w: 2, h: 3 } }])
    expect(parseProject(withSprites([{ name: 'tree', image: listed, rect: { x: 0, y: 1, w: 2, h: 3 } }])).sprites[0].image).toBe(1)
    expect(() => parseProject(withSprites([{ name: 'tree', image: 2, rect: { x: 0, y: 0, w: 1, h: 1 } }]))).toThrow(/does not list/)
    expect(() => parseProject(withSprites([{ name: 'tree', image: 'sheets/nope.png', rect: { x: 0, y: 0, w: 1, h: 1 } }]))).toThrow(/does not list/)
    expect(() => parseProject(withSprites([{ name: 'tree', image: listed, rect: { x: 0, y: 0, w: 0, h: 1 } }]))).toThrow(/whole tiles/)
    // A material has no `side` any more (ruling of 2026-09-18): one a file still carries is not read.
    const ok = parseProject(project([{ id: 0, name: 'Grass', side: 7 }, { id: 7, name: 'Dirt' }], { terrain: { tiles: { 0: [tagOf(7), null, null, null] } } }))
    expect(ok.materials[0]).not.toHaveProperty('side')
  })
})

describe('a stamp of tiles pasted on faces', () => {
  it('lays a floor stamp north up over each column\'s own top, and a wall stamp left to right and down its courses', () => {
    const doc = createMap(6, 6)
    const g = doc.structures.ground as VoxelStructure
    fillColumn(g, 2, 2, 6)
    fillColumn(g, 3, 2, 6)
    // A top: across is +x, down +z, each face at its own column's top.
    expect(stampFaces(g, { x: 2, z: 1, y: 0, dir: FACE_TOP }, 2, 2)).toEqual([
      [{ x: 2, z: 1, y: 0, dir: FACE_TOP }, { x: 3, z: 1, y: 0, dir: FACE_TOP }],
      [{ x: 2, z: 2, y: 2, dir: FACE_TOP }, { x: 3, z: 2, y: 2, dir: FACE_TOP }],
    ])
    // The south side (dir 1, facing +z) seen from outside runs +x; a course down is a layer down; past the wall is nothing.
    expect(stampFaces(g, { x: 2, z: 2, y: 2, dir: 1 }, 3, 1)).toEqual([[{ x: 2, z: 2, y: 2, dir: 1 }, { x: 3, z: 2, y: 2, dir: 1 }, null]])
    // The west side (dir 2, facing -x) runs +z seen from outside, and the stamp's second row is the course below.
    expect(stampFaces(g, { x: 2, z: 2, y: 2, dir: 2 }, 1, 2)).toEqual([[{ x: 2, z: 2, y: 2, dir: 2 }], [{ x: 2, z: 2, y: 1, dir: 2 }]])
    // Pasting writes one slot of each face it lands on, and clears it again with null.
    const patches = pasteTiles(g, { x: 2, z: 2, y: 2, dir: 1 }, 4, [[10, 11]], 1)
    expect(patches.map((p) => (p as { key: string; value: unknown[] }).value[1])).toEqual(['t:4:10', 't:4:11'])
    expect(pasteTiles(g, { x: 2, z: 2, y: 2, dir: 1 }, 4, [[null]], 1)).toEqual([])
  })
})
