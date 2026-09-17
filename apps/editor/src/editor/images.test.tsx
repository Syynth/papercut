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
    await createProjectFolder(fs, '/p', { name: 'P', texelDensity: 16, placeholder: { set: { sheet: 'ground.png', tile: 16, columns: 1, rows: 1, terrains: [], tiles: new Map() }, image: { width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4) } } }, rawImageCodec)
    const live = session(fs)
    mount(() => <ImagesSettings session={live} sets={[]} warning={null} selected={null} onSelect={() => undefined} />)

    // The library offers a template beside the import.
    const open = button('New from template…')
    expect(open).toBeDefined()
    act(() => open?.click())

    // The dialog says what the sheet will be, from the convention and the terrain count, before it is drawn.
    expect(text()).toContain('New tileset from a template')
    // Two terrains plus nothing: C(3,2) pair blocks of 5 x 3 and C(3,3) of 6 x 6, so 11 x 9 tiles at 16 px.
    expect(text()).toContain('11 × 9 tiles')
    expect(text()).toContain('176 × 144 px')

    // Adding a terrain grows it, and the arithmetic follows: three terrains plus nothing is
    // C(4,3) = 4 triple blocks of six rows, which outgrows the C(4,2) = 6 pair blocks of three.
    act(() => button('Add terrain')?.click())
    expect(text()).toContain('11 × 24 tiles')
  })

  it('refuses two terrains that would share an id, rather than writing a sheet and finding out', async () => {
    const fs = new MemoryFs()
    await createProjectFolder(fs, '/p', { name: 'P', texelDensity: 16, placeholder: { set: { sheet: 'ground.png', tile: 16, columns: 1, rows: 1, terrains: [], tiles: new Map() }, image: { width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4) } } }, rawImageCodec)
    const live = session(fs)
    mount(() => <ImagesSettings session={live} sets={[]} warning={null} selected={null} onSelect={() => undefined} />)
    act(() => button('New from template…')?.click())

    const fields = [...window.document.querySelectorAll('input')]
    const second = fields.find((f) => (f as HTMLInputElement).value === 'Sand') as HTMLInputElement | undefined
    expect(second).toBeDefined()
    act(() => {
      // React's own setter, so the change event the component listens for is the one it gets.
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(second, 'Grass')
      second?.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    expect(text()).toContain('Two terrains would have the same id')
    expect((button('Draw the template') as HTMLButtonElement).disabled).toBe(true)
  })
})
