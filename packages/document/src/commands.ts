/**
 * The document's own commands (#3, #66 step 3).
 *
 * `registry` sits below this package precisely so the document can declare
 * what it handles without the host's help: everything whose effect is one
 * call on the write handle is the document actor's, so their declarations
 * live beside it, under an owner id this package reserves and never exports a
 * way to dispose. The host routes a command by its declaring owner (#8),
 * which is why the owner id is exported — it is the key the host spawns the
 * document actor under.
 *
 * Since #66 step 7 that list covers every write the app used to make through
 * `EditorStore` directly: the inspector's object edits, the camera rig, the
 * atmosphere, and replacing the document wholesale on load or new map. The
 * class left the barrel with them, so an app cannot write any other way.
 *
 * Every argument is plain serialisable data addressing its target by stable
 * id (#2), and the schema is where that is enforced (#23) — which is also why
 * the change objects below are spelled out field by field rather than typed
 * as a partial of the model: a schema that accepts whatever it is handed
 * would let a caller write a field no panel edits, and `undefined` is not
 * JSON, so `exactOptional` refuses a key that is present but unset.
 *
 * The two context keys are the document's contribution to the availability
 * vocabulary. The host derives their values from `reader` on every dispatch,
 * never from a held snapshot (#8's finding 2); this file only mints the keys
 * so a predicate can name them and a disabled Undo button can say why. They
 * are minted under the same reserved owner as the commands: a key is revoked
 * with everything else its owner declared, and a reserved owner is never
 * disposed, so these two stand for the life of the process.
 */

import { commands, defineContextKey, reserveOwner } from '@papercut/registry'
import { z } from 'zod'

import { deserialize } from './io'

export const DOCUMENT_OWNER = reserveOwner('document')

export const documentKeys = {
  canUndo: defineContextKey(DOCUMENT_OWNER, 'document.canUndo', false),
  canRedo: defineContextKey(DOCUMENT_OWNER, 'document.canRedo', false),
}

/**
 * Objects by STABLE ID, never "the selected one" (#2's argument convention).
 * Whoever invokes this fills the ids in — a keybinding through the host's
 * `selection.delete`, an inspector button from the object it is showing — so
 * the handler never reads ambient selection and a recorded session replays.
 * An id the document does not hold is dropped rather than refused: the list
 * is a request, and half a delete is not a document state any undo restores.
 */
const objectIds = z.object({ ids: z.array(z.string().min(1)).min(1) }).strict()

/** The facing block is set whole, because every control that edits it spreads the current one. */
const facingConfig = z
  .object({
    facings: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]),
    mirror: z.boolean(),
    back: z.enum(['none', 'mirror', 'dark', 'image']),
    transition: z.enum(['instant', 'flip', 'crossfade']),
    durationMs: z.number().min(0),
    hysteresisDeg: z.number().min(0),
    hinge: z.enum(['center', 'base', 'edge']),
  })
  .strict()

/**
 * What the inspector and the outliner may change about an object. `id` and
 * `seed` are deliberately absent: an identity is not an edit, and the seed is
 * what makes an export reproducible.
 */
const objectChanges = z
  .object({
    name: z.string().exactOptional(),
    sprite: z.string().min(1).exactOptional(),
    position: z.tuple([z.number(), z.number(), z.number()]).exactOptional(),
    rotationY: z.number().exactOptional(),
    scale: z.number().min(0.01).max(100).exactOptional(),
    display: z.enum(['fixed', 'billboardY', 'billboardFull', 'crossed', 'extruded', 'auto']).exactOptional(),
    facing: facingConfig.exactOptional(),
    anchorCell: z.tuple([z.int(), z.int()]).nullable().exactOptional(),
    locked: z.boolean().exactOptional(),
    hidden: z.boolean().exactOptional(),
  })
  .strict()

const objectUpdate = z.object({ id: z.string().min(1), changes: objectChanges }).strict()

const cameraBounds = z
  .object({
    yawMin: z.number(),
    yawMax: z.number(),
    pitchMin: z.number(),
    pitchMax: z.number(),
    distMin: z.number().min(0),
    distMax: z.number().min(0),
  })
  .strict()

