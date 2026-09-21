/**
 * What a stroke means, per tool — the handlers the stroke actor runs.
 *
 * Moved here from `apps/editor/src/editor/tools.ts` with the stroke actor
 * (#66 step 4). What is left is the SWITCH and the object tool: the terrain
 * tool's handler is the `feature-terrain` module's, reached through the
 * `ToolContract` its owner contributed (`deps.contract`), so the host holds no
 * copy of a terrain verb at all. The host cannot import a feature (#35), and
 * the contract is exactly the seam that makes it unnecessary — a declared tool
 * is enumerable before anything runs, and its handler arrives with the deps.
 *
 * A tool whose feature is not installed simply strokes nothing: `contract`
 * answers `undefined`, `createStrokeHandler` passes that on, and the gesture
 * actor spawns no stroke. That is the same answer a press that missed the
 * terrain gets, and the same one the camera tool gets.
 *
 * The contract (registry `tools.ts`) is deliberately STATEFUL: a handler is
 * fresh per stroke and whatever the stroke accumulates — the object a drag is
 * moving, and on the terrain side the rectangle anchor and the flatten height
 * — lives on it and dies with it. So a handler's methods are called exactly
 * once per phase, inside `enq`, never in a transition body (see `stroke.ts`).
 *
 * The shared verbs behave identically everywhere:
 *   Shift  — erase / invert (lower instead of raise, clear paint, remove water);
 *            on a drag, constrain it to one axis
 *   Alt    — eyedropper (pick up whatever is under the cursor)
 *   Ctrl   — reach through objects to the terrain beneath; on a drag, no
 *            snapping (Cmd on a Mac, which the viewport folds into `ctrl`)
 *
 * Two things a stroke changes that are not the document — the eyedropper's
 * tool parameters and the object tool's selection — leave through `StrokeDeps`
 * as typed events to the tools and view actors. They are NOT commands: a
 * command has an id, is declared in the registry and arrives by `dispatch`,
 * and none of that is true of these. #11 has handlers never read ambient
 * selection, so the object being dragged is fixed at the press from the id
 * the host filled in, and a change to selection is the host sending `select`
 * to the view actor on the handler's behalf. A feature's handler reaches the
 * same two doors through `FeatureDeps.setParams`, which is the same event.
 */

import {
  DEFAULT_MATCH,
  DIR_VECTORS,
  SURFACE_CLIFF,
  addObject,
  brushCells,
  clampOffset,
  combineRegions,
  defaultFacing,
  descendantsOf,
  elementAt,
  elementsUnder,
  frameOf,
  groundedPosition,
  inBounds,
  newId,
  matchApplies,
  matchRegion,
  movePatches,
  offsetKeys,
  snapshotObjects,
  snapshotVolume,
  widerMatch,
  placeStructureOnto,
  rectCells,
  regionAnchor,
  regionOf,
  snapTo,
  structureAt,
  structureOf,
  toLocal,
  toWorld,
  topHeight,
  updateObject,
  type Cell,
  type DocumentReader,
  type LayerSpan,
  type MapObject,
  type ObjectsSnapshot,
  type Patch,
  type ReadonlyMapDoc,
  type ReadonlyVoxel,
  type Region,
  type RegionCombine,
  type SnapMode,
  type VolumeSnapshot,
  type VoxelOffset,
  type SurfaceAddress,
} from '@papercut/document'
import type { StrokeHandler, ToolContract } from '@papercut/registry'

import type { ToolSettings, ToolsContext } from './tools'
import type { Selection } from './view'

/** The keyboard state that rides on a pointer event. `button` is not here: it belongs to the press, not the motion. */
export interface PointerModifiers {
  readonly shift: boolean
  readonly alt: boolean
  readonly ctrl: boolean
}

/**
 * What the viewport picked under the pointer, in the shape the stroke needs
 * and no more. Structural on purpose: `runtime`'s `PickResult` is assignable
 * (its `point` is a `Vector3`, which has `x` and `z`) without this package
 * naming `three` or depending on `runtime` at all.
 */
