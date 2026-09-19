import { FORMAT_VERSION, HALF, addObject, createDocument, createMap, createProject, serializeProject, defaultFacing, frameOf, groundHeight, materialById, raise, slotMaterial, removeObject, serialize, tagOf, topHeight, type MapDoc, type MapObject, type Patch, type ProjectDoc, type ReadonlyMapDoc, type SurfaceAddress, type SurfaceKind, type Tag, type VoxelStructure } from '@papercut/document'
import { commands, defineFeature, dispose, provideFeature, type HotHandle, reserveOwner, tools as toolDeclarations } from '@papercut/registry'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SimulatedClock, setup as setupMachine, types, type AnyActorRef } from 'xstate'

import { createHost, type Feature, type Host } from './host'
import { selectionSubject } from './view'
import type { PointerPress } from './gesture'

/** The root voxel volume a fresh level has, mutable for setup: `createMap` names it `ground`. */
const ground = (doc: ReadonlyMapDoc | MapDoc): VoxelStructure => doc.structures.ground as VoxelStructure


/**
 * #10's shape: a behavior test dispatches at the root actor and asserts
 * through `reader` and the actor snapshots. No React, no DOM, no GL. Setup
 * may construct documents directly — `createMap` plus the ops verbs, sent at
 * the document actor with `apply` below — but every assertion about behavior
 * goes through `dispatch`.
 *
 * `dispatched` records every id this file sends, for the enumeration test at
 * the bottom: a command the registry knows and no test here has dispatched
 * fails that test, the same way "declared but unhandled" is a dead letter.
 */
const dispatched = new Set<string>()

/** A declared tool with no feature behind it, for the tests that press with one. */
const GHOST_OWNER = reserveOwner('ghost-feature')
toolDeclarations.declare(GHOST_OWNER, { id: 'ghost', title: 'Ghost' })

function makeHost(features?: readonly Feature[], project?: ProjectDoc): { host: Host; clock: SimulatedClock; dispatch: Host['dispatch'] } {
  const clock = new SimulatedClock()
  const host = createHost({ document: createDocument(createMap(8, 8)), project, clock, features })
  const dispatch: Host['dispatch'] = (id, args) => {
    dispatched.add(id)
    return host.dispatch(id, args)
  }
  return { host, clock, dispatch }
}

/**
 * Setup: one labelled edit, at the document actor's own event rather than
 * through a command. A test holds the ref the same way the stroke actor does
 * — there is no writer to reach for, which is the point (#13).
 */
function apply(host: Host, label: string, patches: Patch[]): void {
  host.children.document.send({ type: 'patch', label, patches })
}

/** One committed edit, so there is something to undo. */
function raiseOnce(host: Host, x: number, y: number, by = 1): void {
  apply(host, 'Raise', raise(host.reader.doc, ground(host.reader.doc), [[x, y]], by))
}