/** The rig, as the camera panel edits it. `bounds` is set whole for the same reason `facing` is. */
const cameraChanges = z
  .object({
    yaw: z.number().exactOptional(),
    pitch: z.number().exactOptional(),
    distance: z.number().min(0).exactOptional(),
    fov: z.number().min(1).max(179).exactOptional(),
    bounds: cameraBounds.exactOptional(),
    yawSnapDeg: z.number().min(0).max(180).exactOptional(),
    projection: z.enum(['perspective', 'orthographic']).exactOptional(),
  })
  .strict()

const backdropCard = z
  .object({
    sprite: z.string().min(1),
    base: z.number(),
    height: z.number(),
    radius: z.number(),
    parallax: z.number(),
    opacity: z.number(),
  })
  .strict()

const colour = z.int().min(0).max(0xffffff)

const atmosphereChanges = z
  .object({
    preset: z.string().min(1).exactOptional(),
    fogColor: colour.exactOptional(),
    fogNear: z.number().exactOptional(),
    fogFar: z.number().exactOptional(),
    skyTop: colour.exactOptional(),
    skyHorizon: colour.exactOptional(),
    skyBottom: colour.exactOptional(),
    sunColor: colour.exactOptional(),
    sunIntensity: z.number().min(0).exactOptional(),
    ambientIntensity: z.number().min(0).exactOptional(),
    sunAzimuth: z.number().exactOptional(),
    sunElevation: z.number().exactOptional(),
    bloom: z.number().min(0).exactOptional(),
    tiltShift: z.number().min(0).exactOptional(),
    backdrop: z.array(backdropCard).exactOptional(),
  })
  .strict()

/**
 * A map to open, as the TEXT on disk rather than as a parsed document: that is
 * what a file drop, a recent-files entry and a test all have, and it keeps the
 * argument something a recorded session can carry verbatim.
 *
 * The parse runs HERE, in the schema, as well as in the handler. A malformed
 * file is a thing the person loading it did, not a bug, so the refusal has to
 * come back as an `invalid-args` result with the `LoadError`'s own message in
 * it (#8: dispatch answers, never throws) — and a transition body that throws
 * would take the actor down instead. Parsing twice costs one parse of one file
 * at the moment a human picked it, which is the cheapest place in the editor
 * to spend one.
 */
const documentLoad = z
  .object({ json: z.string().min(1) })
  .strict()
  .check((ctx) => {
    try {
      deserialize(ctx.value.json)
    } catch (error) {
      ctx.issues.push({ code: 'custom', input: ctx.value, path: ['json'], message: error instanceof Error ? error.message : String(error) })
    }
  })

/** A blank map. The bounds are the mesher's: a map is at least one cell and the chunk grid is not unbounded. */
const documentNew = z
  .object({ width: z.int().min(1).max(512), height: z.int().min(1).max(512), name: z.string().min(1).exactOptional() })
  .strict()

commands.declare(DOCUMENT_OWNER, { id: 'undo', title: 'Undo', category: 'Edit', when: documentKeys.canUndo.is(true) })
commands.declare(DOCUMENT_OWNER, { id: 'redo', title: 'Redo', category: 'Edit', when: documentKeys.canRedo.is(true) })
commands.declare(DOCUMENT_OWNER, { id: 'objects.delete', title: 'Delete Objects', category: 'Edit', args: objectIds })
commands.declare(DOCUMENT_OWNER, { id: 'objects.update', title: 'Edit Object', category: 'Edit', args: objectUpdate })
commands.declare(DOCUMENT_OWNER, { id: 'camera.set', title: 'Set Camera Rig', category: 'Camera', args: cameraChanges })
commands.declare(DOCUMENT_OWNER, { id: 'atmosphere.set', title: 'Set Atmosphere', category: 'Atmosphere', args: atmosphereChanges })
commands.declare(DOCUMENT_OWNER, { id: 'document.load', title: 'Open Map', category: 'File', args: documentLoad })
commands.declare(DOCUMENT_OWNER, { id: 'document.new', title: 'New Map', category: 'File', args: documentNew })

const profilePoint = z.object({ x: z.number(), z: z.number(), smooth: z.boolean() }).strict()
const wallProfile = z
  .object({ points: z.array(z.object({ out: z.number(), t: z.number().min(0).max(1) }).strict()).min(2), smooth: z.boolean() })
  .strict()