export interface PickSample {
  readonly surface: SurfaceAddress | null
  /** The hit, with its height when the pick had one (a test's may not). */
  readonly point: { readonly x: number; readonly y?: number; readonly z: number } | null
  readonly objectId: string | null
  /** The ray the pick was made along, so a handler can find where it crosses another height; absent from a test's pick. */
  readonly ray?: { readonly origin: { readonly x: number; readonly y: number; readonly z: number }; readonly direction: { readonly x: number; readonly y: number; readonly z: number } } | null
  /**
   * Mid-stroke only: where the pointer's ray meets the horizontal plane
   * through the press's hit, whatever is under the cursor now. A handler
   * that MOVES something reads this rather than `point`, which mid-drag is
   * the dragged sprite or a cliff face the ray crossed. Absent on a press
   * (the press point is its own plane point) and from a test that has no
   * camera; `point` is the fallback.
   */
  readonly plane?: { readonly x: number; readonly z: number } | null
  /** The drawn sketch point under the pointer, hit-tested on screen by the viewport; absent from a pick without one. */
  readonly handle?: { readonly structure: string; readonly index: number } | null
  /** The Move handle under the pointer, hit-tested on screen by the viewport: the axis it drags along. */
  readonly axis?: 'x' | 'y' | 'z' | null
}

export const NO_PICK: PickSample = { surface: null, point: null, objectId: null }

/** One tick's input to a handler: the pick plus the modifiers held at that instant. */
export interface StrokeSample {
  readonly pick: PickSample
  readonly modifiers: PointerModifiers
  /** On a press, which of a run of quick presses in one place it is: 2 for a double-click. Absent is 1. */
  readonly clicks?: number
}

/** The tools actor's snapshot, flattened: its state (`terrainMode`) beside its context. */
/** The tools actor's context: the active tool, the object tool's sprite, and every feature's parameter slice. */
export type ToolsSnapshot = ToolsContext

export interface StrokeDeps {
  readonly reader: DocumentReader
  /** Read per tick, not captured at the press: `]` mid-drag widens the brush, as it always did. */
  tools(): ToolsSnapshot
  /** The eyedropper's output. The host turns it into a `settings` event to the tools actor. */
  setTools(settings: ToolSettings): void
  /** The object tool's output. The host turns it into a `select` event to the view actor. */
  select(selection: Selection | null): void
  /** The voxel layers the layer view leaves drawn, or `null` for all of them: what a region reaches through. Absent from a test that has no view. */
  layerSpan?(): LayerSpan | null
  /**
   * The contract behind a declared tool, or `undefined` when nobody declared
   * it or its owner contributed none — `Host.toolContract`, handed in rather
   * than imported, because this file is below `host.ts` and the lookup needs
   * the live feature instances.
   */
  contract(toolId: string): ToolContract<StrokeSample, Patch> | undefined
}

/**
 * A stroke handler as the host runs it: the registry's contract, plus what
 * the stroke is CARRYING — the ids a pick taken while it is open looks past,
 * so the sample says what the carried thing would land on rather than
 * hitting the thing itself. A handler that carries nothing leaves it out.
 */
export type EditorStrokeHandler = StrokeHandler<StrokeSample, Patch> & { carrying?(): ReadonlySet<string> }

/**
 * The handler for a left press at `sample` under the current tool, or
 * `undefined` when that tool declines the press, so the host spawns nothing
 * and the pointer-down falls through to arbitration. `selection` is the id
 * the host read from the view actor at the press: the drag target when the
 * press lands on nothing selectable.
 */
export function createStrokeHandler(deps: StrokeDeps, sample: StrokeSample, selection: Selection | null): EditorStrokeHandler | undefined {
  const tool = deps.tools().tool
  // The host's two tools are built in; any other declared tool runs the contract its feature contributed.
  if (tool === 'select') return selectStroke(deps, sample, selection)
  if (tool === 'object') return objectStroke(deps, selection)
  return deps.contract(tool)?.stroke(sample)
}

/** What a drag can move: an object, or a structure by its placement. */
type DragTarget = { readonly kind: 'object'; readonly id: string } | { readonly kind: 'structure'; readonly id: string }

/** The drag target a selection names, if it names one. */
function selectedTarget(selection: Selection | null): DragTarget | null {
  if (selection?.kind === 'object') return { kind: 'object', id: selection.id }
  if (selection?.kind === 'structure') return { kind: 'structure', id: selection.id }
  return null
}

