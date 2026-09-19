import {
  NO_RAMP,
  NO_WATER,
  createDocument,
  SURFACE_TOP,
  cellIndex,
  columnHeights,
  createMap,
  faceKey,
  topLayersAt,
  layersOf,
  paintTint,
  patchAddress,
  raise,
  rampDirAt,
  tintPaint,
  topHeight,
  type Patch,
  type SurfaceAddress,
  type MapDoc,
  type ReadonlyMapDoc,
  type VoxelStructure,
} from '@papercut/document'
import { createHost, type Host, type PointerPress } from '@papercut/editor-host'
import { commands, evaluate, keymap, panels, parseChords, resolve, tools } from '@papercut/registry'
import type { TerrainParams } from '@papercut/feature-terrain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { features } from './index'

/** The root voxel volume a fresh level has, mutable for setup: `createMap` names it `ground`. */
const ground = (doc: ReadonlyMapDoc | MapDoc): VoxelStructure => doc.structures.ground as VoxelStructure


/**
 * The composition this app is: a host, the features it installs, and nothing
 * else. It lives here rather than in either package because #35 rules that a
 * feature never imports the host and the host never imports a feature — so an
 * app is the only place the two halves can be seen at once, and the test that
 * proves the seam works has to sit where the seam is assembled.
 *
 * Every assertion about behavior goes through `dispatch`, `Host.input` and
 * `reader` (#10). Setup may build documents directly — `apply` below stands in
 * for the app's own writes, which is what the mid-drag test is about — but no
 * assertion reads anything else.
 */
const TERRAIN = 'terrain'

/** Every id this file dispatches, for the enumeration test at the bottom. */
const dispatched = new Set<string>()

/**
 * Every host this file builds, so `afterEach` can stop each one. A host holds
 * a module-level install hook that only `stop()` releases (`editor-host`'s
 * `releaseFeatureHook`) and a running root actor, and the feature registry is
 * a process-wide singleton — leaving them alive would have one file's abandoned
 * hosts spawning logic for the next hot re-import, which is exactly what the
 * host's own comment says must not happen.
 */
const started: Host[] = []

function makeHost(): { host: Host; dispatch: Host['dispatch'] } {
  const host = createHost({ document: createDocument(createMap(8, 8)), features })
  started.push(host)
  const dispatch: Host['dispatch'] = (id, args) => {
    dispatched.add(id)
    return host.dispatch(id, args)
  }
  // Every stroke below is a terrain stroke; the editor opens on Select.
  host.dispatch('tools.set', { tool: 'terrain' })
  return { host, dispatch }
}

/**
 * Setup: one labelled edit, at the document actor's own event rather than
 * through a command. A test holds the ref the same way the stroke actor does —
 * there is no writer to reach for, which is the point (#13).
 */
function apply(host: Host, label: string, patches: Patch[]): void {
  host.children.document.send({ type: 'patch', label, patches })
}

let live: ReturnType<typeof makeHost>
beforeEach(() => {
  live = makeHost()
})
afterEach(() => {
  for (const host of started.splice(0)) host.stop()
})

describe('what the feature declares, before anything is running', () => {
  // #9's claim, and the reason the declaration registries are static: a
  // palette, a keybinding editor and this test can all enumerate a feature's
  // surface with no actor in existence. `features` was imported at module
  // scope; no host has been built at the point these ids were registered.
  it('is enumerable from the import alone, under the feature\'s own owner', () => {
    const ids = commands
      .all()
      .filter((command) => commands.ownerOf(command.id) === TERRAIN)
      .map((command) => command.id)
      .sort()
    expect(ids).toEqual([
      'terrain.brush.resize',
      'terrain.edges',
      'terrain.face',
      'terrain.flatten',
      'terrain.material',
      'terrain.params',
      'terrain.paste',
      'terrain.raise',
      'terrain.ramp',
      'terrain.ramp.clear',
      'terrain.smooth',
      'terrain.tint',
      'terrain.water',
    ])
    expect(tools.get('terrain')).toMatchObject({ title: 'Terrain', icon: 'terrain' })
    // The bar panel is the tool's row of controls; the inspector ones are gated.
    expect(panels.ownerOf('terrain.bar')).toBe(TERRAIN)
    expect(panels.get('terrain.bar')).toMatchObject({ slot: 'bar' })
    expect(typeof panels.get('terrain.bar')?.component).toBe('function')
    expect(panels.get('terrain.ramp')?.slot).toBeUndefined()
    expect(panels.get('terrain.paint')?.when).toBeDefined()
  })
})

