/**
 * The host: the root actor and the single dispatch entry point (#8, #11).
 *
 * Bubble-down from one root. A keybinding, a menu item and a test all call
 * `dispatch(id, args)` and nothing else; the host looks the id up in the
 * registry, evaluates its availability against context keys derived from the
 * live actor snapshots, validates the arguments, and routes the command to
 * the actor of the OWNER that declared it — by `ActorRef`, never by string
 * id, which on v6 is unrepresentable rather than forbidden (#15: `enq.sendTo`
 * takes a ref or `undefined`). Every outcome is a return value; nothing here
 * throws on an ordinary user action.
 *
 * The host owns `mode` as its top-level state — `edit` or `play` (#11) — and
 * the lifetimes of its children: the document actor (the one holder of the
 * write path, #13), the long-lived `tools`, `view` and `gesture` actors, and
 * one actor per installed feature. The gesture actor in turn spawns one
 * stroke actor per pointer-down (`gesture.ts`, `stroke.ts`), and entering
 * `play` spawns one play actor per SESSION (`play.ts`), stopped on the way
 * back out — the two places where a lifetime shorter than the host's is a
 * lifetime an actor has rather than a flag somebody clears. Children are
 * held in context as refs, and a STALE REF IS RETAINED, NEVER NULLED: a send
 * to a stopped ref dead-letters with `reason: 'stopped'` and the router stays
 * `active`, while a send to `undefined` is a silent no-op (#15, measured on
 * alpha.53). Retaining is what makes "declared but nobody is listening"
 * observable as an `unhandled` result instead of vanishing.
 *
 * Pointer input is NOT a command. It reaches the gesture actor through
 * `Host.input`, whose methods the viewport's handlers are: a press or a move
 * is not something a keybinding or a palette invokes, and its answer — which
 * gesture this is — is read back synchronously so the viewport can apply its
 * per-frame deltas against it. `dispatch` stays the only entry point for
 * everything a command is.
 *
 * Three constraints from the map shape the code and are easy to undo by
 * accident:
 *
 * 1. THE DOCUMENT ARRIVES BY FACTORY CLOSURE, NEVER BY `input`. `hostLogic`
 *    closes over the reader (and `play.ts` over it again); the machine's
 *    context holds refs and nothing else, so nothing the size of a document
 *    can reach an inspector (#4).
 * 2. EVERY EFFECT GOES THROUGH `enq`. A v6 transition body re-runs from the
 *    top the moment it touches `enq` (#2), so the routing bodies below are
 *    pure apart from `enq.sendTo` / `enq.stop`, and the dead letters the
 *    dispatcher reads are taken outside the machine, after `send` returns —
 *    and matched to the routed command's event, not counted, because a stroke
 *    actor sending internally can dead-letter for reasons of its own.
 * 3. TEARDOWN IS NEVER IN `exit`: exit actions do not run when an actor is
 *    stopped (xstate#4630). `dispose(owner)` orders it explicitly — revoke
 *    declarations, send `dispose`, stop the ref (#21 §5) — and `stop()` is a
 *    method, not a state.
 *
 * A FEATURE IS INSTALLED IN TWO PLACES, and they are not interchangeable. An
 * app hands its features to `createHost`, which builds each one's half from
 * deps only a composition root can supply and spawns it under its owner. After
 * that, a hot re-import of a feature module arrives through the registry's
 * install hook instead (#21 §6): the module that re-executes exports a NEW
 * `create` this host has never spawned, and nothing else would tell it so. The
 * hook is released by `stop`, because a stopped host must not be installed
 * into.
 *
 * Context keys are derived on EVERY dispatch, never held (#8's finding 2:
 * a frozen snapshot left `play.stop` permanently unavailable). The cost is a
 * handful of `getSnapshot` calls per dispatch; a palette rendering every
 * frame would memoise on the revision counter plus the host snapshot instead.
 */

import {
  DOCUMENT_OWNER,
  clampOffset,
  contractRegion,
  documentKeys,
  expandRegion,
  frameOf,
  groundedPosition,
  invertRegion,
  offsetKeys,
  pairRegion,
  pruneRegion,
  regionOf,
  structureOf,
  toLocal,
  createProject,
  type Cell,
  type DocumentActorLogic,
  type DocumentReader,
  type DocumentSource,
  type Frame,
  type LayerSpan,
  type Patch,
  type ProjectDoc,
  type ReadonlyMapDoc,
} from '@papercut/document'
import {
  and,
  commands,
  dispose as disposeDeclarations,
  defineContextKey,
  onFeatureChange,
  reserveOwner,
  resolveCommand,
  tools as toolDeclarations,
  type ContextSnapshot,
  type DispatchResult,
  type FeatureDeps,
  type FeatureInstance,
  type OwnerId,
  type ToolContract,
} from '@papercut/registry'
import { z } from 'zod'
import {
  createActor,
  setup,
  types,
  type Actor,
  type ActorOptions,
  type ActorRefFrom,
  type AnyActorLogic,
  type AnyActorRef,
  type AnyEventObject,
  type InspectionEvent,
} from 'xstate'