describe('the document commands, routed to the document actor', () => {
  it('undoes and redoes what the write path recorded, seen through reader', () => {
    const { host, dispatch } = makeHost()
    // A column's height is derived from its voxels, so it is read, never indexed.
    const height = () => topHeight(ground(host.reader.doc), 2, 2)
    const before = height()
    raiseOnce(host, 2, 2, 3)
    expect(height()).toBe(before + 3)

    expect(dispatch('undo')).toEqual({ ok: true })
    expect(height()).toBe(before)

    expect(dispatch('redo')).toEqual({ ok: true })
    expect(height()).toBe(before + 3)
  })

  it('undoes exactly once per dispatch, not twice', () => {
    // Two edits in history, one undo: a doubled write would empty the stack.
    const { host, dispatch } = makeHost()
    raiseOnce(host, 1, 1)
    raiseOnce(host, 2, 2)

    dispatch('undo')

    expect(host.reader.canUndo()).toBe(true)
    expect(host.reader.canRedo()).toBe(true)
  })

  it('is unavailable with nothing to undo, and says which key failed', () => {
    const { dispatch } = makeHost()
    expect(dispatch('undo')).toMatchObject({ ok: false, kind: 'unavailable', reason: expect.stringContaining('document.canUndo') as string })
    expect(dispatch('redo')).toMatchObject({ ok: false, kind: 'unavailable', reason: expect.stringContaining('document.canRedo') as string })
  })

  it('refuses arguments the declaration does not take', () => {
    const { host, dispatch } = makeHost()
    raiseOnce(host, 1, 1)
    expect(dispatch('undo', { steps: 2 })).toMatchObject({ ok: false, kind: 'invalid-args' })
    expect(host.reader.canUndo()).toBe(true)
  })

  /**
   * The writes `App.tsx` made through `store.apply` until #66 step 7. Each is
   * one labelled entry, addressed by stable id or by the document field it
   * owns — there is no store to call any more, so these are the whole of what
   * the inspector, the camera panel and the atmosphere panel can do.
   */
  it('edits an object by id, as one undoable entry', () => {
    const { host, dispatch } = makeHost()
    apply(host, 'Add object', addObject(host.reader.doc, OBJECT))
    expect(dispatch('objects.update', { id: OBJECT.id, changes: { name: 'Renamed', display: 'billboardY' } })).toEqual({ ok: true })

    expect(host.reader.doc.objects[OBJECT.id].name).toBe('Renamed')
    expect(host.reader.doc.objects[OBJECT.id].display).toBe('billboardY')
    // Untouched fields survive: the handler merges onto the object it read.
    expect(host.reader.doc.objects[OBJECT.id].sprite).toBe(OBJECT.sprite)
    expect(host.reader.undoLabel()).toBe('Edit object')

    dispatch('undo')
    expect(host.reader.doc.objects[OBJECT.id].name).toBe(OBJECT.name)
  })

  it('records nothing for an object id the document does not hold', () => {
    const { host, dispatch } = makeHost()
    expect(dispatch('objects.update', { id: 'nobody', changes: { name: 'x' } })).toEqual({ ok: true })
    expect(host.reader.canUndo()).toBe(false)
  })

  it('refuses an object change the schema does not name, rather than writing it', () => {
    const { host, dispatch } = makeHost()
    apply(host, 'Add object', addObject(host.reader.doc, OBJECT))
    // `id` is identity, not an edit; `seed` is what makes an export
    // reproducible. Both are absent from the schema, so `.strict()` refuses.
    expect(dispatch('objects.update', { id: OBJECT.id, changes: { seed: 9 } })).toMatchObject({ ok: false, kind: 'invalid-args' })
    // Nothing was written: the top of the stack is still the setup's entry.
    expect(host.reader.undoLabel()).toBe('Add object')
  })

  it('replaces the project\'s material list whole, so a reorder is one change and no face changes', () => {
    const { host, dispatch } = makeHost()
    const project = () => host.children.project.getSnapshot().context.project
    const before = project().materials
    const reordered = [...before].reverse()
    const faces: unknown = JSON.parse(JSON.stringify(ground(host.reader.doc).paint.faces))
    const undo = host.reader.undoLabel()
    expect(dispatch('project.materials.set', { materials: reordered })).toEqual({ ok: true })
    expect(project().materials.map((m) => m.id)).toEqual(reordered.map((m) => m.id))
    // A project setting, not a document edit: nothing lands on the undo stack.
    expect(host.reader.undoLabel()).toBe(undo)
    // The list's order is only its priority: a face names its material by id, so no face changed what it is made of.
    expect(ground(host.reader.doc).paint.faces).toEqual(faces)
    const first = slotMaterial(ground(host.reader.doc).paint.faces['0,0,0,4'][0]) ?? -1
    expect(materialById(project().materials, first)?.name).toBe(materialById(before, first)?.name)
    // A material owes the slots of an archetype papercut ships, so one naming anything else is not a material.
    expect(dispatch('project.materials.set', { materials: [{ id: 9, name: 'X', color: 0, archetype: 'any' }] })).toMatchObject({ ok: false, kind: 'invalid-args' })
    // And two materials may not share an id: a voxel names its material by it.
    expect(dispatch('project.materials.set', { materials: [before[0], { ...before[1], id: before[0].id }] })).toMatchObject({ ok: false, kind: 'invalid-args' })
    // A material has no `side` any more (ruling of 2026-09-18): each face carries its own material layers.
    expect(dispatch('project.materials.set', { materials: [{ id: 9, name: 'X', color: 0, archetype: 'floor', side: 9 }] })).toMatchObject({ ok: false, kind: 'invalid-args' })
  })

  it('takes a deleted material\'s tags with it, and lets the library empty (ruling of 2026-09-19)', () => {
    const { host, dispatch } = makeHost()
    const project = () => host.children.project.getSnapshot().context.project
    const [first, second] = project().materials
    const entry = { ...project().images[0], terrain: { tiles: { 0: [tagOf(first.id), tagOf(second.id), null, null], 1: [tagOf(first.id), null, null, null] } }, layout: { convention: 'corner-blocks', origin: { x: 0, y: 0 }, materials: [first.id, second.id] } }
    expect(dispatch('project.images.set', { images: [entry] })).toEqual({ ok: true })
    expect(dispatch('project.materials.set', { materials: project().materials.filter((m) => m.id !== first.id) })).toEqual({ ok: true })
    // The tag naming it is cleared; a tile left with no tag is dropped; the layout lays out the rest.
    expect(project().images[0].terrain.tiles).toEqual({ 0: [null, tagOf(second.id), null, null] })
    expect(project().images[0].layout?.materials).toEqual([second.id])
    expect(dispatch('project.materials.set', { materials: [] })).toEqual({ ok: true })
    expect(project().materials).toEqual([])
    expect(project().images[0].terrain.tiles).toEqual({})
  })

  it('holds the project the app opened, and takes its settings and lists as commands', () => {
    const opened = createProject('Harbour Town', 32)
    const { host, dispatch } = makeHost(undefined, opened)
    const project = () => host.children.project.getSnapshot().context.project
    expect(project()).toBe(opened)
    expect(dispatch('project.set', { name: 'Harbour', resolution: { texelDensity: 16, filtering: 'linear' } })).toEqual({ ok: true })
    expect(project().name).toBe('Harbour')
    expect(project().resolution).toEqual({ texelDensity: 16, filtering: 'linear' })
    expect(dispatch('project.maps.set', { maps: ['maps/a.map.json', 'maps/b.map.json'] })).toEqual({ ok: true })
    expect(project().maps).toEqual(['maps/a.map.json', 'maps/b.map.json'])
    // Paths stay inside the folder, and a sheet is named by its file name, so two cannot share one.
    expect(dispatch('project.maps.set', { maps: ['../outside.map.json'] })).toMatchObject({ ok: false, kind: 'invalid-args' })
    // A sprite is a named region of a listed image (ruling of 2026-09-18); one cut from an image the project does not
    // list could never draw, and two of one name would be ambiguous.
    const tree = { name: 'tree', image: 1, rect: { x: 0, y: 0, w: 2, h: 3 } }
    expect(dispatch('project.sprites.set', { sprites: [tree] })).toEqual({ ok: true })
    expect(project().sprites).toEqual([tree])
    dispatch('project.sprites.set', { sprites: [{ ...tree, image: 9 }] })
    expect(project().sprites).toEqual([tree])
    expect(dispatch('project.sprites.set', { sprites: [tree, tree] })).toMatchObject({ ok: false, kind: 'invalid-args' })
    const image = (path: string, terrain: { tiles: Record<string, [Tag, Tag, Tag, Tag]> } = { tiles: {} }, id = 2) => ({ id, path, name: 'A', kind: 'tileset', hash: null, grid: { tile: 16, margin: { x: 0, y: 0 }, spacing: { x: 0, y: 0 } }, terrain })
    expect(dispatch('project.images.set', { images: [image('sheets/a.png'), image('other/a.png', undefined, 3)] })).toMatchObject({ ok: false, kind: 'invalid-args' })
    // An image is identified by its id (ruling of 2026-09-18), so two cannot share one either.
    expect(dispatch('project.images.set', { images: [image('sheets/a.png'), image('sheets/b.png')] })).toMatchObject({ ok: false, kind: 'invalid-args' })
    // A tag names a material (ruling of 2026-09-17), so a word that is nobody's id is refused.
    expect(dispatch('project.images.set', { images: [image('sheets/a.png', { tiles: { 0: [tagOf(0), 'grass', null, null] } })] })).toMatchObject({ ok: false, kind: 'invalid-args' })
    const tagged = image('sheets/a.png', { tiles: { 0: [tagOf(0), tagOf(2, 'convex'), null, null] } })
    expect(dispatch('project.images.set', { images: [tagged] })).toEqual({ ok: true })
    // An entry always carries a layout; leaving it out means there is none, and it comes back as `null`.
    expect(project().images).toEqual([{ ...tagged, layout: null }])
    // The tree sprite was cut from the placeholder sheet, which this list no longer has: it went with its image.
    expect(project().sprites).toEqual([])
    // A layout names its materials by id, and rides through the command the same way the tags do.
    const laid = { ...tagged, layout: { convention: 'corner-blocks', origin: { x: 0, y: 0 }, materials: [0, 2] } }
    expect(dispatch('project.images.set', { images: [laid] })).toEqual({ ok: true })
    expect(project().images).toEqual([laid])
    host.stop()
  })

  it('opens a project from its file text and folder, tracks the current map, and closes back to none', () => {
    const { host, dispatch } = makeHost()
    const project = () => host.children.project.getSnapshot().context
    expect(project().folder).toBeNull()
    // Closing needs a project to close: the key says none is open.
    expect(dispatch('project.close')).toMatchObject({ ok: false, kind: 'unavailable' })
    // A file that will not parse is refused as invalid-args carrying the load error, and nothing changes.
    expect(dispatch('project.load', { folder: '/p', json: '{"formatVersion": 1}' })).toMatchObject({ ok: false, kind: 'invalid-args' })
    expect(project().folder).toBeNull()
    const opened = createProject('Harbour Town', 16)
    opened.maps = ['maps/a.map.json']
    expect(dispatch('project.load', { folder: '/projects/harbour', json: serializeProject(opened) })).toEqual({ ok: true })
    expect(project()).toMatchObject({ folder: '/projects/harbour', map: null })
    expect(project().project).toEqual(opened)
    expect(host.contextKeys()['project.open']).toBe(true)
    expect(dispatch('project.current', { map: 'maps/a.map.json' })).toEqual({ ok: true })
    expect(project().map).toBe('maps/a.map.json')
    expect(dispatch('project.current', { map: '../escape.map.json' })).toMatchObject({ ok: false, kind: 'invalid-args' })
    expect(dispatch('project.close')).toEqual({ ok: true })
    expect(project()).toMatchObject({ folder: null, map: null })
    expect(project().project.name).toBe('Untitled Project')
  })

  it('merges the camera rig and the atmosphere, one entry each', () => {
    const { host, dispatch } = makeHost()
    const fov = host.reader.doc.camera.fov
    expect(dispatch('camera.set', { yawSnapDeg: 90 })).toEqual({ ok: true })
    expect(host.reader.doc.camera.yawSnapDeg).toBe(90)
    expect(host.reader.doc.camera.fov).toBe(fov)
    expect(host.reader.undoLabel()).toBe('Camera rig')

    expect(dispatch('atmosphere.set', { bloom: 1.25 })).toEqual({ ok: true })
    expect(host.reader.doc.atmosphere.bloom).toBe(1.25)
    expect(host.reader.doc.atmosphere.preset).toBe('Clear noon')
    expect(host.reader.undoLabel()).toBe('Atmosphere')

    dispatch('undo')
    expect(host.reader.doc.atmosphere.bloom).not.toBe(1.25)
    expect(host.reader.doc.camera.yawSnapDeg).toBe(90)
  })

  it('opens a map from its text, clearing the history the replaced document owned', () => {
    const { host, dispatch } = makeHost()
    raiseOnce(host, 1, 1)
    expect(host.reader.canUndo()).toBe(true)

    const other = createMap(6, 6, 'Other')
    expect(dispatch('document.load', { json: serialize(other) })).toEqual({ ok: true })
    expect(host.reader.doc.name).toBe('Other')
    expect(ground(host.reader.doc).size).toEqual({ width: 6, height: 6 })
    // Nothing on the stack addresses a document that is gone.
    expect(host.reader.canUndo()).toBe(false)
  })

  it('refuses a malformed map as invalid-args carrying the load error, and leaves the document alone', () => {
    // The parse lives in the schema so a refusal is a RESULT (#8) rather than
    // a throw inside the enqueued write. A transition that never ran is what
    // keeps the open document open.
    const { host, dispatch } = makeHost()
    const name = host.reader.doc.name
    // The current format, so the failure is the missing structures and not the version gate in front of them.
    expect(dispatch('document.load', { json: JSON.stringify({ formatVersion: FORMAT_VERSION }) })).toMatchObject({
      ok: false,
      kind: 'invalid-args',
      issues: [{ path: ['json'], message: expect.stringContaining('no structures') as string }],
    })
    expect(host.reader.doc.name).toBe(name)
  })

  it('starts a blank map at the size asked for', () => {
    const { host, dispatch } = makeHost()
    raiseOnce(host, 1, 1)
    expect(dispatch('document.new', { width: 4, height: 4, name: 'Fresh' })).toEqual({ ok: true })
    expect(ground(host.reader.doc).size).toEqual({ width: 4, height: 4 })
    expect(host.reader.doc.name).toBe('Fresh')
    expect(host.reader.canUndo()).toBe(false)
    expect(dispatch('document.new', { width: 0, height: 4 })).toMatchObject({ ok: false, kind: 'invalid-args' })
  })

  it('moves the reader generation on a replace and on nothing else, so a renderer re-points itself', () => {
    // The renderer caches the document BY REFERENCE (`RuntimeScene`), and no
    // patch and no dirty chunk says "that object is not the document any
    // more". `generation` is that announcement, and it is on the read path
    // the viewport already drains every frame — which is what makes these two
    // commands dispatchable from anywhere rather than only from the one App
    // callback that used to call `viewport.reset()` by hand beside them.
    const { host, dispatch } = makeHost()
    const start = host.reader.generation

    raiseOnce(host, 1, 1)
    dispatch('camera.set', { yaw: 10 })
    expect(host.reader.revision).toBeGreaterThan(0)
    expect(host.reader.generation).toBe(start)

    expect(dispatch('document.new', { width: 4, height: 4, name: 'Fresh' })).toEqual({ ok: true })
    expect(host.reader.generation).toBe(start + 1)

    expect(dispatch('document.load', { json: serialize(createMap(6, 6, 'Other')) })).toEqual({ ok: true })
    expect(host.reader.generation).toBe(start + 2)

    // A refused load replaced nothing, so it announces nothing.
    expect(dispatch('document.load', { json: '{ "formatVersion": 1 }' })).toMatchObject({ ok: false })
    expect(host.reader.generation).toBe(start + 2)
  })
})

