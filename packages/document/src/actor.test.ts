import { describe, expect, it } from 'vitest'
import { createActor, initialTransition, transition } from 'xstate'

import { createDocumentActorLogic, documentLogic } from './actor'
import { cellIndex, createMap, type MapDoc, type ReadonlyMapDoc } from './document'
import { structureOf, type ReadonlyVoxel, type VoxelStructure } from './structure'
import { inversePatch, type Patch } from './edits'
import { columnPatches, raise } from './ops'
import { createDocumentStore, EditorStore, type DocumentReader, type DocumentWriter } from './store'
import { columnHeights, topHeight } from './voxels'

/**
 * A writer that only counts. The guard tests below are about how many times
 * the actor reaches for the write handle, which a real store hides — a raise
 * applied twice through `pruneNoops` still moves the cell, just twice as far.
 * Counting the calls is the direct measurement; the real-store tests further
 * down are the same claim seen through `reader`.
 */
function countingWriter(): { writer: DocumentWriter; reader: DocumentReader; calls: Record<keyof DocumentWriter, number> } {
  const calls = { apply: 0, applyStrokeTick: 0, beginStroke: 0, endStroke: 0, undo: 0, redo: 0, replace: 0 }
  const writer: DocumentWriter = {
    apply: () => void (calls.apply += 1),
    applyStrokeTick: () => void (calls.applyStrokeTick += 1),
    beginStroke: () => void (calls.beginStroke += 1),
    endStroke: () => void (calls.endStroke += 1),
    undo: () => void (calls.undo += 1),
    redo: () => void (calls.redo += 1),
    replace: () => void (calls.replace += 1),
  }
  // The actor takes a reader too, for the commands that carry a request
  // rather than patches. These tests only send the raw verbs, so an empty
  // document is enough.
  const { reader } = createDocumentStore(createMap(4, 4))
  return { writer, reader, calls }
}

const ground = (doc: MapDoc | ReadonlyMapDoc): VoxelStructure => doc.structures.ground as VoxelStructure
// Never applied to a real store: the counting writer only counts, so the id and the voxel are nominal.
const onePatch = (index: number) => [{ t: 'voxel' as const, id: 'g', field: 'shape' as const, index, value: 5 }]

/**
 * The standing guard #22 asked for. On xstate 6.0.0-alpha.53 a transition
 * body runs twice when it touches `enq` (once as its own guard with a stub,
 * once for real), and runs even when it returns `undefined` — so a write
 * placed inline instead of inside `enq(() => …)` lands twice, or lands on a
 * path that was never taken. The first three are red under exactly those
 * edits to `actor.ts`; that is their job, and they must stay. The fourth catches
 * the one shape the counts cannot: an inline write in a body with no `enq`
 * call at all, which v6 runs once, so the count is right for the wrong reason.
 */
describe('document actor: every write goes through enq (#22)', () => {
  it('applies N patch events exactly N times, not 2N', () => {
    const { writer, reader, calls } = countingWriter()
    const actor = createActor(documentLogic(writer, reader)).start()

    const N = 7
    for (let i = 0; i < N; i++) actor.send({ type: 'patch', label: 'Raise', patches: onePatch(i) })

    expect(calls.apply).toBe(N)
  })

  it('applies N strokePatch events exactly N times, not 2N, and refuses the empty one', () => {
    const { writer, reader, calls } = countingWriter()
    const actor = createActor(documentLogic(writer, reader)).start()

    const N = 7
    for (let i = 0; i < N; i++) actor.send({ type: 'strokePatch', patches: onePatch(i) })
    actor.send({ type: 'strokePatch', patches: [] })

    expect(calls.applyStrokeTick).toBe(N)
    // A stroke tick never reaches the always-recording verb.
    expect(calls.apply).toBe(0)
  })

  it('applies nothing on the path the transition refuses', () => {
    const { writer, reader, calls } = countingWriter()
    const actor = createActor(documentLogic(writer, reader)).start()

    // An empty patch list is the "not enabled" branch: the body returns
    // `undefined` before it touches `enq`. An inline write above that return
    // would still fire, which is the third failure mode.
    actor.send({ type: 'patch', label: 'Nothing', patches: [] })

    expect(calls.apply).toBe(0)
    expect(actor.getSnapshot().status).toBe('active')
  })

  it('writes nothing when a transition is computed but not executed', () => {
    // The shape the two tests above cannot see: an inline write in a body
    // that never touches `enq` at all runs once on v6 (the body is reusable),
    // so the count comes out right by accident. xstate's pure `transition`
    // runs the body to compute the next snapshot and RETURNS the effects
    // instead of executing them — an `enq`'d write appears in that list and
    // does not happen; an inline one happens here, with nothing executed.
    const { writer, reader, calls } = countingWriter()
    const logic = documentLogic(writer, reader)
    const [initial] = initialTransition(logic)

    const [, actions] = transition(logic, initial, { type: 'patch', label: 'Raise', patches: onePatch(0) })

    expect(calls.apply).toBe(0)
    expect(actions.length).toBeGreaterThan(0)
  })

  it('routes each verb to exactly one call on the writer, and only that one', () => {
    const { writer, reader, calls } = countingWriter()
    const actor = createActor(documentLogic(writer, reader)).start()

    actor.send({ type: 'beginStroke', label: 'Stroke' })
    actor.send({ type: 'endStroke', patches: [], inverse: [] })
    actor.send({ type: 'undo' })
    actor.send({ type: 'redo' })

    expect(calls).toEqual({ apply: 0, applyStrokeTick: 0, beginStroke: 1, endStroke: 1, undo: 1, redo: 1, replace: 0 })
  })
})

