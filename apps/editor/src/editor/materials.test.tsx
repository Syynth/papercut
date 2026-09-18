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
import { tagOf } from '@papercut/document'
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
  it("reports a material's art against the fifteen arrangements, and groups Meets by archetype", () => {
    // Grass (0) alone, and grass over dirt (1). Stone, Sand and Path have nothing drawn.
    const sets = ground([
      [0, null],
      [0, 1],
    ])
    mount(() => <MaterialsSettings session={session()} selected={0} onSelect={() => undefined} sets={sets} />)

    expect(text()).toContain('15 of 15 arrangements drawn')

    // Meets is grouped by the archetype each pairing is drawn on, and every archetype has a heading.
    expect(text()).toContain('Floor')
    expect(text()).toContain('Wall')
    expect(text()).toContain('Ramp')

    // Grass has drawn its meeting with Dirt and nothing else.
    expect(inMeets('Dirt')).toBeDefined()
    expect(text()).toContain('drawn')
    expect(text()).toContain('composites')
  })

  it('takes an authored tile from another sheet, which is what the terrain layer used to prevent', () => {
    // Grass's own art is on one image and its meeting with Dirt on a second. Before a tag named a
    // material, an authored tile only counted when every terrain at the corner was on ONE image, so
    // this pairing could never resolve and always composited. Nothing about that was a decision.
    const sets = [sheet('ground.png', [[0, null]]), sheet('cliffs.png', [[0, 1]])]
    mount(() => <MaterialsSettings session={session()} selected={0} onSelect={() => undefined} sets={sets} />)

    act(() => inMeets('Dirt')?.click())
    // Fourteen, not fifteen: the all-grass arrangement is grass's own tile, not something the pairing owes.
    expect(text()).toContain('14 of 14 arrangements drawn')
    expect(text()).toContain('cliffs.png')
  })

  it("keeps the cliff material editable, because the mesher still draws vertical faces with it", () => {
    const sets = ground([[0, null]])
    mount(() => <MaterialsSettings session={session()} selected={0} onSelect={() => undefined} sets={sets} />)

    // Grass ships cutting its cliffs with Dirt, and the look reads that for every vertical face, so
    // a screen with no control for it strands live data.
    expect(text()).toContain('Cliffs')
    const options = [...window.document.querySelectorAll('select')].flatMap((s) => [...s.options].map((o) => o.label))
    expect(options).toContain('Made of this one')
  })

  it('lights an arrangement from the strip and says how much of the patch it draws', () => {
    const sets = ground([[0, null]])
    mount(() => <MaterialsSettings session={session()} selected={0} onSelect={() => undefined} sets={sets} />)

    const slots = [...window.document.querySelectorAll('.ui-slot')]
    expect(slots).toHaveLength(15)

    // Every one of the fifteen corner masks is somewhere in the preview shape, so hovering any of
    // them names it and counts the corners of the patch it draws.
    for (const [index, slot] of slots.entries()) {
      act(() => slot.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true })))
      expect(slot.className).toContain('is-lit')
      const count = /· (\d+) corners? of the patch/.exec(text())
      expect(text()).toContain(`mask ${index + 1} ·`)
      expect(Number(count?.[1] ?? 0)).toBeGreaterThan(0)
    }
  })

  it('lights only the corners of the pairing, not where the material meets nothing', () => {
    const sets = ground([
      [0, null],
      [0, 1],
    ])
    mount(() => <MaterialsSettings session={session()} selected={0} onSelect={() => undefined} sets={sets} />)
    act(() => inMeets('Dirt')?.click())

    // Worked out from the pairing's preview shape by hand. Counting only which corners are Grass
    // made the outer edge of the blob, where Grass meets nothing, answer the same mask as the
    // boundary with Dirt: mask 3 lit ten corners where four are Grass meeting Dirt.
    const expected: Record<number, number> = { 1: 1, 2: 1, 3: 4, 4: 2, 5: 1, 6: 1, 7: 3, 8: 2, 9: 1, 10: 1, 11: 3, 12: 2, 13: 4, 14: 4 }
    const slots = [...window.document.querySelectorAll('.ui-slot')]
    expect(slots).toHaveLength(14)
    for (const slot of slots) {
      act(() => slot.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true })))
      const mask = Number(/mask (\d+) ·/.exec(text())?.[1])
      const count = Number(/· (\d+) corners? of the patch/.exec(text())?.[1])
      expect(count).toBe(expected[mask])
    }
  })

  it('swaps the preview to the two materials together when a pairing is picked', () => {
    const sets = ground([
      [0, null],
      [0, 1],
    ])
    mount(() => <MaterialsSettings session={session()} selected={0} onSelect={() => undefined} sets={sets} />)

    expect(text()).not.toContain('meets')
    act(() => inMeets('Dirt')?.click())

    expect(text()).toContain('meets')
    expect(text()).toContain('how the two draw where they meet')
    expect(text()).toContain('14 of 14 arrangements drawn')

    act(() => named('Back to the material')?.click())
    expect(text()).toContain('how it draws')
  })

  it('says what a wall archetype adds beyond the corner model, and does not pretend to author it', () => {
    const sets = ground([[0, null]])
    mount(() => <MaterialsSettings session={session()} selected={0} onSelect={() => undefined} sets={sets} />)

    // Stone is the one wall in the default library. Its extra parts are the two seams, which are
    // the cases no arrangement of four coplanar corners can express.
    act(() => inMeets('Stone')?.click())
    expect(text()).toContain('Convex seam')
    expect(text()).toContain('Concave seam')
    expect(text()).toContain('Nothing authors these yet')
  })
})