import { gestureLogic, type Gesture, type GestureLogic, type PointerMotion, type PointerPress, type PointerRelease } from './gesture'
import { playLogic, type PlayLogic } from './play'
import { PROJECT_OWNER, projectKeys, projectLogicWith, type ProjectLogic } from './project'
import { createStrokeHandler, type PickSample, type PointerModifiers, type StrokeDeps, type StrokeSample } from './strokes'
import { TOOLS_OWNER, toolKeys, toolsLogicWith, type FeatureParams, type ToolsLogic } from './tools'
import { VIEW_OWNER, viewKeys, viewLogic, type Selection, type ViewLogic } from './view'
import { VIEWPORT_OWNER, viewportLogic, type ViewportLogic } from './viewport'

export const HOST_OWNER = reserveOwner('editor-host')
/** The gesture actor declares no commands; the id is the key its ref is held under. */
export const GESTURE_OWNER = reserveOwner('editor-host.gesture')

export type Mode = 'edit' | 'play'

/**
 * What a running play session tells the outside world: where the character
 * was put down. Read by the viewport, which builds the character from it —
 * the session's own context, narrowed to what leaves the host.
 */
export interface PlaySession {
  readonly start: readonly [number, number, number]
}

export const hostKeys = {
  mode: defineContextKey<Mode>(HOST_OWNER, 'host.mode', 'edit'),
}

/**
 * Whether a pointer stroke is open. Minted under the gesture actor's owner
 * because it is that actor's state, and it exists because a keybinding must
 * be able to say "not mid-drag": `keydown` is on `window` and pointer capture
 * does not stop it, so Delete fires in the middle of a drag, and the object
 * tool drags the SELECTED object — the one Delete would remove. The store
 * refuses a write at an address the open stroke owns, so the delete would not
 * land while the selection cleared anyway. As a predicate the refusal happens
 * one step earlier, with a reason, and the key falls through untouched.
 */
export const gestureKeys = {
  stroking: defineContextKey(GESTURE_OWNER, 'host.stroking', false),
}

/**
 * A binding binds ONE `(id, args)` — that is the shape every editor surveyed
 * converged on (#5) — and some intents are two commands. `3` selects the
 * camera tool AND opens the coverage panel, which are two owners' business.
 * VS Code answers this with `runCommands`; so does this. The steps are plain
 * serialisable data, so the composite is as storable as any other binding,
 * and each step still goes through `resolveCommand` and its own schema: this
 * is a sequence of dispatches, not a way around one.
 */
const runCommands = z
  .object({ commands: z.array(z.object({ id: z.string().min(1), args: z.unknown().optional() })).min(1) })
  .strict()

commands.declare(HOST_OWNER, { id: 'mode.play', title: 'Enter Play Mode', category: 'Mode', when: hostKeys.mode.is('edit') })
commands.declare(HOST_OWNER, { id: 'mode.edit', title: 'Leave Play Mode', category: 'Mode', when: hostKeys.mode.is('play') })
commands.declare(HOST_OWNER, { id: 'commands.run', title: 'Run Commands', category: 'Commands', args: runCommands })
/**
 * "Delete what is selected" is a UI intent, and the UI is what turns it into
 * arguments: this expands to `objects.delete({ ids })` plus `selection.set`,
 * both id-addressed, both validated. No handler learns the selection from it
 * (#11) — the expansion happens in `dispatch`, outside every actor, which is
 * the same place a menu item filling in its own arguments would.
 */
commands.declare(HOST_OWNER, {
  id: 'selection.delete',
  title: 'Delete Selection',
  category: 'Selection',
  when: and(viewKeys.hasSelection.is(true), gestureKeys.stroking.is(false)),
})
/**
 * "Move what is selected by a cell" (ruling of 2026-09-12, "Select tool": the
 * arrow keys nudge the selection) expands the same way: to the id-addressed
 * command the selection's kind answers to — an object's position, a
 * structure's placement, a sketch point — with the step applied to what the
 * document holds at the moment of the dispatch. World axes: `dx` is east,
 * `dz` south, in whole cells.
 */
const nudgeArgs = z.object({ dx: z.int().min(-64).max(64), dz: z.int().min(-64).max(64), /** Up, in voxels: a region of voxels is the one thing that can be nudged in height. */ dy: z.int().min(-64).max(64).exactOptional() }).strict()
export type NudgeArgs = z.infer<typeof nudgeArgs>
commands.declare(HOST_OWNER, {
  id: 'selection.nudge',
  title: 'Nudge Selection',
  category: 'Selection',
  args: nudgeArgs,
  when: and(viewKeys.hasSelection.is(true), gestureKeys.stroking.is(false)),
})

/**
 * A region grown, shrunk or turned inside out (ruling of 2026-09-12, "App frame": region verbs). Like the two above it
 * expands, outside every actor, to the one command that sets a selection, with the region worked out from the
 * document as it stands at the dispatch.
 */
const regionOpArgs = z.object({ op: z.enum(['expand', 'contract', 'invert', 'pair']) }).strict()
export type RegionOpArgs = z.infer<typeof regionOpArgs>
commands.declare(HOST_OWNER, {
  id: 'selection.region',
  title: 'Change Region',
  category: 'Selection',
  args: regionOpArgs,
  when: and(viewKeys.hasSelection.is(true), gestureKeys.stroking.is(false)),
})

