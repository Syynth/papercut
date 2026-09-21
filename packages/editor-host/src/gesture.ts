/**
 * The gesture actor: pointer arbitration (#11, #14).
 *
 * The viewport's `dragging` union — `'none' | 'stroke' | 'orbit' | 'pan' |
 * 'pending'` across three pointer handlers — SPLIT rather than moved. What
 * came here is the arbitration: which button with which modifier means which
 * gesture, the alt+left press held as `pending` until it travels
 * `ORBIT_DRAG_THRESHOLD` and replays as a click if it never does, and
 * pointer-up. What stayed in `viewport.ts` is the per-frame yaw, pitch and
 * pan deltas, which never round-trip through an actor: this actor sees a
 * handful of events per gesture, the viewport applies sixty deltas a second
 * against the answer it got back. The reason is the map's "three kinds of
 * state" constraint, not performance (#11).
 *
 * The state names ARE the answer: `snapshot.value` is the `Gesture` the
 * viewport reads, so there is no second copy of the decision anywhere.
 *
 * The seam this closes was one bug's home. Before, the viewport decided
 * `pending` and replayed the press through `onStrokeStart`, while the app's
 * handler was what called `store.beginStroke()` — one gesture, two files, and
 * the replay picked at the press event's coordinates after the fact. Now the
 * press's sample is picked once, at the press, held in context, and the
 * replay begins and ends a stroke at that sample in one transition. The
 * tests are synthetic pointer sequences into this actor, no DOM (#10).
 *
 * `editing` rides on every `pointer.down` rather than being mirrored into
 * context: the host's `mode` is the host's, and #8 found that a held copy of
 * something derived is how `play.stop` went permanently unavailable. In play
 * mode a left press starts no stroke and a pending release replays no click,
 * but middle, right and alt+drag still orbit and pan — the parity the
 * prototype's history needed.
 *
 * Held keys moved here from the viewport's `Set<string>` (#14: modifier-held-
 * while-dragging is the gesture actor's, not the keymap's). The viewport reads
 * them back per frame for WASD; step 6's keymap dispatcher takes over the
 * `window` listener that feeds them.
 *
 * A stroke is a SPAWNED CHILD, not a state with data (#11): `pointer.down`
 * spawns `strokeLogic` with the handler the active tool returned and sends it
 * `begin` in the same transition; `pointer.up` sends `end` and the child stops
 * itself. The ref is retained, never nulled (#8): a send to the stopped child
 * dead-letters instead of vanishing. Everything reaching the stroke is by ref
 * — `enq.sendTo` takes nothing else on v6.
 */

import type { DocumentReader } from '@papercut/document'
import { setup, types } from 'xstate'

import { strokeLogic, type DocumentRef, type StrokeRef } from './stroke'
import { NO_PICK, type EditorStrokeHandler, type PickSample, type PointerModifiers, type StrokeSample } from './strokes'

/** Which gesture a press turned out to be. `'none'` between gestures; `'pending'` while an alt+left press has not yet declared itself. */
export type Gesture = 'none' | 'pending' | 'stroke' | 'orbit' | 'pan'

/**
 * How far an alt+left press must travel before it counts as an orbit drag
 * rather than an eyedropper click. Small enough that a deliberate drag is
 * never swallowed, large enough to absorb trackpad jitter during a tap.
 */
export const ORBIT_DRAG_THRESHOLD = 4

/** A press, with what the viewport picked under it (left button only; `null` otherwise). */
export interface PointerPress {
  readonly x: number
  readonly y: number
  /** DOM button: 0 left, 1 middle, 2 right. */
  readonly button: number
  readonly modifiers: PointerModifiers
  readonly pick: PickSample | null
  /** Which press of a run of quick presses in one place this is: 2 for a double-click. Absent is 1. */
  readonly clicks?: number
}

export interface PointerMotion {
  readonly x: number
  readonly y: number
  readonly modifiers: PointerModifiers
}

export interface PointerRelease {
  readonly x: number
  readonly y: number
}

export interface GestureDeps {
  readonly reader: DocumentReader
  readonly document: DocumentRef
  /** The active tool's handler for a left press at `sample`, or `undefined` to start no stroke. */
  strokeFor(sample: StrokeSample): EditorStrokeHandler | undefined
}

/**
 * Exported for declaration emit only (#46). The actor logic below infers a
 * return type that names this interface, and a `.d.ts` cannot refer to a type
 * its own module does not export (TS4058). It stays off `index.ts`, so the
 * package's public surface is unchanged.
 */