describe('mode: the host\'s own top-level state', () => {
  it('enters and leaves play, and the mode key follows the live snapshot', () => {
    const { host, dispatch } = makeHost()
    expect(host.actor.getSnapshot().value).toBe('edit')
    expect(host.contextKeys()['host.mode']).toBe('edit')

    expect(dispatch('mode.play')).toEqual({ ok: true })
    expect(host.actor.getSnapshot().value).toBe('play')
    // #8's finding 2: keys are derived per dispatch. A snapshot frozen at
    // construction would still say `edit` here and leave `mode.edit`
    // permanently unavailable.
    expect(host.contextKeys()['host.mode']).toBe('play')

    expect(dispatch('mode.edit')).toEqual({ ok: true })
    expect(host.actor.getSnapshot().value).toBe('edit')
  })

  it('refuses the mode it is already in, with the reason', () => {
    const { dispatch } = makeHost()
    expect(dispatch('mode.edit')).toMatchObject({ ok: false, kind: 'unavailable', reason: expect.stringContaining('host.mode') as string })
    dispatch('mode.play')
    expect(dispatch('mode.play')).toMatchObject({ ok: false, kind: 'unavailable' })
  })

  it('keeps routing to children while playing', () => {
    const { host, dispatch } = makeHost()
    dispatch('mode.play')
    expect(dispatch('view.set', { showGrid: false })).toEqual({ ok: true })
    expect(host.children.view.getSnapshot().context.showGrid).toBe(false)
  })

  it('spawns a play session that knows where the character stands up, and stops it on the way out', () => {
    // #11: the session is an actor with the session's lifetime, not a flag.
    // What it holds is read from the document once, at spawn — the middle of
    // the map, on the ground under that point — which is what the viewport's
    // `togglePlay` used to compute for itself.
    const { host, dispatch } = makeHost()
    expect(host.playSession()).toBeNull()

    apply(host, 'Raise', raise(host.reader.doc, ground(host.reader.doc), [[4, 4]], 6))
    dispatch('mode.play')
    const session = host.playSession()
    expect(session?.start).toEqual([4, groundHeight(host.reader.doc, 4, 4), 4])
    expect(host.actor.getSnapshot().context.play?.getSnapshot().status).toBe('active')

    // Stopped through `enq`, and the ref is retained: what says the session is
    // over is the mode, so `playSession` answers null while the stopped child
    // is still addressable.
    const ref = host.actor.getSnapshot().context.play
    dispatch('mode.edit')
    expect(host.playSession()).toBeNull()
    expect(ref?.getSnapshot().status).toBe('stopped')
    expect(host.actor.getSnapshot().context.play).toBe(ref)
  })

  it('reads the ground again for the NEXT session, not for the one already walking', () => {
    const { host, dispatch } = makeHost()
    dispatch('mode.play')
    const first = host.playSession()?.start
    apply(host, 'Raise', raise(host.reader.doc, ground(host.reader.doc), [[4, 4]], 4))
    expect(host.playSession()?.start).toEqual(first)

    dispatch('mode.edit')
    dispatch('mode.play')
    expect(host.playSession()?.start).toEqual([4, groundHeight(host.reader.doc, 4, 4), 4])
    expect(host.playSession()?.start).not.toEqual(first)
  })
})

describe('tools: the active tool and the sprite are the host\'s; every other parameter is a feature\'s slice', () => {
  it('sets the tool and the sprite, together or apart', () => {
    const { host, dispatch } = makeHost()
    expect(dispatch('tools.set', { tool: 'object', spriteName: 'rock' })).toEqual({ ok: true })
    const after = host.children.tools.getSnapshot().context
    expect(after.tool).toBe('object')
    expect(after.spriteName).toBe('rock')
  })

  it('exposes the active tool as a key', () => {
    const { host, dispatch } = makeHost()
    expect(host.contextKeys()['tools.tool']).toBe('select')
    dispatch('tools.set', { tool: 'object' })
    expect(host.contextKeys()['tools.tool']).toBe('object')
  })

  it('refuses a tool nobody declared, and a parameter that is not the host\'s', () => {
    const { host, dispatch } = makeHost()
    // Declared by no owner: not a tool; the transition is not taken.
    dispatch('tools.set', { tool: 'lathe' })
    expect(host.children.tools.getSnapshot().context.tool).toBe('select')
    // A feature's parameter goes through the feature's own command, never here.
    expect(dispatch('tools.set', { brush: { size: 5, shape: 'circle' } })).toMatchObject({ ok: false, kind: 'invalid-args' })
    expect(dispatch('tools.set', { tool: undefined })).toMatchObject({ ok: false, kind: 'invalid-args', issues: [{ path: ['tool'] }] })
    expect(dispatch('tools.set')).toMatchObject({ ok: false, kind: 'invalid-args' })
  })
})


describe('view and selection', () => {
  it('sets the toggles', () => {
    const { host, dispatch } = makeHost()
    expect(dispatch('view.set', { gameCamera: true, inspector: 'outliner', levelOpen: true, notice: 'Saved sample.map.json' })).toEqual({ ok: true })
    const { context } = host.children.view.getSnapshot()
    expect(context.gameCamera).toBe(true)
    expect(context.inspector).toBe('outliner')
    expect(context.showGrid).toBe(true)
    expect(context.levelOpen).toBe(true)
    expect(context.notice).toBe('Saved sample.map.json')
    expect(dispatch('view.set', { notice: null })).toEqual({ ok: true })
    expect(dispatch('view.set', { projection: 'orthographic' })).toEqual({ ok: true })
    expect(host.children.view.getSnapshot().context.projection).toBe('orthographic')
    expect(dispatch('view.set', { projection: 'isometric' })).toMatchObject({ ok: false, kind: 'invalid-args' })
    expect(host.children.view.getSnapshot().context.notice).toBeNull()
  })

  it('holds the layer view range, validated against the document bounds, cleared with null', () => {
    const { host, dispatch } = makeHost()
    expect(host.children.view.getSnapshot().context.layers).toBeNull()
    expect(dispatch('view.set', { layers: { lo: 1, hi: 6 } })).toEqual({ ok: true })
    expect(host.children.view.getSnapshot().context.layers).toEqual({ lo: 1, hi: 6 })
    expect(dispatch('view.set', { layers: { lo: 7, hi: 6 } })).toMatchObject({ ok: false, kind: 'invalid-args' })
    expect(dispatch('view.set', { layers: { lo: 0, hi: 99 } })).toMatchObject({ ok: false, kind: 'invalid-args' })
    expect(dispatch('view.set', { layers: { lo: 0.5, hi: 6 } })).toMatchObject({ ok: false, kind: 'invalid-args' })
    expect(host.children.view.getSnapshot().context.layers).toEqual({ lo: 1, hi: 6 })
    expect(dispatch('view.set', { layers: null })).toEqual({ ok: true })
    expect(host.children.view.getSnapshot().context.layers).toBeNull()
  })

  it('rejects an explicitly undefined toggle and keeps the previous value', () => {
    const { host, dispatch } = makeHost()
    expect(host.children.view.getSnapshot().context.showGrid).toBe(true)

    expect(dispatch('view.set', { showGrid: undefined })).toMatchObject({ ok: false, kind: 'invalid-args', issues: [{ path: ['showGrid'] }] })

    const { context } = host.children.view.getSnapshot()
    expect(context.showGrid).toBe(true)
    expect(Object.values(context)).not.toContain(undefined)
  })

  it('selection by stable id, cleared with null, mirrored by hasSelection', () => {
    const { host, dispatch } = makeHost()
    expect(host.contextKeys()['view.hasSelection']).toBe(false)

    expect(dispatch('selection.set', { id: 'obj-1' })).toEqual({ ok: true })
    expect(host.children.view.getSnapshot().context.selectedObjectId).toBe('obj-1')
    expect(host.contextKeys()['view.hasSelection']).toBe(true)

    expect(dispatch('selection.set', { id: null })).toEqual({ ok: true })
    expect(host.contextKeys()['view.hasSelection']).toBe(false)
  })

  it('refuses a selection that is not an id', () => {
    const { dispatch } = makeHost()
    expect(dispatch('selection.set', { id: 42 })).toMatchObject({ ok: false, kind: 'invalid-args' })
    expect(dispatch('selection.set', {})).toMatchObject({ ok: false, kind: 'invalid-args' })
  })
})

describe('the ways a dispatch does not happen', () => {
  it('unknown: nobody declared the id', () => {
    const { dispatch } = makeHost()
    expect(dispatch('terrain.melt')).toMatchObject({ ok: false, kind: 'unknown' })
  })

  it('unhandled: declared, but its owner\'s actor was never started', () => {
    commands.declare('test.ghost', { id: 'test.ghost.wave', title: 'Wave' })
    try {
      const { host, dispatch } = makeHost()
      expect(dispatch('test.ghost.wave')).toMatchObject({ ok: false, kind: 'unhandled', reason: expect.stringContaining('never started') as string })
      // No ref means no dead letter: `enq.sendTo(undefined)` is silent, so
      // the dispatcher answers this shape before sending.
      expect(host.deadLetters).toEqual([])
    } finally {
      dispose('test.ghost')
    }
  })
})

// --- pointer input -------------------------------------------------------------

const NO_MODIFIERS = { shift: false, alt: false, ctrl: false }

function topAt(x: number, y: number): SurfaceAddress {
  return { structure: 'ground', kind: 0, x, y, dir: -1, level: 0 }
}

/** A minimal object to drag; the tests that use it override position and anchor. */
const OBJECT: MapObject = {
  id: 'obj-1',
  name: 'tree',
  sprite: 'tree',
  position: [0, 0, 0],
  rotationY: 0,
  scale: 1,
  display: 'auto',
  facing: defaultFacing(),
  anchorCell: [0, 0],
  seed: 0,
  locked: false,
  hidden: false,
}

function pressAt(x: number, y: number, extra: Partial<PointerPress> = {}): PointerPress {
  return { x: x * 10, y: y * 10, button: 0, modifiers: NO_MODIFIERS, pick: { surface: topAt(x, y), point: { x, z: y }, objectId: null }, ...extra }
}