/**
 * What the host hands a feature when it spawns it: the document's read path,
 * the tool parameters, and the one write door — `apply` is an event at the
 * document actor, which is the only holder of `writer` (#13). A feature builds
 * its actor from these and closes over them; they never travel as `input`
 * (#4), which would put the document in reach of an inspector.
 */
/** What a feature is handed: the document, its own parameter slice (typed by the feature), and the write path. */
export type EditorFeatureDeps = FeatureDeps<ReadonlyMapDoc, Patch, object>

/** What a feature's `create` answers with, in the host's own types. */
export type EditorFeatureInstance = FeatureInstance<AnyActorLogic, StrokeSample, Patch>

/**
 * A feature module as the host sees it (#9, #35): the owner id its
 * declarations were registered under, and the factory that builds its half
 * once the deps exist. The host spawns the logic under that id and routes the
 * owner's commands to it; it never imports the feature — an app hands these
 * in, and a hot re-import arrives through `onFeatureChange` instead (#21 §6).
 *
 * `create` is a METHOD rather than a function-typed property, deliberately:
 * see `registry`'s `feature.ts` for why the seam stops working if that
 * changes.
 */
export interface Feature {
  readonly owner: OwnerId
  /** The feature's parameters as they start; its slice in the tools actor is seeded with them. */
  readonly params?: object
  create(deps: EditorFeatureDeps): EditorFeatureInstance
}

/** A command on its way down: the routed form of `CommandEvent`, carrying the owner the registry resolved. */
interface RoutedCommand {
  readonly owner: OwnerId
  readonly id: string
  readonly args: unknown
}

interface HostContext {
  /**
   * `AnyActorRef`, not a union of the child logics — #8's accepted cost. A
   * heterogeneous map keyed by a runtime string cannot keep per-child
   * snapshot types; routing needs none, and the typed accessors on `Host`
   * are the helper readers get instead.
   */
  readonly children: Readonly<Record<OwnerId, AnyActorRef>>
  /**
   * The play session, spawned on the way into `play` and stopped on the way
   * out (#11). Typed rather than `AnyActorRef` because something reads its
   * context: `Host.playSession` answers with the character's start.
   *
   * The stopped ref is RETAINED, as every other child ref is — what says the
   * session is over is the host's own state, not a null here, and a stale ref
   * is what makes a send to a finished session dead-letter instead of
   * vanishing (#15).
   */
  readonly play: ActorRefFrom<PlayLogic> | null
}

/** An undelivered event, as the dispatcher saw it. `target` is the actor id the ref pointed at. */
export interface DeadLetter {
  readonly reason: string
  readonly target: string
  readonly event: AnyEventObject
}

/**
 * What v6 exposes for time: `{ now?, setTimeout, clearTimeout }`, the shape
 * `createActor` takes as `clock` and `SimulatedClock` implements. The
 * interface itself is not re-exported from `xstate`'s index on alpha.53, so
 * it is named here off the option that carries it.
 */
export type Clock = NonNullable<ActorOptions<AnyActorLogic>['clock']>

export interface HostOptions {
  /**
   * The document, as the two faces `createDocument` hands out (#13, #66 step
   * 7): the reader everything reads through and the logic the host spawns the
   * one write path from. No store — there is no such type outside
   * `packages/document` any more.
   */
  readonly document: DocumentSource
  /** The project the document belongs to: its materials, resolution and sheets. A fresh one with the defaults when absent. */
  readonly project?: ProjectDoc
  /** Time is injected (#10). Absent means xstate's real clock. */
  readonly clock?: Clock
  readonly features?: readonly Feature[]
}

/**
 * The deps a feature is built from, closed over the sibling refs the context
 * factory spawned — the same mechanism the gesture actor's stroke deps use,
 * and the reason neither the store nor the document travels as `input` (#4).
 * `apply` is one labelled edit as an EVENT at the document actor: a feature
 * has no writer and no route to one (#13).
 */
function featureDeps(owner: OwnerId, reader: DocumentReader, document: AnyActorRef, tools: ActorRefFrom<ToolsLogic>, view: ActorRefFrom<ViewLogic>): EditorFeatureDeps {
  return {
    select: (selection) => view.send({ type: 'select', selection: selection as Selection | null }),
    doc: () => reader.doc,
    // The feature's own slice, and nothing else's: what it declared at install, plus what it set since.
    params: () => tools.getSnapshot().context.features[owner] ?? {},
    setParams: (changes) => tools.send({ type: 'feature', owner, changes: changes as FeatureParams }),
    apply: (label, patches) => document.send({ type: 'patch', label, patches: [...patches] }),
  }
}

function contractFor(instances: Map<OwnerId, EditorFeatureInstance>, toolId: string): ToolContract<StrokeSample, Patch> | undefined {
  const owner = toolDeclarations.ownerOf(toolId)
  return owner === undefined ? undefined : instances.get(owner)?.tools?.[toolId]
}

