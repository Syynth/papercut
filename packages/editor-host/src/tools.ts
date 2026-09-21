/**
 * The tools actor: which tool is active, and every feature's parameters.
 *
 * The host owns three facts — the active tool, the object tool's sprite and
 * how a drag snaps (ruling of 2026-09-12, "Select tool") — and holds, without reading, one parameter slice per installed feature:
 * the terrain feature's brush, verbs and modes live under `features.terrain`
 * and are shaped by the terrain feature alone (its `<owner>.params` command
 * validates them; the host only stores what arrives). A feature is seeded
 * with its declared defaults when it is installed and reads its slice back
 * through `FeatureDeps.params()`. Nothing terrain-shaped is declared here.
 *
 * Any declared tool can be made active: the rail lists what the registry
 * knows, and `tools.set { tool }` refuses an id no owner declared.
 */

import type { RegionCombine, RegionDepth, RegionElement, RegionMatch, SnapMode } from '@papercut/document'
import { commands, defineContextKey, reserveOwner, tools } from '@papercut/registry'
import { setup, types } from 'xstate'
import { z } from 'zod'

export const TOOLS_OWNER = reserveOwner('editor-host.tools')

/** A declared tool's id: `select` and `object` are the host's; the rest come from features. */
export type ToolId = string

export const toolKeys = {
  tool: defineContextKey<ToolId>(TOOLS_OWNER, 'tools.tool', 'select'),
}

const toolSettings = z
  .object({
    tool: z.string().min(1).exactOptional(),
    spriteName: z.string().min(1).exactOptional(),
    snap: z.enum(['grid', 'half', 'free']).exactOptional(),
    /** Select's two halves (ruling of 2026-09-12): objects and structures, or a region of a voxel volume. */
    selectMode: z.enum(['objects', 'region']).exactOptional(),
    /** What a drag does under Select's region half: take a region, or move the one there. */
    selectVerb: z.enum(['select', 'move']).exactOptional(),
    /** What a region is of (ruling of 2026-09-20). */
    selectElement: z.enum(['voxel', 'face', 'edge']).exactOptional(),
    selectFootprint: z.enum(['brush', 'rect']).exactOptional(),
    selectSize: z.int().min(1).max(12).exactOptional(),
    selectDepth: z.enum(['surface', 'through']).exactOptional(),
    selectCombine: z.enum(['replace', 'add', 'subtract', 'intersect']).exactOptional(),
    /** Whether an edge's run or loop carries on down a ramp's side and onto the rim below. */
    selectFollowSlopes: z.boolean().exactOptional(),
    /** The rule a double-click takes "the whole" by, for each element: one of that element's. */
    selectMatch: z
      .object({ edge: z.enum(['run', 'loop', 'sameKind', 'sameTrim']), face: z.enum(['flat', 'material', 'tile', 'surface', 'wall']), voxel: z.enum(['layer', 'island', 'column', 'samePiece']) })
      .strict()
      .exactOptional(),
    /** Take every element the rule's test passes, connected or not. */
    selectEverywhere: z.boolean().exactOptional(),
    /** How big a change of height is still the same surface, in half-tiles. */
    selectStep: z.int().min(0).max(8).exactOptional(),
    /** Keep a match on a side face to the clicked layer. */
    selectBand: z.boolean().exactOptional(),
    /** Material and Tile look at every layer of a face's stack. */
    selectAnyLayer: z.boolean().exactOptional(),
  })
  .strict()

export type ToolSettings = z.infer<typeof toolSettings>

/** One feature's parameters, as the host holds them: shaped by the feature, opaque here. */
export type FeatureParams = Record<string, unknown>

/** Fill was one until 2026-09-21: it was a double-click all along (design pass of 2026-09-20). */
export type SelectFootprint = 'brush' | 'rect'

export interface ToolsContext {
  readonly tool: ToolId
  readonly spriteName: string
  /** How the Select and Objects tools snap a drag; the sketch feature keeps its own for now. */
  readonly snap: SnapMode
  readonly selectMode: 'objects' | 'region'
  readonly selectVerb: 'select' | 'move'
  readonly selectElement: RegionElement
  /** How a drag becomes a set of cells: under a brush, or in a rectangle from the press. */
  readonly selectFootprint: SelectFootprint
  readonly selectSize: number
  readonly selectDepth: RegionDepth
  /** How a new region meets the one there; shift adds and alt subtracts whatever this says. */
  readonly selectCombine: RegionCombine
  readonly selectFollowSlopes: boolean
  readonly selectMatch: Readonly<Record<RegionElement, RegionMatch>>
  readonly selectEverywhere: boolean
  readonly selectStep: number
  readonly selectBand: boolean
  readonly selectAnyLayer: boolean
  readonly features: Readonly<Record<string, FeatureParams>>
}

