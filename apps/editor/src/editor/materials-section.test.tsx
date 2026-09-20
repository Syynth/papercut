// @vitest-environment jsdom
/**
 * The Materials section, under a real renderer (decisions of 2026-09-19).
 *
 * What the tags amount to is covered where it is computed, in `coverage.ts`.
 * What only the SCREEN can show is that the list is the project's materials
 * with their coverage, that the selected one expands into its subjects, that
 * picking one swaps every view to it, that the tiles and the patch point at
 * each other, and that a transition is spelled from the subject.
 *
 * jsdom has no 2D canvas, so `getContext` and `toDataURL` are stubbed: the
 * patch's pixels are not what is under test, its arithmetic is.
 */

import { createDocument, createMap } from '@papercut/document'
import { HostProvider, createHost, type Host } from '@papercut/editor-host'
import { tagOf } from '@papercut/document'
import { templateTags, type CornerTags, type LoadedSet } from '@papercut/geometry'
import { DecodedImageCache, MemoryFs, rawImageCodec } from '@papercut/project'
import { UiProvider } from '@papercut/ui'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { features } from '../features'

// The 3D fixture is a WebGL scene with generated sprites, neither of which jsdom can stand up; which view the section
// chooses is what these tests are about, not what the fixture draws.
vi.mock('./fixture-view', () => ({ Fixture: () => null }))

import { run } from './commands'
import { MaterialsSection } from './materials-section'
import { LibraryStore, StrayStore, SummaryStore, type Session } from './session'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no media queries and no resize observer; Mantine asks for both.
window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false })) as unknown as typeof window.matchMedia
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver

// jsdom has no canvas at all; the screen draws to one, so give it a surface that answers.
const context = new Proxy({} as CanvasRenderingContext2D, { get: () => () => undefined, set: () => true })
window.HTMLCanvasElement.prototype.getContext = (() => context) as unknown as HTMLCanvasElement['getContext']
window.HTMLCanvasElement.prototype.toDataURL = () => 'data:,'
globalThis.ImageData ??= class {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
} as unknown as typeof ImageData

const started: Array<{ host: Host; root: Root; container: HTMLElement }> = []

afterEach(() => {
  for (const { host, root, container } of started.splice(0)) {
    act(() => root.unmount())
    container.remove()
    host.stop()
  }
})

function session(): Session {
  return { fs: new MemoryFs(), codec: rawImageCodec, images: new DecodedImageCache(), dialogs: null, menu: null, lastWriteAt: 0, persistFailure: null, summaries: new SummaryStore(), library: new LibraryStore(), strays: new StrayStore() }
}

/**
 * A sheet that has drawn something: for each pair given, the fifteen
 * arrangements of the first material over the second, tagged with material
 * ids. `null` as the second is the material on its own against nothing.
 */
function sheet(name: string, drawn: ReadonlyArray<readonly [number, number | null]>): LoadedSet {
  const tile = 4
  const columns = 15
  const rows = Math.max(1, drawn.length)
  const tiles = new Map<number, CornerTags>()
  drawn.forEach(([over, under], row) => {
    for (let mask = 1; mask <= 15; mask++) tiles.set(row * columns + (mask - 1), templateTags(mask, under === null ? null : tagOf(under), tagOf(over)))
  })
  const width = columns * tile
  const height = rows * tile
  return { set: { sheet: name, tile, columns, rows, tiles }, image: { width, height, data: new Uint8ClampedArray(width * height * 4) } }
}

/** Grass alone and grass over dirt, both on one sheet: the ordinary case. */
const ground = (drawn: ReadonlyArray<readonly [number, number | null]>): LoadedSet[] => [sheet('ground.png', drawn)]

/** The same art spread over two sheets, every other tile on each: what the section shows as a grid of tiles rather than a crop of one sheet. */
function scattered(drawn: ReadonlyArray<readonly [number, number | null]>): LoadedSet[] {
  return [0, 1].map((parity) => {
    const whole = sheet(parity ? 'odd.png' : 'even.png', drawn)
    return { ...whole, set: { ...whole.set, tiles: new Map([...whole.set.tiles].filter(([index]) => index % 2 === parity)) } }
  })
}

function mount(ui: (host: Host) => ReactNode): HTMLElement {
  const host = createHost({ document: createDocument(createMap(8, 8)), features })
  const container = window.document.createElement('div')
  window.document.body.append(container)
  const root = createRoot(container)
  started.push({ host, root, container })
  act(() => root.render(<UiProvider><HostProvider host={host}>{ui(host)}</HostProvider></UiProvider>))
  return container
}