/**
 * The editor's gestures through `Host.input`: the arbitration actor, the
 * stroke actor it spawns, and the document actor the patches reach — asserted
 * through `reader`.
 *
 * Every press below is the OBJECT tool's, which is the only tool whose handler
 * this package still owns. The terrain tool's is `feature-terrain`'s, reached
 * through the contract its owner contributed, and a host built here installs
 * no features — so a terrain press finds no contract and starts nothing. The
 * same gestures over the real terrain contract are in `apps/editor`, which is
 * the only place the two halves may be seen at once (#35).
 */
describe('pointer input through the host', () => {
  it('refuses a mid-drag delete of the object being dragged, so no orphan survives the undo', () => {
    // Same keyboard path as the test above, but now the write collides: the
    // object tool drags the SELECTED object, and Delete deletes the
    // selection. Recorded independently they unwind backwards — the stroke's
    // entry pops first and writes `doc.objects[A]` while `objectOrder`, which
    // only the delete's entry owns, stays without it. The store refuses the
    // colliding write, and `selection.delete` is unavailable mid-drag — the
    // open-stroke check `App.tsx` used to make against the store, now a
    // predicate that says why — so the drag is all that happened and one undo
    // takes it back whole.
    const { host, dispatch } = makeHost()
    dispatch('tools.set', { tool: 'object' })
    const object = { ...OBJECT, position: [1.5, 0, 1.5] as [number, number, number], anchorCell: [1, 1] as [number, number] }
    apply(host, 'Add object', addObject(host.reader.doc, object))
    const doc = host.reader.doc

    const onObject = { pick: { surface: topAt(1, 1), point: { x: 1.5, z: 1.5 }, objectId: object.id } }
    expect(host.input.pointerDown(pressAt(1, 1, onObject))).toBe('stroke')
    expect(host.children.view.getSnapshot().context.selectedObjectId).toBe(object.id)
    host.input.pointerMove({ x: 50, y: 50, modifiers: NO_MODIFIERS })
    host.input.strokeMove({ surface: topAt(5, 5), point: { x: 5.5, z: 5.5 }, objectId: null }, NO_MODIFIERS)
    // Ground level comes from the terrain, so only x and z are the drag's.
    const groundPlane = (id: string) => [doc.objects[id]?.position[0], doc.objects[id]?.position[2]]
    expect(groundPlane(object.id)).toEqual([5.5, 5.5])

    expect(host.contextKeys()['host.stroking']).toBe(true)
    expect(dispatch('selection.delete')).toMatchObject({
      ok: false,
      kind: 'unavailable',
      reason: expect.stringContaining('host.stroking') as string,
    })
    // And the store would have refused it even if the predicate had not.
    apply(host, 'Delete object', removeObject(doc, object.id))
    expect(doc.objectOrder).toEqual([object.id])

    host.input.pointerUp({ x: 50, y: 50 })
    expect(host.reader.undoLabel()).toBe('Edit object')
    expect(dispatch('undo')).toEqual({ ok: true })
    // The invariant: an id in `objects` is an id in `objectOrder`, and the
    // object is back where the drag began, not where it ended.
    expect(Object.keys(doc.objects)).toEqual(doc.objectOrder)
    expect(groundPlane(object.id)).toEqual([1.5, 1.5])
  })

  it('refuses undo and redo while the stroke is open, and says which key failed', () => {
    const { host, dispatch } = makeHost()
    dispatch('tools.set', { tool: 'object' })
    raiseOnce(host, 5, 5)
    expect(host.reader.canUndo()).toBe(true)

    host.input.pointerDown(pressAt(3, 3))
    expect(host.reader.canUndo()).toBe(false)
    expect(dispatch('undo')).toMatchObject({ ok: false, kind: 'unavailable' })
    host.input.pointerUp({ x: 30, y: 30 })
    expect(dispatch('undo')).toEqual({ ok: true })
  })

  it('a press with a tool whose feature was never installed starts nothing', () => {
    // `terrain`'s handler belongs to a feature this host was not given.
    // `toolContract` answers `undefined`, so the gesture actor spawns no
    // stroke — the same fall-through a declined press gets, rather than a
    // half-live stroke over a tool nothing implements.
    // A tool some owner declared — the rail can show it — whose feature was never given to this host.
    const { host, dispatch } = makeHost()
    dispatch('tools.set', { tool: 'ghost' })
    expect(host.contextKeys()['tools.tool']).toBe('ghost')
    expect(host.toolContract('ghost')).toBeUndefined()

    expect(host.input.pointerDown(pressAt(3, 3))).toBe('none')
    host.input.pointerUp({ x: 30, y: 30 })
    expect(host.reader.canUndo()).toBe(false)
  })

  it('in play mode a left press starts no stroke, while middle and right still orbit and pan', () => {
    const { host, dispatch } = makeHost()
    dispatch('tools.set', { tool: 'object', spriteName: 'tree' })
    dispatch('mode.play')

    expect(host.input.pointerDown(pressAt(1, 1))).toBe('none')
    host.input.pointerUp({ x: 10, y: 10 })
    expect(host.reader.doc.objectOrder).toEqual([])
    expect(host.reader.canUndo()).toBe(false)

    expect(host.input.pointerDown(pressAt(1, 1, { button: 1, pick: null }))).toBe('orbit')
    host.input.pointerUp({ x: 10, y: 10 })
    expect(host.input.pointerDown(pressAt(1, 1, { button: 2, pick: null }))).toBe('pan')
    host.input.pointerUp({ x: 10, y: 10 })

    // Back in edit mode the same press strokes again: `editing` is read per press.
    dispatch('mode.edit')
    expect(host.input.pointerDown(pressAt(1, 1))).toBe('stroke')
    host.input.pointerUp({ x: 10, y: 10 })
    expect(host.reader.doc.objectOrder).toHaveLength(1)
    expect(host.reader.canUndo()).toBe(true)
  })

  it('the object tool places on a press, drags what it placed, and selects it through the view actor', () => {
    const { host, dispatch } = makeHost()
    dispatch('tools.set', { tool: 'object', spriteName: 'tree' })
    const doc = host.reader.doc
    expect(doc.objectOrder).toHaveLength(0)

    // The press is snapped to the grid, as the drag will be: an object stands in the middle of its cell.
    host.input.pointerDown(pressAt(2, 2, { pick: { surface: topAt(2, 2), point: { x: 2.4, z: 2.4 }, objectId: null } }))
    expect(doc.objectOrder).toHaveLength(1)
    const id = doc.objectOrder[0]
    expect(doc.objects[id].position[0]).toBe(2.5)
    expect(host.children.view.getSnapshot().context.selectedObjectId).toBe(id)
    expect(host.contextKeys()['view.hasSelection']).toBe(true)

    host.input.strokeMove({ surface: topAt(4, 4), point: { x: 4.4, z: 4.4 }, objectId: null }, NO_MODIFIERS)
    expect(doc.objects[id].position[0]).toBe(4.5)
    host.input.pointerUp({ x: 40, y: 40 })
    expect(host.reader.undoLabel()).toBe('Edit object')
  })

  it('the select tool selects what it presses — an object, or the structure under the pointer — clears on nothing unless shift is held, and never places', () => {
    const { host, dispatch } = makeHost()
    dispatch('tools.set', { tool: 'object', spriteName: 'tree' })
    host.input.pointerDown(pressAt(2, 2, { pick: { surface: topAt(2, 2), point: { x: 2, z: 2 }, objectId: null } }))
    host.input.pointerUp({ x: 20, y: 20 })
    const doc = host.reader.doc
    const id = doc.objectOrder[0]
    expect(id).toBeDefined()

    // The default tool. The ground is a structure like any other: pressing it selects it, and adds nothing.
    dispatch('tools.set', { tool: 'select' })
    host.input.pointerDown(pressAt(5, 5, { pick: { surface: topAt(5, 5), point: { x: 5.5, z: 5.5 }, objectId: null } }))
    host.input.pointerUp({ x: 50, y: 50 })
    expect(doc.objectOrder).toHaveLength(1)
    expect(host.children.view.getSnapshot().context.selection).toEqual({ kind: 'structure', id: 'ground' })
    // Nothing was edited: the last entry is still the placement.
    expect(host.reader.undoLabel()).toBe('Edit object')

    // Pressing nothing at all clears it.
    host.input.pointerDown(pressAt(7, 7, { pick: { surface: null, point: null, objectId: null } }))
    host.input.pointerUp({ x: 70, y: 70 })
    expect(host.children.view.getSnapshot().context.selection).toBeNull()

    // Pressing the object selects it, and the rest of the drag moves it, snapped to a cell's centre.
    host.input.pointerDown(pressAt(2, 2, { pick: { surface: topAt(2, 2), point: { x: 2.5, z: 2.5 }, objectId: id } }))
    expect(host.children.view.getSnapshot().context.selectedObjectId).toBe(id)
    host.input.strokeMove({ surface: topAt(4, 4), point: { x: 4.6, z: 4.6 }, objectId: null }, NO_MODIFIERS)
    expect(doc.objects[id].position[0]).toBe(4.5)
    host.input.pointerUp({ x: 40, y: 40 })
    expect(host.reader.undoLabel()).toBe('Move object')

    // Shift on nothing keeps the selection.
    host.input.pointerDown(pressAt(6, 6, { pick: { surface: null, point: null, objectId: null }, modifiers: { ...NO_MODIFIERS, shift: true } }))
    host.input.pointerUp({ x: 60, y: 60 })
    expect(host.children.view.getSnapshot().context.selectedObjectId).toBe(id)
    expect(doc.objectOrder).toHaveLength(1)
  })

  it('a drag snaps as the tools actor says; ctrl frees one drag; shift holds it to an axis', () => {
    const { host, dispatch } = makeHost()
    apply(host, 'Add', addObject(host.reader.doc, { ...OBJECT, position: [2.5, 0, 2.5], anchorCell: [2, 2] }))
    const doc = host.reader.doc
    dispatch('tools.set', { tool: 'select' })
    const grab = () => host.input.pointerDown(pressAt(2, 2, { pick: { surface: topAt(2, 2), point: { x: 2.8, z: 2.8 }, objectId: OBJECT.id } }))

    // Grid: the middle of a cell. The grab was 0.3 off the object, and that offset rides along before the snap.
    grab()
    host.input.strokeMove({ surface: null, point: null, objectId: null, plane: { x: 5.6, z: 4.4 } }, NO_MODIFIERS)
    expect([doc.objects[OBJECT.id].position[0], doc.objects[OBJECT.id].position[2]]).toEqual([5.5, 4.5])
    // Ctrl (Cmd on a Mac) frees it, to the hundredth.
    host.input.strokeMove({ surface: null, point: null, objectId: null, plane: { x: 5.6, z: 4.4 } }, { ...NO_MODIFIERS, ctrl: true })
    expect([doc.objects[OBJECT.id].position[0], doc.objects[OBJECT.id].position[2]]).toEqual([5.3, 4.1])
    // Shift holds the drag to the axis it has moved further along, measured from the press.
    host.input.strokeMove({ surface: null, point: null, objectId: null, plane: { x: 6.8, z: 3.8 } }, { ...NO_MODIFIERS, shift: true })
    expect([doc.objects[OBJECT.id].position[0], doc.objects[OBJECT.id].position[2]]).toEqual([6.5, 2.5])
    host.input.pointerUp({ x: 60, y: 30 })

    // Half cells, set on the tools actor and read per tick. The object is at (6.5, 2.5) now, and the
    // grab is again 0.3 past the press cell, so the same travel lands 2.8 east and 1.6 south of it.
    expect(dispatch('tools.set', { snap: 'half' })).toEqual({ ok: true })
    grab()
    host.input.strokeMove({ surface: null, point: null, objectId: null, plane: { x: 5.6, z: 4.4 } }, NO_MODIFIERS)
    expect([doc.objects[OBJECT.id].position[0], doc.objects[OBJECT.id].position[2]]).toEqual([9.5, 4])
    host.input.pointerUp({ x: 50, y: 40 })
    expect(dispatch('tools.set', { snap: 'sticky' })).toMatchObject({ ok: false })
  })

  it('the select tool drags a structure by its placement in its parent, and never the root', () => {
    const { host, dispatch } = makeHost()
    dispatch('sketch.new', { parent: 'ground', name: 'Island' })
    const doc = host.reader.doc
    const island = doc.structureOrder.find((id) => id !== 'ground') as string
    dispatch('structure.place', { id: island, placement: { x: 3, z: 3, yaw: 0 } })
    dispatch('tools.set', { tool: 'select' })

    const cap: SurfaceAddress = { structure: island, kind: 3, x: 0, y: 0, dir: -1, level: 0 }
    host.input.pointerDown(pressAt(4, 4, { pick: { surface: cap, point: { x: 4.2, z: 4.2 }, objectId: null } }))
    expect(host.children.view.getSnapshot().context.selection).toEqual({ kind: 'structure', id: island })
    host.input.strokeMove({ surface: null, point: null, objectId: null, plane: { x: 6.3, z: 5.1 } }, NO_MODIFIERS)
    expect(doc.structures[island].placement).toEqual({ x: 5, z: 4, yaw: 0 })
    host.input.pointerUp({ x: 60, y: 50 })
    expect(host.reader.undoLabel()).toBe('Move structure')

    // The root sits on the level itself: a press selects it, the drag moves nothing.
    host.input.pointerDown(pressAt(1, 1, { pick: { surface: topAt(1, 1), point: { x: 1, z: 1 }, objectId: null } }))
    host.input.strokeMove({ surface: null, point: null, objectId: null, plane: { x: 4, z: 4 } }, NO_MODIFIERS)
    host.input.pointerUp({ x: 40, y: 40 })
    expect(doc.structures.ground.placement).toEqual({ x: 0, z: 0, yaw: 0 })
    expect(host.reader.undoLabel()).toBe('Move structure')
  })

  it('a drag keeps the grabbed point under the pointer and follows the press plane, not what the ray hits', () => {
    const { host, dispatch } = makeHost()
    dispatch('tools.set', { tool: 'object', spriteName: 'tree' })
    host.input.pointerDown(pressAt(2, 2, { pick: { surface: topAt(2, 2), point: { x: 2, z: 2 }, objectId: null } }))
    host.input.pointerUp({ x: 20, y: 20 })
    const doc = host.reader.doc
    const id = doc.objectOrder[0]
    expect(doc.objects[id].position[0]).toBe(2.5)

    // Grab the tree half a cell off its position: that half-cell is the offset.
    dispatch('tools.set', { tool: 'select' })
    host.input.pointerDown(pressAt(2, 2, { pick: { surface: null, point: { x: 3, z: 3 }, objectId: id } }))
    // Mid-drag the ray hits the dragged sprite itself (`point` is the sprite
    // plane, `objectId` the tree); the plane point is what the move reads.
    host.input.strokeMove({ surface: null, point: { x: 9, z: 1 }, objectId: id, plane: { x: 6, z: 7 } }, NO_MODIFIERS)
    expect(doc.objects[id].position[0]).toBeCloseTo(5.5)
    expect(doc.objects[id].position[2]).toBeCloseTo(6.5)
    // Without a plane (no camera in a test) the ground point is the fallback, offset applied the same way.
    host.input.strokeMove({ surface: topAt(4, 4), point: { x: 5, z: 5 }, objectId: null }, NO_MODIFIERS)
    expect(doc.objects[id].position[0]).toBeCloseTo(4.5)
    expect(doc.objects[id].position[2]).toBeCloseTo(4.5)
    host.input.pointerUp({ x: 40, y: 40 })
  })

  it('held keys round-trip for the play loop', () => {
    const { host } = makeHost()
    host.input.keyDown('w')
    expect(host.input.heldKeys().has('w')).toBe(true)
    host.input.keyUp('w')
    expect(host.input.heldKeys().has('w')).toBe(false)
  })
})

