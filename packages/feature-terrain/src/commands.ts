/**
 * The terrain commands: the verbs as an intent layer (#5, #8, #23).
 *
 * A command is what a palette, a keybinding and a test all invoke identically,
 * so every one of these takes its target as PLAIN SERIALISABLE DATA and reads
 * nothing ambient — `terrain.raise({ cells, delta })`, never "raise whatever
 * the brush is over with whatever the verb bar says". The tool parameters that
 * a stroke reads (brush size, the active verb, the selected tile) are the
 * stroke's business, not a command's; they reach this package through
 * `FeatureDeps.params()` and appear here only as the arguments a UI fills in.
 *
 * Erasure is `null`, not an absent key: `undefined` is not JSON and the
 * schemas refuse it (#23), so "clear the paint here" has to be a value a
 * recorded session can carry. The ops take `undefined`, which is where the two
 * spellings meet — at the boundary, once, rather than in every caller.
 */

import {
  structureOf,
  MATERIAL_LAYERS,
  MAX_HEIGHT,
  MIN_HEIGHT,
  clearRampRun,
  flatten,
  paintFace,
  paintTint,
  raise,
  rampRun,
  setEdges,
  setMaterial,
  setWater,
  smooth,
  type Patch,
  type ReadonlyMapDoc,
} from '@papercut/document'
import { commands, type OwnerId } from '@papercut/registry'
import { z } from 'zod'

/**
 * A cell address, as a pair. Bounds are the document's question — `cellIndex`
 * and the ops clamp or skip what is off the map — so the schema checks the
 * shape and the sign, which is what it can check without a document.
 */
const cell = z.tuple([z.int().min(0), z.int().min(0)])
const cells = z.array(cell).min(1)
/** The voxel volume the cells are in: nothing ambient, a command names its structure. */
const structure = z.string().min(1)

/** One face of one voxel: the cell, the layer, and the side (0–3, 4 top, 5 bottom). */
const face = z.object({ x: z.int().min(0), z: z.int().min(0), y: z.int().min(-1), dir: z.int().min(0).max(5) }).strict()
const edge = z.object({ x: z.int().min(0), z: z.int().min(0), dir: z.int().min(0).max(3), end: z.enum(['top', 'foot']) }).strict()

const raiseArgs = z.object({ structure, cells, delta: z.int().min(-MAX_HEIGHT).max(MAX_HEIGHT) }).strict()
const flattenArgs = z.object({ structure, cells, height: z.int().min(MIN_HEIGHT).max(MAX_HEIGHT) }).strict()
const smoothArgs = z.object({ structure, cells, strength: z.int().min(1).max(MAX_HEIGHT) }).strict()
/** A cliff edge — a cell and the side that stands above its neighbour — and how many cells the ramp runs back from it. */
const rampArgs = z.object({ structure, edge: z.object({ x: z.int().min(0), z: z.int().min(0), dir: z.int().min(0).max(3) }).strict(), run: z.int().min(1) }).strict()
const rampClearArgs = z.object({ structure, cell }).strict()
const waterArgs = z.object({ structure, cells, level: z.int().min(MIN_HEIGHT).max(MAX_HEIGHT).nullable() }).strict()
/** Which of a face's material layers a paint command writes; the first when not said. */
const layer = z.int().min(0).max(MATERIAL_LAYERS - 1).optional()
const materialArgs = z.object({ structure, cells, material: z.int().min(0).nullable(), layer }).strict()
const faceArgs = z.object({ structure, faces: z.array(face).min(1), material: z.int().min(0).nullable(), layer }).strict()
const tintArgs = z.object({ structure, cells, tint: z.int().min(0).max(0xffffff).nullable() }).strict()
/** Switch walls' fringes (at their tops) or pickets (at their feet) off, or back on to what the art does. */
const edgeArgs = z.object({ structure, edges: z.array(edge).min(1), on: z.boolean() }).strict()

/**
 * Declared at import, under the feature's owner, and revoked with it. No
 * `when`: a terrain verb reads its whole target from its arguments, so there
 * is no state in which one of these is meaningless — which tool is selected
 * decides what a POINTER does, not what a command may do.
 */
/** The feature's own parameters, in the shape the host stores opaquely: validated here, where they are declared. */
const terrainParams = z
  .object({
    terrainMode: z.enum(['sculpt', 'paint']).exactOptional(),
    sculptVerb: z.enum(['raise', 'flatten', 'smooth', 'ramp', 'water']).exactOptional(),
    paintVerb: z.enum(['material', 'tint', 'fringe']).exactOptional(),
    strokeShape: z.enum(['brush', 'rect', 'fill']).exactOptional(),
    brush: z.object({ size: z.int().min(1).max(12), shape: z.enum(['square', 'circle']) }).exactOptional(),
    material: z.int().min(0).exactOptional(),
    materialLayer: z.int().min(0).max(MATERIAL_LAYERS - 1).exactOptional(),
    tint: z.int().min(0).max(0xffffff).exactOptional(),
    strength: z.int().min(1).max(8).exactOptional(),
    height: z.int().min(MIN_HEIGHT).max(MAX_HEIGHT).exactOptional(),
    heightPinned: z.boolean().exactOptional(),
    rampRun: z
      .object({ edge: z.object({ x: z.int().min(0), z: z.int().min(0), dir: z.int().min(0).max(3) }).strict(), run: z.int().min(1), needed: z.int().min(1), blocked: z.string().nullable() })
      .strict()
      .nullable()
      .exactOptional(),
    sculptDeadZone: z.number().min(0).max(0.5).exactOptional(),
  })
  .strict()
