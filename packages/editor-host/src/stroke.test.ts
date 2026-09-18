import {
  AIR,
  SHAPE_SLAB,
  brushCells,
  cellIndex,
  columnHeights,
  createDocument,
  createMap,
  fillColumn,
  patchAddress,
  raise,
  topHeight,
  voxelIndex,
  type Patch,
  type SurfaceAddress,
  type MapDoc,
  type ReadonlyMapDoc,
  type VoxelStructure,
} from '@papercut/document'
import type { ToolContract } from '@papercut/registry'
import { describe, expect, it } from 'vitest'
import { createActor, type InspectionEvent } from 'xstate'

import { strokeLogic, type DocumentRef } from './stroke'
import { createStrokeHandler, type StrokeDeps, type StrokeSample, type ToolsSnapshot } from './strokes'

/** The root voxel volume a fresh level has, mutable for setup: `createMap` names it `ground`. */
const ground = (doc: ReadonlyMapDoc | MapDoc): VoxelStructure => doc.structures.ground as VoxelStructure


/**
 * The stroke actor's two invariants (#11), each asserted through `reader` and
 * the events the document actor received: patches APPLY on every tick, and
 * ONE `Edit` lands on release with one patch per address touched. The second
 * is the regression test `docs/stack.md` asked for — committed patch count
 * equals unique addresses — against the measured 3,780-over-260 baseline.
 *
 * The handler under the actor is a STUB contract declared here, not the
 * terrain tool's: this package holds no terrain verbs any more (`strokes.ts`
 * routes the `terrain` tool at whatever `deps.contract` answers with), and
 * #35 forbids importing the feature that does. What matters to the actor is
 * only that a handler answers with patches per phase, which is exactly what
 * the stub is — and the routing itself is pinned below, while the real verbs
 * are pinned in `feature-terrain` and end to end in `apps/editor`.
 */

/** The terrain feature's slice as this package sees it: opaque, except the brush the stub contract reads. */
const BRUSH = { size: 3, shape: 'square' as const }
const SCULPT: ToolsSnapshot = { tool: 'terrain', spriteName: 'tree', snap: 'grid', features: { terrain: { brush: BRUSH } } }
const brushOf = (tools: ToolsSnapshot) => (tools.features.terrain as { brush: { size: number; shape: 'square' | 'circle' } }).brush
/** The same snapshot with a one-cell brush. */
const withBrush = (size: number): ToolsSnapshot => ({ ...SCULPT, features: { terrain: { brush: { size, shape: 'square' } } } })

function top(x: number, y: number): SurfaceAddress {
  return { structure: 'ground', kind: 0, x, y, dir: -1, level: 0 }
}

function sample(x: number, y: number, modifiers: Partial<StrokeSample['modifiers']> = {}): StrokeSample {
  return { pick: { surface: top(x, y), point: { x: x + 0.5, z: y + 0.5 }, objectId: null }, modifiers: { shift: false, alt: false, ctrl: false, ...modifiers } }
}

/**
 * A handler that raises the brush under the pointer: the smallest thing that
 * produces one patch per cell per tick, which is what the compaction map is
 * measured against. Shift lowers, so a test can put a cell back where it
 * started; `end` answers with nothing, the way a live (non-rectangle) stroke
 * does — the release is a bracket, not a tick.
 */
function raiseContract(deps: StrokeDeps): ToolContract<StrokeSample, Patch> {
  const patches = (tick: StrokeSample): Patch[] => {
    const address = tick.pick.surface
    if (!address) return []
    const doc = deps.reader.doc
    return raise(doc, ground(doc), brushCells(ground(doc), address.x, address.y, brushOf(deps.tools())), tick.modifiers.shift ? -1 : 1)
  }
  return {
    stroke: (press) =>
      press.pick.surface
        ? { label: 'Raise', begin: patches, move: patches, end: () => [] }
        : undefined,
  }
}

/** The voxel arrays as they stand, copied, so a stroke's net effect can be judged against them. */
function snapshot(voxel: VoxelStructure): { shape: number[]; water: number[]; faces: Record<string, unknown> } {
  return { shape: voxel.voxels.shape.slice(), water: voxel.water.slice(), faces: JSON.parse(JSON.stringify(voxel.paint.faces)) as Record<string, unknown> }
}

/**
 * The addresses an Edit should hold once a stroke's ticks are compacted: each
 * one the last tick left at a value other than the one it started with. An
 * address is one voxel's field or one face's paint, and a shape that went slab,
 * block, slab, block over four half-tiles is back where it began, so it is not
 * one of them.
 */
function changedAddresses(before: ReturnType<typeof snapshot>, sent: Patch[]): Set<string> {
  const last = new Map<string, Patch>()
  for (const patch of sent) last.set(patchAddress(patch), patch)
  const changed = new Set<string>()
  for (const [address, patch] of last) {
    if (patch.t === 'voxel' && patch.value !== before[patch.field][patch.index]) changed.add(address)
    if (patch.t === 'voxelPaint' && patch.layer === 'faces' && JSON.stringify(patch.value) !== JSON.stringify(before.faces[patch.key])) changed.add(address)
  }
  return changed
}