function hostLogic(source: DocumentSource, project: ProjectDoc, features: readonly Feature[], instances: Map<OwnerId, EditorFeatureInstance>) {
  const { reader } = source

  return setup({
    schemas: {
      context: types<HostContext>(),
      events: {
        command: types<RoutedCommand>(),
        dispose: types<{ owner: OwnerId }>(),
        install: types<{ owner: OwnerId; logic: AnyActorLogic }>(),
      },
    },
  }).createMachine({
    id: 'host',
    // Spawned from the logic values, not from string source keys: on
    // alpha.53 `spawn('key')` inside the initial-context factory reaches a
    // logic with no `initialTransition` and the child starts in `error`.
    context: ({ spawn }) => {
      const document = spawn(source.logic, { id: 'document' })
      const projectRef = spawn(projectLogicWith(project), { id: 'project' })
      const tools = spawn(toolsLogicWith(Object.fromEntries(features.map((feature) => [feature.owner, (feature.params ?? {}) as FeatureParams]))), { id: 'tools' })
      const view = spawn(viewLogic, { id: 'view' })
      const viewport = spawn(viewportLogic, { id: 'viewport' })
      // The gesture actor's stroke children write through the document ref,
      // read tool parameters from the tools ref, and reach a feature's tool
      // contract through `instances`, so its logic is built here, closed over
      // the sibling refs — a factory closure, the same mechanism that keeps
      // the store off `input` (#4).
      //
      // The eyedropper's tool write and the object tool's selection leave
      // through `settings` and `select`: TYPED HOST-INTERNAL EVENTS, not
      // commands. They run inside a stroke's enqueued effect, where calling
      // `dispatch` would re-enter the registry from within an effect; and a
      // hand-rolled `{ type: 'command', id, args }` at the sibling ref — what
      // this was — skipped `resolveCommand`, `validateArgs` and availability
      // while looking exactly like the entry point #8 settled on, with
      // `args: unknown` letting a cast rather than the schema decide what was
      // legal. The typed events carry `ToolSettings` and the id as types, so
      // a change to the schema's shape reaches these call sites, and nothing
      // here pretends to be a command. `dispatch` stays the only way IN.
      const strokeDeps: StrokeDeps = {
        reader,
        tools: () => tools.getSnapshot().context,
        setTools: (settings) => tools.send({ type: 'settings', settings }),
        select: (selection) => view.send({ type: 'select', selection }),
        // The layer view is kept in half-tiles and a voxel is two of them: the layers a region may reach through.
        layerSpan: () => {
          const range = view.getSnapshot().context.layers
          return range === null ? null : { lo: Math.floor(range.lo / 2), hi: Math.ceil(range.hi / 2) }
        },
        // Read per press, never captured: a feature installed by a hot
        // re-import replaces its instance wholesale, and the next stroke must
        // run the new contract rather than one closed over at spawn.
        contract: (toolId) => contractFor(instances, toolId),
      }
      const gesture = spawn(
        gestureLogic({
          reader,
          document,
          // #11: a handler never reads ambient selection; the host fills the
          // id in at the press, the way a UI fills in a command's argument.
          strokeFor: (sample) => createStrokeHandler(strokeDeps, sample, view.getSnapshot().context.selection),
        }),
        { id: 'gesture' },
      )
      // A feature's half is built HERE, where the sibling refs it needs exist,
      // and the instance is kept beside the ref: `create` answers with the
      // actor to spawn plus the tool contracts and context keys the
      // declarations alone cannot carry (#9's two-registry split).
      const spawned = features.map((feature) => {
        const instance = feature.create(featureDeps(feature.owner, reader, document, tools, view))
        instances.set(feature.owner, instance)
        return [feature.owner, spawn(instance.logic, { id: feature.owner })] as const
      })
      return {
        children: {
          [DOCUMENT_OWNER]: document,
          [PROJECT_OWNER]: projectRef,
          [TOOLS_OWNER]: tools,
          [VIEW_OWNER]: view,
          [VIEWPORT_OWNER]: viewport,
          [GESTURE_OWNER]: gesture,
          ...Object.fromEntries(spawned),
        },
        play: null,
      }
    },
    initial: 'edit',
    states: {
      edit: {
        on: {
          command: ({ context, event }, enq) => {
            if (event.owner === HOST_OWNER) {
              if (event.id !== 'mode.play') return undefined
              // The session actor and the `play` state begin together, in one
              // transition: spawning it from an effect elsewhere would leave a
              // window in which the editor is in play mode with no session.
              return { target: 'play', context: { play: enq.spawn(playLogic(reader), { id: 'play' }) } }
            }
            enq.sendTo(context.children[event.owner], { type: 'command', id: event.id, args: event.args })
            return {}
          },
          dispose: ({ context, event }, enq) => {
            const ref = context.children[event.owner]
            enq.sendTo(ref, { type: 'dispose' })
            enq.stop(ref)
            return {}
          },
          // A hot re-import (#21 §6). The previous incarnation's declarations
          // and keys were revoked by the registry and its actor stopped by the
          // `dispose` above, both before this arrives, so what is left is to
          // spawn the module's new logic under the same owner: an id a stopped
          // child still holds is free, which is what lets the address stay the
          // one the registry routes by.
          install: ({ context, event }, enq) => ({
            context: { children: { ...context.children, [event.owner]: enq.spawn(event.logic, { id: event.owner }) } },
          }),
        },
      },
      play: {
        on: {
          command: ({ context, event }, enq) => {
            if (event.owner === HOST_OWNER) {
              if (event.id !== 'mode.edit') return undefined
              // Stopped through `enq`, never in `exit`: exit actions do not
              // run when an actor is stopped (xstate#4630), and a non-root
              // actor is stopped only this way. The ref stays in context.
              if (context.play) enq.stop(context.play)
              return { target: 'edit' }
            }
            enq.sendTo(context.children[event.owner], { type: 'command', id: event.id, args: event.args })
            return {}
          },
          dispose: ({ context, event }, enq) => {
            const ref = context.children[event.owner]
            enq.sendTo(ref, { type: 'dispose' })
            enq.stop(ref)
            return {}
          },
          // A hot re-import (#21 §6). The previous incarnation's declarations
          // and keys were revoked by the registry and its actor stopped by the
          // `dispose` above, both before this arrives, so what is left is to
          // spawn the module's new logic under the same owner: an id a stopped
          // child still holds is free, which is what lets the address stay the
          // one the registry routes by.
          install: ({ context, event }, enq) => ({
            context: { children: { ...context.children, [event.owner]: enq.spawn(event.logic, { id: event.owner }) } },
          }),
        },
      },
    },
  })
}