describe('the terrain commands, dispatched through the host', () => {
  it('raises what the arguments name, seen through reader', () => {
    const { host, dispatch } = live
    const height = () => topHeight(ground(host.reader.doc), 2, 3)
    const before = height()

    expect(dispatch('terrain.raise', { structure: 'ground', cells: [[2, 3]], delta: 2 })).toEqual({ ok: true })

    expect(height()).toBe(before + 2)
    // One labelled edit, on the undo stack the document actor owns — the
    // feature has no writer and never saw one.
    expect(host.reader.undoLabel()).toBe('Raise')
    expect(dispatch('undo')).toEqual({ ok: true })
    expect(height()).toBe(before)
  })

  it('carries the rest of the verbs, each addressing its target by data', () => {
    const { host, dispatch } = live
    const g = () => ground(host.reader.doc)
    const size = g().size

    expect(dispatch('terrain.flatten', { structure: 'ground', cells: [[1, 1]], height: 4 })).toEqual({ ok: true })
    expect(topHeight(g(), 1, 1)).toBe(4)

    // A ramp is cut from a cliff edge: (1,1) now stands one cube above (0,1),
    // its neighbour to the west, and that drop takes a run of one cell. Any
    // other run is refused (ok, no patch).
    expect(dispatch('terrain.ramp', { structure: 'ground', edge: { x: 1, z: 1, dir: 2 }, run: 2 })).toEqual({ ok: true })
    expect(rampDirAt(g(), 1, 1)).toBe(NO_RAMP)
    expect(dispatch('terrain.ramp', { structure: 'ground', edge: { x: 1, z: 1, dir: 2 }, run: 1 })).toEqual({ ok: true })
    expect(rampDirAt(g(), 1, 1)).toBe(2)
    // The heights stay when the run is removed; only the slope goes.
    expect(dispatch('terrain.ramp.clear', { structure: 'ground', cell: [1, 1] })).toEqual({ ok: true })
    expect(rampDirAt(g(), 1, 1)).toBe(NO_RAMP)
    expect(topHeight(g(), 1, 1)).toBe(4)

    // Water is a line above the ground, never level with it: 3 over a column
    // flattened to 4 is refused (ok, no patch), 5 lands.
    expect(dispatch('terrain.water', { structure: 'ground', cells: [[1, 1]], level: 3 })).toEqual({ ok: true })
    expect(g().water[cellIndex(size, 1, 1)]).toBe(NO_WATER)
    expect(dispatch('terrain.water', { structure: 'ground', cells: [[1, 1]], level: 5 })).toEqual({ ok: true })
    expect(g().water[cellIndex(size, 1, 1)]).toBe(5)

    expect(dispatch('terrain.material', { structure: 'ground', cells: [[1, 1]], material: 1 })).toEqual({ ok: true })
    expect(topLayersAt(g(), 1, 1)).toEqual(layersOf(1))

    // Smoothing moves a column toward the mean of its neighbours by at most
    // `strength`: every neighbour of (1,1) is at 2, so it comes down one.
    expect(dispatch('terrain.smooth', { structure: 'ground', cells: [[1, 1]], strength: 1 })).toEqual({ ok: true })
    expect(topHeight(g(), 1, 1)).toBe(3)
    expect(g().water[cellIndex(size, 1, 1)]).toBe(5)

    // A face holds material layers, keyed by voxel and side: the bottom
    // cube's west face here. `null` empties a layer, and the label says which.
    expect(dispatch('terrain.face', { structure: 'ground', faces: [{ x: 1, z: 1, y: 0, dir: 2 }], material: 2 })).toEqual({ ok: true })
    expect(ground(host.reader.doc).paint.faces[faceKey(1, 1, 0, 2)]).toEqual(layersOf(2))
    expect(host.reader.undoLabel()).toBe('Paint face')
    expect(dispatch('terrain.face', { structure: 'ground', faces: [{ x: 1, z: 1, y: 0, dir: 2 }], material: 3, layer: 1 })).toEqual({ ok: true })
    expect(ground(host.reader.doc).paint.faces[faceKey(1, 1, 0, 2)]).toEqual(['m:2', 'm:3', null, null])
    expect(dispatch('terrain.face', { structure: 'ground', faces: [{ x: 1, z: 1, y: 0, dir: 2 }], material: null })).toEqual({ ok: true })
    expect(ground(host.reader.doc).paint.faces[faceKey(1, 1, 0, 2)]).toEqual([null, 'm:3', null, null])
    expect(host.reader.undoLabel()).toBe('Clear face')

    // Tiles paste whole onto faces from the stamp's top-left (ruling of 2026-09-18). On (1,1)'s west side the stamp runs
    // along the wall, +z seen from outside, and down a course. Only the half-cube course it lands on stands clear, so
    // that face takes its tile; what lands against a neighbour or past the wall's end writes nothing.
    expect(dispatch('terrain.paste', { structure: 'ground', face: { x: 1, z: 1, y: 1, dir: 2 }, image: 1, tiles: [[5, 6], [7, 8]], layer: 1 })).toEqual({ ok: true })
    expect(ground(host.reader.doc).paint.faces[faceKey(1, 1, 1, 2)]?.[1]).toBe('t:1:5')
    expect(ground(host.reader.doc).paint.faces[faceKey(1, 2, 1, 2)]).toBeUndefined()
    expect(ground(host.reader.doc).paint.faces[faceKey(1, 1, 0, 2)]).toEqual([null, 'm:3', null, null])
    expect(host.reader.undoLabel()).toBe('Paste tiles')

    // (1,1) stands above its neighbours, so its sides are walls: a wall's fringe switches off, and back on.
    expect(dispatch('terrain.edges', { structure: 'ground', edges: [{ x: 1, z: 1, dir: 0, end: 'top' }], on: false })).toEqual({ ok: true })
    expect(ground(host.reader.doc).paint.edges['1,1,0,top']).toBe('off')
    expect(host.reader.undoLabel()).toBe('Fringe off')
    expect(dispatch('terrain.edges', { structure: 'ground', edges: [{ x: 1, z: 1, dir: 0, end: 'top' }], on: true })).toEqual({ ok: true })
    expect(ground(host.reader.doc).paint.edges['1,1,0,top']).toBeUndefined()
    expect(host.reader.undoLabel()).toBe('Fringe back on')

    expect(dispatch('terrain.tint', { structure: 'ground', cells: [[1, 1]], tint: 0x00ff00 })).toEqual({ ok: true })
    expect(tintPaint(ground(host.reader.doc).paint, 1, 1)).toBe(0x00ff00)
    expect(host.reader.undoLabel()).toBe('Tint')
  })

  it('refuses arguments the schema does not admit, before anything is sent', () => {
    const { host, dispatch } = live
    const before = topHeight(ground(host.reader.doc), 2, 3)

    // A stray key, a missing one, and the shape that matters most: `undefined`
    // where a value belongs, which is not JSON and so cannot be an argument.
    expect(dispatch('terrain.raise', { structure: 'ground', cells: [[2, 3]], delta: 1, verb: 'raise' })).toMatchObject({ ok: false, kind: 'invalid-args' })
    expect(dispatch('terrain.raise', { structure: 'ground', cells: [[2, 3]] })).toMatchObject({ ok: false, kind: 'invalid-args' })
    expect(dispatch('terrain.raise', { structure: 'ground', cells: [], delta: 1 })).toMatchObject({ ok: false, kind: 'invalid-args' })

    expect(topHeight(ground(host.reader.doc), 2, 3)).toBe(before)
    expect(host.reader.canUndo()).toBe(false)
  })
})