describe('document actor over a real store', () => {
  it('moves a cell by exactly the sum of the patches it was sent', () => {
    const store = new EditorStore(createMap(8, 8))
    const actor = createActor(createDocumentActorLogic(store)).start()
    const before = topHeight(ground(store.reader.doc), 2, 2)

    for (let i = 0; i < 3; i++) {
      actor.send({ type: 'patch', label: 'Raise', patches: raise(store.reader.doc, ground(store.reader.doc), [[2, 2]], 1) })
    }

    // +3, not +6: the same claim as the counting test, seen through `reader`.
    expect(topHeight(ground(store.reader.doc), 2, 2)).toBe(before + 3)
  })

  it('closes one Edit per stroke — the record it is handed — so one undo unwinds every tick', () => {
    const store = new EditorStore(createMap(8, 8))
    const actor = createActor(createDocumentActorLogic(store)).start()
    const doc = store.reader.doc
    const before = columnHeights(ground(doc))

    // The record is the sender's: inverses read before each patch lands, as
    // the stroke actor in `editor-host` does per tick (#11).
    const patches: Patch[] = []
    const inverse: Patch[] = []
    actor.send({ type: 'beginStroke', label: 'Raise' })
    for (let i = 0; i < 5; i++) {
      const tick = raise(doc, ground(doc), [[i, 0]], 1)
      patches.push(...tick)
      inverse.push(...tick.map((patch) => inversePatch(doc, patch)))
      actor.send({ type: 'strokePatch', patches: tick })
      // Applied on arrival: the drag is visible before it is an undo entry.
      expect(topHeight(ground(doc), i, 0)).toBe(before[cellIndex(ground(doc).size, i, 0)] + 1)
      expect(store.reader.canUndo()).toBe(false)
    }
    actor.send({ type: 'endStroke', patches, inverse })
    expect(store.reader.canUndo()).toBe(true)
    expect(store.reader.undoLabel()).toBe('Raise')

    actor.send({ type: 'undo' })
    expect(columnHeights(ground(doc))).toEqual(before)
    expect(store.reader.canUndo()).toBe(false)
    expect(store.reader.canRedo()).toBe(true)

    actor.send({ type: 'redo' })
    for (let i = 0; i < 5; i++) expect(topHeight(ground(doc), i, 0)).toBe(before[cellIndex(ground(doc).size, i, 0)] + 1)
  })
})

describe('the read and write paths', () => {
  it('hands out a reader and a writer over one document', () => {
    const { reader, writer } = createDocumentStore(createMap(4, 4))
    const revision = reader.revision
    let notified = 0
    reader.subscribe(() => void (notified += 1))

    writer.apply('Raise', columnPatches(ground(reader.doc), 0, 0, 9))

    expect(topHeight(ground(reader.doc), 0, 0)).toBe(9)
    expect(reader.revision).toBe(revision + 1)
    expect(reader.getSnapshot()).toBe(reader.revision)
    expect(notified).toBe(1)
  })

  it('reads the new document after replace, through the same reader', () => {
    const { reader, writer } = createDocumentStore(createMap(4, 4, 'First'))
    writer.replace(createMap(6, 6, 'Second'))
    expect(reader.doc.name).toBe('Second')
    expect(ground(reader.doc).size.width).toBe(6)
    expect(reader.canUndo()).toBe(false)
  })

  it('announces a replace as a generation, which an edit does not move', () => {
    // `revision` says "something changed", the dirty set says "remesh these
    // keys"; neither says "the object you cached is a different document".
    // A consumer that holds `doc` by reference — the runtime scene does —
    // needs the third fact, and it belongs beside the other two on the read
    // path rather than beside one caller's dispatch site.
    const { reader, writer } = createDocumentStore(createMap(4, 4, 'First'))
    expect(reader.generation).toBe(0)

    writer.apply('Raise', columnPatches(ground(reader.doc), 0, 0, 3))
    expect(reader.revision).toBeGreaterThan(0)
    expect(reader.generation).toBe(0)

    writer.replace(createMap(6, 6, 'Second'))
    expect(reader.generation).toBe(1)
    writer.replace(createMap(8, 8, 'Third'))
    expect(reader.generation).toBe(2)
  })

  it('rejects all four write shapes at the type level and leaves reads alone', () => {
    // Each directive below is checked by the package's `tsc` run: if the
    // deep-readonly type ever stopped rejecting one of these, the directive
    // would be reported as unused and typecheck would fail. The runtime
    // assignments land on a throwaway document — the type is the guard, not
    // `Object.freeze`, so what this proves is what the compiler refuses.
    const doc: ReadonlyMapDoc = createMap(2, 2)
    const g = structureOf(doc, 'ground', 'voxel') as ReadonlyVoxel
    // @ts-expect-error indexed assignment
    g.voxels.shape[0] = 1
    // @ts-expect-error record assignment
    g.paint.faces['0,0,0,4'] = ['m:1', null, null, null]
    // @ts-expect-error array mutation
    doc.objectOrder.push('x')
    // @ts-expect-error property replacement
    doc.name = 'x'

    expect(ground(doc).size.width).toBe(2)
    expect(cellIndex(ground(doc).size, 1, 1)).toBe(3)
  })
})