/**
 * A feature whose actor has a lifetime shorter than the host's — the shape
 * #11 gives strokes, play sessions and async jobs. `finish` runs it to a
 * final state; its declarations stand, so the next command routes to a ref
 * that has stopped.
 */
const jobLogic = setupMachine({
  schemas: {
    context: types<{ pokes: number; disposed: boolean }>(),
    events: { command: types<{ id: string; args: unknown }>(), dispose: types<void>() },
  },
}).createMachine({
  id: 'job',
  context: { pokes: 0, disposed: false },
  initial: 'running',
  states: {
    running: {
      on: {
        command: ({ context, event }) => (event.id === 'test.job.finish' ? { target: 'finished' } : { context: { pokes: context.pokes + 1 } }),
        dispose: () => ({ context: { disposed: true } }),
      },
    },
    finished: { type: 'final' },
  },
})

describe('a child with a lifetime: dead letters are observable', () => {
  beforeAll(() => {
    commands.declare('test.job', { id: 'test.job.poke', title: 'Poke' })
    commands.declare('test.job', { id: 'test.job.finish', title: 'Finish' })
  })
  afterAll(() => dispose('test.job'))

  it('routes to the feature while it runs, dead-letters once it has stopped, and the host survives', () => {
    const { host, dispatch } = makeHost([{ owner: 'test.job', create: () => ({ logic: jobLogic }) }])
    const job = host.child('test.job')
    expect(job).toBeDefined()

    expect(dispatch('test.job.poke')).toEqual({ ok: true })
    expect((job?.getSnapshot() as { context: { pokes: number } }).context.pokes).toBe(1)

    expect(dispatch('test.job.finish')).toEqual({ ok: true })
    expect(job?.getSnapshot().status).toBe('done')

    // THE ONE THAT KILLS A v5 ROUTER (#15). The ref is retained in context,
    // so the send reaches a stopped actor and dead-letters instead of
    // disappearing into `sendTo(undefined)`.
    expect(dispatch('test.job.poke')).toMatchObject({ ok: false, kind: 'unhandled', reason: expect.stringContaining('stopped') as string })
    expect(host.deadLetters).toHaveLength(1)
    expect(host.deadLetters[0]).toMatchObject({ reason: 'stopped', target: 'test.job', event: { type: 'command', id: 'test.job.poke' } })
    expect(host.child('test.job')).toBe(job)
    expect(host.actor.getSnapshot().status).toBe('active')

    // And the router still works afterwards — the real proof.
    expect(dispatch('tools.set', { tool: 'object' })).toEqual({ ok: true })
    expect(host.children.tools.getSnapshot().context.tool).toBe('object')
  })

  it('dispose(owner): revokes the declarations, sends dispose, stops the ref, keeps the ref', () => {
    commands.declare('test.job2', { id: 'test.job2.poke', title: 'Poke' })
    const { host, dispatch } = makeHost([{ owner: 'test.job2', create: () => ({ logic: jobLogic }) }])
    const job = host.child('test.job2')
    expect(dispatch('test.job2.poke')).toEqual({ ok: true })

    host.dispose('test.job2')

    expect(commands.get('test.job2.poke')).toBeUndefined()
    expect(dispatch('test.job2.poke')).toMatchObject({ ok: false, kind: 'unknown' })
    const last = job?.getSnapshot() as { status: string; context: { disposed: boolean } } | undefined
    expect(last?.status).toBe('stopped')
    expect(last?.context.disposed).toBe(true)
    expect(host.child('test.job2')).toBe(job)
    expect(host.actor.getSnapshot().status).toBe('active')
  })

  it('refuses to dispose a reserved owner, and leaves it running', () => {
    const { host, dispatch } = makeHost()
    expect(() => host.dispose('editor-host.tools')).toThrow(/reserved/)
    expect(dispatch('tools.set', { spriteName: 'rock' })).toEqual({ ok: true })
  })
})

