// @vitest-environment jsdom
/**
 * The Materials screen, under a real renderer.
 *
 * What the archetype vocabularies and the assembled patch come to is covered
 * where they live, in `@papercut/geometry`. What only the SCREEN can show is
 * that a material's art is reported against its own archetype's slots, that
 * Meets is grouped by the archetype each pairing is drawn in, and that
 * picking a pairing swaps the preview to the two materials together.
 *
 * jsdom has no 2D canvas, so `getContext` and `toDataURL` are stubbed: the
 * patch's pixels are not what is under test, its arithmetic is.
 */

import { createDocument, createMap } from '@papercut/document'
import { HostProvider, createHost, type Host } from '@papercut/editor-host'
import { templateTags, type CornerTags, type LoadedSet } from '@papercut/geometry'
import { MemoryFs, rawImageCodec } from '@papercut/project'
import { UiProvider } from '@papercut/ui'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { features } from '../features'

import { MaterialsSettings } from './materials'
import { LibraryStore, SummaryStore, type Session } from './session'

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
  return { fs: new MemoryFs(), codec: rawImageCodec, dialogs: null, menu: null, lastWriteAt: 0, persistFailure: null, summaries: new SummaryStore(), library: new LibraryStore() }
}

/**
 * The placeholder sheet as a set that has drawn something: grass alone, and
 * grass over dirt, but nothing for stone — so the screen has one pairing that
 * is finished and several that are not.
 */
function ground(drawn: ReadonlyArray<readonly [string, string | null]>): LoadedSet {
  const tile = 4
  const columns = 15
  const rows = drawn.length
  const tiles = new Map<number, CornerTags>()
  drawn.forEach(([over, under], row) => {
    for (let mask = 1; mask <= 15; mask++) tiles.set(row * columns + (mask - 1), templateTags(mask, under, over))
  })
  const width = columns * tile
  const height = rows * tile
  return { set: { sheet: 'ground.png', tile, columns, rows, terrains: [], tiles }, image: { width, height, data: new Uint8ClampedArray(width * height * 4) } }
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
/** The same, but only in the form column — where Meets is, so a name in the side list is not what is clicked. */
const inMeets = (label: string): HTMLButtonElement | undefined => [...(window.document.querySelector('.ui-library-form')?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').trim() === label)

describe('the materials screen', () => {
  it("reports a material's art against its own archetype's slots, and groups Meets by archetype", () => {
    const sets = [ground([['grass', null], ['grass', 'dirt']])]
    mount(() => <MaterialsSettings session={session()} selected={0} onSelect={() => undefined} sets={sets} />)

    // Grass is a floor, so it owes the fifteen corner masks and has drawn all of them.
    expect(text()).toContain('15 slots · 15 of 15 drawn')

    // Meets is grouped by the archetype each pairing is drawn in, and every
    // archetype's heading says what it owes even when nothing meets there.
    expect(text()).toContain('Floor · 15 slots')
    expect(text()).toContain('Wall · 7 slots')
    expect(text()).toContain('Ramp · 4 slots')

    // Grass has drawn its meeting with Dirt and nothing else.
    expect(inMeets('Dirt')).toBeDefined()
    expect(text()).toContain('drawn')
    expect(text()).toContain('composites')
  })

  it('swaps the preview to the two materials together when a pairing is picked', () => {
    const sets = [ground([['grass', null], ['grass', 'dirt']])]
    mount(() => <MaterialsSettings session={session()} selected={0} onSelect={() => undefined} sets={sets} />)

    expect(text()).not.toContain('meets')
    act(() => inMeets('Dirt')?.click())

    // The header now reads as the pairing, and the patch is the two of them.
    expect(text()).toContain('meets')
    expect(text()).toContain('how the two draw where they meet')
    expect(text()).toContain('15 slots · 15 of 15 drawn')

    // And it goes back.
    act(() => named('Back to the material')?.click())
    expect(text()).toContain('how it draws')
  })

  it('lights a slot from the strip and says how much of the patch it draws', () => {
    const sets = [ground([['grass', null]])]
    mount(() => <MaterialsSettings session={session()} selected={0} onSelect={() => undefined} sets={sets} />)

    const slots = [...window.document.querySelectorAll('.ui-slot')]
    expect(slots).toHaveLength(15)

    // Every one of the fifteen corner masks is somewhere in the preview shape, so
    // hovering any slot names it and counts the corners of the patch it draws.
    for (const [index, slot] of slots.entries()) {
      act(() => slot.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true })))
      expect(slot.className).toContain('is-lit')
      const count = /· (\d+) corners? of the patch/.exec(text())
      expect(text()).toContain(`mask ${index + 1} ·`)
      expect(Number(count?.[1] ?? 0)).toBeGreaterThan(0)
    }

    // And the readout goes back to the summary when the pointer leaves the strip.
    act(() => window.document.querySelector('.ui-slots')?.parentElement?.dispatchEvent(new window.MouseEvent('pointerout', { bubbles: true })))
    expect(text()).toContain('15 slots · 15 of 15 drawn')
  })

  it('says a pairing drawn in a wall owes the wall vocabulary, not fifteen corners', () => {
    const sets = [ground([['grass', null]])]
    mount(() => <MaterialsSettings session={session()} selected={0} onSelect={() => undefined} sets={sets} />)

    // Stone is the one wall in the default library, so Grass meets it in the wall's seven slots.
    act(() => inMeets('Stone')?.click())
    expect(text()).toContain('7 slots')
    expect(text()).toContain('seams mitred when empty')
  })
})