export interface GestureContext {
  /** Keys currently down, lower-cased, as the viewport's play loop reads them. */
  readonly held: ReadonlySet<string>
  /** The alt+left press being held: replayed as a click on release, discarded once it orbits. */
  readonly press: (PointerPress & { readonly editing: boolean }) | null
  /** The most recent stroke — stopped or not. Retained so a late send dead-letters. */
  readonly stroke: StrokeRef | undefined
  /** The open stroke's handler, for what it says it is carrying; `null` outside a stroke. */
  readonly handler: EditorStrokeHandler | null
  /** The last sample the open stroke saw, so `end` can carry where the pointer was. */
  readonly lastSample: StrokeSample | null
}

function sampleOf(press: PointerPress): StrokeSample {
  return { pick: press.pick ?? NO_PICK, modifiers: press.modifiers, ...(press.clicks !== undefined && press.clicks > 1 ? { clicks: press.clicks } : {}) }
}

export function gestureLogic(deps: GestureDeps) {
  return setup({
    schemas: {
      context: types<GestureContext>(),
      events: {
        'pointer.down': types<PointerPress & { editing: boolean }>(),
        'pointer.move': types<PointerMotion>(),
        'pointer.up': types<PointerRelease>(),
        'stroke.move': types<{ sample: StrokeSample }>(),
        'key.down': types<{ key: string }>(),
        'key.up': types<{ key: string }>(),
      },
    },
  }).createMachine({
    id: 'gesture',
    context: { held: new Set<string>(), press: null, stroke: undefined, handler: null, lastSample: null },
    initial: 'none',
    on: {
      'key.down': ({ context, event }) => (context.held.has(event.key) ? undefined : { context: { held: new Set([...context.held, event.key]) } }),
      'key.up': ({ context, event }) => {
        if (!context.held.has(event.key)) return undefined
        const held = new Set(context.held)
        held.delete(event.key)
        return { context: { held } }
      },
    },
    states: {
      none: {
        on: {
          'pointer.down': ({ event }, enq) => {
            // Middle drags orbit and right drags pan, but a MacBook trackpad
            // has no middle button, so alt+drag orbits as well — the
            // Maya/Unity gesture. Alt is also the eyedropper, so that press is
            // held as `pending` until it moves far enough to be a drag.
            if (event.button === 1) return { target: 'orbit' }
            if (event.button === 2) return { target: 'pan' }
            if (event.button !== 0) return undefined
            if (event.modifiers.alt) return { target: 'pending', context: { press: event } }
            if (!event.editing) return undefined

            const sample = sampleOf(event)
            const handler = deps.strokeFor(sample)
            if (!handler) return undefined
            const stroke = enq.spawn(strokeLogic(handler, deps.reader, deps.document))
            enq.sendTo(stroke, { type: 'begin', sample })
            return { target: 'stroke', context: { stroke, handler, lastSample: sample } }
          },
        },
      },
      pending: {
        on: {
          'pointer.move': ({ context, event }) => {
            const press = context.press
            if (!press) return { target: 'none' }
            const moved = Math.hypot(event.x - press.x, event.y - press.y)
            if (moved < ORBIT_DRAG_THRESHOLD) return {}
            return { target: 'orbit', context: { press: null } }
          },
          'pointer.up': ({ context }, enq) => {
            const press = context.press
            // Never moved: replay it as the click it turned out to be, AT THE
            // PRESS SAMPLE, so a stray pixel of travel cannot land the
            // eyedropper on a different cell. Not in play mode.
            if (!press || !press.editing) return { target: 'none', context: { press: null } }
            const sample = sampleOf(press)
            const handler = deps.strokeFor(sample)
            if (!handler) return { target: 'none', context: { press: null } }
            const stroke = enq.spawn(strokeLogic(handler, deps.reader, deps.document))
            enq.sendTo(stroke, { type: 'begin', sample })
            enq.sendTo(stroke, { type: 'end', sample })
            return { target: 'none', context: { press: null, stroke, lastSample: sample } }
          },
        },
      },
      stroke: {
        on: {
          'stroke.move': ({ context, event }, enq) => {
            enq.sendTo(context.stroke, { type: 'move', sample: event.sample })
            return { context: { lastSample: event.sample } }
          },
          'pointer.up': ({ context }, enq) => {
            enq.sendTo(context.stroke, { type: 'end', sample: context.lastSample ?? { pick: NO_PICK, modifiers: { shift: false, alt: false, ctrl: false } } })
            return { target: 'none', context: { handler: null } }
          },
        },
      },
      orbit: {
        on: { 'pointer.up': () => ({ target: 'none' }) },
      },
      pan: {
        on: { 'pointer.up': () => ({ target: 'none' }) },
      },
    },
  })
}

export type GestureLogic = ReturnType<typeof gestureLogic>