describe('the tool contract, which a declaration cannot carry', () => {
  const top: SurfaceAddress = { structure: 'ground', x: 4, y: 4, kind: SURFACE_TOP, dir: 0, level: 0 }

  it('is reachable from the host by the tool\'s id, and answers with patches', () => {
    const { host, dispatch } = live
    const before = topHeight(ground(host.reader.doc), 4, 4)
    const contract = host.toolContract('terrain')
    expect(contract).toBeDefined()

    const handler = contract?.stroke({ pick: { surface: top, point: null, objectId: null }, modifiers: { shift: false, alt: false, ctrl: false } })
    expect(handler?.label).toBe('Raise')
    // The contract reads the tool parameters live, through the deps the host
    // handed it — so a `tools.set` between the press and the tick is seen.
    expect(dispatch('terrain.params', { brush: { size: 3, shape: 'square' } })).toEqual({ ok: true })
    const patches = handler?.begin({ pick: { surface: top, point: null, objectId: null }, modifiers: { shift: false, alt: false, ctrl: false } })
    // Nine cells, each one cube up (the default strength) from a whole cube:
    // one new block per cell, then the paint that moves with the surface.
    const shapes = patches?.filter((patch) => patch.t === 'voxel') ?? []
    expect(shapes).toHaveLength(9)
    expect(new Set(shapes.map((patch) => patch.index % (8 * 8))).size).toBe(9)
    expect(patches?.some((patch) => patch.t === 'voxelPaint')).toBe(true)

    // And it applied nothing: a handler answers with patches, and the stroke
    // actor is what sends them to the document (#13).
    expect(topHeight(ground(host.reader.doc), 4, 4)).toBe(before)
  })

  it('declines a press that missed the terrain', () => {
    const contract = live.host.toolContract('terrain')
    expect(contract).toBeDefined()
    expect(contract?.stroke({ pick: { surface: null, point: null, objectId: null }, modifiers: { shift: false, alt: false, ctrl: false } })).toBeUndefined()
  })

  it('is undefined for a tool nobody declared', () => {
    expect(live.host.toolContract('nonesuch')).toBeUndefined()
  })
})

