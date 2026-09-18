/**
 * The project actor: what every map in the folder shares, held live.
 *
 * The project document (`@papercut/document`'s `ProjectDoc`) is small — the
 * material library, the resolution profile, the image list, the map list —
 * so unlike the map it is context, replaced whole on every edit. Edits are
 * commands, one per list, each taking the list whole: a material reorder is
 * a priority change and lands as one edit; ids never move, so no voxel
 * changes what it is made of. Nothing here is undoable: these are settings,
 * as brink's are, not strokes.
 *
 * Where the project lives — its folder, and which of its maps the document
 * currently is — is held here too, as LOCATION and nothing more: the files
 * are read and written by the app through `@papercut/project`, and what it
 * read arrives as `project.load` with the file's text, parsed in the schema
 * the way `document.load` is, so a bad file is an `invalid-args` refusal
 * rather than a throw. `folder` is `null` while no project is open, which
 * is what the startup screen shows for.
 */

import { createProject, normaliseTerrain, parseProject, type ImageEntry, type ProjectDoc } from '@papercut/document'
import { commands, defineContextKey, reserveOwner } from '@papercut/registry'
import { setup, types } from 'xstate'
import { z } from 'zod'

export const PROJECT_OWNER = reserveOwner('editor-host.project')

export const projectKeys = {
  /** A project is open: its folder is known. */
  open: defineContextKey(PROJECT_OWNER, 'project.open', false),
}

const relativePath = z.string().min(1).refine((p) => !p.startsWith('/') && !p.includes('\\') && !p.split('/').includes('..'), { message: 'a path inside the project' })

const materialDef = z
  .object({
    id: z.int().min(0),
    name: z.string().min(1),
    color: z.int().min(0).max(0xffffff),
    archetype: z.enum(['floor', 'wall', 'ramp']),
    /** Another material by id: what a voxel of this one cuts its cliffs with. */
    side: z.int().min(0).exactOptional(),
  })
  .strict()
/** The whole list, replaced: its order is the materials' priority, so a reorder is as much an edit as a rename. */
const materialsSet = z
  .object({ materials: z.array(materialDef).min(1) })
  .strict()
  .refine(({ materials }) => new Set(materials.map((m) => m.id)).size === materials.length, { message: 'material ids must be unique' })
  .refine(({ materials }) => materials.every((m) => m.side === undefined || materials.some((o) => o.id === m.side)), { message: 'a side names a material the project does not have' })

const axes = z.object({ x: z.int().min(0), y: z.int().min(0) }).strict()
const grid = z.object({ tile: z.int().min(1), margin: axes, spacing: axes }).strict()
/** A material id, optionally with a slot of its archetype: `"3"` or `"3:convex"`. */
const cornerTag = z.string().min(1).nullable()
/** An image's tags, checked the way the project file's parser checks them. Whether the materials exist is the host's business, not the schema's. */
const imageTerrain = z
  .object({ tiles: z.record(z.string(), z.tuple([cornerTag, cornerTag, cornerTag, cornerTag])) })
  .strict()
  .check((ctx) => {
    try {
      normaliseTerrain(ctx.value, 'image')
    } catch (error) {
      ctx.issues.push({ code: 'custom', input: ctx.value, message: error instanceof Error ? error.message : String(error) })
    }
  })
/**
 * The convention an image was laid out to, or `null` for one tagged by hand.
 *
 * This was missing while the schema was `.strict()`, which made
 * `project.images.set` refuse every entry that carried one — including the
 * entries `newTemplateImage` dispatches, since drawing a template is exactly
 * what puts a layout on an image. It never type-errored because the machine
 * stores the result through an `as ImageEntry` cast.
 */
const imageLayout = z
  .object({ convention: z.string().min(1), origin: axes, materials: z.array(z.int().min(0)) })
  .strict()
  .nullable()
  // Missing means the same as `null`: an image tagged by hand. Every other field of an entry is
  // required because leaving one out is a mistake; leaving this one out is just saying there is none.
  .default(null)
const imageEntry = z
  .object({
    path: relativePath,
    name: z.string().min(1),
    kind: z.enum(['tileset', 'sprites', 'texture']),
    hash: z.string().min(1).nullable(),
    grid,
    layout: imageLayout,
    terrain: imageTerrain,
  })
  .strict()
/** The whole list, replaced. An image is identified by its file name, so two cannot share one. */
const imagesSet = z
  .object({ images: z.array(imageEntry) })
  .strict()
  .refine(({ images }) => new Set(images.map((i) => i.path.slice(i.path.lastIndexOf('/') + 1))).size === images.length, { message: 'an image is identified by its file name, so two cannot share one' })

const mapsSet = z.object({ maps: z.array(relativePath) }).strict()

