// @vitest-environment jsdom
/**
 * The session's data-loss paths, over the memory tree: what is written when,
 * and what is refused rather than half-opened.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { createDocument, createMap, deserialize, raise, type VoxelStructure } from '@papercut/document'
import { createHost, type Host } from '@papercut/editor-host'
import { generatePlaceholderTerrainSet } from '@papercut/fixtures'
import { MemoryFs, createProjectFolder, rawImageCodec } from '@papercut/project'

import { LibraryStore, SummaryStore, closeProject, createProjectAt, newMapIn, openMapAt, openProjectAt, recents, repaintAndDeleteMaterial, type Session } from './session'

function makeSession(): Session & { fs: MemoryFs } {
  return { fs: new MemoryFs(), codec: rawImageCodec, dialogs: null, menu: null, lastWriteAt: 0, persistFailure: null, summaries: new SummaryStore(), library: new LibraryStore() }
}

function makeHost(): Host {
  return createHost({ document: createDocument(createMap(2, 2, 'No map')) })
}

const location = (host: Host) => host.children.project.getSnapshot().context

beforeEach(() => localStorage.clear())

describe('opening a project', () => {
  it('creates, opens on the first map, and comes back to the map that was open there last', async () => {
    const host = makeHost()
    const session = makeSession()
    await createProjectAt(host, session, { folder: '/p/harbour', name: 'Harbour', texelDensity: 4 })
    expect(location(host)).toMatchObject({ folder: '/p/harbour', map: 'maps/harbour.map.json' })
    expect(host.reader.doc.name).toBe('Harbour')
    expect(recents().map((r) => r.folder)).toEqual(['/p/harbour'])
    expect(host.children.viewport.getSnapshot().context.loadedTerrain.map((s) => s.set.sheet)).toEqual(['ground.png'])

    await session.fs.writeFile('/p/harbour/maps/road.map.json', JSON.stringify(createMap(3, 3, 'Road')))
    host.dispatch('project.maps.set', { maps: ['maps/harbour.map.json', 'maps/road.map.json'] })
    await openMapAt(host, session, 'maps/road.map.json')
    expect(host.reader.doc.name).toBe('Road')
    await closeProject(host, session)
    expect(location(host).folder).toBeNull()
    await openProjectAt(host, session, '/p/harbour')
    expect(location(host).map).toBe('maps/road.map.json')
  })

  it('refuses a project whose map will not read, leaving nothing half-open, and keeps it in recents', async () => {
    const host = makeHost()
    const session = makeSession()
    await createProjectAt(host, session, { folder: '/p/bad', name: 'Bad', texelDensity: 4 })
    await closeProject(host, session)
    await session.fs.writeFile('/p/bad/maps/bad.map.json', '{ "not": "a map" }')
    await expect(openProjectAt(host, session, '/p/bad')).rejects.toThrow(/bad\.map\.json/)
    expect(location(host)).toMatchObject({ folder: null, map: null })
    expect(host.reader.doc.name).toBe('No map')
    expect(recents().map((r) => r.folder)).toEqual(['/p/bad'])
  })

  it('gives a project whose listed map is gone a fresh first map rather than refusing it', async () => {
    const host = makeHost()
    const session = makeSession()
    await createProjectFolder(session.fs, '/p/gone', { name: 'Gone', texelDensity: 4, placeholder: generatePlaceholderTerrainSet(4) }, rawImageCodec)
    await session.fs.writeFile('/p/gone/papercut.json', JSON.stringify({ ...JSON.parse(await session.fs.readTextFile('/p/gone/papercut.json')), maps: ['maps/missing.map.json'] }))
    await openProjectAt(host, session, '/p/gone')
    expect(location(host).map).toBe('maps/gone.map.json')
    expect(location(host).project.maps).toEqual(['maps/missing.map.json', 'maps/gone.map.json'])
    expect(await session.fs.exists('/p/gone/maps/gone.map.json')).toBe(true)
  })

  it('drops a folder from recents only when it is gone, not when it is unreadable', async () => {
    const host = makeHost()
    const session = makeSession()
    await createProjectAt(host, session, { folder: '/p/a', name: 'A', texelDensity: 4 })
    await closeProject(host, session)
    await session.fs.writeFile('/p/a/papercut.json', 'nope')
    await expect(openProjectAt(host, session, '/p/a')).rejects.toThrow(/Could not open/)
    expect(recents().map((r) => r.folder)).toEqual(['/p/a'])
    await expect(openProjectAt(host, session, '/p/nowhere')).rejects.toThrow(/Could not open/)
    expect(recents().map((r) => r.folder)).toEqual(['/p/a'])
  })
})

describe('the map summaries and repainting', () => {
  it("knows every map's size and materials without opening it, and repaints a deleted material in all of them", async () => {
    const host = makeHost()
    const session = makeSession()
    await createProjectAt(host, session, { folder: '/p/many', name: 'Many', texelDensity: 4 })
    const ground = host.reader.doc.structures.ground as VoxelStructure
    host.children.document.send({ type: 'patch', label: 'Paint', patches: [{ t: 'voxel', id: ground.id, field: 'material', index: 0, value: 4 }] })
    await newMapIn(host, session, 'Second', 8, 6)
    const second = host.reader.doc.structures.ground as VoxelStructure
    host.children.document.send({ type: 'patch', label: 'Paint', patches: [{ t: 'voxel', id: second.id, field: 'material', index: 3, value: 4 }] })
    const summaries = () => session.summaries.get().map((s) => ({ path: s.path, size: `${s.width}×${s.height}`, uses4: s.materials.has(4) }))
    // A summary is what the FILE says: the first map was saved when the second opened; the second's paint is not saved yet.
    expect(summaries()).toEqual([
      { path: 'maps/many.map.json', size: '32×32', uses4: true },
      { path: 'maps/second.map.json', size: '8×6', uses4: false },
    ])
    await repaintAndDeleteMaterial(host, session, 4, 1)
    expect(host.children.project.getSnapshot().context.project.materials.map((m) => m.id)).toEqual([0, 1, 2, 3])
    expect(second.voxels.material[3]).toBe(1)
    const first = deserialize(await session.fs.readTextFile('/p/many/maps/many.map.json'))
    expect((first.structures.ground as VoxelStructure).voxels.material[0]).toBe(1)
    expect(summaries().every((s) => !s.uses4)).toBe(true)
  })
})

describe('switching and saving', () => {
  it('saves the open map before opening another project, and reopening the open map is a no-op', async () => {
    const host = makeHost()
    const session = makeSession()
    await createProjectAt(host, session, { folder: '/p/one', name: 'One', texelDensity: 4 })
    const ground = host.reader.doc.structures.ground as VoxelStructure
    host.children.document.send({ type: 'patch', label: 'Raise', patches: raise(host.reader.doc, ground, [[1, 1]], 2) })
    expect(host.reader.undoLabel()).toBe('Raise')
    await openMapAt(host, session, 'maps/one.map.json')
    expect(host.reader.undoLabel()).toBe('Raise')

    await createProjectAt(host, session, { folder: '/p/two', name: 'Two', texelDensity: 4 })
    expect(location(host).folder).toBe('/p/two')
    const saved = deserialize(await session.fs.readTextFile('/p/one/maps/one.map.json'))
    expect((saved.structures.ground as VoxelStructure).voxels.material.some((m) => m !== -1)).toBe(true)
  })

  it('keeps the project open when closing cannot save it', async () => {
    const host = makeHost()
    const session = makeSession()
    await createProjectAt(host, session, { folder: '/p/stuck', name: 'Stuck', texelDensity: 4 })
    const broken = session as { fs: Session['fs'] }
    broken.fs = { ...session.fs, writeFile: () => Promise.reject(new Error('[EACCES] no')) } as Session['fs']
    await expect(closeProject(host, session)).rejects.toThrow(/Not closed/)
    expect(location(host).folder).toBe('/p/stuck')
  })
})