// --- pointer input -------------------------------------------------------------

const NO_MODIFIERS = { shift: false, alt: false, ctrl: false }

function topAt(x: number, y: number): SurfaceAddress {
  return { structure: 'ground', kind: SURFACE_TOP, x, y, dir: -1, level: 0 }
}

function pressAt(x: number, y: number, extra: Partial<PointerPress> = {}): PointerPress {
  return { x: x * 10, y: y * 10, button: 0, modifiers: NO_MODIFIERS, pick: { surface: topAt(x, y), point: { x, z: y }, objectId: null }, ...extra }
}

/**
 * The addresses an Edit should hold once a stroke's ticks are compacted: each
 * one the last tick left at a value other than the one it started with. An
 * address is one voxel's field (`voxel:<id>:<field>:<index>`), and a shape
 * that went slab, block, slab, block over four half-tiles is back where it
 * began, so it is not one of them.
 */
function changedAddresses(before: { shape: number[]; water: number[]; faces: Record<string, unknown> }, sent: Patch[]): Set<string> {
  const last = new Map<string, Patch>()
  for (const patch of sent) last.set(patchAddress(patch), patch)
  const changed = new Set<string>()
  for (const [address, patch] of last) {
    if (patch.t === 'voxel' && patch.value !== before[patch.field][patch.index]) changed.add(address)
    if (patch.t === 'voxelPaint' && patch.layer === 'faces' && JSON.stringify(patch.value) !== JSON.stringify(before.faces[patch.key])) changed.add(address)
  }
  return changed
}

/** One committed edit, so a test has terrain to work against. */
function raiseOnce(host: Host, x: number, y: number, by = 1): void {
  apply(host, 'Raise', raise(host.reader.doc, ground(host.reader.doc), [[x, y]], by))
}

/**
 * A terrain drag, end to end, and the reason these tests live in the app
 * rather than in `editor-host`: the stroke actor now runs the CONTRACT the
 * terrain feature contributed, and the host may not import a feature (#35), so
 * the only place a press can travel the whole path — arbitration actor, stroke
 * actor, the feature's handler, the document actor — is where the two halves
 * are composed. `editor-host`'s own pointer tests keep the object tool, whose
 * handler is still the host's, plus a stub contract for the routing itself.
 */