const brushResize = z.object({ by: z.int().min(-12).max(12) }).strict()

export type TerrainParamsChange = z.infer<typeof terrainParams>

export function declareTerrainCommands(owner: OwnerId): void {
  commands.declare(owner, { id: 'terrain.params', title: 'Set Terrain Parameters', category: 'Terrain', args: terrainParams })
  commands.declare(owner, { id: 'terrain.brush.resize', title: 'Resize Brush', category: 'Terrain', args: brushResize })
  commands.declare(owner, { id: 'terrain.raise', title: 'Raise Terrain', category: 'Terrain', args: raiseArgs })
  commands.declare(owner, { id: 'terrain.flatten', title: 'Flatten Terrain', category: 'Terrain', args: flattenArgs })
  commands.declare(owner, { id: 'terrain.smooth', title: 'Smooth Terrain', category: 'Terrain', args: smoothArgs })
  commands.declare(owner, { id: 'terrain.ramp', title: 'Cut Ramp', category: 'Terrain', args: rampArgs })
  commands.declare(owner, { id: 'terrain.ramp.clear', title: 'Remove Ramp', category: 'Terrain', args: rampClearArgs })
  commands.declare(owner, { id: 'terrain.water', title: 'Set Water', category: 'Terrain', args: waterArgs })
  commands.declare(owner, { id: 'terrain.material', title: 'Set Material', category: 'Terrain', args: materialArgs })
  commands.declare(owner, { id: 'terrain.face', title: 'Paint Face', category: 'Terrain', args: faceArgs })
  commands.declare(owner, { id: 'terrain.tint', title: 'Tint Cells', category: 'Terrain', args: tintArgs })
  commands.declare(owner, { id: 'terrain.edges', title: 'Switch Fringes', category: 'Terrain', args: edgeArgs })
}

/** One command's effect: its undo label and the patches it produces. */
export interface TerrainEdit {
  readonly label: string
  readonly patches: Patch[]
}

/**
 * What a routed command means, as data. The actor turns this into one
 * `deps.apply`; nothing here writes, and an id this owner never declared
 * answers `undefined` so the actor can refuse it with v6's "not enabled"
 * shape rather than dropping it inside an effect.
 *
 * `args` is trusted: the host validated it against the schema above before
 * routing (#23), which is what the casts rest on.
 */
export function terrainEdit(doc: ReadonlyMapDoc, id: string, args: unknown): TerrainEdit | undefined {
  const voxel = structureOf(doc, (args as { structure: string }).structure, 'voxel')
  if (!voxel) return undefined
  switch (id) {
    case 'terrain.raise': {
      const { cells, delta } = args as z.infer<typeof raiseArgs>
      return { label: delta < 0 ? 'Lower' : 'Raise', patches: raise(doc, voxel, cells, delta) }
    }
    case 'terrain.flatten': {
      const { cells, height } = args as z.infer<typeof flattenArgs>
      return { label: 'Flatten', patches: flatten(doc, voxel, cells, height) }
    }
    case 'terrain.smooth': {
      const { cells, strength } = args as z.infer<typeof smoothArgs>
      return { label: 'Smooth', patches: smooth(doc, voxel, cells, strength) }
    }
    case 'terrain.ramp': {
      const { edge, run } = args as z.infer<typeof rampArgs>
      return { label: 'Cut ramp', patches: rampRun(doc, voxel, edge, run) }
    }
    case 'terrain.ramp.clear': {
      const { cell: [x, z] } = args as z.infer<typeof rampClearArgs>
      return { label: 'Remove ramp', patches: clearRampRun(doc, voxel, x, z) }
    }
    case 'terrain.water': {
      const { cells, level } = args as z.infer<typeof waterArgs>
      return { label: level === null ? 'Remove water' : 'Carve water', patches: setWater(voxel, cells, level) }
    }
    case 'terrain.material': {
      const { cells, material, layer } = args as z.infer<typeof materialArgs>
      return { label: material === null ? 'Clear material' : 'Set material', patches: setMaterial(voxel, cells, material, layer) }
    }
    case 'terrain.face': {
      const { faces, material, layer } = args as z.infer<typeof faceArgs>
      return { label: material === null ? 'Clear face' : 'Paint face', patches: paintFace(voxel, faces, material, layer) }
    }
    case 'terrain.tint': {
      const { cells, tint } = args as z.infer<typeof tintArgs>
      return { label: tint === null ? 'Clear tint' : 'Tint', patches: paintTint(voxel, cells, tint ?? undefined) }
    }
    case 'terrain.edges': {
      const { edges, on } = args as z.infer<typeof edgeArgs>
      return { label: on ? 'Fringe back on' : 'Fringe off', patches: setEdges(voxel, edges, on) }
    }
    default:
      return undefined
  }
}
