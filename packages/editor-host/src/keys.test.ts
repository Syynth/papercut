import { commands, keymap, parseChords, resolve, validateArgs, type Chord, type KeyBinding } from '@papercut/registry'
import { describe, expect, it } from 'vitest'

import { createHost, type Host } from './host'
import { createDocument, createMap } from '@papercut/document'

// Importing the module is what declares the defaults, and the barrel is what
// an app reaches them through.
import { CORE_KEYMAP_OWNER } from './keys'

/**
 * The default keymap is data, so what can be checked about it is: does every
 * binding name a command that exists, do its arguments satisfy that command's
 * schema, and does the resolver reach the right one in the right state. The
 * arguments matter most — a binding is the one caller whose arguments nobody
 * typed, since `KeyBinding.args` is `unknown` by design (a preferences file
 * holds the same field).
 */
function host(): Host {
  return createHost({ document: createDocument(createMap(8, 8)) })
}

const press = (spec: string): Chord => parseChords(spec, 'other')[0]

function hit(live: Host, spec: string) {
  return resolve({ bindings: keymap.all(), snapshot: live.contextKeys(), platform: 'other' }, [], press(spec))
}

const core = (): readonly KeyBinding[] => keymap.all().filter((binding) => binding.weight === 'core')

describe('the default keymap', () => {
  it('is declared under one reserved owner and cannot be disposed by accident', () => {
    expect(CORE_KEYMAP_OWNER).toBe('core-keymap')
    expect(core().length).toBeGreaterThan(0)
  })

  it('binds only commands that exist, with arguments those commands accept', () => {
    for (const binding of core()) {
      const declaration = binding.command === null ? undefined : commands.get(binding.command)
      expect(declaration, `${binding.chord} binds "${binding.command ?? 'nothing'}", which nobody declared`).toBeDefined()
      if (!declaration) continue
      const validated = validateArgs(declaration, binding.args)
      expect(validated.ok, `${binding.chord} → ${declaration.id}: ${JSON.stringify(validated)}`).toBe(true)
    }
  })

  it('resolves every chord the old keydown handler carried', () => {
    const live = host()
    // The rail's subjects on the letters the reference apps use; Escape only
    // resolves when there is a tool to return from.
    expect(hit(live, 'escape')).toEqual({ kind: 'none' })
    expect(hit(live, 't')).toMatchObject({ command: 'tools.set', args: { tool: 'terrain' } })
    expect(hit(live, 'o')).toMatchObject({ command: 'tools.set', args: { tool: 'object' } })
    expect(hit(live, 'v')).toMatchObject({ command: 'tools.set', args: { tool: 'select' } })
    // `object` rather than `terrain`: no feature is installed here, so `terrain` is a tool nobody declared and the switch is refused.
    live.dispatch('tools.set', { tool: 'object' })
    expect(hit(live, 'escape')).toMatchObject({ command: 'tools.set', args: { tool: 'select' } })
    // `[`, `]` and Tab are the terrain feature's bindings now, pinned where the feature is installed (apps/editor).
    live.stop()
  })

  it('binds undo and redo on ctrl AND meta, as the old handler accepted both', () => {
    const live = host()
    // Nothing to undo yet, so the command's own `when` is false and both
    // chords fall through — which is the fall-through rule visible on the
    // editor's own bindings rather than a fixture's.
    expect(hit(live, 'ctrl+z')).toEqual({ kind: 'none' })

    // The layer-1 voxel of cell 0 on the 8×8 fixture, air until now: one shape patch stands the column a cube taller.
    live.children.document.send({ type: 'patch', label: 'Raise', patches: [{ t: 'voxel', id: 'ground', field: 'shape', index: 64, value: 0 }] })

    expect(hit(live, 'ctrl+z')).toMatchObject({ command: 'undo' })
    expect(hit(live, 'meta+z')).toMatchObject({ command: 'undo' })
    // Shift is a different chord, not a flag the undo binding reads: with
    // nothing to redo it falls through, and only after an undo does it land.
    expect(hit(live, 'ctrl+shift+z')).toEqual({ kind: 'none' })
    live.dispatch('undo')
    expect(hit(live, 'ctrl+shift+z')).toMatchObject({ command: 'redo' })
    expect(hit(live, 'meta+shift+z')).toMatchObject({ command: 'redo' })
    live.stop()
  })

  it('toggles with two bindings on one chord, gated on the value each flips away from', () => {
    const live = host()
    // P: neither binding carries a `when`; the commands' own availability is
    // what the resolver ANDs in.
    expect(hit(live, 'p')).toMatchObject({ command: 'mode.play' })
    live.dispatch('mode.play')
    expect(hit(live, 'p')).toMatchObject({ command: 'mode.edit' })
    live.dispatch('mode.edit')

    // G carries its own `when`, because `view.set` takes any value at any time and cannot gate itself.
    expect(hit(live, 'g')).toMatchObject({ command: 'view.set', args: { gameCamera: true } })
    live.dispatch('view.set', { gameCamera: true })
    expect(hit(live, 'g')).toMatchObject({ command: 'view.set', args: { gameCamera: false } })
    live.stop()
  })

  it('leaves Delete alone until something is selected', () => {
    const live = host()
    expect(hit(live, 'delete')).toEqual({ kind: 'none' })
    expect(hit(live, 'backspace')).toEqual({ kind: 'none' })

    live.dispatch('selection.set', { id: 'obj-1' })
    expect(hit(live, 'delete')).toMatchObject({ command: 'selection.delete' })
    expect(hit(live, 'backspace')).toMatchObject({ command: 'selection.delete' })
    live.stop()
  })

  it('reports a chord beside a command, for a menu to print', () => {
    expect(keymap.bindingFor('undo')?.chord).toBe('meta+z')
    expect(keymap.bindingFor('selection.delete')?.chord).toBe('backspace')
    expect(keymap.bindingFor('nothing.is.bound.to.this')).toBeUndefined()
  })
})