describe('a terrain stroke, from the pointer to the document', () => {
  it('a left drag sculpts on every tick and lands as one undo entry, one patch per address', () => {
    const { host, dispatch } = live
    // One half-tile per pass, so each cell reads as +1 below; the tool's default strength is a whole cube.
    dispatch('terrain.params', { brush: { size: 3, shape: 'square' }, strength: 1 })
    const doc = host.reader.doc
    const before = columnHeights(ground(doc))
    const arrays = { shape: ground(doc).voxels.shape.slice(), water: ground(doc).water.slice(), faces: structuredClone(ground(doc).paint.faces) as Record<string, unknown> }
    const at = (x: number, y: number) => topHeight(ground(doc), x, y)
    // What the document actor received, off the system's inspector (v6's
    // `Actor.send` is a getter and cannot be spied on). Matched by the id the
    // host spawns it under: `ActorRefLike`, which is what an inspection event
    // carries, has no typed `sessionId` to compare a child ref against.
    const received: Array<{ type: string } & Record<string, unknown>> = []
    host.actor.system.inspect((event) => {
      if (event.type === '@xstate.transition' && 'id' in event.actorRef && event.actorRef.id === 'document') received.push(event.event)
    })

    expect(host.input.pointerDown(pressAt(3, 3))).toBe('stroke')
    expect(at(3, 3)).toBe(before[cellIndex(ground(doc).size, 3, 3)] + 1)
    for (const [x, y] of [[4, 3], [5, 3], [4, 3], [3, 3]] as const) {
      expect(host.input.pointerMove({ x: x * 10, y: y * 10, modifiers: NO_MODIFIERS })).toBe('stroke')
      const seen = at(x, y)
      host.input.strokeMove({ surface: topAt(x, y), point: null, objectId: null }, NO_MODIFIERS)
      expect(at(x, y)).toBe(seen + 1)
    }
    expect(host.input.strokeOrigin()).toEqual([3, 3])
    host.input.pointerUp({ x: 30, y: 30 })
    expect(host.input.gesture()).toBe('none')
    expect(host.input.strokeOrigin()).toBeNull()

    // The drag re-raises cells, so more patches were sent than there are
    // addresses; the record holds one patch per address that ended somewhere
    // other than it began, and no address twice.
    const patches = received.flatMap((event) => (event.type === 'strokePatch' ? (event.patches as Patch[]) : []))
    const record = received.find((event) => event.type === 'endStroke')
    const unique = new Set(patches.map(patchAddress)).size
    expect(patches.length).toBeGreaterThan(unique)
    const changed = changedAddresses(arrays, patches)
    expect(changed.size).toBeGreaterThan(0)
    expect(new Set((record?.patches as Patch[] | undefined)?.map(patchAddress))).toEqual(changed)

    expect(host.reader.undoLabel()).toBe('Raise')
    expect(dispatch('undo')).toEqual({ ok: true })
    expect(columnHeights(ground(doc))).toEqual(before)
  })

  it('records an app write that lands mid-drag, so one undo brings it back', () => {
    // `App`'s Delete keybinding is a `window` keydown listener: pointer
    // capture does not stop it, so `store.apply` is reachable in the middle of
    // an open stroke. Once, that write was applied and recorded by nothing —
    // the store refused it and the stroke's compaction map holds only patches
    // the stroke itself produced.
    const { host, dispatch } = live
    dispatch('terrain.params', { strength: 1 })
    const doc = host.reader.doc
    const height = (x: number, y: number) => topHeight(ground(doc), x, y)
    const before = columnHeights(ground(doc))

    expect(host.input.pointerDown(pressAt(3, 3))).toBe('stroke')
    apply(host, 'Elsewhere', raise(doc, ground(doc), [[7, 7]], 1))
    expect(height(7, 7)).toBe(before[cellIndex(ground(doc).size, 7, 7)] + 1)
    host.input.pointerUp({ x: 30, y: 30 })

    expect(dispatch('undo')).toEqual({ ok: true })
    expect(height(3, 3)).toBe(before[cellIndex(ground(doc).size, 3, 3)])
    expect(host.reader.undoLabel()).toBe('Elsewhere')
    expect(dispatch('undo')).toEqual({ ok: true })
    expect(columnHeights(ground(doc))).toEqual(before)
  })

  it('a rect stroke commits nothing until release, then one block from the press cell to the last', () => {
    const { host, dispatch } = live
    dispatch('terrain.params', { strokeShape: 'rect' })
    const doc = host.reader.doc
    const before = columnHeights(ground(doc))
    const height = (x: number, y: number) => topHeight(ground(doc), x, y)

    expect(host.input.pointerDown(pressAt(2, 2))).toBe('stroke')
    // Nothing on the press, and nothing mid-drag: a rectangle is only known
    // once both corners are.
    expect(columnHeights(ground(doc))).toEqual(before)
    for (const [x, y] of [[3, 3], [4, 4]] as const) {
      host.input.pointerMove({ x: x * 10, y: y * 10, modifiers: NO_MODIFIERS })
      host.input.strokeMove({ surface: topAt(x, y), point: null, objectId: null }, NO_MODIFIERS)
    }
    expect(columnHeights(ground(doc))).toEqual(before)
    // The preview grows from the press cell, which is what `strokeOrigin` is for.
    expect(host.input.strokeOrigin()).toEqual([2, 2])

    host.input.pointerUp({ x: 40, y: 40 })
    for (let y = 2; y <= 4; y++) for (let x = 2; x <= 4; x++) expect(height(x, y)).toBe(before[cellIndex(ground(doc).size, x, y)] + 2)
    expect(height(5, 5)).toBe(before[cellIndex(ground(doc).size, 5, 5)])
    expect(height(1, 1)).toBe(before[cellIndex(ground(doc).size, 1, 1)])

    // One entry for the block, not nine.
    expect(host.reader.undoLabel()).toBe('Raise')
    expect(dispatch('undo')).toEqual({ ok: true })
    expect(columnHeights(ground(doc))).toEqual(before)
    expect(host.reader.canUndo()).toBe(false)
  })

  it('a fill stroke floods the contiguous plateau under the press and stops at the step', () => {
    const { host, dispatch } = live
    // A wall of raised cells down x = 4 bounds the flood: `fillCells` walks
    // cells of equal height, so the press at (2,2) reaches only its own side.
    for (let y = 0; y < 8; y++) raiseOnce(host, 4, y)
    dispatch('terrain.params', { strokeShape: 'fill' })
    const doc = host.reader.doc
    const before = columnHeights(ground(doc))
    const height = (x: number, y: number) => topHeight(ground(doc), x, y)

    host.input.pointerDown(pressAt(2, 2))
    host.input.pointerUp({ x: 20, y: 20 })

    for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) expect(height(x, y)).toBe(before[cellIndex(ground(doc).size, x, y)] + 2)
    expect(height(5, 5)).toBe(before[cellIndex(ground(doc).size, 5, 5)])
    expect(dispatch('undo')).toEqual({ ok: true })
    expect(columnHeights(ground(doc))).toEqual(before)
  })

  it('the flatten verb levels a drag to the height sampled at the press', () => {
    const { host, dispatch } = live
    raiseOnce(host, 0, 0, 3)
    dispatch('terrain.params', { sculptVerb: 'flatten', brush: { size: 1, shape: 'square' } })
    const doc = host.reader.doc
    const anchor = topHeight(ground(doc), 0, 0)

    host.input.pointerDown(pressAt(0, 0))
    for (const [x, y] of [[1, 0], [2, 0]] as const) {
      host.input.pointerMove({ x: x * 10, y: y * 10, modifiers: NO_MODIFIERS })
      host.input.strokeMove({ surface: topAt(x, y), point: null, objectId: null }, NO_MODIFIERS)
      // Flattened to the press height, not to each cell's own.
      expect(topHeight(ground(doc), x, y)).toBe(anchor)
    }
    host.input.pointerUp({ x: 20, y: 0 })
    expect(host.reader.undoLabel()).toBe('Flatten')
    expect(dispatch('undo')).toEqual({ ok: true })
    expect(topHeight(ground(doc), 1, 0)).not.toBe(anchor)
  })

  it('the water verb pools one half-tile over the pressed cell (interim, until the layer view), and shift removes it', () => {
    const { host, dispatch } = live
    dispatch('terrain.params', { sculptVerb: 'water' })
    const doc = host.reader.doc
    const water = () => ground(doc).water[cellIndex(ground(doc).size, 3, 3)]
    const level = topHeight(ground(doc), 3, 3) + 1

    host.input.pointerDown(pressAt(3, 3))
    host.input.pointerUp({ x: 30, y: 30 })
    expect(water()).toBe(level)
    expect(host.reader.undoLabel()).toBe('Carve water')

    const shift = { modifiers: { ...NO_MODIFIERS, shift: true } }
    host.input.pointerDown(pressAt(3, 3, shift))
    host.input.pointerUp({ x: 30, y: 30 })
    expect(water()).toBe(NO_WATER)
    expect(host.reader.undoLabel()).toBe('Remove water')

    expect(dispatch('undo')).toEqual({ ok: true })
    expect(water()).toBe(level)
  })

  it('alt-click runs the eyedropper at the press cell, and a 6 px alt-drag orbits without it', () => {
    const { host, dispatch } = live
    dispatch('terrain.params', { terrainMode: 'paint', paintVerb: 'tint' })
    apply(host, 'Tint', paintTint(ground(host.reader.doc), [[2, 2]], 0xff0000))
    apply(host, 'Tint', paintTint(ground(host.reader.doc), [[6, 6]], 0x00ff00))
    const alt = { modifiers: { ...NO_MODIFIERS, alt: true } }

    expect(host.input.pointerDown(pressAt(2, 2, alt))).toBe('pending')
    expect(host.input.pointerMove({ x: 21, y: 22, modifiers: alt.modifiers })).toBe('pending')
    host.input.pointerUp({ x: 21, y: 22 })
    expect((host.children.tools.getSnapshot().context.features.terrain as unknown as TerrainParams).tint).toBe(0xff0000)
    // The eyedropper wrote a tool parameter, never the document.
    expect(host.reader.undoLabel()).toBe('Tint')

    expect(host.input.pointerDown(pressAt(6, 6, alt))).toBe('pending')
    expect(host.input.pointerMove({ x: 66, y: 60, modifiers: alt.modifiers })).toBe('orbit')
    host.input.pointerUp({ x: 66, y: 60 })
    expect((host.children.tools.getSnapshot().context.features.terrain as unknown as TerrainParams).tint).toBe(0xff0000)
  })
})

