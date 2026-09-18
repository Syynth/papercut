/**
 * The view actor: what is shown, and what is selected.
 *
 * Selection is typed: an object, a structure, or one point of a sketch. The
 * Select tool is one polymorphic tool over everything that exists (ruling
 * of 2026-09-12, "App frame"), so what it holds has a kind, and each kind
 * knows what deleting or moving it means. `selectedObjectId` is kept beside
 * it as the object case, read by the viewport and the inspector.
 */

import { MAX_HEIGHT, MIN_HEIGHT, type DocumentTarget } from '@papercut/document'
import { commands, defineContextKey, reserveOwner } from '@papercut/registry'
import { setup, types } from 'xstate'
import { z } from 'zod'

export const VIEW_OWNER = reserveOwner('editor-host.view')

/** The Project settings sections, in rail order (design of 2026-09-14). */
export const SETTINGS_SECTIONS = ['general', 'resolution', 'images', 'terrains', 'materials', 'camera', 'editor', 'keymap'] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

export const viewKeys = {
  hasSelection: defineContextKey(VIEW_OWNER, 'view.hasSelection', false),
  gameCamera: defineContextKey(VIEW_OWNER, 'view.gameCamera', false),
}

const layerRange = z
  .object({ lo: z.int().min(MIN_HEIGHT).max(MAX_HEIGHT), hi: z.int().min(MIN_HEIGHT).max(MAX_HEIGHT) })
  .strict()
  .refine((range) => range.lo <= range.hi, { message: 'lo must not exceed hi' })

const viewSettings = z
  .object({
    showGrid: z.boolean().exactOptional(),
    /** Mark every corner no transition tile is authored for, where the terrain draws the fallback. */
    showMissing: z.boolean().exactOptional(),
    /** The colour, 0xRRGGBB, a face with nothing on it and a corner no tile answers are drawn: magenta unless set. */
    fallback: z.int().min(0).max(0xffffff).exactOptional(),
    /** Which material layers the stage draws, bottom first: hiding one changes the view, never the map. */
    materialLayersShown: z.tuple([z.boolean(), z.boolean(), z.boolean(), z.boolean()]).exactOptional(),
    /** Whether the Material Layers widget is open on the stage, or collapsed to its header. */
    materialLayersOpen: z.boolean().exactOptional(),
    gameCamera: z.boolean().exactOptional(),
    /** How the editor camera projects while free: the view cube's second click flips it. The game's rig has its own. */
    projection: z.enum(['perspective', 'orthographic']).exactOptional(),
    inspector: z.enum(['properties', 'coverage', 'atmosphere', 'outliner']).exactOptional(),
    layers: layerRange.nullable().exactOptional(),
    /** The level's own sections — camera rig, atmosphere, coverage — opened and closed together from the rail's gear. */
    levelOpen: z.boolean().exactOptional(),
    /** What the last file action said (saved, loaded, exported, or why not), shown until the next one. */
    notice: z.string().min(1).nullable().exactOptional(),
    /** The Project settings section that is open, or `null` while the modal is closed. */
    settings: z.enum(SETTINGS_SECTIONS).nullable().exactOptional(),
    /** The dialog that is open — New Project, New Map — or `null`; the startup doors, the menu and the shell's menu all open the same one. */
    dialog: z.enum(['new-project', 'new-map']).nullable().exactOptional(),
  })
  .strict()

export type ViewSettings = z.infer<typeof viewSettings>

export type Selection =
  | { readonly kind: 'object'; readonly id: string }
  | { readonly kind: 'structure'; readonly id: string }
  | { readonly kind: 'sketchPoint'; readonly structure: string; readonly index: number }

const selectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('object'), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('structure'), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('sketchPoint'), structure: z.string().min(1), index: z.int().min(0) }).strict(),
])

/** The object case, kept for the callers that only ever selected objects. */
const objectSelection = z.object({ id: z.string().min(1).nullable() }).strict()
const selectArgs = z.object({ selection: selectionSchema.nullable() }).strict()

export interface ViewContext extends Required<ViewSettings> {
  readonly selection: Selection | null
  readonly selectedObjectId: string | null
}

commands.declare(VIEW_OWNER, { id: 'view.set', title: 'Set View Options', category: 'View', args: viewSettings })
commands.declare(VIEW_OWNER, { id: 'selection.set', title: 'Select Object', category: 'Selection', args: objectSelection })
commands.declare(VIEW_OWNER, { id: 'selection.select', title: 'Select', category: 'Selection', args: selectArgs })

/**
 * What a selection lives in, as the scene can point at it: an object, or a
 * structure — a sketch point's is its sketch. The ONE place a selection kind
 * meets a target, so a highlight, a framing or a pick that takes a
 * `DocumentTarget` serves every kind, and a new kind is a new case here.
 */
export function selectionSubject(selection: Selection | null): DocumentTarget | null {
  switch (selection?.kind) {
    case 'object':
      return { kind: 'object', id: selection.id }
    case 'structure':
      return { kind: 'structure', id: selection.id }
    case 'sketchPoint':
      return { kind: 'structure', id: selection.structure }
    default:
      return null
  }
}

function selected(selection: Selection | null): Pick<ViewContext, 'selection' | 'selectedObjectId'> {
  return { selection, selectedObjectId: selection?.kind === 'object' ? selection.id : null }
}

export const viewLogic = setup({
  schemas: {
    context: types<ViewContext>(),
    events: {
      command: types<{ id: string; args: unknown }>(),
      select: types<{ selection: Selection | null }>(),
    },
  },
}).createMachine({
  id: 'view',
  context: { showGrid: true, showMissing: false, fallback: 0xff00ff, materialLayersShown: [true, true, true, true], materialLayersOpen: true, gameCamera: false, projection: 'perspective', inspector: 'properties', layers: null, levelOpen: false, notice: null, settings: null, dialog: null, selection: null, selectedObjectId: null },
  initial: 'ready',
  states: {
    ready: {
      on: {
        command: ({ event }) => {
          if (event.id === 'view.set') return { context: event.args as ViewSettings }
          if (event.id === 'selection.set') {
            const { id } = event.args as z.infer<typeof objectSelection>
            return { context: selected(id === null ? null : { kind: 'object', id }) }
          }
          if (event.id === 'selection.select') return { context: selected((event.args as z.infer<typeof selectArgs>).selection) }
          return undefined
        },
        select: ({ event }) => ({ context: selected(event.selection) }),
      },
    },
  },
})

export type ViewLogic = typeof viewLogic