/**
 * Vite's half of a hot update, as a stub: it records the disposer so a test
 * can fire it in Vite's own order — the changed module's disposer runs and is
 * awaited, and only THEN is the new module imported (#21 §4 read that out of
 * `vite/dist/client/client.mjs`). No Vite here, and none needed: what the host
 * has to get right is what happens on either side of that call.
 */
function fakeHot(): HotHandle & { fire(): void } {
  let disposer: (() => void) | null = null
  return {
    accept: () => undefined,
    dispose: (callback) => void (disposer = callback),
    fire: () => disposer?.(),
  }
}

function pokesOf(ref: AnyActorRef | undefined): number {
  return (ref?.getSnapshot() as { context: { pokes: number } } | undefined)?.context.pokes ?? -1
}

describe('a hot re-import: the install hook (#21 §6)', () => {
  it('replaces the owner\'s actor with the re-minted logic, and keeps routing to the address', () => {
    const hot = fakeHot()
    const owner = defineFeature('test.hmr', hot)
    commands.declare(owner, { id: 'test.hmr.poke', title: 'Poke' })
    // Published before the host exists, exactly as an app's `features/index.ts`
    // does it: nobody is listening yet, and the module value is handed in.
    const { host, dispatch } = makeHost([provideFeature({ owner, create: () => ({ logic: jobLogic }) })])
    const first = host.child(owner)
    expect(dispatch('test.hmr.poke')).toEqual({ ok: true })
    expect(pokesOf(first)).toBe(1)

    hot.fire()

    // The registry revoked, the host drained and stopped. Both halves, and in
    // that order: a command that arrives now is `unknown`, not `unhandled`.
    expect(commands.get('test.hmr.poke')).toBeUndefined()
    expect(first?.getSnapshot().status).toBe('stopped')
    expect(dispatch('test.hmr.poke')).toMatchObject({ ok: false, kind: 'unknown' })

    // The module re-executes: same owner, new declarations, NEW logic the host
    // has never spawned. Nothing hands it in this time — the install hook is
    // the only thing that tells the host at all.
    const remint = defineFeature('test.hmr', hot)
    commands.declare(remint, { id: 'test.hmr.poke', title: 'Poke' })
    provideFeature({ owner: remint, create: () => ({ logic: jobLogic }) })

    const second = host.child(owner)
    expect(second).toBeDefined()
    expect(second).not.toBe(first)
    expect(second?.getSnapshot().status).toBe('active')
    expect(dispatch('test.hmr.poke')).toEqual({ ok: true })
    // A fresh actor, not the old one's state: the count restarts.
    expect(pokesOf(second)).toBe(1)

    host.dispose(owner)
    host.stop()
  })

  it('stops installing into a host that has stopped', () => {
    const hot = fakeHot()
    const owner = defineFeature('test.hmr2', hot)
    const { host } = makeHost([provideFeature({ owner, create: () => ({ logic: jobLogic }) })])
    host.stop()

    hot.fire()
    defineFeature('test.hmr2', hot)
    provideFeature({ owner, create: () => ({ logic: jobLogic }) })

    // Nothing was sent at the stopped root, so nothing dead-lettered: the hook
    // is released by `stop`, not left to fire at a corpse.
    expect(host.deadLetters).toEqual([])
    dispose('test.hmr2')
  })
})

/**
 * A feature that dead-letters for reasons of its own: it holds a ref to a
 * child that finished the moment it started, and pokes it on every command.
 * The poke is undelivered, the command was delivered.
 */
const ghostLogic = setupMachine({ schemas: { events: { boo: types<void>() } } }).createMachine({
  id: 'ghost',
  initial: 'gone',
  states: { gone: { type: 'final' } },
})

const noisyLogic = setupMachine({
  schemas: { context: types<{ ghost: AnyActorRef; pokes: number }>(), events: { command: types<{ id: string; args: unknown }>() } },
}).createMachine({
  id: 'noisy',
  context: ({ spawn }) => ({ ghost: spawn(ghostLogic), pokes: 0 }),
  initial: 'running',
  states: {
    running: {
      on: {
        command: ({ context }, enq) => {
          enq.sendTo(context.ghost, { type: 'boo' })
          return { context: { pokes: context.pokes + 1 } }
        },
      },
    },
  },
})

describe('dead-letter attribution', () => {
  beforeAll(() => commands.declare('test.noisy', { id: 'test.noisy.poke', title: 'Poke a ghost' }))
  afterAll(() => dispose('test.noisy'))

  it('reports a delivered command ok even when its handler dead-lettered something else', () => {
    const { host, dispatch } = makeHost([{ owner: 'test.noisy', create: () => ({ logic: noisyLogic }) }])

    expect(dispatch('test.noisy.poke')).toEqual({ ok: true })

    // The noise is still observable — it is a real dead letter — but it is
    // not this command's.
    expect(host.deadLetters).toHaveLength(1)
    expect(host.deadLetters[0]).toMatchObject({ reason: 'stopped', event: { type: 'boo' } })
    expect((host.child('test.noisy')?.getSnapshot() as { context: { pokes: number } }).context.pokes).toBe(1)
  })
})

describe('the host as a whole', () => {
  it('runs on the injected clock', () => {
    const { host, clock } = makeHost()
    expect(host.actor.clock).toBe(clock)
  })

  it('dead-letters every dispatch once stopped, and says so', () => {
    const { host, dispatch } = makeHost()
    host.stop()
    expect(dispatch('tools.set', { spriteName: 'rock' })).toMatchObject({ ok: false, kind: 'unhandled' })
    expect(host.deadLetters.at(-1)).toMatchObject({ reason: 'stopped', target: 'host' })
  })

  it('holds the document actor as a child the document commands route to', () => {
    const { host } = makeHost()
    expect(host.child('document')).toBe(host.children.document)
    expect(host.children.document.getSnapshot().status).toBe('active')
  })

  it('holds the viewport actor as a child, keyed under its reserved owner', () => {
    const { host } = makeHost()
    expect(host.child('editor-host.viewport')).toBe(host.children.viewport)
    expect(() => host.dispose('editor-host.viewport')).toThrow(/reserved/)
  })

  it('holds the gesture actor as a child, keyed under its reserved owner', () => {
    const { host } = makeHost()
    expect(host.child('editor-host.gesture')).toBe(host.children.gesture)
    expect(host.input.gesture()).toBe('none')
    expect(() => host.dispose('editor-host.gesture')).toThrow(/reserved/)
  })
})

describe('the viewport actor: what the viewport observed', () => {
  it('writes a reading only when it differs from the last, so a pointer within a cell or a camera nudge notifies nobody', () => {
    const { host } = makeHost()
    const viewport = host.children.viewport
    const top = topAt(2, 3)
    viewport.send({ type: 'hover', surface: top, cells: [[2, 3]] })
    const after = viewport.getSnapshot()
    expect(after.context.hover).toEqual(top)
    expect(after.context.brushCells).toEqual([[2, 3]])

    // The same cell again, as new objects: nothing changes, the snapshot is the same one.
    viewport.send({ type: 'hover', surface: { ...top }, cells: [[2, 3]] })
    expect(viewport.getSnapshot()).toBe(after)
    viewport.send({ type: 'hover', surface: topAt(4, 3), cells: [[2, 3]] })
    expect(viewport.getSnapshot()).not.toBe(after)
    expect(viewport.getSnapshot().context.brushCells).toBe(after.context.brushCells)

    const camera = viewport.getSnapshot().context.camera
    const settled = viewport.getSnapshot()
    viewport.send({ type: 'camera', camera: { ...camera, yaw: camera.yaw + 0.2 } })
    expect(viewport.getSnapshot()).toBe(settled)
    viewport.send({ type: 'camera', camera: { ...camera, inBounds: false } })
    expect(viewport.getSnapshot().context.camera.inBounds).toBe(false)

    viewport.send({ type: 'stats', stats: { fps: 60, triangles: 5000, meshMs: 1.5, missingTransitions: [] } })
    viewport.send({ type: 'renderer', software: true })
    expect(viewport.getSnapshot().context).toMatchObject({ stats: { fps: 60 }, softwareRenderer: true })
  })

  it("holds the project's loaded terrain sets and what loading them said, until the project closes", () => {
    const { host } = makeHost()
    const image = { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4) }
    const set = { set: { sheet: 'ground.png', tile: 16, columns: 4, rows: 4 }, image }
    host.children.viewport.send({ type: 'terrain', sets: [set], warning: 'sheets/cliffs.png: no such file' })
    expect(host.children.viewport.getSnapshot().context).toMatchObject({ loadedTerrain: [set], terrainWarning: 'sheets/cliffs.png: no such file' })
    host.children.viewport.send({ type: 'terrain', sets: [], warning: null })
    expect(host.children.viewport.getSnapshot().context.loadedTerrain).toEqual([])
    expect(host.children.viewport.getSnapshot().context.terrainWarning).toBeNull()
  })

  it('answers frame and sweep with an event for whoever holds the viewport', () => {
    const { host, dispatch } = makeHost()
    const heard: string[] = []
    const frame = host.children.viewport.on('frame', (event) => heard.push(event.type))
    const sweep = host.children.viewport.on('sweep', (event) => heard.push(event.type))
    expect(dispatch('viewport.frame')).toEqual({ ok: true })
    expect(dispatch('viewport.sweep')).toEqual({ ok: true })
    expect(heard).toEqual(['frame', 'sweep'])
    frame.unsubscribe()
    sweep.unsubscribe()
  })
})