/**
 * Select is one polymorphic tool over everything that exists (ruling of
 * 2026-09-12, "App frame"): a press on an object selects and drags it; on a
 * structure's surface — a voxel volume's top or cliff, a sketch's cap or
 * wall — selects and drags the structure; on nothing at all it clears the
 * selection unless shift is held. The undo label is decided at the press,
 * because the document reads it before `begin` runs.
 */
function selectStroke(deps: StrokeDeps, sample: StrokeSample, selection: Selection | null): EditorStrokeHandler {
  const tools = deps.tools()
  if (tools.selectMode === 'region') return tools.selectVerb === 'move' && selection?.kind === 'region' && selection.element === 'voxel' ? moveStroke(deps, selection) : regionStroke(deps, selection)
  const drag = new Drag(deps)
  const { pick } = sample
  const label = pick.objectId ? 'Move object' : pick.surface ? 'Move structure' : 'Select'

  return {
    label,
    carrying: () => drag.carrying(),
    begin(sample) {
      const { pick, modifiers } = sample
      if (pick.objectId) {
        if (modifiers.alt) deps.setTools({ spriteName: deps.reader.doc.objects[pick.objectId]?.sprite ?? deps.tools().spriteName })
        deps.select({ kind: 'object', id: pick.objectId })
        drag.grab({ kind: 'object', id: pick.objectId }, pick)
        return []
      }
      if (pick.surface) {
        deps.select({ kind: 'structure', id: pick.surface.structure })
        drag.grab({ kind: 'structure', id: pick.surface.structure }, pick)
        return []
      }
      // Shift on nothing keeps the selection, and the drag moves it from wherever the press was.
      const held = selectedTarget(selection)
      if (modifiers.shift && held) drag.grab(held, pick)
      else if (!modifiers.shift) deps.select(null)
      return []
    },
    move: (sample) => drag.move(sample),
    end: () => [],
  }
}

/** Where in a cell the pointer is, and whether it is in the upper half of the wall it is on: what picks one edge among several. */
function placeIn(doc: ReadonlyMapDoc, pick: PickSample, cell: SurfaceAddress, voxel: ReadonlyVoxel): { fx: number; fz: number; upper: boolean } {
  const frame = frameOf(doc, voxel.id)
  const [lx, lz] = pick.point ? toLocal(frame, pick.point.x, pick.point.z) : [cell.x + 0.5, cell.y + 0.5]
  const clamp = (v: number): number => Math.min(1, Math.max(0, v))
  // A wall's middle, in world units: half way between the ground its foot is on and its own top.
  const [dx, dz] = DIR_VECTORS[cell.dir] ?? [0, 0]
  const foot = inBounds(voxel.size, cell.x + dx, cell.y + dz) ? topHeight(voxel, cell.x + dx, cell.y + dz) : 0
  const middle = frame.y + ((topHeight(voxel, cell.x, cell.y) + foot) / 2) * 0.5
  return { fx: clamp(lx - cell.x), fz: clamp(lz - cell.y), upper: pick.point?.y === undefined || pick.point.y >= middle }
}

/** How much a press takes: what is under it, the whole that belongs to (a double-click), or the next whole out (a triple-click). */
export type Whole = false | 'whole' | 'wider'

/**
 * What a press at `at` takes, read against the face first pressed, `press`: the whole the element under it belongs to
 * for a double-click; one element under a one-cell brush; else what the footprint covers. The ONE answer to "what
 * would selecting here take", so the hover preview and the stroke cannot disagree.
 */
