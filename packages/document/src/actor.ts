/**
 * The document actor: the one holder of the write path (#13).
 *
 * Everything that changes the document — a stroke tick, an inspector edit,
 * undo — arrives here as an event and leaves as exactly one call on `writer`.
 * Nothing else in the workspace can obtain a `writer` (it is not in the
 * barrel, and `EditorStore.doc` is private), so "one write path" is a fact
 * about the type graph rather than a rule someone has to remember. Undo
 * granularity lands here for the same reason: `beginStroke`/`endStroke` are
 * events, so the actor is the one place that decides when an `Edit` closes.
 *
 * Two constraints from the map (#2) shape the code and are easy to undo by
 * accident, so they are spelled out:
 *
 * 1. THE STORE ARRIVES BY FACTORY CLOSURE, NEVER BY `input`. `input` rides
 *    the `xstate.init` event and reaches an inspector even when kept out of
 *    context — measured at 100,089 bytes for a 50k-entry store against 22 for
 *    a closure (#4). `documentLogic(writer, reader)` closes over both; the
 *    machine's context is empty and stays that way.
 *
 * 2. EVERY WRITE IS `enq(() => writer.…)`, NEVER INLINE. On `6.0.0-alpha.53` a
 *    transition body is its own guard: v6 runs it once with a stub `enq`
 *    whose methods throw an internal signal, and if the body touched `enq` it
 *    is replayed with the real one. So a statement above the first `enq` call
 *    runs twice, one below it runs once, and one on a path that returns
 *    `undefined` — "not enabled" — runs anyway even though no transition is
 *    taken. An inline `writer.apply` raising a cell by +3 moves it by 6 with
 *    no error (#8 hit exactly this). `actor.test.ts` holds the standing guard
 *    #22 asked for: N patch events are N applications, and a refused event is
 *    zero. It goes red the moment a write moves inline; leave it standing.
 *
 * Teardown is not in `exit`: exit actions do not run when an actor is stopped
 * (xstate#4630). The actor owns nothing that needs releasing — the store
 * outlives it by design — so there is nothing to tear down here either.
 */

import type { CommandEvent } from '@papercut/registry'
import { setup, types } from 'xstate'

// Two imports of one module, and the bare one is not redundant: it is the
// SIDE EFFECT — `commands.ts` declares, at import, every command whose effect
// is one call on the write handle, and this actor is what makes them handled.
// The second import is types only, and a type-only import is elided from the
// emitted module, so without the line above a consumer that reaches this file
// without going through the barrel would get an actor whose commands nobody
// declared.
import './commands'
import type {
  AtmosphereChanges,
  CameraChanges,
  DocumentLoadArgs,
  DocumentNewArgs,
  ObjectUpdateArgs,
  SketchNewArgs,
  SketchPointAddArgs,
  SketchPointDeleteArgs,
  SketchPointUpdateArgs,
  SketchSetArgs,
  StructureIdArgs,
  StructurePlaceArgs,
  VoxelsMoveArgs,
  StructureRenameArgs,
  StructureReparentArgs,
} from './commands'
import { createMap, type MapDoc } from './document'
import { clampOffset, movePatches, snapshotObjects, snapshotVolume } from './move'
import { structureOf } from './structure'
import type { Patch } from './edits'
import { deserialize } from './io'
import {
  addSketchPoint,
  addStructure,
  closeSketch,
  createSketch,
  deleteSketchPoint,
  placeStructure,
  removeObjects,
  removeStructure,
  renameStructure,
  reparentStructure,
  setSketch,
  updateObject,
  updateSketchPoint,
} from './ops'
import { createDocumentStore, writerOf, type DocumentReader, type DocumentWriter, type EditorStore } from './store'

/**
 * What the actor accepts. Plain data throughout — a `Patch` addresses its
 * target by index, key or id, never by reference — which is what keeps a
 * recorded session replayable (#2's argument convention).
 *
 * `command` is the host's route in (#8): the same `undo`/`redo` the raw
 * events carry, arriving as a dispatched command so a keybinding, a menu and
 * a test reach the write handle by one path. The raw events are for callers
 * that hold the ref directly — the stroke actor in `editor-host` (#11, #66
 * step 4) sends `strokePatch` per tick without a command in between, and
 * closes with `endStroke` carrying the record it compacted per address.
 * Patches are applied as they arrive; the record is only what history keeps.
 *
 * `strokePatch` is a SEPARATE VERB from `patch` on purpose. When "inside a
 * stroke" was a property of `apply` instead, an ordinary edit that happened
 * to land mid-drag — the Delete keybinding fires on `window` during a pointer
 * drag — was applied and recorded by nothing: not by the history, and not by
 * the stroke actor's map, which only holds patches the stroke itself
 * produced. `patch` now always records; a stroke tick says so in its type.
 */
