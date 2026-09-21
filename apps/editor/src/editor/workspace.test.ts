// @vitest-environment jsdom
/**
 * The workspace across a "reload": one host sets things, and a second host, installed afresh as a reloaded page would
 * install it, gets them back from what the first left in `localStorage`.
 */
import { createDocument, createMap, createProject, serializeProject } from '@papercut/document'
import { createHost, type Host } from '@papercut/editor-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { features } from '../features'
import * as workspace from './workspace'

const MAP = 'maps/a.map.json'

function session(): { host: Host; workspace: typeof workspace } {
  const host = createHost({ document: createDocument(createMap(8, 8)), features })
  workspace.installWorkspace(host)
  host.dispatch('project.load', { folder: '/projects/test', json: serializeProject(createProject('Test')) })
  host.dispatch('project.current', { map: MAP })
  return { host, workspace }
}

/** A page going away: what is pending is written, as `pagehide` has it. */
const leave = (): void => void window.dispatchEvent(new Event('pagehide'))

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('the workspace', () => {
  it('brings the tool, Select\'s settings and a feature\'s parameters back after a reload', () => {
    const first = session()
    first.host.dispatch('tools.set', { tool: 'select', selectMode: 'region', selectElement: 'edge', selectSize: 4, selectMatch: { edge: 'loop', face: 'material', voxel: 'column' } })
    first.host.dispatch('terrain.params', { strength: 5, sculptVerb: 'smooth' })
    vi.advanceTimersByTime(300)

    const second = session()
    const tools = second.host.children.tools.getSnapshot().context
    expect(tools).toMatchObject({ tool: 'select', selectMode: 'region', selectElement: 'edge', selectSize: 4, selectMatch: { edge: 'loop', face: 'material', voxel: 'column' } })
    expect(Object.values(tools.features).some((params) => params.strength === 5 && params.sculptVerb === 'smooth')).toBe(true)
  })

  it('is not put off by something that changes every frame: a write on its way lands', () => {
    const { host, workspace } = session()
    workspace.adoptMap(host, workspace.mapKeyOf(host) as string)
    host.dispatch('tools.set', { selectSize: 6 })
    // A camera reporting sixty times a second for a second, moving every time.
    for (let i = 0; i < 60; i++) {
      workspace.saveCamera(workspace.mapKeyOf(host) as string, { yaw: i, pitch: 30, distance: 20, target: [1, 2, 3] })
      vi.advanceTimersByTime(16)
    }
    expect(JSON.parse(localStorage.getItem('papercut:workspace') ?? '{}').tools.selectSize).toBe(6)
  })

  it('brings a map\'s camera, layer view and selection back, and lets go of what the map no longer has', () => {
    const first = session()
    const key = first.workspace.mapKeyOf(first.host) as string
    first.workspace.adoptMap(first.host, key)
    first.workspace.saveCamera(key, { yaw: 80, pitch: 25, distance: 12, target: [10, 1, 20] })
    first.host.dispatch('view.set', { layers: { lo: 0, hi: 6 } })
    first.host.dispatch('selection.select', { selection: { kind: 'region', structure: 'ground', element: 'voxel', keys: ['2,2,0', '99,99,9'] } })
    leave()

    const second = session()
    expect(second.workspace.savedCamera(key)).toEqual({ yaw: 80, pitch: 25, distance: 12, target: [10, 1, 20] })
    second.workspace.adoptMap(second.host, key)
    const view = second.host.children.view.getSnapshot().context
    expect(view.layers).toEqual({ lo: 0, hi: 6 })
    // The voxel that exists comes back; the one off the map is let go. And putting the layer view back did not write the selection over.
    expect(view.selection).toEqual({ kind: 'region', structure: 'ground', element: 'voxel', keys: ['2,2,0'] })
    expect(second.workspace.savedCamera('/projects/other::maps/b.map.json')).toBeNull()
  })

  it('drops a saved value a newer build no longer takes, alone', () => {
    localStorage.setItem('papercut:workspace', JSON.stringify({ tools: { selectSize: 9, selectElement: 'vertex', snap: 'half' }, features: {}, view: {}, maps: {} }))
    const { host } = session()
    expect(host.children.tools.getSnapshot().context).toMatchObject({ selectSize: 9, selectElement: 'voxel', snap: 'half' })
  })
})