describe('the feature\'s context key', () => {
  it('lands in the host\'s vocabulary and follows the tool parameters', () => {
    const { host, dispatch } = live
    expect(host.contextKeys()['terrain.verb']).toBe('raise')

    expect(dispatch('terrain.params', { sculptVerb: 'ramp' })).toEqual({ ok: true })
    expect(host.contextKeys()['terrain.verb']).toBe('ramp')

    // The paint verb is "the verb" in paint mode: the key is the feature's
    // because what counts as a verb is the terrain tool's business.
    expect(dispatch('terrain.params', { terrainMode: 'paint', paintVerb: 'tint' })).toEqual({ ok: true })
    expect(host.contextKeys()['terrain.verb']).toBe('tint')
  })

  it('is what the sculpt panel\'s availability is expressed over', () => {
    const { host, dispatch } = live
    const sculpt = panels.get('terrain.sculpt')
    expect(sculpt?.when).toBeDefined()
    dispatch('terrain.params', { terrainMode: 'paint' })
    expect(evaluate(sculpt!.when!, host.contextKeys())).toMatchObject({ available: false, reason: expect.stringContaining('terrain.mode') as string })

    dispatch('terrain.params', { terrainMode: 'sculpt' })
    expect(evaluate(sculpt!.when!, host.contextKeys())).toEqual({ available: true })
  })
})

