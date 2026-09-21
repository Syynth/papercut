/**
 * The terrain tool's `ToolContract` — the handler half of #9's split, and the
 * seam #66 step 3 left open: a `ToolDecl` says the tool exists and is
 * enumerable before anything runs, while this says what a stroke with it DOES
 * and cannot exist before the deps do.
 *
 * The contract is deliberately STATEFUL per stroke (registry `tools.ts`): the
 * rectangle anchor, the height sampled at the press, and the cell the last
 * tick edited live on the handler and die with it. The host's stroke actor
 * calls each phase exactly once, inside `enq`, and forwards the patches to the
 * document actor — this package never applies anything and never sees a
 * writer.
 *
 * The sample type is named here rather than imported: #35 forbids reaching
 * into `editor-host`, so the feature states the narrowest shape it reads and
 * structural typing makes the host's richer one fit. `ToolContract.stroke` is
 * a METHOD for the same reason `create` is (registry `feature.ts`): parameter
 * bivariance is what lets the host hand this its own richer `StrokeSample`.
 *
 * This is the only terrain stroke there is. The host's stroke actor reaches it
 * through `Host.toolContract('terrain')` and holds no copy of a terrain verb;
 * `verbs.ts` underneath is shared with the commands, so the stroke form and
 * the command form of a verb cannot drift from each other either.
 */

import { DIR_VECTORS, NO_RAMP, SURFACE_CLIFF, SURFACE_TOP, clearRampRun, decodeExtra, frameOf, inBounds, rampDirAt, rampRun, rampRunBlocked, rampRunLength, toLocal, topHeight, type Cell, type Patch, type SurfaceAddress, structureOf, type ReadonlyVoxel } from '@papercut/document'
import type { FeatureDeps, StrokeHandler, ToolContract } from './deps'
import { eyedrop, paintPatches, sculptPatches, strokeCells, terrainLabel, type TerrainModifiers } from './verbs'

/** One tick's input: what the pointer is over, and the modifiers held at that instant. */
export interface TerrainSample {
  readonly pick: {
    readonly surface: SurfaceAddress | null
    /** Mid-stroke, the pointer on the horizontal plane through the press's hit; what a sculpt stroke steers by. */
    readonly plane?: { readonly x: number; readonly z: number } | null
  }
  readonly modifiers: TerrainModifiers
}

export type TerrainStrokeHandler = StrokeHandler<TerrainSample, Patch>

function addressKey(address: SurfaceAddress): string {
  return `${address.x},${address.y},${address.kind},${address.dir},${address.level}`
}

/**
 * Whether the pointer, at `point` on the press plane, has moved from `from`
 * into another cell by more than `deadZone` along every axis it crossed.
 * Measured from the boundary it crossed, so a pointer hovering on a line
 * does not flip cells with every pixel, and one crossing a corner has to
 * clear both edges. `null` while it has not.
 */
export function cellPast(from: Cell, point: { readonly x: number; readonly z: number }, deadZone: number): Cell | null {
  const cx = Math.floor(point.x)
  const cz = Math.floor(point.z)
  if (cx === from[0] && cz === from[1]) return null
  if (cx !== from[0]) {
    const inside = cx > from[0] ? point.x - cx : cx + 1 - point.x
    if (inside < deadZone) return null
  }
  if (cz !== from[1]) {
    const inside = cz > from[1] ? point.z - cz : cz + 1 - point.z
    if (inside < deadZone) return null
  }
  return [cx, cz]
}

/** The top of `cell`, as the address a sculpt verb targets when it was steered there by the plane rather than by a pick. */
/** A column's top, whichever layer it is at: a level under the floor names none, and means the highest. */
const topOf = (structure: string, [x, y]: Cell): SurfaceAddress => ({ structure, x, y, kind: SURFACE_TOP, ...decodeExtra(0) })

/**
 * The Ramp verb is a drag (spec §4): press on a cliff face and drag back onto
 * the high side; the run grows one cell per cell of drag, up to what the
 * drop needs, and is previewed through the tool parameters. The slope is
 * fixed at 45°, so the drag decides nothing the drop has not: on release the
 * run the drop needs is cut, whatever the drag reached, unless the ground
 * behind the edge blocks it — in which case the reason is shown for the
 * length of the press and nothing is cut. A press on a ramp's own top
 * removes its run; so does a shift-press anywhere on one.
 */
function rampHandler(deps: FeatureDeps, press: TerrainSample, voxel: ReadonlyVoxel): TerrainStrokeHandler | undefined {
  const address = press.pick.surface
  if (!address) return undefined
  const label = press.modifiers.shift ? 'Remove ramp' : address.kind === SURFACE_CLIFF ? 'Cut ramp' : 'Remove ramp'
  if (press.modifiers.shift || address.kind !== SURFACE_CLIFF) {
    if (rampDirAt(voxel, address.x, address.y) === NO_RAMP) return undefined
    return { label, begin: () => clearRampRun(deps.doc(), voxel, address.x, address.y), move: () => [], end: () => [] }
  }
  const edge = { x: address.x, z: address.y, dir: address.dir }
  const needed = rampRunLength(voxel, edge)
  if (needed === null) return undefined
  const blocked = rampRunBlocked(voxel, edge)
  const frame = frameOf(deps.doc(), voxel.id)
  const [dx, dz] = DIR_VECTORS[edge.dir]
  let run = 1
  const show = (): void => deps.setParams({ rampRun: { edge, run, needed, blocked } })
  return {
    label,
    begin: () => {
      show()
      return []
    },
    move: (sample) => {
      const plane = sample.pick.plane
      if (!plane) return []
      // How far back onto the high side the pointer has come, in cells, from the edge cell's centre — in the volume's own frame.
      const [lx, lz] = toLocal(frame, plane.x, plane.z)
      const back = -((lx - (edge.x + 0.5)) * dx + (lz - (edge.z + 0.5)) * dz)
      const next = Math.min(needed, Math.max(1, Math.floor(back + 0.5) + 1))
      if (next !== run) {
        run = next
        show()
      }
      return []
    },
    end: () => {
      deps.setParams({ rampRun: null })
      return blocked ? [] : rampRun(deps.doc(), voxel, edge, needed)
    },
  }
}