/** How Select starts: on objects, and for a region, one voxel under a one-cell brush, replacing what was selected. */
export const SELECT_DEFAULTS = { selectMode: 'objects', selectVerb: 'select', selectElement: 'voxel', selectFootprint: 'brush', selectSize: 1, selectDepth: 'surface', selectCombine: 'replace', selectFollowSlopes: true, selectMatch: { edge: 'run', face: 'flat', voxel: 'layer' }, selectEverywhere: false, selectStep: 1, selectBand: false, selectAnyLayer: false } as const satisfies Partial<ToolsContext>

commands.declare(TOOLS_OWNER, { id: 'tools.set', title: 'Set Tool', category: 'Tools', args: toolSettings })

tools.declare(TOOLS_OWNER, { id: 'select', title: 'Select', icon: 'select' })
tools.declare(TOOLS_OWNER, { id: 'object', title: 'Objects', icon: 'objects' })

function applySettings(settings: ToolSettings): { context: Partial<ToolsContext> } | undefined {
  const next: { -readonly [K in keyof Omit<ToolsContext, 'features'>]?: ToolsContext[K] } = {}
  if (settings.tool !== undefined) {
    // A tool nobody declared is not a tool; the rail could never have shown it.
    if (tools.ownerOf(settings.tool) === undefined) return undefined
    next.tool = settings.tool
  }
  if (settings.spriteName !== undefined) next.spriteName = settings.spriteName
  if (settings.snap !== undefined) next.snap = settings.snap
  if (settings.selectMode !== undefined) next.selectMode = settings.selectMode
  if (settings.selectVerb !== undefined) next.selectVerb = settings.selectVerb
  if (settings.selectElement !== undefined) next.selectElement = settings.selectElement
  if (settings.selectFootprint !== undefined) next.selectFootprint = settings.selectFootprint
  if (settings.selectSize !== undefined) next.selectSize = settings.selectSize
  if (settings.selectDepth !== undefined) next.selectDepth = settings.selectDepth
  if (settings.selectCombine !== undefined) next.selectCombine = settings.selectCombine
  if (settings.selectFollowSlopes !== undefined) next.selectFollowSlopes = settings.selectFollowSlopes
  if (settings.selectMatch !== undefined) next.selectMatch = settings.selectMatch
  if (settings.selectEverywhere !== undefined) next.selectEverywhere = settings.selectEverywhere
  if (settings.selectStep !== undefined) next.selectStep = settings.selectStep
  if (settings.selectBand !== undefined) next.selectBand = settings.selectBand
  if (settings.selectAnyLayer !== undefined) next.selectAnyLayer = settings.selectAnyLayer
  return { context: next }
}

/** The tools logic, seeded with each installed feature's default parameters. A closure, not `input`: `input` leaks into the inspector. */
export function toolsLogicWith(seeds: Readonly<Record<string, FeatureParams>>) {
  const initial: ToolsContext = { tool: 'select', spriteName: 'tree', snap: 'grid', ...SELECT_DEFAULTS, features: { ...seeds } }
  return setup({
    schemas: {
      context: types<ToolsContext>(),
      events: {
        command: types<{ id: string; args: unknown }>(),
        settings: types<{ settings: ToolSettings }>(),
        /** A feature changing its own parameters, through `FeatureDeps.setParams`. */
        feature: types<{ owner: string; changes: FeatureParams }>(),
        /** A feature installed after start, bringing its defaults; a slice already present is left alone. */
        seed: types<{ owner: string; params: FeatureParams }>(),
      },
    },
  }).createMachine({
    id: 'tools',
    context: initial,
    initial: 'ready',
    states: {
      ready: {
        on: {
          command: ({ event }) => (event.id === 'tools.set' ? applySettings(event.args as ToolSettings) : undefined),
          settings: ({ event }) => applySettings(event.settings),
          feature: ({ context, event }) => ({
            context: { features: { ...context.features, [event.owner]: { ...context.features[event.owner], ...event.changes } } },
          }),
          seed: ({ context, event }) =>
            context.features[event.owner] === undefined ? { context: { features: { ...context.features, [event.owner]: { ...event.params } } } } : undefined,
        },
      },
    },
  })
}

export const toolsLogic = toolsLogicWith({})
export type ToolsLogic = ReturnType<typeof toolsLogicWith>