const cameraRig = z
  .object({
    yaw: z.number(),
    pitch: z.number(),
    distance: z.number().min(0),
    fov: z.number().min(1).max(179),
    bounds: z.object({ yawMin: z.number(), yawMax: z.number(), pitchMin: z.number(), pitchMax: z.number(), distMin: z.number().min(0), distMax: z.number().min(0) }).strict(),
    yawSnapDeg: z.number().min(0).max(180),
    projection: z.enum(['perspective', 'orthographic']),
  })
  .strict()
const projectSettings = z
  .object({
    name: z.string().min(1).exactOptional(),
    resolution: z.object({ texelDensity: z.int().min(1), filtering: z.enum(['nearest', 'linear']) }).strict().exactOptional(),
    /** The rig every new map starts from, whole. */
    camera: cameraRig.exactOptional(),
  })
  .strict()

/** A project file's text, from the folder it was read in. Parsed here so a file that will not parse is refused as `invalid-args` carrying the load error. */
const projectLoad = z
  .object({ folder: z.string().min(1), json: z.string().min(1) })
  .strict()
  .check((ctx) => {
    try {
      parseProject(ctx.value.json)
    } catch (error) {
      ctx.issues.push({ code: 'custom', input: ctx.value, path: ['json'], message: error instanceof Error ? error.message : String(error) })
    }
  })
/** Which of the project's maps the document is, by its path in the project; `null` between maps. */
const projectCurrent = z.object({ map: relativePath.nullable() }).strict()

export type ProjectSettings = z.infer<typeof projectSettings>
export type ProjectLoadArgs = z.infer<typeof projectLoad>
export type ProjectCurrentArgs = z.infer<typeof projectCurrent>
export type MaterialsSetArgs = z.infer<typeof materialsSet>
export type ImagesSetArgs = z.infer<typeof imagesSet>
export type MapsSetArgs = z.infer<typeof mapsSet>

commands.declare(PROJECT_OWNER, { id: 'project.set', title: 'Set Project Settings', category: 'Project', args: projectSettings })
commands.declare(PROJECT_OWNER, { id: 'project.materials.set', title: 'Set Materials', category: 'Project', args: materialsSet })
commands.declare(PROJECT_OWNER, { id: 'project.images.set', title: 'Set Images', category: 'Project', args: imagesSet })
commands.declare(PROJECT_OWNER, { id: 'project.maps.set', title: 'Set Map List', category: 'Project', args: mapsSet })
commands.declare(PROJECT_OWNER, { id: 'project.load', title: 'Open Project', category: 'File', args: projectLoad })
commands.declare(PROJECT_OWNER, { id: 'project.current', title: 'Set Current Map', category: 'File', args: projectCurrent })
commands.declare(PROJECT_OWNER, { id: 'project.close', title: 'Close Project', category: 'File', when: projectKeys.open.is(true) })

export interface ProjectContext {
  readonly project: ProjectDoc
  /** The project's folder, absolute; `null` while none is open. */
  readonly folder: string | null
  /** The document's path in the project, relative to the folder; `null` while none is open. */
  readonly map: string | null
}

/** The project logic, seeded with a project and, when the app already knows it, where it lives. A closure, not `input`: `input` leaks into the inspector. */
export function projectLogicWith(initial: ProjectDoc, folder: string | null = null, map: string | null = null) {
  return setup({
    schemas: {
      context: types<ProjectContext>(),
      events: {
        command: types<{ id: string; args: unknown }>(),
        /** A whole project arriving: opened from a folder, or created. */
        replace: types<{ project: ProjectDoc }>(),
      },
    },
  }).createMachine({
    id: 'project',
    context: { project: initial, folder, map },
    initial: 'ready',
    states: {
      ready: {
        on: {
          command: ({ context, event }) => {
            const { project } = context
            switch (event.id) {
              case 'project.set': {
                const { name, resolution, camera } = event.args as ProjectSettings
                return { context: { project: { ...project, ...(name === undefined ? {} : { name }), ...(resolution === undefined ? {} : { resolution }), ...(camera === undefined ? {} : { camera }) } } }
              }
              case 'project.materials.set':
                return { context: { project: { ...project, materials: (event.args as MaterialsSetArgs).materials.map((m) => ({ ...m })) } } }
              case 'project.images.set':
                return { context: { project: { ...project, images: (event.args as ImagesSetArgs).images.map((i) => JSON.parse(JSON.stringify(i)) as ImageEntry) } } }
              case 'project.maps.set':
                return { context: { project: { ...project, maps: [...(event.args as MapsSetArgs).maps] } } }
              case 'project.load': {
                const { folder, json } = event.args as ProjectLoadArgs
                return { context: { project: parseProject(json), folder, map: null } }
              }
              case 'project.current':
                return { context: { map: (event.args as ProjectCurrentArgs).map } }
              case 'project.close':
                return { context: { project: createProject(), folder: null, map: null } }
              default:
                return undefined
            }
          },
          replace: ({ event }) => ({ context: { project: event.project } }),
        },
      },
    },
  })
}

export type ProjectLogic = ReturnType<typeof projectLogicWith>