/** What deleting the selection means, by what it is: the commands that do it, then the selection that remains. */
function nudgeSteps(doc: ReadonlyMapDoc, selection: Selection | null, { dx, dz, dy }: NudgeArgs): readonly { readonly id: string; readonly args?: unknown }[] {
  switch (selection?.kind) {
    case 'object': {
      const object = doc.objects[selection.id]
      if (!object || object.locked) return []
      const position = groundedPosition(doc, object.position[0] + dx, object.position[2] + dz)
      return [{ id: 'objects.update', args: { id: selection.id, changes: { position, anchorCell: object.anchorCell ? [Math.floor(position[0]), Math.floor(position[2])] : null } } }]
    }
    case 'structure': {
      const structure = doc.structures[selection.id]
      // The root has no parent to move within.
      if (!structure || structure.parent === null) return []
      const [lx, lz] = toLocalDelta(frameOf(doc, structure.parent), dx, dz)
      return [{ id: 'structure.place', args: { id: selection.id, placement: { ...structure.placement, x: structure.placement.x + lx, z: structure.placement.z + lz } } }]
    }
    case 'sketchPoint': {
      const sketch = structureOf(doc, selection.structure, 'sketch')
      const point = sketch?.points[selection.index]
      if (!sketch || !point) return []
      const [lx, lz] = toLocalDelta(frameOf(doc, sketch.id), dx, dz)
      return [{ id: 'sketch.point.update', args: { id: selection.structure, index: selection.index, changes: { x: point.x + lx, z: point.z + lz } } }]
    }
    case 'region': {
      // Voxels move (design round of 2026-09-19); faces and edges are not things a nudge can carry.
      const voxel = structureOf(doc, selection.structure, 'voxel')
      if (!voxel || selection.element !== 'voxel') return []
      const [lx, lz] = toLocalDelta(frameOf(doc, voxel.id), dx, dz)
      const offset = clampOffset(voxel, selection.keys, { dx: Math.round(lx), dz: Math.round(lz), dy: dy ?? 0 })
      if (offset.dx === 0 && offset.dz === 0 && offset.dy === 0) return []
      return [
        { id: 'voxels.move', args: { structure: selection.structure, keys: [...selection.keys], ...offset } },
        { id: 'selection.select', args: { selection: { kind: 'region', ...regionOf(selection.structure, 'voxel', offsetKeys(selection.keys, offset)) } } },
      ]
    }
    default:
      return []
  }
}

/** A world-axis step as the frame sees it: rotated by the frame's yaw, not shifted by its origin. */
function toLocalDelta(frame: Frame, dx: number, dz: number): [number, number] {
  const [x0, z0] = toLocal(frame, frame.x, frame.z)
  const [x1, z1] = toLocal(frame, frame.x + dx, frame.z + dz)
  return [x1 - x0, z1 - z0]
}

function regionSteps(doc: ReadonlyMapDoc, selection: Selection | null, args: RegionOpArgs, span: LayerSpan | null): readonly { readonly id: string; readonly args?: unknown }[] {
  if (selection?.kind !== 'region') return []
  const voxel = structureOf(doc, selection.structure, 'voxel')
  if (!voxel) return []
  const next = args.op === 'expand' ? expandRegion(voxel, selection) : args.op === 'contract' ? contractRegion(voxel, selection) : args.op === 'pair' ? pruneRegion(voxel, pairRegion(selection)) : invertRegion(voxel, selection, span)
  return [{ id: 'selection.select', args: { selection: next ? { kind: 'region', ...next } : null } }]
}