function handlerFor(deps: FeatureDeps, press: TerrainSample, voxel: ReadonlyVoxel): TerrainStrokeHandler {
  const address = press.pick.surface
  /** Anchor cell for rectangle strokes, and the corner a rectangle preview grows from. */
  const anchor: Cell | null = address ? [address.x, address.y] : null
  /** Height sampled when the stroke began, for flatten. */
  const anchorHeight = address && inBounds(voxel.size, address.x, address.y) ? topHeight(voxel, address.x, address.y) : 0
  /** Cell last edited, so a drag does not re-apply to the same cell. */
  let lastCell: string | null = null
  /** The pressed volume's frame: the press plane is in world space, the cells it steers by are the volume's own. */
  const frame = frameOf(deps.doc(), voxel.id)
  /** The cell a sculpt stroke is on, steered by the press plane; `null` until a tick lands one. */
  let steered: Cell | null = null

  /**
   * A sculpt stroke (raise, flatten, water) is steered by where the pointer
   * is on the press plane, not by what the ray hits: raising a cell puts a
   * taller face under the cursor, and picking that face is what made the
   * stroke re-fire on the cell it had just raised. It moves to the next cell
   * only once the pointer is `sculptDeadZone` past the boundary. Ramp and
   * paint keep the pick, since they target faces.
   */
  function steer(sample: TerrainSample): SurfaceAddress | null {
    const params = deps.params()
    const surface = sample.pick.surface
    if (params.terrainMode !== 'sculpt') return surface
    const plane = sample.pick.plane
    if (plane === undefined || plane === null) {
      // No plane — a press, or no camera: the pick decides, by cell only.
      if (surface) steered = [surface.x, surface.y]
      return surface ? topOf(voxel.id, [surface.x, surface.y]) : null
    }
    const [lx, lz] = toLocal(frame, plane.x, plane.z)
    if (steered === null) steered = [Math.floor(lx), Math.floor(lz)]
    else {
      const next = cellPast(steered, { x: lx, z: lz }, params.sculptDeadZone)
      if (next !== null && inBounds(voxel.size, next[0], next[1])) steered = next
    }
    return topOf(voxel.id, steered)
  }

  function tick(sample: TerrainSample, phase: 'start' | 'move' | 'end'): Patch[] {
    const address = steer(sample)
    // A stroke edits the volume it was pressed on: a pick that wandered onto another structure is not its business.
    if (!address || address.structure !== voxel.id) return []

    if (sample.modifiers.alt) {
      // The eyedropper changes a tool parameter, not the document, so it
      // leaves through `setParams` — an event at the tools actor — and the
      // stroke produces no patches at all.
      if (phase === 'start') deps.setParams(eyedrop(voxel, deps.params(), address))
      return []
    }

    const params = deps.params()
    // Flatten shows the height it levels to: sampled at the press, unless the field is pinned to a typed value.
    if (phase === 'start' && params.terrainMode === 'sculpt' && params.sculptVerb === 'flatten' && !params.heightPinned && params.height !== anchorHeight) {
      deps.setParams({ height: anchorHeight })
    }
    // Rectangle strokes only commit on release; everything else is live.
    if (params.strokeShape === 'rect' && phase !== 'end') return []
    if (params.strokeShape !== 'rect' && phase === 'end') return []

    // A stamp bigger than one tile lands once, where it was pressed: dragged, stamps would overlap each other.
    if (phase === 'move' && params.terrainMode === 'paint' && params.paintVerb === 'tiles' && params.stamp && (params.stamp.tiles.length > 1 || (params.stamp.tiles[0]?.length ?? 0) > 1)) return []

    const key = addressKey(address)
    if (phase === 'move' && lastCell === key) return []
    lastCell = key

    // Read per tick, not captured at the press: `]` mid-drag widens the brush,
    // as it always did.
    const doc = deps.doc()
    const cells = strokeCells(voxel, params, address, anchor)
    return params.terrainMode === 'sculpt'
      ? sculptPatches(doc, voxel, params, address, cells, sample.modifiers, anchorHeight)
      : paintPatches(voxel, params, address, cells, sample.modifiers)
  }

  return {
    label: terrainLabel(deps.params(), press.modifiers, press.pick.surface),
    begin: (sample) => tick(sample, 'start'),
    move: (sample) => tick(sample, 'move'),
    end: (sample) => tick(sample, 'end'),
  }
}

/**
 * The contract for the `terrain` tool. A press that missed the terrain
 * declines (`undefined`), which is what lets the host's arbitration treat it
 * as a click or an orbit instead of spawning a stroke over nothing.
 */
export function terrainContract(deps: FeatureDeps): ToolContract<TerrainSample, Patch> {
  return {
    stroke: (sample) => {
      // The tool addresses the voxel volume the press landed on; a press on any other kind of structure is not its stroke.
      const surface = sample.pick.surface
      const voxel = surface ? structureOf(deps.doc(), surface.structure, 'voxel') : undefined
      if (!voxel) return undefined
      const params = deps.params()
      if (params.terrainMode === 'sculpt' && params.sculptVerb === 'ramp' && !sample.modifiers.alt) return rampHandler(deps, sample, voxel)
      return handlerFor(deps, sample, voxel)
    },
  }
}
