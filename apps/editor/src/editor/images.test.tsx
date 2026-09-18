// @vitest-environment jsdom
/**
 * The image library's dialogs, under a real renderer.
 *
 * The layout model and the template generator are covered where they live, in
 * `@papercut/geometry`, and their round trip through a folder in
 * `@papercut/project`. What neither of those exercises is the SECTION: that
 * the template dialog renders, that its arithmetic reaches the artist before
 * anything is written, and that naming two terrains the same is refused
 * rather than written and then discovered.
 *
 * jsdom for the reason `react-glue.test.tsx` next door uses it: this is a
 * component, and what is under test is what it puts on screen.
 */

import { createDocument, createMap } from '@papercut/document'
import { HostProvider, createHost, type Host } from '@papercut/editor-host'
import { MemoryFs, createProjectFolder, rawImageCodec } from '@papercut/project'
import { UiProvider } from '@papercut/ui'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { features } from '../features'

import { ImagesSettings } from './images'
import { LibraryStore, SummaryStore, type Session } from './session'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no media queries and no resize observer; Mantine asks for both.
window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false })) as unknown as typeof window.matchMedia
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver

const started: Array<{ host: Host; root: Root; container: HTMLElement }> = []

afterEach(() => {
  for (const { host, root, container } of started.splice(0)) {
    act(() => root.unmount())
    container.remove()
    host.stop()
  }
})

function session(fs: MemoryFs): Session {
  return { fs, codec: rawImageCodec, dialogs: null, menu: null, lastWriteAt: 0, persistFailure: null, summaries: new SummaryStore(), library: new LibraryStore() }
}

function mount(ui: (host: Host) => ReactNode): { host: Host; container: HTMLElement } {
  const host = createHost({ document: createDocument(createMap(8, 8)), features })
  const container = window.document.createElement('div')
  window.document.body.append(container)
  const root = createRoot(container)
  started.push({ host, root, container })
  act(() => root.render(<UiProvider><HostProvider host={host}>{ui(host)}</HostProvider></UiProvider>))
  return { host, container }
}

const text = (): string => window.document.body.textContent ?? ''
const button = (label: string): HTMLButtonElement | undefined => [...window.document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(label))

describe('the image library', () => {
  it('offers a template, and says what the layout comes to before anything is written', async () => {
    const fs = new MemoryFs()
    await createProjectFolder(fs, '/p', { name: 'P', texelDensity: 16, placeholder: { set: { sheet: 'ground.png', tile: 16, columns: 1, rows: 1, tiles: new Map() }, image: { width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4) } } }, rawImageCodec)
    const live = session(fs)
    mount(() => <ImagesSettings session={live} sets={[]} warning={null} selected={null} onSelect={() => undefined} />)

    // The library offers a template beside the import.
    const open = button('New from template…')
    expect(open).toBeDefined()
    act(() => open?.click())

    // The dialog says what the sheet will be, from the convention and how many materials are picked,
    // before it is drawn. It starts on the first two of the project's library.
    expect(text()).toContain('New tileset from a template')
    // Two materials plus nothing: C(3,2) pair blocks of 5 x 3 and C(3,3) of 6 x 6, so 11 x 9 tiles at 16 px.
    expect(text()).toContain('11 × 9 tiles')
    expect(text()).toContain('176 × 144 px')

    // Picking a third grows it, and the arithmetic follows: three materials plus nothing is
    // C(4,3) = 4 triple blocks of six rows, which outgrows the C(4,2) = 6 pair blocks of three.
    act(() => button('Stone')?.click())
    expect(text()).toContain('11 × 24 tiles')
  })

  it('lays the blocks out in the order the materials were picked, not the library order', async () => {
    const fs = new MemoryFs()
    await createProjectFolder(fs, '/p', { name: 'P', texelDensity: 16, placeholder: { set: { sheet: 'ground.png', tile: 16, columns: 1, rows: 1, tiles: new Map() }, image: { width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4) } } }, rawImageCodec)
    const live = session(fs)
    mount(() => <ImagesSettings session={live} sets={[]} warning={null} selected={null} onSelect={() => undefined} />)
    act(() => button('New from template…')?.click())

    // Grass and Dirt are picked to start, so Path joins them third. The order is what a block's
    // position on the sheet is derived from, so the dialog has to show it rather than sort it away.
    act(() => button('Path')?.click())
    const order = [...window.document.querySelectorAll('.ui-tagger-item.is-active')].map((row) => (row.textContent ?? '').trim())
    expect(order).toEqual(['Grass1', 'Dirt2', 'Path3'])
  })

  it('refuses a template with nothing to lay out, rather than writing an empty sheet', async () => {
    const fs = new MemoryFs()
    await createProjectFolder(fs, '/p', { name: 'P', texelDensity: 16, placeholder: { set: { sheet: 'ground.png', tile: 16, columns: 1, rows: 1, tiles: new Map() }, image: { width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4) } } }, rawImageCodec)
    const live = session(fs)
    mount(() => <ImagesSettings session={live} sets={[]} warning={null} selected={null} onSelect={() => undefined} />)
    act(() => button('New from template…')?.click())

    // Two materials naming the same terrain used to be the thing to catch here. Materials have ids,
    // so that cannot happen; what can is picking none, which would draw a sheet with no blocks.
    act(() => button('Grass')?.click())
    act(() => button('Dirt')?.click())
    expect(text()).toContain('Pick at least one material to lay out')
    expect((button('Draw the template') as HTMLButtonElement).disabled).toBe(true)
  })
})