describe('the relative and composite commands the keymap needs', () => {
  it('runs a composite in order, across owners', () => {
    // The `3` binding: one chord, two owners' commands. A binding carries one
    // `(id, args)`, so the composite is the argument.
    const { host, dispatch } = makeHost()
    expect(
      dispatch('commands.run', {
        commands: [
          { id: 'tools.set', args: { tool: 'object' } },
          { id: 'view.set', args: { inspector: 'coverage' } },
        ],
      }),
    ).toEqual({ ok: true })
    expect(host.children.tools.getSnapshot().context.tool).toBe('object')
    expect(host.children.view.getSnapshot().context.inspector).toBe('coverage')
  })

  it('stops a composite at the first step that refuses, and answers with that refusal', () => {
    const { host, dispatch } = makeHost()
    expect(
      dispatch('commands.run', {
        commands: [
          { id: 'view.set', args: { showGrid: false } },
          { id: 'view.set', args: { inspector: 'nonsense' } },
          { id: 'tools.set', args: { tool: 'object' } },
        ],
      }),
    ).toMatchObject({ ok: false, kind: 'invalid-args' })
    // The first step landed and the third never ran: a composite is a
    // sequence of dispatches, not a transaction.
    expect(host.children.view.getSnapshot().context.showGrid).toBe(false)
    expect(host.children.tools.getSnapshot().context.tool).toBe('select')
  })

  it('refuses a composite that recurses instead of looping forever', () => {
    const { dispatch } = makeHost()
    const loop: { commands: { id: string; args: unknown }[] } = { commands: [] }
    loop.commands.push({ id: 'commands.run', args: loop })
    expect(dispatch('commands.run', loop)).toMatchObject({ ok: false, kind: 'unhandled', reason: expect.stringContaining('refers to itself') as string })
  })
})

describe('deleting objects', () => {
  function withObject(): ReturnType<typeof makeHost> & { object: MapObject } {
    const made = makeHost()
    apply(made.host, 'Add object', addObject(made.host.reader.doc, OBJECT))
    return { ...made, object: OBJECT }
  }

  it('deletes by stable id, leaving objects and objectOrder agreeing', () => {
    const { host, dispatch, object } = withObject()
    expect(host.reader.doc.objectOrder).toEqual([object.id])

    expect(dispatch('objects.delete', { ids: [object.id] })).toEqual({ ok: true })

    expect(host.reader.doc.objects[object.id]).toBeUndefined()
    expect(host.reader.doc.objectOrder).toEqual([])
    expect(Object.keys(host.reader.doc.objects)).toEqual(host.reader.doc.objectOrder)
  })

  it('deletes several at once without one restoring another', () => {
    // `removeObject` rebuilds the WHOLE order per call against a document
    // that has not been written yet, so mapping it over two ids would have
    // the second list still holding the first — and the last patch to land
    // would put it back.
    const { host, dispatch } = makeHost()
    const second = { ...OBJECT, id: 'obj-2' }
    apply(host, 'Add object', addObject(host.reader.doc, OBJECT))
    apply(host, 'Add object', addObject(host.reader.doc, second))

    expect(dispatch('objects.delete', { ids: [OBJECT.id, second.id] })).toEqual({ ok: true })
    expect(host.reader.doc.objectOrder).toEqual([])
    expect(Object.keys(host.reader.doc.objects)).toEqual([])
  })

  it('leaves the document alone when no id names anything', () => {
    const { host, dispatch } = withObject()
    const revision = host.reader.revision
    expect(dispatch('objects.delete', { ids: ['nobody'] })).toEqual({ ok: true })
    expect(host.reader.revision).toBe(revision)
    // No entry pushed either: the top of the stack is still what put the
    // object there, so an undo does not have a no-op to eat first.
    expect(host.reader.undoLabel()).toBe('Add object')
  })

  it('refuses an empty or malformed id list', () => {
    const { dispatch } = makeHost()
    expect(dispatch('objects.delete', { ids: [] })).toMatchObject({ ok: false, kind: 'invalid-args' })
    expect(dispatch('objects.delete', { id: 'obj-1' })).toMatchObject({ ok: false, kind: 'invalid-args' })
  })

  it('selection.delete fills the ids in from the selection and then clears it', () => {
    // The whole point of the composite: what reaches a handler is
    // `objects.delete({ ids })`. No actor learns what was selected (#11), and
    // the expansion happens in `dispatch`, outside every machine.
    const { host, dispatch, object } = withObject()
    dispatch('selection.set', { id: object.id })

    expect(dispatch('selection.delete')).toEqual({ ok: true })

    expect(host.reader.doc.objects[object.id]).toBeUndefined()
    expect(host.children.view.getSnapshot().context.selectedObjectId).toBeNull()
    expect(host.contextKeys()['view.hasSelection']).toBe(false)
  })

  it('a dragged structure hops onto whatever is under the pointer and off it again, and its children ride along', () => {
    const { host, dispatch } = makeHost()
    const doc = host.reader.doc
    // An island on the ground, a tier on the island.
    dispatch('sketch.new', { parent: 'ground', name: 'Island' })
    const island = doc.structureOrder[1]
    for (const point of [
      { x: 0, z: 0, smooth: false },
      { x: 4, z: 0, smooth: false },
      { x: 4, z: 4, smooth: false },
      { x: 0, z: 4, smooth: false },
    ])
      dispatch('sketch.point.add', { id: island, point })
    dispatch('sketch.close', { id: island })
    dispatch('structure.place', { id: island, placement: { x: 2, z: 2, yaw: 0 } })
    dispatch('sketch.new', { parent: island, name: 'Tier' })
    const tier = doc.structureOrder[2]
    dispatch('structure.place', { id: tier, placement: { x: 1, z: 1, yaw: 0 } })
    dispatch('tools.set', { tool: 'select' })
    expect(frameOf(doc, tier).x).toBe(3)

    // Drag the island: the tier keeps its placement in the island and moves through the world with it.
    const cap = (structure: string): SurfaceAddress => ({ structure, kind: 3, x: 0, y: 0, dir: -1, level: 0 })
    host.input.pointerDown(pressAt(3, 3, { pick: { surface: cap(island), point: { x: 3, z: 3 }, objectId: null } }))
    host.input.strokeMove({ surface: null, point: null, objectId: null, plane: { x: 4, z: 3 } }, NO_MODIFIERS)
    host.input.pointerUp({ x: 40, y: 30 })
    expect(doc.structures[island].placement).toEqual({ x: 3, z: 2, yaw: 0 })
    expect(doc.structures[tier].placement).toEqual({ x: 1, z: 1, yaw: 0 })
    expect(frameOf(doc, tier).x).toBe(4)

    // Drag the tier off the island onto bare ground: it becomes the ground's child, where it was dropped.
    host.input.pointerDown(pressAt(4, 3, { pick: { surface: cap(tier), point: { x: 4, z: 3 }, objectId: null } }))
    host.input.strokeMove({ surface: null, point: null, objectId: null, plane: { x: 1, z: 0 } }, NO_MODIFIERS)
    expect(doc.structures[tier].parent).toBe('ground')
    expect(doc.structures[tier].placement).toEqual({ x: 1, z: 0, yaw: 0 })
    expect(frameOf(doc, tier).y).toBe(groundHeight(doc, 1, 0))
    // ... and back onto the island: the island's child again, placed in the island's frame.
    host.input.strokeMove({ surface: null, point: null, objectId: null, plane: { x: 5, z: 4 } }, NO_MODIFIERS)
    expect(doc.structures[tier].parent).toBe(island)
    expect(doc.structures[tier].placement).toEqual({ x: 2, z: 2, yaw: 0 })
    host.input.pointerUp({ x: 50, y: 40 })
    expect(host.reader.undoLabel()).toBe('Move structure')
    // One undo takes the whole drag back, parent included.
    dispatch('undo')
    expect(doc.structures[tier].parent).toBe(island)
    expect(doc.structures[tier].placement).toEqual({ x: 1, z: 1, yaw: 0 })
  })

  it('carried by the point it was grabbed at, a structure lands on the surface the pick found under the pointer', () => {
    const { host, dispatch } = makeHost()
    const doc = host.reader.doc
    dispatch('sketch.new', { parent: 'ground', name: 'Island' })
    const island = doc.structureOrder[1]
    for (const point of [
      { x: 0, z: 0, smooth: false },
      { x: 6, z: 0, smooth: false },
      { x: 6, z: 6, smooth: false },
      { x: 0, z: 6, smooth: false },
    ])
      dispatch('sketch.point.add', { id: island, point })
    dispatch('sketch.close', { id: island })
    dispatch('sketch.set', { id: island, changes: { layers: 4 } })
    dispatch('sketch.new', { parent: 'ground', name: 'Tier' })
    const tier = doc.structureOrder[2]
    for (const point of [
      { x: 0, z: 0, smooth: false },
      { x: 2, z: 0, smooth: false },
      { x: 2, z: 2, smooth: false },
      { x: 0, z: 2, smooth: false },
    ])
      dispatch('sketch.point.add', { id: tier, point })
    dispatch('sketch.close', { id: tier })
    dispatch('sketch.set', { id: tier, changes: { layers: 2 } })
    dispatch('structure.place', { id: tier, placement: { x: 7, z: 1, yaw: 0 } })
    dispatch('tools.set', { tool: 'select' })

    // The stroke says what it carries: the tier and whatever stands on it.
    expect(host.input.carrying()).toEqual(new Set())
    // `groundHeight` is the top of whatever stands there: at (8, 2) that is the tier's cap, a whole cap above its base.
    const capY = groundHeight(doc, 8, 2)
    expect(capY).toBe(frameOf(doc, tier).y + 2 * HALF)
    const cap = (structure: string, kind: SurfaceKind): SurfaceAddress => ({ structure, kind, x: 0, y: 0, dir: -1, level: 0 })
    // Grabbed at (8, 2) on its cap: one cell east and one south of its origin, a whole cap's height above its base.
    host.input.pointerDown(pressAt(8, 2, { pick: { surface: cap(tier, 3), point: { x: 8, y: capY, z: 2 }, objectId: null } }))
    expect(host.input.carrying()).toEqual(new Set([tier]))

    // The pick looked past the tier and found the island's cap at (3, 3), along a ray coming down at 45° from the north.
    const s = Math.SQRT1_2
    const ray = { origin: { x: 3, y: 100, z: 3 - 100 }, direction: { x: 0, y: -s, z: s } }
    const islandCapY = groundHeight(doc, 3, 3)
    host.input.strokeMove({ surface: cap(island, 3), point: { x: 3, y: islandCapY, z: 3 }, objectId: null, ray, plane: { x: 99, z: 99 } }, NO_MODIFIERS)
    // Walking back up the ray by the cap's height (one unit) moves the grabbed point one unit north of the hit:
    // the tier's cap point under the cursor is (3, 2), so its origin is (2, 1) — in the island's frame, where it now stands.
    expect(doc.structures[tier].parent).toBe(island)
    expect(doc.structures[tier].placement).toEqual({ x: 2, z: 1, yaw: 0 })
    // A pick that hit the carried thing itself (a test's, or a stale one) is not a landing; the press plane decides,
    // and what stands under the pointer there — the ground, off the island's east edge — is the parent.
    host.input.strokeMove({ surface: cap(tier, 3), point: { x: 0, y: 0, z: 0 }, objectId: null, ray, plane: { x: 7.5, z: 3 } }, NO_MODIFIERS)
    expect(doc.structures[tier].parent).toBe('ground')
    expect(doc.structures[tier].placement).toEqual({ x: 7, z: 2, yaw: 0 })
    host.input.pointerUp({ x: 0, y: 0 })
    expect(host.input.carrying()).toEqual(new Set())
  })

  it('selection.nudge moves the selection a cell along the world axes, by its kind', () => {
    const { host, dispatch } = makeHost()
    apply(host, 'Add', addObject(host.reader.doc, { ...OBJECT, position: [2, 0, 2], anchorCell: [2, 2] }))
    const doc = host.reader.doc
    expect(dispatch('selection.nudge', { dx: 1, dz: 0 })).toMatchObject({ ok: false, kind: 'unavailable' })

    dispatch('selection.set', { id: OBJECT.id })
    expect(dispatch('selection.nudge', { dx: 1, dz: 0 })).toEqual({ ok: true })
    expect(dispatch('selection.nudge', { dx: 0, dz: -1 })).toEqual({ ok: true })
    expect([doc.objects[OBJECT.id].position[0], doc.objects[OBJECT.id].position[2]]).toEqual([3, 1])
    expect(doc.objects[OBJECT.id].anchorCell).toEqual([3, 1])

    // A structure by its placement, turned into its parent's frame; the root stays put.
    dispatch('sketch.new', { parent: 'ground', name: 'Island' })
    const island = doc.structureOrder.find((id) => id !== 'ground') as string
    dispatch('selection.select', { selection: { kind: 'structure', id: island } })
    expect(dispatch('selection.nudge', { dx: -1, dz: 1 })).toEqual({ ok: true })
    expect(doc.structures[island].placement).toEqual({ x: -1, z: 1, yaw: 0 })
    dispatch('selection.select', { selection: { kind: 'structure', id: 'ground' } })
    expect(dispatch('selection.nudge', { dx: 1, dz: 0 })).toEqual({ ok: true })
    expect(doc.structures.ground.placement).toEqual({ x: 0, z: 0, yaw: 0 })

    // A sketch point, in its sketch's frame.
    dispatch('sketch.point.add', { id: island, point: { x: 1, z: 1, smooth: false } })
    dispatch('selection.select', { selection: { kind: 'sketchPoint', structure: island, index: 0 } })
    expect(dispatch('selection.nudge', { dx: 0, dz: 1 })).toEqual({ ok: true })
    expect(doc.structures[island].kind === 'sketch' && doc.structures[island].points[0]).toMatchObject({ x: 1, z: 2 })
    expect(dispatch('selection.nudge', { dx: 99, dz: 0 })).toMatchObject({ ok: false })
  })

  it('selection.delete is unavailable with nothing selected, and says so', () => {
    const { dispatch } = makeHost()
    expect(dispatch('selection.delete')).toMatchObject({
      ok: false,
      kind: 'unavailable',
      reason: expect.stringContaining('view.hasSelection') as string,
    })
  })
})