/**
 * #10: every declared command must have a test that dispatches it. Runs last
 * in the file, so `dispatched` is complete — and scoped to this feature's
 * owner, because the host's own commands have the same guard in
 * `editor-host`'s tests.
 */
describe('the terrain feature owns its parameters', () => {
  it('is seeded with its defaults, sets them through its own command, and nudges the brush clamped at both ends', () => {
    const { host, dispatch } = live
    const slice = () => host.children.tools.getSnapshot().context.features.terrain as unknown as TerrainParams
    expect(slice()).toMatchObject({ terrainMode: 'sculpt', sculptVerb: 'raise', strokeShape: 'brush' })
    expect(dispatch('terrain.params', { terrainMode: 'paint', paintVerb: 'tint' })).toEqual({ ok: true })
    expect(slice()).toMatchObject({ terrainMode: 'paint', paintVerb: 'tint' })
    expect(host.contextKeys()['terrain.mode']).toBe('paint')
    expect(dispatch('terrain.params', { brush: { size: 99, shape: 'circle' } })).toMatchObject({ ok: false, kind: 'invalid-args', issues: [{ path: ['brush', 'size'] }] })

    dispatch('terrain.params', { brush: { size: 1, shape: 'square' } })
    expect(dispatch('terrain.brush.resize', { by: 4 })).toEqual({ ok: true })
    expect(slice().brush.size).toBe(5)
    for (let i = 0; i < 20; i++) dispatch('terrain.brush.resize', { by: -1 })
    expect(slice().brush.size).toBe(1)
    for (let i = 0; i < 20; i++) dispatch('terrain.brush.resize', { by: 1 })
    expect(slice().brush.size).toBe(12)
    expect(dispatch('terrain.brush.resize', { by: 99 })).toMatchObject({ ok: false, kind: 'invalid-args' })
    dispatch('terrain.params', { terrainMode: 'sculpt', paintVerb: 'material', brush: { size: 1, shape: 'square' } })
  })

  it('binds Tab to its mode toggle and the brackets to the brush, at the feature weight', () => {
    const { host, dispatch } = live
    const hit = (spec: string) => resolve({ bindings: keymap.all(), snapshot: host.contextKeys(), platform: 'other' }, [], parseChords(spec, 'other')[0])
    expect(hit('tab')).toMatchObject({ command: 'terrain.params', args: { terrainMode: 'paint' } })
    dispatch('terrain.params', { terrainMode: 'paint' })
    expect(hit('tab')).toMatchObject({ command: 'terrain.params', args: { terrainMode: 'sculpt' } })
    dispatch('terrain.params', { terrainMode: 'sculpt' })
    expect(hit('[')).toMatchObject({ command: 'terrain.brush.resize', args: { by: -1 } })
    expect(hit(']')).toMatchObject({ command: 'terrain.brush.resize', args: { by: 1 } })
  })
})