export type DocumentEvent =
  | { type: 'patch'; label: string; patches: Patch[] }
  | { type: 'replace'; doc: MapDoc }
  | { type: 'strokePatch'; patches: Patch[] }
  | { type: 'beginStroke'; label: string }
  | { type: 'endStroke'; patches: Patch[]; inverse: Patch[] }
  | { type: 'undo' }
  | { type: 'redo' }
  | CommandEvent

/**
 * The machine, closed over a writer and the matching reader. Internal: the
 * barrel exports only the pre-wired `createDocumentActorLogic`, so the
 * parameter type — the write handle — is never namable outside this package.
 *
 * The reader is here because a command carries a REQUEST, not patches:
 * `objects.delete({ ids })` has to be turned into the edit that removes them,
 * and the op that does it reads the document. Read per event, never captured
 * — the document is mutated in place, so a held `doc` is the live one anyway,
 * but saying so at the call site is what keeps that true if it ever stops
 * being.
 */
export function documentLogic(writer: DocumentWriter, reader: DocumentReader) {
  return setup({
    schemas: {
      events: {
        patch: types<{ label: string; patches: Patch[] }>(),
        replace: types<{ doc: MapDoc }>(),
        strokePatch: types<{ patches: Patch[] }>(),
        beginStroke: types<{ label: string }>(),
        endStroke: types<{ patches: Patch[]; inverse: Patch[] }>(),
        undo: types<void>(),
        redo: types<void>(),
        command: types<{ id: string; args: unknown }>(),
      },
    },
  }).createMachine({
    id: 'document',
    initial: 'ready',
    states: {
      ready: {
        on: {
          patch: ({ event }, enq) => {
            // An empty patch list is refused, not applied: returning
            // `undefined` here is the v6 "not enabled" shape, and the
            // `pruneNoops` inside `apply` would make it a no-op anyway. It is
            // also the not-taken path the guard test drives — the third
            // failure mode is an inline effect firing on exactly this branch.
            if (event.patches.length === 0) return undefined
            enq(() => writer.apply(event.label, event.patches))
            return {}
          },
          // The whole document, swapped: load and new map. History is cleared
          // by the writer, because an undo across a replace would restore
          // patches addressed to a document that is gone.
          replace: ({ event }, enq) => {
            enq(() => writer.replace(event.doc))
            return {}
          },
          strokePatch: ({ event }, enq) => {
            // Same refusal as `patch`, and for the same reason: the empty list
            // is the "not enabled" shape, taken before `enq` is touched.
            if (event.patches.length === 0) return undefined
            enq(() => writer.applyStrokeTick(event.patches))
            return {}
          },
          beginStroke: ({ event }, enq) => {
            enq(() => writer.beginStroke(event.label))
            return {}
          },
          endStroke: ({ event }, enq) => {
            enq(() => writer.endStroke({ patches: event.patches, inverse: event.inverse }))
            return {}
          },
          undo: (_, enq) => {
            enq(() => writer.undo())
            return {}
          },
          redo: (_, enq) => {
            enq(() => writer.redo())
            return {}
          },
          command: ({ event }, enq) => {
            // Only the ids `commands.ts` declared can arrive here: the host
            // routes by declaring owner, and this owner declared eight.
            // Anything else is refused with the `undefined` guard shape rather
            // than dropped inside `enq`, so it takes no transition at all.
            //
            // Everything below is computed ABOVE the first `enq` call, so it
            // runs twice — and every one of them is pure (an op reads the
            // document and returns patches; `deserialize` and `createMap`
            // build a new one and touch nothing), which is the contract a v6
            // transition body has to keep. A request that comes to no patches
            // takes the `undefined` guard shape rather than enqueuing a write
            // `apply` would prune anyway.
            if (event.id === 'undo') enq(() => writer.undo())
            else if (event.id === 'redo') enq(() => writer.redo())
            else if (event.id === 'objects.delete') {
              const patches = removeObjects(reader.doc, (event.args as { ids: string[] }).ids)
              if (patches.length === 0) return undefined
              enq(() => writer.apply('Delete object', patches))
            } else if (event.id === 'objects.update') {
              const { id, changes } = event.args as ObjectUpdateArgs
              // An id the document does not hold comes to no patches, the
              // same as a delete of one: the request named something that is
              // not there, which is not an error to report from here.
              const patches = updateObject(reader.doc, id, changes)
              if (patches.length === 0) return undefined
              enq(() => writer.apply('Edit object', patches))
            } else if (event.id === 'camera.set') {
              // One `doc` patch carrying the merged rig, not a patch per
              // field: `camera` is one field of the document, so the
              // before-value an undo restores is the whole rig.
              const camera = { ...reader.doc.camera, ...(event.args as CameraChanges) }
              enq(() => writer.apply('Camera rig', [{ t: 'doc', field: 'camera', value: camera }]))
            } else if (event.id === 'atmosphere.set') {
              const atmosphere = { ...reader.doc.atmosphere, ...(event.args as AtmosphereChanges) }
              enq(() => writer.apply('Atmosphere', [{ t: 'doc', field: 'atmosphere', value: atmosphere }]))
            } else if (event.id === 'document.load') {
              // Parsed again here, having already parsed in the schema: the
              // schema's copy is what turns a bad file into an `invalid-args`
              // result instead of a throw inside this effect (see
              // `commands.ts`), and what arrives is known to parse.
              const doc = deserialize((event.args as DocumentLoadArgs).json)
              enq(() => writer.replace(doc))
            } else if (event.id === 'document.new') {
              const { width, height, name } = event.args as DocumentNewArgs
              const doc = createMap(width, height, name)
              enq(() => writer.replace(doc))
            } else if (event.id === 'sketch.new') {
              const { parent, name, placement } = event.args as SketchNewArgs
              const sketch = createSketch(parent, name, placement)
              enq(() => writer.apply('New sketch', addStructure(reader.doc, sketch)))
            } else if (event.id === 'sketch.point.add') {
              const { id, point, at } = event.args as SketchPointAddArgs
              const patches = addSketchPoint(reader.doc, id, point, at)
              if (patches.length === 0) return undefined
              enq(() => writer.apply('Add point', patches))
            } else if (event.id === 'sketch.point.update') {
              const { id, index, changes } = event.args as SketchPointUpdateArgs
              const patches = updateSketchPoint(reader.doc, id, index, changes)
              if (patches.length === 0) return undefined
              enq(() => writer.apply('Edit point', patches))
            } else if (event.id === 'sketch.point.delete') {
              const { id, index } = event.args as SketchPointDeleteArgs
              const patches = deleteSketchPoint(reader.doc, id, index)
              if (patches.length === 0) return undefined
              enq(() => writer.apply('Delete point', patches))
            } else if (event.id === 'sketch.close') {
              const patches = closeSketch(reader.doc, (event.args as StructureIdArgs).id)
              if (patches.length === 0) return undefined
              enq(() => writer.apply('Close sketch', patches))
            } else if (event.id === 'sketch.set') {
              const { id, changes } = event.args as SketchSetArgs
              const patches = setSketch(reader.doc, id, changes)
              if (patches.length === 0) return undefined
              enq(() => writer.apply('Edit sketch', patches))
            } else if (event.id === 'structure.delete') {
              const patches = removeStructure(reader.doc, (event.args as StructureIdArgs).id)
              if (patches.length === 0) return undefined
              enq(() => writer.apply('Delete structure', patches))
            } else if (event.id === 'structure.rename') {
              const { id, name } = event.args as StructureRenameArgs
              const patches = renameStructure(reader.doc, id, name)
              if (patches.length === 0) return undefined
              enq(() => writer.apply('Rename structure', patches))
            } else if (event.id === 'structure.place') {
              const { id, placement } = event.args as StructurePlaceArgs
              const patches = placeStructure(reader.doc, id, placement)
              if (patches.length === 0) return undefined
              enq(() => writer.apply('Place structure', patches))
            } else if (event.id === 'voxels.move') {
              const { structure, keys, dx, dz, dy, copy } = event.args as VoxelsMoveArgs
              const voxel = structureOf(reader.doc, structure, 'voxel')
              if (!voxel) return undefined
              const offset = clampOffset(voxel, keys, { dx, dz, dy })
              const patches = movePatches(reader.doc, voxel, snapshotVolume(voxel), snapshotObjects(reader.doc), keys, offset, copy ?? false)
              if (patches.length === 0) return undefined
              enq(() => writer.apply('Move voxels', patches))
            } else if (event.id === 'structure.reparent') {
              const { id, parent } = event.args as StructureReparentArgs
              const patches = reparentStructure(reader.doc, id, parent)
              if (patches.length === 0) return undefined
              enq(() => writer.apply('Move structure', patches))
            } else return undefined
            return {}
          },
        },
      },
    },
  })
}

/**
 * The pre-wired logic, over a store this package already holds. Internal since
 * #66 step 7 — `EditorStore` is not namable outside the package, so the only
 * callers left are `createDocument` below and this package's tests.
 */
export function createDocumentActorLogic(store: EditorStore) {
  return documentLogic(writerOf(store), store.reader)
}

export type DocumentActorLogic = ReturnType<typeof createDocumentActorLogic>

/**
 * What a composition root asks for (#13, #66 step 7): a document, as the two
 * faces it is allowed to have. The store is constructed in here and never
 * escapes, so an app holds a `reader` to read through and a `logic` to hand
 * `createHost`, and has no way to write except by dispatching a command at the
 * actor the host spawns from that logic.
 */
export function createDocument(doc: MapDoc): DocumentSource {
  const store = createDocumentStore(doc)
  return { reader: store.reader, logic: documentLogic(store.writer, store.reader) }
}

/** The pair a host is built from. Named so `HostOptions` can take it as one argument. */
export interface DocumentSource {
  readonly reader: DocumentReader
  readonly logic: DocumentActorLogic
}