export function regionKeysAt(doc: ReadonlyMapDoc, tools: ToolsSnapshot, press: SurfaceAddress, at: SurfaceAddress, pick: PickSample, span: LayerSpan | null, whole: Whole): string[] {
  const voxel = structureOf(doc, press.structure, 'voxel')
  if (!voxel) return []
  if (whole) {
    const key = elementAt(voxel, press, tools.selectElement, placeIn(doc, pick, press, voxel))
    if (key === null) return []
    // A double-click takes the whole by the rule picked in the bar — the element's default until someone picks — and a
    // triple-click the next one out. A rule that means nothing for what was clicked, Surface on a wall, gives way to the default.
    const picked = tools.selectMatch[tools.selectElement]
    const chosen = matchApplies(tools.selectElement, key, picked) ? picked : DEFAULT_MATCH[tools.selectElement]
    const rule = whole === 'wider' ? widerMatch(tools.selectElement, key) : chosen
    return matchRegion(voxel, tools.selectElement, key, rule, { span, followSlopes: tools.selectFollowSlopes, everywhere: tools.selectEverywhere, step: tools.selectStep, band: tools.selectBand, anyLayer: tools.selectAnyLayer })
  }
  if (tools.selectFootprint === 'brush' && tools.selectSize === 1 && tools.selectDepth === 'surface') {
    // The element under the pointer, read against the face pressed but at the cell the pointer is over now.
    const key = elementAt(voxel, { ...press, x: at.x, y: at.y }, tools.selectElement, placeIn(doc, pick, at, voxel))
    return key === null ? [] : [key]
  }
  const cells: Cell[] = tools.selectFootprint === 'rect' ? rectCells(voxel, press.x, press.y, at.x, at.y) : brushCells(voxel, at.x, at.y, { size: tools.selectSize, shape: 'square' })
  return elementsUnder(voxel, press, cells, tools.selectElement, tools.selectDepth, span)
}

/** What a click where the pointer is would take, or with `whole` a double-click: the hover preview's region. `null` off the terrain, or when Select is not on regions. */
export function regionUnder(doc: ReadonlyMapDoc, tools: ToolsSnapshot, pick: PickSample, span: LayerSpan | null, whole: Whole): Region | null {
  if (tools.tool !== 'select' || tools.selectMode !== 'region' || !pick.surface) return null
  const keys = regionKeysAt(doc, tools, pick.surface, pick.surface, pick, span, whole)
  return keys.length ? regionOf(pick.surface.structure, tools.selectElement, keys) : null
}

/**
 * Select's region half (rulings of 2026-09-12 and 2026-09-20): a press and a drag select some of a voxel volume's
 * edges, faces or voxels. The face pressed says what is taken — a top's cells, or one side of them — the footprint
 * says which cells, and the stroke meets the region already there as the bar says: shift adds and alt subtracts,
 * whatever it says. It writes nothing to the map, so it is no undo step; the selection it makes is the view's.
 *
 * A brush gathers along the drag; a rectangle runs from the press to the pointer. A one-cell brush takes ONE element,
 * so a click on a cell with several edges round it takes the edge nearest the pointer. A DOUBLE-CLICK takes the whole
 * the element belongs to (design pass of 2026-09-20): an edge's run, a face's flat, a voxel's island. It meets the
 * A TRIPLE-CLICK takes the next whole out: an edge's loop, a top's surface or a side's wall, a voxel's island. Each meets the
 * selection as any press does, and by then the first click of the pair has already taken the element itself, so
 * shift-double-click adds the whole and alt-double-click takes it away. The pressed face stays the reference for the whole stroke, so dragging off a cliff top onto the ground
 * keeps taking tops, and along a wall keeps taking that side.
 */
function regionStroke(deps: StrokeDeps, selection: Selection | null): EditorStrokeHandler {
  const before: Region | null = selection?.kind === 'region' ? selection : null
  let press: SurfaceAddress | null = null
  let mode: RegionCombine = 'replace'
  /** A double-click: the press takes the whole its element belongs to, and the drag after it takes nothing more. */
  let whole: Whole = false
  const gathered = new Set<string>()

  const take = (sample: StrokeSample): void => {
    if (!press) return
    const at = sample.pick.surface?.structure === press.structure ? sample.pick.surface : null
    if (!at) return
    const tools = deps.tools()
    // A rectangle is redrawn from the press each tick; a brush keeps what it has passed over.
    if (tools.selectFootprint === 'rect' && !whole) gathered.clear()
    for (const key of regionKeysAt(deps.reader.doc, tools, press, at, sample.pick, deps.layerSpan?.() ?? null, whole)) gathered.add(key)
    const next = regionOf(press.structure, tools.selectElement, gathered)
    const region = combineRegions(before, next, mode)
    deps.select(region ? { kind: 'region', ...region } : null)
  }

  return {
    label: 'Select region',
    begin(sample) {
      const { pick, modifiers } = sample
      mode = modifiers.shift ? 'add' : modifiers.alt ? 'subtract' : deps.tools().selectCombine
      if (!pick.surface || !structureOf(deps.reader.doc, pick.surface.structure, 'voxel')) {
        // A press on nothing clears, unless it was reaching to add or take away.
        if (mode === 'replace') deps.select(null)
        return []
      }
      press = pick.surface
      whole = (sample.clicks ?? 1) >= 3 ? 'wider' : (sample.clicks ?? 1) === 2 ? 'whole' : false
      take(sample)
      return []
    },
    move(sample) {
      if (!whole) take(sample)
      return []
    },
    end: () => [],
  }
}