/**
 * #10: every declared command must have a test that dispatches it. This runs
 * last in the file (vitest runs a file's tests in order), so `dispatched` is
 * complete by now. A new declaration anywhere in the workspace that no test
 * here exercises turns this red — add the test, not an exemption.
 */
describe('the sketch and structure commands, routed to the document actor', () => {
  it('draws a sketch on the ground, edits it, moves it, and deletes it, one command each', () => {
    const { host, dispatch } = makeHost()
    const doc = () => host.reader.doc
    expect(dispatch('sketch.new', { parent: 'ground', name: 'Island' })).toMatchObject({ ok: true })
    const id = doc().structureOrder.at(-1) as string
    expect(doc().structures[id]).toMatchObject({ kind: 'sketch', parent: 'ground', closed: false })

    for (const point of [
      { x: 1, z: 1, smooth: true },
      { x: 4, z: 1, smooth: false },
      { x: 4, z: 4, smooth: true },
    ])
      expect(dispatch('sketch.point.add', { id, point })).toMatchObject({ ok: true })
    // Two points are not an outline: closing is refused as a no-op, not an error.
    expect(dispatch('sketch.point.delete', { id, index: 2 })).toMatchObject({ ok: true })
    dispatch('sketch.close', { id })
    expect(doc().structures[id]).toMatchObject({ closed: false })
    expect(dispatch('sketch.point.add', { id, point: { x: 1, z: 4, smooth: true }, at: 2 })).toMatchObject({ ok: true })
    expect(dispatch('sketch.point.update', { id, index: 0, changes: { smooth: false } })).toMatchObject({ ok: true })
    expect(dispatch('sketch.close', { id })).toMatchObject({ ok: true })
    expect(dispatch('sketch.set', { id, changes: { layers: 5, lip: 'bevel' } })).toMatchObject({ ok: true })
    const sketch = doc().structures[id]
    expect(sketch).toMatchObject({ closed: true, layers: 5, lip: 'bevel' })
    expect(sketch.kind === 'sketch' ? sketch.points[0].smooth : null).toBe(false)

    expect(dispatch('structure.rename', { id, name: 'Isle' })).toMatchObject({ ok: true })
    expect(dispatch('structure.place', { id, placement: { x: 2, z: 3, yaw: 1 } })).toMatchObject({ ok: true })
    expect(doc().structures[id]).toMatchObject({ name: 'Isle', placement: { x: 2, z: 3, yaw: 1 } })
    // Reparenting onto itself is refused; onto the root is fine.
    dispatch('structure.reparent', { id, parent: id })
    expect(doc().structures[id]?.parent).toBe('ground')
    expect(dispatch('structure.reparent', { id, parent: null })).toMatchObject({ ok: true })
    expect(doc().structures[id]?.parent).toBeNull()

    expect(dispatch('structure.delete', { id })).toMatchObject({ ok: true })
    expect(doc().structures[id]).toBeUndefined()
    expect(host.reader.undoLabel()).toBe('Delete structure')
    dispatch('undo')
    expect(doc().structures[id]).toBeDefined()
  })
})

describe('typed selection', () => {
  it('every kind lives in a target the scene can point at', () => {
    expect(selectionSubject(null)).toBeNull()
    expect(selectionSubject({ kind: 'object', id: 'a' })).toEqual({ kind: 'object', id: 'a' })
    expect(selectionSubject({ kind: 'structure', id: 'ground' })).toEqual({ kind: 'structure', id: 'ground' })
    expect(selectionSubject({ kind: 'sketchPoint', structure: 'sk', index: 2 })).toEqual({ kind: 'structure', id: 'sk' })
  })

  it('selects a structure, deletes it as one, and comes back whole on undo', () => {
    const { host, dispatch } = makeHost()
    expect(dispatch('selection.select', { selection: { kind: 'structure', id: 'ground' } })).toEqual({ ok: true })
    expect(host.children.view.getSnapshot().context.selection).toEqual({ kind: 'structure', id: 'ground' })
    expect(host.children.view.getSnapshot().context.selectedObjectId).toBeNull()
    expect(host.contextKeys()['view.hasSelection']).toBe(true)

    expect(dispatch('selection.delete')).toEqual({ ok: true })
    expect(host.reader.doc.structures.ground).toBeUndefined()
    expect(host.children.view.getSnapshot().context.selection).toBeNull()
    dispatch('undo')
    expect(host.reader.doc.structures.ground).toBeDefined()
  })

  it('keeps the object case readable as before', () => {
    const { host, dispatch } = makeHost()
    apply(host, 'Add', addObject(host.reader.doc, OBJECT))
    expect(dispatch('selection.set', { id: OBJECT.id })).toEqual({ ok: true })
    const view = host.children.view.getSnapshot().context
    expect(view.selection).toEqual({ kind: 'object', id: OBJECT.id })
    expect(view.selectedObjectId).toBe(OBJECT.id)
    expect(dispatch('selection.select', { selection: null })).toEqual({ ok: true })
    expect(host.children.view.getSnapshot().context.selectedObjectId).toBeNull()
  })
})

describe('declared but untested', () => {
  it('has dispatched every command the registry knows', () => {
    const untested = commands
      .all()
      .map((command) => command.id)
      .filter((id) => !dispatched.has(id))
    expect(untested, `declared but never dispatched by a test: ${untested.join(', ')}`).toEqual([])
  })
})
