/**
 * The default keymap (#14, #66 step 6).
 *
 * Every binding the editor shipped before there was a keymap, read off the
 * `window` keydown handler `App.tsx` used to install and restated as data.
 * Nothing here knows about a window: these are declarations, and the one
 * listener that feeds them is the app's, because `registry` and this package
 * both compile without `DOM` and a keydown listener is exactly the thing that
 * would change that.
 *
 * Three of them are TOGGLES, and a toggle is two bindings on one chord rather
 * than one binding that reads the current value — which is #14's fall-through
 * doing the work. `P` is the clearest: `mode.play` and `mode.edit` are
 * already gated on `host.mode`, so the two bindings need no scope of their
 * own and the resolver picks whichever command is available. `Tab` and `G`
 * say the same thing with an explicit `when`, because `tools.set` and
 * `view.set` take any value at any time and cannot gate themselves.
 *
 * `Ctrl` AND `Meta` are both bound for undo and redo, rather than `mod`,
 * because that is what the old handler did — `(event.ctrlKey ||
 * event.metaKey)` on every platform — and this step preserves behaviour
 * rather than tidying it. `mod` is what a USER binding should use; the two
 * specs stay distinct at declare time (`canonicalSpec` leaves `mod` alone) so
 * neither platform sees a phantom conflict.
 */

import { and, keymap, reserveOwner, type KeyBinding } from '@papercut/registry'

// `./host` for its side effect only: `mode.play`, `mode.edit`,
// `commands.run` and `selection.delete` are declared at its import, and a
// binding is checked against the command it names. This file is itself
// side-effect-only in the same way — the barrel exports `CORE_KEYMAP_OWNER`
// so that importing `editor-host` is what installs the defaults.

import './host'
import { projectKeys } from './project'
import { toolKeys } from './tools'
import { viewKeys } from './view'

export const CORE_KEYMAP_OWNER = reserveOwner('core-keymap')

/** Declaration order is resolution order within a weight, and the resolver scans in reverse. */
const CORE_BINDINGS: readonly KeyBinding[] = [
  { chord: 'ctrl+z', command: 'undo' },
  { chord: 'meta+z', command: 'undo' },
  { chord: 'ctrl+shift+z', command: 'redo' },
  { chord: 'meta+shift+z', command: 'redo' },

  // Project settings on the chord every editor uses for preferences.
  { chord: 'ctrl+,', command: 'view.set', args: { settings: 'general' }, when: projectKeys.open.is(true) },
  { chord: 'meta+,', command: 'view.set', args: { settings: 'general' }, when: projectKeys.open.is(true) },

  // The rail's subjects, on the letters the reference art apps use for them
  // (2026-09-12 ruling): `V` for Select as Figma, Photoshop and Blender have
  // it, and Escape returns to Select from anywhere, which is the convention
  // every one of them shares. These are a DEFAULT preset — a user binding
  // list that prefers `1`/`2`/`3` shadows them without touching the tools.
  { chord: 'v', command: 'tools.set', args: { tool: 'select' } },
  { chord: 'escape', command: 'tools.set', args: { tool: 'select' }, when: toolKeys.tool.is('select').not() },
  // Already in Select, Escape lets go of what is selected: the stage's selection pill says so beside it.
  { chord: 'escape', command: 'selection.select', args: { selection: null }, when: and(toolKeys.tool.is('select'), viewKeys.hasSelection.is(true)) },
  { chord: 't', command: 'tools.set', args: { tool: 'terrain' } },
  { chord: 'o', command: 'tools.set', args: { tool: 'object' } },



  { chord: 'g', command: 'view.set', args: { gameCamera: true }, when: viewKeys.gameCamera.is(false) },
  { chord: 'g', command: 'view.set', args: { gameCamera: false }, when: viewKeys.gameCamera.is(true) },
  // The inspector folds to a strip and back: the backslash, as the reference art apps hide their panels with it.
  { chord: '\\', command: 'view.set', args: { inspectorCollapsed: true }, when: viewKeys.inspectorCollapsed.is(false) },
  { chord: '\\', command: 'view.set', args: { inspectorCollapsed: false }, when: viewKeys.inspectorCollapsed.is(true) },

  // No `when` on either: `hostKeys.mode` already gates the commands, and the
  // resolver ANDs a command's own availability into the binding's condition.
  { chord: 'p', command: 'mode.play' },
  { chord: 'p', command: 'mode.edit' },

  { chord: 'delete', command: 'selection.delete' },
  { chord: 'backspace', command: 'selection.delete' },

  // The arrows nudge the selection a cell along the world's axes (2026-09-12
  // ruling, "Select tool"); `selection.nudge` gates itself on having one.
  { chord: 'arrowleft', command: 'selection.nudge', args: { dx: -1, dz: 0 } },
  { chord: 'arrowright', command: 'selection.nudge', args: { dx: 1, dz: 0 } },
  { chord: 'arrowup', command: 'selection.nudge', args: { dx: 0, dz: -1 } },
  { chord: 'arrowdown', command: 'selection.nudge', args: { dx: 0, dz: 1 } },
  // Up and down a layer, for the one kind of selection that has a height to change: a region of voxels.
  { chord: 'pageup', command: 'selection.nudge', args: { dx: 0, dz: 0, dy: 1 } },
  { chord: 'pagedown', command: 'selection.nudge', args: { dx: 0, dz: 0, dy: -1 } },
]

for (const binding of CORE_BINDINGS) keymap.declare(CORE_KEYMAP_OWNER, { ...binding, weight: 'core' })