/**
 * Move (design round of 2026-09-19): the selected voxels, dragged. The face pressed says which way they can go: a top,
 * and they slide over the ground, east and south; a cliff, and they slide along that wall and up and down it. Shift
 * holds the drag to whichever of its two ways it has gone further; alt at the press leaves a copy behind. One of the
 * three HANDLES pressed instead, the drag goes along that axis alone, read where the pointer's ray passes closest to it.
 *
 * Every tick is worked out from the volume and the objects AS THEY WERE AT THE PRESS (`movePatches`), so dragging out
 * and back puts everything back, and the stroke's compaction makes the whole drag one undo step. The selection goes
 * with the voxels. Whole voxels each way: a voxel is a cube, and a half-tile step up would be a change of shape.
 */
function moveStroke(deps: StrokeDeps, selection: Extract<Selection, { kind: 'region' }>): EditorStrokeHandler {
  const keys = selection.keys
  let volume: VolumeSnapshot | null = null
  let objects: ObjectsSnapshot = {}
  let pressed: { x: number; y: number; z: number } | null = null
  /** The side pressed, 0 to 3, or `null` for a top: which plane the drag is read on. */
  let wall: number | null = null
  /** A handle pressed: the drag goes along that one axis, read off the line the handle stands on. */
  let axis: { id: 'x' | 'y' | 'z'; origin: readonly [number, number, number]; from: number } | null = null
  let copy = false
  let last = ''

  /** How far along a handle's line the pointer's ray comes closest to it, in world units from the handle's foot. */
  const alongAxis = (id: 'x' | 'y' | 'z', origin: readonly [number, number, number], ray: NonNullable<PickSample['ray']>): number => {
    const a = id === 'x' ? [1, 0, 0] : id === 'y' ? [0, 1, 0] : [0, 0, 1]
    const d = [ray.direction.x, ray.direction.y, ray.direction.z]
    const w = [origin[0] - ray.origin.x, origin[1] - ray.origin.y, origin[2] - ray.origin.z]
    const dot = (p: readonly number[], q: readonly number[]): number => p[0] * q[0] + p[1] * q[1] + p[2] * q[2]
    const b = dot(a, d)
    // Looking straight down the handle, the pointer says nothing about how far along it is.
    return Math.abs(1 - b * b) < 1e-6 ? 0 : (b * dot(d, w) - dot(a, w)) / (1 - b * b)
  }

  const offsetAt = (sample: StrokeSample): VoxelOffset => {
    if (!pressed && !axis) return { dx: 0, dz: 0, dy: 0 }
    const voxel = structureOf(deps.reader.doc, selection.structure, 'voxel')
    if (!voxel) return { dx: 0, dz: 0, dy: 0 }
    const frame = frameOf(deps.reader.doc, voxel.id)
    const local = (x: number, z: number): [number, number] => toLocal(frame, x, z)
    const [px, pz] = pressed ? local(pressed.x, pressed.z) : [0, 0]
    let moved = { dx: 0, dz: 0, dy: 0 }
    if (axis) {
      if (!sample.pick.ray) return { dx: 0, dz: 0, dy: 0 }
      const travelled = alongAxis(axis.id, axis.origin, sample.pick.ray) - axis.from
      if (axis.id === 'y') moved = { dx: 0, dz: 0, dy: Math.round(travelled) }
      else {
        // A world step along the handle, as the volume's own cells see it.
        const [ox, oz] = local(axis.origin[0], axis.origin[2])
        const [tx, tz] = local(axis.origin[0] + (axis.id === 'x' ? travelled : 0), axis.origin[2] + (axis.id === 'z' ? travelled : 0))
        moved = { dx: Math.round(tx - ox), dz: Math.round(tz - oz), dy: 0 }
      }
      return clampOffset(voxel, keys, moved)
    }
    if (wall === null) {
      const at = sample.pick.plane ?? sample.pick.point
      if (at) {
        const [ax, az] = local(at.x, at.z)
        moved = { dx: Math.round(ax - px), dz: Math.round(az - pz), dy: 0 }
      }
    } else if (sample.pick.ray && pressed) {
      // Where the pointer's ray meets the upright plane of the wall that was pressed: along it, and up it.
      const { origin, direction } = sample.pick.ray
      const [nx, nz] = DIR_VECTORS[wall]
      const facing = direction.x * nx + direction.z * nz
      if (Math.abs(facing) > 1e-6) {
        const t = ((pressed.x - origin.x) * nx + (pressed.z - origin.z) * nz) / facing
        const [hx, hz] = local(origin.x + direction.x * t, origin.z + direction.z * t)
        moved = { dx: nx === 0 ? Math.round(hx - px) : 0, dz: nz === 0 ? Math.round(hz - pz) : 0, dy: Math.round(origin.y + direction.y * t - pressed.y) }
      }
    }
    if (sample.modifiers.shift) {
      const flat = Math.max(Math.abs(moved.dx), Math.abs(moved.dz))
      moved = wall === null ? (Math.abs(moved.dx) >= Math.abs(moved.dz) ? { ...moved, dz: 0 } : { ...moved, dx: 0 }) : flat >= Math.abs(moved.dy) ? { ...moved, dy: 0 } : { dx: 0, dz: 0, dy: moved.dy }
    }
    return clampOffset(voxel, keys, moved)
  }

  const move = (sample: StrokeSample): readonly Patch[] => {
    const voxel = structureOf(deps.reader.doc, selection.structure, 'voxel')
    if (!voxel || !volume) return []
    const offset = offsetAt(sample)
    const id = `${offset.dx},${offset.dz},${offset.dy}`
    if (id === last) return []
    last = id
    deps.select({ kind: 'region', ...regionOf(selection.structure, 'voxel', offsetKeys(keys, offset)) })
    return movePatches(deps.reader.doc, voxel, volume, objects, keys, offset, copy)
  }

  return {
    label: 'Move voxels',
    begin(sample) {
      const { pick, modifiers } = sample
      const voxel = structureOf(deps.reader.doc, selection.structure, 'voxel')
      if (!voxel) return []
      const anchor = regionAnchor(keys)
      if (pick.axis && pick.ray && anchor) {
        // A handle: the line it stands on, as it is at the press, and how far along it the press was.
        const frame = frameOf(deps.reader.doc, voxel.id)
        const [wx, wz] = toWorld(frame, anchor[0], anchor[2])
        const origin = [wx, frame.y + anchor[1], wz] as const
        axis = { id: pick.axis, origin, from: alongAxis(pick.axis, origin, pick.ray) }
      } else if (!pick.surface || pick.surface.structure !== selection.structure || !pick.point) return []
      volume = snapshotVolume(voxel)
      objects = snapshotObjects(deps.reader.doc)
      pressed = pick.point ? { x: pick.point.x, y: pick.point.y ?? 0, z: pick.point.z } : null
      wall = !axis && pick.surface?.kind === SURFACE_CLIFF ? pick.surface.dir : null
      copy = modifiers.alt
      last = '0,0,0'
      return []
    },
    move,
    end: () => [],
  }
}