function deleteSteps(selection: Selection | null): readonly { readonly id: string; readonly args?: unknown }[] {
  switch (selection?.kind) {
    case 'object':
      return [{ id: 'objects.delete', args: { ids: [selection.id] } }, { id: 'selection.select', args: { selection: null } }]
    case 'structure':
      return [{ id: 'structure.delete', args: { id: selection.id } }, { id: 'selection.select', args: { selection: null } }]
    case 'sketchPoint':
      return [
        { id: 'sketch.point.delete', args: { id: selection.structure, index: selection.index } },
        { id: 'selection.select', args: { selection: { kind: 'structure', id: selection.structure } } },
      ]
    default:
      return []
  }
}

export type HostLogic = ReturnType<typeof hostLogic>
export type HostActor = Actor<HostLogic>

export interface HostChildren {
  readonly document: ActorRefFrom<DocumentActorLogic>
  /** The project the document belongs to (`project.ts`): materials, resolution, sheets, the map list. */
  readonly project: ActorRefFrom<ProjectLogic>
  readonly tools: ActorRefFrom<ToolsLogic>
  readonly view: ActorRefFrom<ViewLogic>
  /** What the viewport reports back: hover, brush cells, camera, frame stats (`viewport.ts`). */
  readonly viewport: ActorRefFrom<ViewportLogic>
  readonly gesture: ActorRefFrom<GestureLogic>
}

/**
 * The pointer and key port the viewport drives (#11). Each pointer method
 * answers with the gesture the press has become, read straight off the
 * gesture actor after the send — xstate processes a send synchronously when
 * the actor is idle — so the viewport applies orbit and pan deltas against
 * the actor's decision without holding a copy of it. All arrows: the viewport
 * stores them detached from `Host`.
 */
export interface EditorInput {
  pointerDown(press: PointerPress): Gesture
  pointerMove(motion: PointerMotion): Gesture
  pointerUp(release: PointerRelease): void
  /** The pick under the pointer while `pointerMove` answers `'stroke'`; the viewport picks only then. */
  strokeMove(pick: PickSample, modifiers: PointerModifiers): void
  /** What the open stroke is carrying: ids the viewport's pick looks past, so the sample says what they would land on. Empty outside a stroke. */
  carrying(): ReadonlySet<string>
  keyDown(key: string): void
  keyUp(key: string): void
  heldKeys(): ReadonlySet<string>
  gesture(): Gesture
  /** The cell the open stroke began on — what a rectangle preview grows from — or `null` outside a stroke. */
  strokeOrigin(): Cell | null
}

export interface Host {
  readonly actor: HostActor
  /** The document's read path (#13): what a panel selects from and what a test asserts through. */
  readonly reader: DocumentReader
  readonly children: HostChildren
  readonly input: EditorInput
  /** Every undelivered event since the host started, oldest first. */
  readonly deadLetters: readonly DeadLetter[]
  /** THE SINGLE ENTRY POINT. Plain serialisable arguments; never throws. */
  dispatch(id: string, args?: unknown): DispatchResult
  /** The live availability vocabulary, derived now — what a palette evaluates every declaration against. */
  contextKeys(): ContextSnapshot
  /**
   * The contract behind a declared tool (#9's handler half), or `undefined`
   * when the tool is unknown or its owner contributed none. This is the join a
   * `ToolDecl` cannot carry: the declaration is enumerable before any actor,
   * the contract cannot exist before the deps do.
   */
  toolContract(toolId: string): ToolContract<StrokeSample, Patch> | undefined
  /**
   * The running play session, or `null` while editing (#11). Gated on the
   * host's own state rather than on the ref, which is retained after the
   * session is stopped — the mode is what says whether a session is running.
   */
  playSession(): PlaySession | null
  /** The ref an owner's commands route to, stopped or not; `undefined` if that owner was never installed. */
  child(owner: OwnerId): AnyActorRef | undefined
  /**
   * Tear a feature down (#21 §5): revoke its declarations, then send its
   * actor `dispose`, then stop it — in that order, so nothing reaches a
   * half-disposed feature through the registry. The ref stays in context.
   * Throws for a reserved owner, as the registry does.
   */
  dispose(owner: OwnerId): void
  /** Stop the root and every child. Not `exit`: it would not run. */
  stop(): void
}

