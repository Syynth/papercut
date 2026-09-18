/**
 * The stroke actor: spawned at pointer-down, dead at release (#11).
 *
 * One per stroke, spawned by the gesture actor with the handler the active
 * tool returned. Its context is the COMPACTION MAP — one `{ first, last }`
 * per patch address, `first` the before-value at the address's first touch
 * and `last` the most recent forward value — which is where the measured
 * 3,780 patches over 260 unique addresses (14.5x) collapse to one `Edit`.
 * Two invariants, both pinned by `stroke.test.ts`:
 *
 *   1. PATCHES APPLY IMMEDIATELY. Every tick's patches go to the document
 *      actor as they are computed, so the terrain deforms under the pointer.
 *      Only the undo record is compacted; this is not buffer-then-apply.
 *   2. ONE `Edit` ON RELEASE, one entry per address touched. Lossless because
 *      nothing inside a stroke is observable as a separate state — the whole
 *      drag is one undo entry — so a cell raised, lowered and raised again
 *      keeps its first before-value and its last forward value and nothing
 *      in between; a cell put back where it started drops out entirely.
 *
 * The map is bounded by cells touched, not ticks, which is why the "never put
 * the document in machine context" constraint does not reach it (#11). It is
 * held in context and MUTATED inside `enq` rather than rebuilt and returned:
 * the handler contract (registry `tools.ts`) is stateful by design — a
 * handler is fresh per stroke and its methods are called once per phase — and
 * a v6 transition body re-runs from the top the moment it touches `enq` (#2),
 * so the one place a `handler.move()` can be called exactly once is inside
 * the enqueued effect, and the map has to be recorded there too because the
 * inverse must be read BEFORE the document applies the patch. Nothing in a
 * body below runs before its first `enq` call except destructuring.
 *
 * The document ref and the reader arrive by factory closure, never `input`
 * (#4): a handler is a closure over the reader and would reach an inspector
 * on the init event. The map dies with the actor: its natural death at
 * `done` is what makes discarding it a lifecycle event rather than a field
 * somebody must remember to clear, and teardown is never in `exit` (#8).
 */

import { inversePatch, patchAddress, type Cell, type DocumentActorLogic, type DocumentReader, type Patch } from '@papercut/document'
import { setup, types, type ActorRefFrom } from 'xstate'

import type { EditorStrokeHandler, StrokeSample } from './strokes'

export type DocumentRef = ActorRefFrom<DocumentActorLogic>

/**
 * Exported for declaration emit only (#46). The actor logic below infers a
 * return type that names this interface, and a `.d.ts` cannot refer to a type
 * its own module does not export (TS4058). It stays off `index.ts`, so the
 * package's public surface is unchanged.
 */
export interface Compacted {
  readonly first: Patch
  last: Patch
}

/** Exported for declaration emit only, same as `Compacted` above (#46). */
export interface StrokeContext {
  readonly compaction: Map<string, Compacted>
  /** The cell the stroke began on — what a rectangle preview grows from — or `null` off the map. */
  readonly origin: Cell | null
}

/**
 * Record a tick into the map. Must run before `patches` reach the document:
 * `first` is the before-value, and after the apply it is gone.
 */
function record(compaction: Map<string, Compacted>, reader: DocumentReader, patches: readonly Patch[]): void {
  for (const patch of patches) {
    const key = patchAddress(patch)
    const entry = compaction.get(key)
    if (entry) entry.last = patch
    else compaction.set(key, { first: inversePatch(reader.doc, patch), last: patch })
  }
}

/**
 * The record for `endStroke`. An address whose last value equals its first
 * before-value was put back where it started, so both its forward and its
 * inverse would be no-ops; it is dropped rather than recorded.
 */
function compacted(compaction: Map<string, Compacted>): { patches: Patch[]; inverse: Patch[] } {
  const patches: Patch[] = []
  const inverse: Patch[] = []
  for (const { first, last } of compaction.values()) {
    // A face's material layers are an array, so equal is equal content, not the same array.
    if (first.value === last.value || JSON.stringify(first.value) === JSON.stringify(last.value)) continue
    patches.push(last)
    inverse.push(first)
  }
  return { patches, inverse }
}

export function strokeLogic(handler: EditorStrokeHandler, reader: DocumentReader, document: DocumentRef) {
  /** One tick: record, then apply — in that order, see `record`. */
  const tick = (compaction: Map<string, Compacted>, patches: readonly Patch[]): void => {
    if (patches.length === 0) return
    record(compaction, reader, patches)
    // `strokePatch`, not `patch`: a tick applies without recording, and saying
    // so in the verb is what lets `apply` keep its always-record meaning for
    // an ordinary edit that lands mid-drag (see `store.ts`). The label is not
    // sent — the one a stroke shows is the one `beginStroke` carried.
    document.send({ type: 'strokePatch', patches: [...patches] })
  }

  return setup({
    schemas: {
      context: types<StrokeContext>(),
      events: {
        begin: types<{ sample: StrokeSample }>(),
        move: types<{ sample: StrokeSample }>(),
        end: types<{ sample: StrokeSample }>(),
      },
    },
  }).createMachine({
    id: 'stroke',
    context: () => ({ compaction: new Map<string, Compacted>(), origin: null }),
    initial: 'open',
    states: {
      open: {
        on: {
          begin: ({ context, event }, enq) => {
            const { surface } = event.sample.pick
            enq(() => {
              document.send({ type: 'beginStroke', label: handler.label })
              tick(context.compaction, handler.begin(event.sample))
            })
            return { context: { origin: surface ? [surface.x, surface.y] : null } }
          },
          move: ({ context, event }, enq) => {
            enq(() => tick(context.compaction, handler.move(event.sample)))
            return {}
          },
          end: ({ context, event }, enq) => {
            enq(() => {
              tick(context.compaction, handler.end(event.sample))
              document.send({ type: 'endStroke', ...compacted(context.compaction) })
            })
            return { target: 'done' }
          },
        },
      },
      // Final: the actor stops itself and the map goes with it. The gesture
      // actor keeps the stale ref, so a late `move` dead-letters (#8).
      done: { type: 'final' },
    },
  })
}

export type StrokeLogic = ReturnType<typeof strokeLogic>
export type StrokeRef = ActorRefFrom<StrokeLogic>