function rig(tools: ToolsSnapshot = SCULPT, contract: (deps: StrokeDeps) => ToolContract<StrokeSample, Patch> | undefined = raiseContract) {
  const { reader, logic } = createDocument(createMap(16, 16))
  const document = createActor(logic).start()
  // What the document actor RECEIVED, off the system's inspector: `send` is a
  // getter on v6's `Actor`, so it cannot be spied on, and this is the honest
  // record anyway — an event the actor took a transition on.
  const received: Array<{ type: string } & Record<string, unknown>> = []
  document.system.inspect((event) => {
    if (event.type === '@xstate.transition' && event.actorRef.sessionId === document.sessionId) received.push(event.event)
  })
  const deps: StrokeDeps = {
    reader,
    tools: () => tools,
    setTools: () => undefined,
    select: () => undefined,
    contract: (toolId) => (toolId === 'terrain' ? contract(deps) : undefined),
  }
  const dead: InspectionEvent[] = []
  const start = (at: StrokeSample) => {
    const handler = createStrokeHandler(deps, at, null)
    if (!handler) throw new Error('the installed tool declined the press')
    const stroke = createActor(strokeLogic(handler, reader, document as DocumentRef), {
      inspect: (event) => void (event.type === '@xstate.deadletter' && dead.push(event)),
    }).start()
    stroke.send({ type: 'begin', sample: at })
    return stroke
  }
  const patchEvents = () => received.filter((event): event is { type: 'strokePatch'; patches: Patch[] } => event.type === 'strokePatch')
  const record = () => {
    const end = received.find((event): event is { type: 'endStroke'; patches: Patch[]; inverse: Patch[] } => event.type === 'endStroke')
    if (!end) throw new Error('no endStroke was sent')
    return end
  }
  return { reader, document, deps, start, patchEvents, record, dead }
}

/**
 * The routing `strokes.ts` does, which is the whole of what this package knows
 * about the terrain tool: a press with it selected runs the contract the
 * tool's owner contributed, and there is nothing to fall back on when no
 * owner did.
 */
describe('the tool contract behind a press', () => {
  it('runs the contract for the active tool, and its label is the one the Edit gets', () => {
    const { reader, start } = rig()
    start(sample(4, 4)).send({ type: 'end', sample: sample(4, 4) })
    expect(reader.undoLabel()).toBe('Raise')
  })

  it('starts no stroke when the tool\'s feature contributed no contract', () => {
    const { deps } = rig(SCULPT, () => undefined)
    expect(createStrokeHandler(deps, sample(4, 4), null)).toBeUndefined()
  })

  it('starts no stroke when the contract declines the press', () => {
    const { deps } = rig()
    const missed: StrokeSample = { pick: { surface: null, point: null, objectId: null }, modifiers: { shift: false, alt: false, ctrl: false } }
    expect(createStrokeHandler(deps, missed, null)).toBeUndefined()
  })
})