const placement = z.object({ x: z.number(), z: z.number(), yaw: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]) }).strict()
const structureId = z.object({ id: z.string().min(1) }).strict()
const sketchNew = z.object({ parent: z.string().min(1).nullable(), name: z.string().min(1).exactOptional(), placement: placement.exactOptional() }).strict()
const sketchPointAdd = z.object({ id: z.string().min(1), point: profilePoint, at: z.int().min(0).exactOptional() }).strict()
const sketchPointUpdate = z.object({ id: z.string().min(1), index: z.int().min(0), changes: profilePoint.partial() }).strict()
const sketchPointDelete = z.object({ id: z.string().min(1), index: z.int().min(0) }).strict()
const sketchSet = z
  .object({
    id: z.string().min(1),
    changes: z
      .object({
        layers: z.int().min(1).max(64).exactOptional(),
        wall: wallProfile.exactOptional(),
        lip: z.enum(['flat', 'skirt', 'bevel']).exactOptional(),
        capMaterial: z.string().min(1).exactOptional(),
        wallMaterial: z.string().min(1).exactOptional(),
      })
      .strict(),
  })
  .strict()
const structureRename = z.object({ id: z.string().min(1), name: z.string().min(1) }).strict()
const structurePlace = z.object({ id: z.string().min(1), placement }).strict()
const structureReparent = z.object({ id: z.string().min(1), parent: z.string().min(1).nullable() }).strict()

commands.declare(DOCUMENT_OWNER, { id: 'sketch.new', title: 'New Sketch', category: 'Sketch', args: sketchNew })
commands.declare(DOCUMENT_OWNER, { id: 'sketch.point.add', title: 'Add Sketch Point', category: 'Sketch', args: sketchPointAdd })
commands.declare(DOCUMENT_OWNER, { id: 'sketch.point.update', title: 'Edit Sketch Point', category: 'Sketch', args: sketchPointUpdate })
commands.declare(DOCUMENT_OWNER, { id: 'sketch.point.delete', title: 'Delete Sketch Point', category: 'Sketch', args: sketchPointDelete })
commands.declare(DOCUMENT_OWNER, { id: 'sketch.close', title: 'Close Sketch', category: 'Sketch', args: structureId })
commands.declare(DOCUMENT_OWNER, { id: 'sketch.set', title: 'Edit Sketch', category: 'Sketch', args: sketchSet })
/**
 * Some of a volume's voxels carried by an offset, with their paint and what stands on them (`move.ts`). The drag under
 * Select's Move does the same through a stroke; this is the one-shot form, which a nudge key and a test dispatch.
 */
const voxelsMove = z
  .object({
    structure: z.string().min(1),
    keys: z.array(z.string().regex(/^\d+,\d+,\d+$/)).min(1),
    dx: z.int().min(-256).max(256),
    dz: z.int().min(-256).max(256),
    dy: z.int().min(-64).max(64),
    copy: z.boolean().exactOptional(),
  })
  .strict()
export type VoxelsMoveArgs = z.infer<typeof voxelsMove>
commands.declare(DOCUMENT_OWNER, { id: 'voxels.move', title: 'Move Voxels', category: 'Edit', args: voxelsMove })
commands.declare(DOCUMENT_OWNER, { id: 'structure.delete', title: 'Delete Structure', category: 'Edit', args: structureId })
commands.declare(DOCUMENT_OWNER, { id: 'structure.rename', title: 'Rename Structure', category: 'Edit', args: structureRename })
commands.declare(DOCUMENT_OWNER, { id: 'structure.place', title: 'Place Structure', category: 'Edit', args: structurePlace })
commands.declare(DOCUMENT_OWNER, { id: 'structure.reparent', title: 'Move Structure Onto', category: 'Edit', args: structureReparent })

export type SketchNewArgs = z.infer<typeof sketchNew>
export type SketchPointAddArgs = z.infer<typeof sketchPointAdd>
export type SketchPointUpdateArgs = z.infer<typeof sketchPointUpdate>
export type SketchPointDeleteArgs = z.infer<typeof sketchPointDelete>
export type SketchSetArgs = z.infer<typeof sketchSet>
export type StructureIdArgs = z.infer<typeof structureId>
export type StructureRenameArgs = z.infer<typeof structureRename>
export type StructurePlaceArgs = z.infer<typeof structurePlace>
export type StructureReparentArgs = z.infer<typeof structureReparent>
export type ObjectUpdateArgs = z.infer<typeof objectUpdate>
export type CameraChanges = z.infer<typeof cameraChanges>
export type AtmosphereChanges = z.infer<typeof atmosphereChanges>
export type DocumentLoadArgs = z.infer<typeof documentLoad>
export type DocumentNewArgs = z.infer<typeof documentNew>