function objectStroke(deps: StrokeDeps, selection: Selection | null): EditorStrokeHandler {
  /** What a drag moves: the object pressed, the object placed, or on a shift-press the selection. */
  const drag = new Drag(deps)

  return {
    label: 'Edit object',
    carrying: () => drag.carrying(),
    begin(sample) {
      const doc = deps.reader.doc
      const tools = deps.tools()
      const { pick, modifiers } = sample

      if (pick.objectId) {
        if (modifiers.alt) deps.setTools({ spriteName: doc.objects[pick.objectId]?.sprite ?? tools.spriteName })
        deps.select({ kind: 'object', id: pick.objectId })
        drag.grab({ kind: 'object', id: pick.objectId }, pick)
        return []
      }

      if (modifiers.shift) {
        const held = selectedTarget(selection)
        if (held) drag.grab(held, pick)
        return []
      }
      if (!pick.point) return []

      // Placed where the press snaps to, so a click lands on the grid the way a drag would.
      const snap = modifiers.ctrl ? 'free' : tools.snap
      const position = groundedPosition(doc, snapTo(pick.point.x, snap, 'centre'), snapTo(pick.point.z, snap, 'centre'))
      const object: MapObject = {
        id: newId(),
        name: tools.spriteName,
        sprite: tools.spriteName,
        position,
        rotationY: doc.camera.yaw,
        scale: 1,
        display: 'auto',
        facing: defaultFacing(),
        anchorCell: [Math.floor(position[0]), Math.floor(position[2])],
        seed: Math.floor(Math.random() * 0xffff),
        locked: false,
        hidden: false,
      }
      deps.select({ kind: 'object', id: object.id })
      drag.grab({ kind: 'object', id: object.id }, pick, { x: position[0], z: position[2] })
      return addObject(doc, object)
    },
    move: (sample) => drag.move(sample),
    end: () => [],
  }
}