describe('the stroke actor', () => {
  it('applies every tick immediately, then commits one Edit with one patch per address', () => {
    const { reader, document, start, patchEvents, record } = rig()
    const doc = reader.doc
    const before = columnHeights(ground(doc))
    const arrays = snapshot(ground(doc))
    const at = (x: number, y: number) => topHeight(ground(doc), x, y)

    // A size-3 brush dragged right two cells and back again: every tick lands
    // on cells earlier ticks already raised, which is the redundancy measured
    // in docs/stack.md.
    const path: Array<[number, number]> = [[4, 4], [5, 4], [6, 4], [5, 4], [4, 4], [5, 4], [6, 4]]
    const stroke = start(sample(...path[0]))
    expect(at(4, 4), 'the press already deformed the terrain').toBe(before[cellIndex(ground(doc).size, 4, 4)] + 1)
    for (const [x, y] of path.slice(1)) {
      const seen = at(x, y)
      stroke.send({ type: 'move', sample: sample(x, y) })
      expect(at(x, y), 'a mid-drag tick is visible before release').toBe(seen + 1)
    }
    // Not an undo entry yet: the stroke is still open.
    expect(reader.canUndo()).toBe(false)

    stroke.send({ type: 'end', sample: sample(6, 4) })

    // An address is one voxel's field: a half-tile up from a whole cube is the
    // new top voxel's material and its shape, and the next half-tile is that
    // voxel's shape alone, so a cell raised n times spans about n addresses
    // rather than one. The redundancy is what the compaction is measured
    // against, so it is asserted over addresses, not cells.
    const sentPatches = patchEvents().flatMap((event) => event.patches)
    const unique = new Set(sentPatches.map(patchAddress))
    expect(sentPatches.length, 'the drag really was redundant').toBeGreaterThan(unique.size)
    // One patch per address that ended somewhere other than it began — the
    // addresses a cell's even number of half-tiles put back are dropped, as
    // the test below pins — and never more than one per address touched.
    const changed = changedAddresses(arrays, sentPatches)
    expect(changed.size).toBeGreaterThan(0)
    expect(changed.size).toBeLessThan(unique.size)
    const edit = record()
    expect(edit.patches).toHaveLength(changed.size)
    expect(new Set(edit.patches.map(patchAddress))).toEqual(changed)
    expect(edit.inverse).toHaveLength(changed.size)
    expect(stroke.getSnapshot().status).toBe('done')

    // One Edit, and undoing it restores every cell to before the press.
    expect(reader.canUndo()).toBe(true)
    expect(reader.undoLabel()).toBe('Raise')
    const after = columnHeights(ground(doc))
    document.send({ type: 'undo' })
    expect(columnHeights(ground(doc))).toEqual(before)
    expect(reader.canUndo()).toBe(false)
    // And the compacted forward values reproduce the final state exactly.
    document.send({ type: 'redo' })
    expect(columnHeights(ground(doc))).toEqual(after)
  })

  it('keeps the first inverse and the last value: raise, raise, lower undoes to the start in one step', () => {
    const { reader, document, start, record } = rig(withBrush(1))
    const doc = reader.doc
    const before = topHeight(ground(doc), 3, 3)
    // The fresh map is one cube high, so the writes land on the voxel of the
    // second layer: a slab, then a block, then a slab again.
    expect(before).toBe(2)
    const index = voxelIndex(ground(doc), 3, 3, 1)

    const stroke = start(sample(3, 3))
    stroke.send({ type: 'move', sample: sample(4, 3) })
    stroke.send({ type: 'move', sample: sample(3, 3) })
    stroke.send({ type: 'move', sample: sample(4, 3) })
    stroke.send({ type: 'move', sample: sample(3, 3, { shift: true }) })
    // +1, +1, -1 on (3,3): three writes to that voxel's shape, a net of one.
    expect(topHeight(ground(doc), 3, 3)).toBe(before + 1)
    stroke.send({ type: 'end', sample: sample(3, 3) })

    const edit = record()
    const mine = edit.patches.find((patch) => patch.t === 'voxel' && patch.field === 'shape' && patch.index === index)
    const inverse = edit.inverse.find((patch) => patch.t === 'voxel' && patch.field === 'shape' && patch.index === index)
    expect(mine?.value).toBe(SHAPE_SLAB)
    // It was air before the stroke, and air is a shape.
    expect(inverse?.value).toBe(AIR)
    document.send({ type: 'undo' })
    expect(topHeight(ground(doc), 3, 3)).toBe(before)
  })

  it('drops an address put back where it started, and commits no Edit when nothing remains', () => {
    const { reader, start, patchEvents, record } = rig(withBrush(1))
    // Both cells stand on a slab, so a half-tile up and back down writes the
    // one voxel's shape twice and leaves the column exactly as it was. (From
    // a whole cube the way up adds a voxel, and the faces it uncovers and
    // covers again take their paint from their neighbours.)
    fillColumn(ground(reader.doc), 2, 2, 3)
    fillColumn(ground(reader.doc), 3, 2, 3)
    const stroke = start(sample(2, 2))
    stroke.send({ type: 'move', sample: sample(3, 2) })
    stroke.send({ type: 'move', sample: sample(2, 2, { shift: true }) })
    stroke.send({ type: 'move', sample: sample(3, 2, { shift: true }) })
    stroke.send({ type: 'end', sample: sample(3, 2) })

    // Four ticks reached the document…
    expect(patchEvents()).toHaveLength(4)
    // …and the record is empty, so the stroke closed without an entry.
    expect(record().patches).toEqual([])
    expect(reader.canUndo()).toBe(false)
  })

  it('records where it began, for the rectangle preview', () => {
    const { start } = rig()
    const stroke = start(sample(7, 9))
    expect(stroke.getSnapshot().context.origin).toEqual([7, 9])
  })

  it('stops itself on end, so a late move dead-letters rather than landing', () => {
    const { reader, start, dead } = rig(withBrush(1))
    const doc = reader.doc
    const stroke = start(sample(1, 1))
    stroke.send({ type: 'end', sample: sample(1, 1) })
    const settled = columnHeights(ground(doc))

    stroke.send({ type: 'move', sample: sample(2, 1) })

    expect(columnHeights(ground(doc))).toEqual(settled)
    expect(dead).toHaveLength(1)
    expect(dead[0]).toMatchObject({ reason: 'stopped', event: { type: 'move' } })
  })

  it('leaves each tick a Patch the document takes as-is', () => {
    // The handler contract types patches as the document's own `Patch`; a
    // consumer never constructs one, so this only checks the wiring's shape.
    const { start, patchEvents } = rig(withBrush(1))
    const stroke = start(sample(0, 0))
    stroke.send({ type: 'end', sample: sample(0, 0) })
    // A half-tile up from a cube: the new top voxel's shape comes first, then the paint that follows it.
    const patch: Patch | undefined = patchEvents()[0]?.patches[0]
    expect(patch).toMatchObject({ t: 'voxel', id: 'ground', field: 'shape' })
  })
})