export function createHost({ document: source, project = createProject(), clock, features = [] }: HostOptions): Host {
  const deadLetters: DeadLetter[] = []
  // Built by `create` beside each spawned ref, and replaced wholesale when a
  // hot re-import re-mints the owner.
  const instances = new Map<OwnerId, EditorFeatureInstance>()

  const inspect = (event: InspectionEvent): void => {
    if (event.type !== '@xstate.deadletter') return
    // `actorRef` is typed as the location-transparent `ActorRefLike`, which
    // carries only a session id; the co-located actor behind it has the
    // human-readable `id` the ref was spawned under, which is what a log
    // line wants. Fall back to the session id for a remote handle.
    const target = 'id' in event.actorRef && typeof event.actorRef.id === 'string' ? event.actorRef.id : (event.actorRef.sessionId ?? '<unstarted>')
    deadLetters.push({ reason: event.reason, target, event: event.event })
  }

  const actor = createActor(hostLogic(source, project, features, instances), clock ? { clock, inspect } : { inspect })
  actor.start()

  const { reader } = source
  const initial = actor.getSnapshot().context.children
  const children: HostChildren = {
    document: initial[DOCUMENT_OWNER] as ActorRefFrom<DocumentActorLogic>,
    project: initial[PROJECT_OWNER] as ActorRefFrom<ProjectLogic>,
    tools: initial[TOOLS_OWNER] as ActorRefFrom<ToolsLogic>,
    view: initial[VIEW_OWNER] as ActorRefFrom<ViewLogic>,
    viewport: initial[VIEWPORT_OWNER] as ActorRefFrom<ViewportLogic>,
    gesture: initial[GESTURE_OWNER] as ActorRefFrom<GestureLogic>,
  }

  const { gesture } = children
  const currentGesture = (): Gesture => gesture.getSnapshot().value
  const input: EditorInput = {
    // `editing` is derived per press from the live mode, never held (#8).
    pointerDown: (press) => {
      gesture.send({ type: 'pointer.down', ...press, editing: actor.getSnapshot().value === 'edit' })
      return currentGesture()
    },
    pointerMove: (motion) => {
      gesture.send({ type: 'pointer.move', ...motion })
      return currentGesture()
    },
    pointerUp: (release) => gesture.send({ type: 'pointer.up', ...release }),
    strokeMove: (pick, modifiers) => gesture.send({ type: 'stroke.move', sample: { pick, modifiers } }),
    carrying: () => {
      const snapshot = gesture.getSnapshot()
      return snapshot.value === 'stroke' ? (snapshot.context.handler?.carrying?.() ?? NOTHING) : NOTHING
    },
    keyDown: (key) => gesture.send({ type: 'key.down', key }),
    keyUp: (key) => gesture.send({ type: 'key.up', key }),
    heldKeys: () => gesture.getSnapshot().context.held,
    gesture: currentGesture,
    strokeOrigin: () => {
      const snapshot = gesture.getSnapshot()
      return snapshot.value === 'stroke' ? (snapshot.context.stroke?.getSnapshot().context.origin ?? null) : null
    },
  }

  function contextKeys(): ContextSnapshot {
    const tools = children.tools.getSnapshot()
    const view = children.view.getSnapshot()
    return {
      // A feature contributes the values for the keys IT minted, derived on
      // the same per-dispatch schedule as everything else (#8's finding 2).
      // Spread first, so an installed feature cannot shadow `host.mode`: the
      // built-ins below win an id collision, and minting a colliding id throws
      // at import in any case.
      ...Object.fromEntries(
        [...instances.values()].flatMap((instance) => (instance.keys ? Object.entries(instance.keys()) : [])),
      ),
      [hostKeys.mode.id]: actor.getSnapshot().value,
      [gestureKeys.stroking.id]: children.gesture.getSnapshot().value === 'stroke',
      [toolKeys.tool.id]: tools.context.tool,
      [viewKeys.hasSelection.id]: view.context.selection !== null,
      [viewKeys.gameCamera.id]: view.context.gameCamera,
      [viewKeys.inspectorCollapsed.id]: view.context.inspectorCollapsed,
      [projectKeys.open.id]: children.project.getSnapshot().context.folder !== null,
      [documentKeys.canUndo.id]: reader.canUndo(),
      [documentKeys.canRedo.id]: reader.canRedo(),
    }
  }

  function toolContract(toolId: string): ToolContract<StrokeSample, Patch> | undefined {
    return contractFor(instances, toolId)
  }

  function child(owner: OwnerId): AnyActorRef | undefined {
    return actor.getSnapshot().context.children[owner]
  }

  function playSession(): PlaySession | null {
    const snapshot = actor.getSnapshot()
    if (snapshot.value !== 'play') return null
    const session = snapshot.context.play
    return session === null ? null : { start: session.getSnapshot().context.start }
  }

  /**
   * The two HOST_OWNER commands that are not a transition but a SEQUENCE of
   * other dispatches (#14's `3` and Delete keybindings). They expand here,
   * outside the machine, because expanding inside one would mean calling
   * `dispatch` — and therefore re-entering the registry — from inside an
   * enqueued effect. `null` means "not a composite"; an empty list means "a
   * composite with nothing to do", which is what a selection that vanished
   * between the availability check and here comes to.
   */
  function expand(id: string, args: unknown): readonly { readonly id: string; readonly args?: unknown }[] | null {
    if (id === 'commands.run') return (args as { commands: { id: string; args?: unknown }[] }).commands
    if (id === 'selection.nudge') return nudgeSteps(reader.doc, children.view.getSnapshot().context.selection, args as NudgeArgs)
    if (id === 'selection.region') {
      const range = children.view.getSnapshot().context.layers
      return regionSteps(reader.doc, children.view.getSnapshot().context.selection, args as RegionOpArgs, range === null ? null : { lo: Math.floor(range.lo / 2), hi: Math.ceil(range.hi / 2) })
    }
    if (id !== 'selection.delete') return null
    return deleteSteps(children.view.getSnapshot().context.selection)
  }

  const MAX_EXPANSION_DEPTH = 8
  const NOTHING: ReadonlySet<string> = new Set()

  function dispatch(id: string, args?: unknown): DispatchResult {
    const result = dispatchAt(id, args, 0)
    // The selection is not in the document, so the history cannot carry it; this does (the owner, 2026-09-21: undoing
    // a nudge put the voxels back and left the selection where they had been). After an undo or a redo, what was
    // selected when the document last stood here comes back; after anything else, what is selected now is remembered.
    if (result.ok && (id === 'undo' || id === 'redo')) recallSelection()
    else rememberSelection()
    return result
  }

  /** What was selected the last time the document stood at each point of its history, by `historyPosition`. */
  const selectionAt = new Map<number, Selection | null>()
  let rememberedGeneration = reader.generation
  let recalling = false
  function rememberSelection(): void {
    // A stroke moves the selection before its edit exists: what is selected mid-drag belongs to no point in the history.
    if (recalling || children.gesture.getSnapshot().value === 'stroke') return
    if (reader.generation !== rememberedGeneration) {
      // Another document: its history starts over, and nothing of the last one's applies.
      selectionAt.clear()
      rememberedGeneration = reader.generation
    }
    selectionAt.set(reader.historyPosition(), children.view.getSnapshot().context.selection)
    // The history keeps a couple of hundred edits; so does this.
    if (selectionAt.size > 400) for (const key of [...selectionAt.keys()].sort((a, b) => a - b).slice(0, selectionAt.size - 400)) selectionAt.delete(key)
  }
  function recallSelection(): void {
    const position = reader.historyPosition()
    if (!selectionAt.has(position)) return
    recalling = true
    children.view.send({ type: 'select', selection: selectionAt.get(position) ?? null })
    recalling = false
  }
  children.view.subscribe(() => rememberSelection())
  // A stroke's edit lands as the stroke closes, delivered before the gesture's own observers hear of it (pinned in
  // `host.test.ts`): so when the gesture says the stroke is over, the history already stands where the stroke left it.
  children.gesture.subscribe(() => rememberSelection())

  function dispatchAt(id: string, args: unknown, depth: number): DispatchResult {
    const resolution = resolveCommand(id, args, contextKeys())
    if (!resolution.ok) return resolution
    const steps = expand(id, resolution.args)
    if (steps) {
      if (depth >= MAX_EXPANSION_DEPTH)
        return { ok: false, kind: 'unhandled', reason: `"${id}" expanded more than ${MAX_EXPANSION_DEPTH} levels deep; the composite refers to itself` }
      for (const step of steps) {
        const result = dispatchAt(step.id, step.args, depth + 1)
        if (!result.ok) return result
      }
      return { ok: true }
    }
    // Resolved, so declared, so owned.
    const owner = commands.ownerOf(id) as OwnerId
    // A feature whose logic was never installed has no ref at all, and
    // `enq.sendTo(undefined, …)` would be silent — the one shape retaining
    // stale refs cannot make observable, so it is answered before the send.
    if (owner !== HOST_OWNER && child(owner) === undefined)
      return { ok: false, kind: 'unhandled', reason: `"${id}" is declared by "${owner}", whose actor was never started` }
    const before = deadLetters.length
    actor.send({ type: 'command', owner, id, args: resolution.args })
    // Matched to THIS command's event, not counted: a dead letter that lands
    // during the send but carries some other event — a stroke actor's late
    // `move` to a child that finished, say — is somebody else's news, and
    // attributing it here would report a delivered command as unhandled.
    // The undelivered event is the routed form (`{ type: 'command', id }`) at
    // a child, or the host-bound form with `owner` when the host itself has
    // stopped; both carry `type` and `id`.
    const undelivered = deadLetters.slice(before).find((letter) => letter.event.type === 'command' && letter.event.id === id)
    if (undelivered) return { ok: false, kind: 'unhandled', reason: `"${id}" is declared by "${owner}", whose actor has stopped (${undelivered.reason})` }
    return { ok: true }
  }

  function dispose(owner: OwnerId): void {
    disposeDeclarations(owner)
    stopFeature(owner)
  }

  /** #21 §5's second and third steps, with the revocation already done. */
  function stopFeature(owner: OwnerId): void {
    instances.delete(owner)
    if (child(owner) !== undefined) actor.send({ type: 'dispose', owner })
  }

  // The install hook #21 §6 named: a hot re-import revokes and re-mints under
  // the same owner, and the module it exports carries a NEW `create` this host
  // has never spawned. Registered once, released when the host stops — a
  // stopped host must not be installed into, and in a test several hosts share
  // one module registry.
  const releaseFeatureHook = onFeatureChange<Feature['create']>({
    install: ({ owner, create, params }) => {
      children.tools.send({ type: 'seed', owner, params: (params ?? {}) as FeatureParams })
      const instance = create(featureDeps(owner, reader, children.document, children.tools, children.view))
      instances.set(owner, instance)
      actor.send({ type: 'install', owner, logic: instance.logic })
    },
    // The registry revoked the declarations before calling this (its order,
    // not ours), so this is the drain-and-stop half only.
    uninstall: stopFeature,
  })

  return {
    actor,
    reader,
    children,
    input,
    deadLetters,
    dispatch,
    contextKeys,
    toolContract,
    playSession,
    child,
    dispose,
    stop: () => {
      releaseFeatureHook()
      actor.stop()
    },
  }
}