/**
 * Dragging something along the ground, the way a grab feels in every app
 * that has one: the point you pressed stays under the pointer. The offset
 * between the target and the press's plane point is taken once at the grab
 * and kept, so nothing jumps to the cursor, and each tick reads the
 * pointer's position on the PRESS's plane (`pick.plane`) rather than
 * whatever the ray hits now — mid-drag that is the dragged sprite itself,
 * whose hit point slides along the billboard and made the motion feel
 * constrained to an axis for no reason.
 *
 * The target moves by how far the pointer has travelled since the press, so
 * the result is the same whether it is read as an offset or a delta. It snaps
 * as the tools actor says (ruling of 2026-09-12, "Select tool"): grid, half
 * or free, read per tick so a change mid-drag takes — an object to cell
 * centres, a structure to cell corners;
 * Ctrl frees one drag, and Shift holds it to whichever axis it has moved
 * further along, measured from the press. An object's height follows the
 * terrain; a structure moves by its placement in its parent's frame, and a
 * voxel volume only ever to whole cells (its placement is integer by the
 * scene-graph ruling). The root has no parent to move within and stays put.
 */
class Drag {
  private target: DragTarget | null = null
  /** Where the press's plane point was, in the world. */
  private pressed: { x: number; z: number } | null = null
  /** Where the target's origin was at the grab, in the world. */
  private origin: { x: number; z: number } | null = null
  /** How far above the target's base the grabbed point was: a structure grabbed by its cap is carried by its cap. */
  private grabHeight = 0

  constructor(private readonly deps: StrokeDeps) {}

  /** `origin` is where the target is when the document does not hold it yet: the object a press is placing. */
  grab(target: DragTarget, pick: PickSample, origin: { x: number; z: number } | null = this.positionOf(target)): void {
    const at = pick.plane ?? pick.point
    this.target = at && origin ? target : null
    this.pressed = at ? { x: at.x, z: at.z } : null
    this.origin = origin
    const doc = this.deps.reader.doc
    this.grabHeight = target.kind === 'structure' && pick.point?.y !== undefined && doc.structures[target.id] ? Math.max(0, pick.point.y - frameOf(doc, target.id).y) : 0
  }

  release(): void {
    this.target = null
  }

  /** What the drag is carrying — the target and, for a structure, everything standing on it — for a pick to look past. */
  carrying(): ReadonlySet<string> {
    if (!this.target) return new Set()
    if (this.target.kind === 'object') return new Set([this.target.id])
    return new Set([this.target.id, ...descendantsOf(this.deps.reader.doc, this.target.id)])
  }

  /** Where the target's origin is in the world; `null` for what cannot move. */
  private positionOf(target: DragTarget): { x: number; z: number } | null {
    const doc = this.deps.reader.doc
    if (target.kind === 'object') {
      const object = doc.objects[target.id]
      return object ? { x: object.position[0], z: object.position[2] } : null
    }
    const structure = doc.structures[target.id]
    if (!structure || structure.parent === null) return null
    const [x, z] = toWorld(frameOf(doc, structure.parent), structure.placement.x, structure.placement.z)
    return { x, z }
  }