describe('declared but untested', () => {
  it('has dispatched every command the feature declares', () => {
    const untested = commands
      .all()
      .filter((command) => commands.ownerOf(command.id) === TERRAIN)
      .map((command) => command.id)
      .filter((id) => !dispatched.has(id))
    expect(untested, `declared but never dispatched by a test: ${untested.join(', ')}`).toEqual([])
  })
})

/**
 * LAST IN THE FILE, and it has to be: `feature-terrain` declares at module
 * scope under a singleton owner, so revoking it revokes it for the whole
 * process — every test above would then be dispatching at commands that no
 * longer exist. Vitest isolates modules per file, so the blast radius stops at
 * this file, but the ORDER inside it is load-bearing rather than incidental.
 * The host is this block's own, built and stopped here, so nothing about the
 * disposal rides on the fixture the rest of the file shares.
 */
describe('disposing the feature', () => {
  it('takes its commands, its panels and its key with it, and stops its actor', () => {
    const { host, dispatch } = makeHost()
    const actor = host.child(TERRAIN)
    expect(actor?.getSnapshot().status).toBe('active')

    host.dispose(TERRAIN)

    expect(commands.get('terrain.raise')).toBeUndefined()
    expect(panels.get('terrain.brush')).toBeUndefined()
    expect(tools.get('terrain')).toBeUndefined()
    expect(dispatch('terrain.raise', { structure: 'ground', cells: [[2, 3]], delta: 1 })).toMatchObject({ ok: false, kind: 'unknown' })
    expect(actor?.getSnapshot().status).toBe('stopped')

    // The key is revoked with everything else: `contextKeys` no longer carries
    // it, and its owner is gone, so the host is not still deriving a value for
    // a vocabulary entry nobody can name.
    expect('terrain.verb' in host.contextKeys()).toBe(false)
    expect(host.toolContract('terrain')).toBeUndefined()
  })
})