const text = (): string => window.document.body.textContent ?? ''
const named = (label: string): HTMLButtonElement | undefined => [...window.document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === label)
/** A subject under the selected material: `meets Dirt`. */
const subject = (label: string): HTMLButtonElement | undefined => [...window.document.querySelectorAll<HTMLButtonElement>('.ui-subject-row button')].find((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim().startsWith(label))
const section = (sets: readonly LoadedSet[], tagSets: readonly LoadedSet[] = sets) => () => <MaterialsSection session={session()} selected={0} onSelect={() => undefined} sets={sets} tagSets={tagSets} />

describe('the materials section', () => {
  it("lists the project's materials with their coverage, and the selected one's subjects under it", () => {
    // Grass (0) alone, and grass over dirt (1). Stone, Sand and Path have nothing drawn.
    mount(section(ground([[0, null], [0, 1]])))

    // No Floor / Wall / Ramp groups: a material is not one archetype (ruling of 2026-09-18).
    expect(text()).toContain('By priority')
    expect(window.document.querySelectorAll('.ui-material-row')).toHaveLength(5)
    expect(window.document.querySelector('.ui-material-row.is-active')?.textContent).toContain('15/15')

    // Grass expands into its subjects: on its own, then meeting each of the other four, and a way to spell a new one.
    expect(window.document.querySelectorAll('.ui-subject-row')).toHaveLength(5)
    expect(subject('meets Dirt')?.closest('.ui-subject-row')?.textContent).toContain('14/14')
    expect(subject('meets Stone')?.closest('.ui-subject-row')?.textContent).toContain('0/14')
    expect(named('New transition…')).toBeDefined()
  })

  it('takes an authored tile from another sheet', () => {
    // Grass's own art is on one image and its meeting with Dirt on a second.
    mount(section([sheet('ground.png', [[0, null]]), sheet('cliffs.png', [[0, 1]])]))
    act(() => subject('meets Dirt')?.click())
    // Fourteen, not fifteen: the all-grass arrangement is grass's own tile, not something the pairing owes.
    expect(text()).toContain('14 of 14 drawn')
    expect(text()).toContain('cliffs.png')
  })

  it('swaps every view to the two materials together when a pairing is picked, and back', () => {
    mount(section(ground([[0, null], [0, 1]])))
    expect(text()).toContain('how it draws on any face')
    act(() => subject('meets Dirt')?.click())
    expect(text()).toContain('how the two draw where they meet')
    expect(text()).toContain('Meeting Dirt')
    act(() => subject('On its own')?.click())
    expect(text()).toContain('how it draws on any face')
  })

  it('takes the archetype in the bar as the context, and offers only its slots on the stage', () => {
    mount(section(ground([[0, null]])))
    const radio = (value: string): HTMLInputElement | undefined => [...window.document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((r) => r.value === value)
    const slots = (): string[] => [...(window.document.querySelector<HTMLSelectElement>('.ui-stage-float select')?.options ?? [])].map((o) => (o.textContent ?? '').replace(/^Slot: /, '').split(' — ')[0])
    act(() => radio('tag')?.click())
    // Any offers what every archetype has; the form no longer has a Slot or a For field.
    expect(slots()).toEqual(['Surface', 'Fringe', 'Picket'])
    expect(text()).toContain('for any face')
    expect(window.document.querySelector('.ui-library-form')?.textContent).not.toContain('Slot')

    act(() => radio('wall')?.click())
    expect(slots()).toEqual(['Surface', 'Convex seam', 'Concave seam', 'Fringe', 'Picket'])
    expect(text()).toContain('for walls')
    // Tagging is left where it is: the context changes what the sheet lights and the brush writes, not the view.
    expect(radio('tag')?.checked).toBe(true)
    // The small preview rides along, and starts on its 3D side for a wall.
    expect(window.document.querySelector('.ui-stage-panel')).not.toBeNull()
    expect([...window.document.querySelectorAll<HTMLInputElement>('.ui-stage-panel input[type="radio"]')].some((r) => r.value === '3d' && r.checked)).toBe(true)
  })

  it("offers a direction beside the slot where a face has one, as many as the material's art is drawn for", () => {
    mount(section(ground([[0, null]])))
    const { host } = started[started.length - 1]
    const radio = (value: string): HTMLInputElement | undefined => [...window.document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((r) => r.value === value)
    const pickers = (): HTMLSelectElement[] => [...window.document.querySelectorAll<HTMLSelectElement>('.ui-stage-float select')]
    const directions = (): string[] => [...(pickers()[1]?.options ?? [])].map((o) => (o.textContent ?? '').replace(/^Direction: /, '').split(',')[0])
    act(() => radio('tag')?.click())
    // A floor has no direction the map asks art for, so there is a slot picker and nothing beside it.
    act(() => radio('floor')?.click())
    expect(pickers()).toHaveLength(1)

    act(() => radio('ramp')?.click())
    expect(directions()).toEqual(['any', 'runs south'])

    // The material says its ramp art is drawn for four directions: per archetype, so its walls and floors say nothing.
    const field = [...window.document.querySelectorAll<HTMLSelectElement>('.ui-library-form select')].find((el) => [...el.options].some((o) => o.value === '4'))
    act(() => {
      if (field) {
        field.value = '4'
        field.dispatchEvent(new window.Event('change', { bubbles: true }))
      }
    })
    expect(host.children.project.getSnapshot().context.project.materials[0].directions).toEqual({ ramp: 4 })
    expect(directions()).toEqual(['any', 'runs north', 'runs east', 'runs south', 'runs west'])
    expect(text()).toContain('all 4 directions')
  })

  it('opens walls and ramps in 3D, and floors flat', () => {
    mount(section(ground([[0, null]])))
    const radio = (label: string): HTMLInputElement | undefined => [...window.document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((r) => r.parentElement?.textContent?.trim() === label || r.value === label)
    const checked = (value: string): boolean => [...window.document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].some((r) => r.value === value && r.checked)
    expect(checked('preview')).toBe(true)
    act(() => radio('wall')?.click())
    expect(checked('3d')).toBe(true)
    // Picking another subject keeps the wall's view rather than dropping back to the flat patch.
    act(() => subject('meets Dirt')?.click())
    expect(checked('3d')).toBe(true)
    act(() => radio('floor')?.click())
    expect(checked('preview')).toBe(true)
  })

  it('lights an arrangement from a tile and says how much of the patch it draws', () => {
    // The tiles are spread over two sheets, so they are shown as a grid of tiles rather than as a crop of one.
    mount(section(scattered([[0, null]])))

    const slots = [...window.document.querySelectorAll('.ui-slot')]
    expect(slots).toHaveLength(15)
    // Every one of the fifteen corner masks is somewhere in the preview shape, so hovering any of them names it and
    // counts the corners of the patch it draws.
    for (const [index, slot] of slots.entries()) {
      act(() => slot.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true })))
      expect(slot.className).toContain('is-lit')
      expect(text()).toContain(`mask ${index + 1} ·`)
      expect(Number(/· (\d+) corners? of the patch/.exec(text())?.[1] ?? 0)).toBeGreaterThan(0)
    }
  })

  it('lights only the corners of the pairing, not where the material meets nothing', () => {
    mount(section(scattered([[0, null], [0, 1]])))
    act(() => subject('meets Dirt')?.click())

    // Worked out from the pairing's preview shape by hand. Counting only which corners are Grass made the outer edge
    // of the blob, where Grass meets nothing, answer the same mask as the boundary with Dirt.
    const expected: Record<number, number> = { 1: 1, 2: 1, 3: 4, 4: 2, 5: 1, 6: 1, 7: 3, 8: 2, 9: 1, 10: 1, 11: 3, 12: 2, 13: 4, 14: 4 }
    const slots = [...window.document.querySelectorAll('.ui-slot')]
    expect(slots).toHaveLength(14)
    for (const slot of slots) {
      act(() => slot.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true })))
      const mask = Number(/mask (\d+) ·/.exec(text())?.[1])
      expect(Number(/· (\d+) corners? of the patch/.exec(text())?.[1])).toBe(expected[mask])
    }
  })

  it('enters a placing mode from New transition…, spelled from the subject, and leaves it on Done or Esc', () => {
    mount(section(ground([[0, null]])))
    act(() => subject('meets Stone')?.click())
    expect(window.document.querySelector('.ui-stage-toolbar')).toBeNull()
    act(() => named('New transition…')?.click())

    // A toolbar on the Tag stage, not a dialog: the values of the transition, Grass first in the library so Stone is over it.
    const toolbar = window.document.querySelector('.ui-stage-toolbar')
    expect(toolbar).not.toBeNull()
    expect(window.document.querySelector('[role="dialog"]')).toBeNull()
    const values = (): Array<string | null | undefined> => [...window.document.querySelectorAll<HTMLSelectElement>('.ui-stage-toolbar select')].map((s) => s.selectedOptions[0]?.textContent)
    expect(values()).toEqual(['Grass', 'Stone', 'none'])
    expect(toolbar?.textContent).toContain('for any face')
    expect(toolbar?.textContent).toContain('5 × 3')
    // The form says the mode is on, and offers no tool to switch to while it is.
    expect(text()).toContain('Placing a transition')
    expect(text()).not.toContain('Tag corners')

    // Picking another subject while placing spells the next transition without leaving the mode.
    act(() => subject('meets Dirt')?.click())
    expect(values().slice(0, 2)).toEqual(['Grass', 'Dirt'])
    expect(window.document.querySelector('.ui-stage-toolbar')).not.toBeNull()

    act(() => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })))
    expect(window.document.querySelector('.ui-stage-toolbar')).toBeNull()
    expect(text()).toContain('Tag corners')

    act(() => named('New transition…')?.click())
    act(() => [...window.document.querySelectorAll<HTMLButtonElement>('.ui-stage-toolbar button')].find((b) => (b.textContent ?? '').startsWith('Done'))?.click())
    expect(window.document.querySelector('.ui-stage-toolbar')).toBeNull()
  })

  it('keeps the list and New material when the library is empty', () => {
    mount(section(ground([[0, null]])))
    const { host } = started[started.length - 1]
    act(() => void run(host, 'project.materials.set', { materials: [] }))
    expect(text()).toContain('No materials')
    act(() => named('New material')?.click())
    expect(host.children.project.getSnapshot().context.project.materials).toHaveLength(1)
  })
})