  move(sample: StrokeSample): readonly Patch[] {
    const at = sample.pick.plane ?? sample.pick.point
    if (!this.target || !this.pressed || !this.origin || !at) return []
    const { modifiers } = sample
    const snap: SnapMode = modifiers.ctrl ? 'free' : this.deps.tools().snap
    if (this.target.kind === 'object') return this.moveObject(this.target.id, this.origin, this.pressed, this.constrained(at, this.pressed, modifiers.shift), snap)
    const landing = this.landing(sample.pick)
    const to = this.constrained(landing?.at ?? at, this.pressed, modifiers.shift)
    return this.moveStructure(this.target.id, this.origin, this.pressed, to, landing?.parent ?? null, snap)
  }

  /**
   * Where a carried structure lands: the pick looked past what is carried
   * (`carrying`), so its hit is the surface underneath the pointer, and its
   * structure is the parent to stand on. The carried thing is held by the
   * point that was grabbed, `grabHeight` above its base, so the pointer is
   * walked back up its ray by that height — the grabbed point stays under
   * the cursor, resting on what is beneath. `null` when the pick has no such
   * hit (nothing under the pointer, or a test without a picker): the press
   * plane and what stands under it decide instead.
   */
  private landing(pick: PickSample): { at: { x: number; z: number }; parent: string } | null {
    const { surface, point, ray } = pick
    if (!surface || !point || point.y === undefined || !ray) return null
    if (this.carrying().has(surface.structure)) return null
    const back = ray.direction.y !== 0 ? this.grabHeight / ray.direction.y : 0
    return { at: { x: point.x + ray.direction.x * back, z: point.z + ray.direction.z * back }, parent: surface.structure }
  }

  /** The pointer held to the axis it has travelled further along since the press. */
  private constrained(at: { x: number; z: number }, pressed: { x: number; z: number }, hold: boolean): { x: number; z: number } {
    if (!hold) return at
    const dx = at.x - pressed.x
    const dz = at.z - pressed.z
    return Math.abs(dx) >= Math.abs(dz) ? { x: at.x, z: pressed.z } : { x: pressed.x, z: at.z }
  }

  private moveObject(id: string, origin: { x: number; z: number }, pressed: { x: number; z: number }, at: { x: number; z: number }, snap: SnapMode): readonly Patch[] {
    const doc = this.deps.reader.doc
    const object = doc.objects[id]
    if (!object || object.locked) return []
    // An object stands in the middle of a cell (`snap.ts`); its placement is not a corner the way a structure's is.
    const position = groundedPosition(doc, snapTo(origin.x + at.x - pressed.x, snap, 'centre'), snapTo(origin.z + at.z - pressed.z, snap, 'centre'))
    return updateObject(doc, object.id, {
      position,
      anchorCell: object.anchorCell ? [Math.floor(position[0]), Math.floor(position[2])] : null,
    })
  }

  /**
   * A structure's origin moves through the world by the pointer's travel,
   * and it stands on whatever is under the POINTER as it goes — dragged over
   * an island it hops onto it, dragged off it drops to the ground — so a
   * stack of sketches moves as one and a tier can be slid between islands.
   * The structure and its descendants cannot be what is under it; where
   * nothing is (off every volume) it keeps the parent it has.
   */
  private moveStructure(id: string, origin: { x: number; z: number }, pressed: { x: number; z: number }, at: { x: number; z: number }, landingOn: string | null, snap: SnapMode): readonly Patch[] {
    const doc = this.deps.reader.doc
    const structure = doc.structures[id]
    if (!structure || structure.parent === null) return []
    const world = { x: origin.x + at.x - pressed.x, z: origin.z + at.z - pressed.z }
    const parent = landingOn ?? structureAt(doc, at.x, at.z, this.carrying()) ?? structure.parent
    const step = structure.kind === 'voxel' ? 'grid' : snap
    return placeStructureOnto(doc, id, parent, world, (value) => snapTo(value, step))
  }
}
