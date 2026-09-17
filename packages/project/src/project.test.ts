import { describe, expect, it } from 'vitest'

import { PROJECT_FILE, createMap, parseProject, plainGrid, type RgbaImage } from '@papercut/document'
import { CORNER_BLOCKS, addTerrain, createTerrainSet, exactTile, renderTemplate, stampTemplate, terrainOf, type LoadedSet } from '@papercut/geometry'

import { rawImageCodec } from './codec'
import { addImage, addMap, createProjectFolder, hashBytes, listImage, listImageFiles, mapPathFor, openProject, readMap, slugOf, writeMap } from './folder'
import { FsError, MemoryFs, joinPath, parentPath } from './fs'
import { forget, parseRecents, remember } from './recents'

/** A stand-in for the placeholder set: one terrain, its edge set, over a flat image. */
function placeholder(tile = 4): LoadedSet {
  let set = createTerrainSet('ground.png', tile, 4, 4)
  set = addTerrain(set, { id: 'grass', name: 'Grass', color: '#6aa84f' })
  set = stampTemplate(set, 0, 0, null, 'grass')
  const image: RgbaImage = { width: 4 * tile, height: 4 * tile, data: new Uint8ClampedArray(4 * tile * 4 * tile * 4).fill(200) }
  return { set, image }
}

describe('the memory filesystem', () => {
  it('joins and splits paths the way the shell does', () => {
    expect(joinPath('/projects', 'harbour', 'maps/a.map.json')).toBe('/projects/harbour/maps/a.map.json')
    expect(joinPath('/projects/', '/harbour/')).toBe('/projects/harbour')
    expect(parentPath('/a/b/c.png')).toBe('/a/b')
    expect(parentPath('/a')).toBe('/')
    expect(parentPath('a')).toBe('')
  })

  it('needs a parent to write into, lists what it holds, and comes back from a snapshot', async () => {
    const fs = new MemoryFs()
    await expect(fs.writeFile('/p/a.txt', 'x')).rejects.toBeInstanceOf(FsError)
    await fs.mkdir('/p/maps', { recursive: true })
    await fs.writeFile('/p/a.txt', 'hello')
    await fs.writeFile('/p/maps/m.json', new Uint8Array([1, 2, 3]))
    expect(await fs.readTextFile('/p/a.txt')).toBe('hello')
    expect(await fs.readDir('/p')).toEqual([{ name: 'maps', kind: 'directory' }, { name: 'a.txt', kind: 'file' }])
    expect(await fs.exists('/p/maps')).toBe(true)
    expect(await fs.exists('/p/nope')).toBe(false)
    await expect(fs.readFile('/p/nope')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.mkdir('/p/maps')).rejects.toMatchObject({ code: 'EEXIST' })
    const back = MemoryFs.restore(fs.snapshot())
    expect(await back.readFile('/p/maps/m.json')).toEqual(new Uint8Array([1, 2, 3]))
    expect(await back.readDir('/p')).toEqual(await fs.readDir('/p'))
  })
})

describe('a project folder', () => {
  it('is created with the project file, one map and the placeholder image, and opens back the same', async () => {
    const fs = new MemoryFs()
    const created = await createProjectFolder(fs, '/projects/harbour', { name: 'Harbour Town', texelDensity: 4, placeholder: placeholder() }, rawImageCodec)
    expect(created.project.maps).toEqual(['maps/harbour-town.map.json'])
    expect(created.warnings).toEqual([])
    expect(await fs.readDir('/projects/harbour')).toEqual([{ name: 'maps', kind: 'directory' }, { name: 'sheets', kind: 'directory' }, { name: PROJECT_FILE, kind: 'file' }])
    // No sidecar: the terrain set is in the project file, beside the image's grid and hash.
    expect(await fs.readDir('/projects/harbour/sheets')).toEqual([{ name: 'ground.png', kind: 'file' }])
    const entry = created.project.images[0]
    expect(entry).toMatchObject({ path: 'sheets/ground.png', name: 'Ground', kind: 'tileset', grid: plainGrid(4) })
    expect(entry.hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(entry.terrain).toEqual(terrainOf(placeholder().set))

    const opened = await openProject(fs, '/projects/harbour', rawImageCodec)
    expect(opened.project).toEqual(created.project)
    expect(opened.warnings).toEqual([])
    expect(opened.unlisted).toEqual([])
    expect(opened.sets).toHaveLength(1)
    expect(opened.sets[0].set.sheet).toBe('ground.png')
    expect(opened.sets[0].set.tiles.size).toBe(16)
    expect(opened.sets[0].image.width).toBe(16)
    expect(opened.sets[0].source?.width).toBe(16)
    const map = await readMap(fs, '/projects/harbour', 'maps/harbour-town.map.json')
    expect(map.name).toBe('Harbour Town')
    // A second project cannot land in the same folder, and none in a folder that holds anything.
    await expect(createProjectFolder(fs, '/projects/harbour', { name: 'Again', texelDensity: 4, placeholder: placeholder() }, rawImageCodec)).rejects.toThrow(/already holds a project/)
    await fs.mkdir('/projects/busy/notes', { recursive: true })
    await expect(createProjectFolder(fs, '/projects/busy', { name: 'Busy', texelDensity: 4, placeholder: placeholder() }, rawImageCodec)).rejects.toThrow(/not empty/)
  })

  it('opens with warnings for an image that is missing, does not divide the density or tags past its edge, and a map that is not there, never refusing', async () => {
    const fs = new MemoryFs()
    await createProjectFolder(fs, '/p', { name: 'P', texelDensity: 4, placeholder: placeholder() }, rawImageCodec)
    const project = parseProject(await fs.readTextFile('/p/papercut.json'))
    project.images.push({ path: 'sheets/cliffs.png', name: 'Cliffs', kind: 'tileset', hash: null, grid: plainGrid(4), layout: null, terrain: { terrains: [], tiles: {} } })
    project.images.push({ path: 'sheets/props.png', name: 'Props', kind: 'tileset', hash: null, grid: plainGrid(3), layout: null, terrain: { terrains: [], tiles: {} } })
    await fs.writeFile('/p/sheets/props.png', await rawImageCodec.encode(placeholder(3).image))
    // The placeholder's tags describe a 4×4 grid; listed at 8 px it is 2×2, so twelve tags fall past the edge.
    project.images[0].grid = plainGrid(8)
    project.maps.push('maps/gone.map.json')
    await fs.writeFile('/p/papercut.json', JSON.stringify(project))
    await fs.writeFile('/p/maps/stray.map.json', JSON.stringify(createMap(2, 2, 'Stray')))

    const opened = await openProject(fs, '/p', rawImageCodec)
    expect(opened.sets.map((s) => s.set.sheet)).toEqual([])
    expect(opened.warnings).toEqual([
      'ground.png: 8 px tiles do not divide the project\'s 4 px, so it is not drawn.',
      expect.stringMatching(/^sheets\/cliffs\.png: /),
      "props.png: 3 px tiles do not divide the project's 4 px, so it is not drawn.",
      'maps/gone.map.json is listed but not in the folder.',
      "maps/stray.map.json is in the folder but not in the project's map list.",
    ])
    // At the density with a grid too coarse for its tags, the set loads with the tags past the edge dropped and named.
    project.images[0].grid = plainGrid(4)
    project.images[0].terrain.tiles['99'] = ['grass', null, null, null]
    await fs.writeFile('/p/papercut.json', JSON.stringify(project))
    const again = await openProject(fs, '/p', rawImageCodec)
    expect(again.sets[0].set.tiles.size).toBe(16)
    expect(again.warnings[0]).toBe('ground.png: 1 tagged tile is past the edge of its 4×4 grid and not drawn.')
  })

  it('finds a moved image by its hash, refreshes hashes as it reads, and names what is in sheets/ but not listed', async () => {
    const fs = new MemoryFs()
    const created = await createProjectFolder(fs, '/p', { name: 'P', texelDensity: 4, placeholder: placeholder() }, rawImageCodec)
    const bytes = await fs.readFile('/p/sheets/ground.png')
    // The artist moved the file into a subfolder and dropped an unrelated image beside it.
    await fs.mkdir('/p/sheets/kit')
    await fs.writeFile('/p/sheets/kit/terrain.png', bytes)
    await fs.writeFile('/p/sheets/extra.png', await rawImageCodec.encode(placeholder(2).image))
    const project = parseProject(await fs.readTextFile('/p/papercut.json'))
    // Pretend the original is gone by pointing the entry at a path that is not there, keeping its hash.
    project.images[0].path = 'sheets/ground-old.png'
    await fs.writeFile('/p/papercut.json', JSON.stringify(project))
    expect(await listImageFiles(fs, '/p')).toEqual(['sheets/extra.png', 'sheets/ground.png', 'sheets/kit/terrain.png'])

    const opened = await openProject(fs, '/p', rawImageCodec)
    expect(opened.warnings).toEqual(['sheets/ground-old.png was not there; sheets/ground.png has the same contents, so Ground now points at it.'])
    expect(opened.project.images[0].path).toBe('sheets/ground.png')
    expect(opened.project.images[0].hash).toBe(created.project.images[0].hash)
    expect(opened.sets.map((s) => s.set.sheet)).toEqual(['ground.png'])
    expect(opened.unlisted).toEqual(['sheets/extra.png', 'sheets/kit/terrain.png'])
    // The relink was written back.
    expect(parseProject(await fs.readTextFile('/p/papercut.json')).images[0].path).toBe('sheets/ground.png')

    // A hash that is stale — the file was edited in place — is refreshed on read, and written back.
    const repainted = placeholder(4).image
    repainted.data.fill(90)
    await fs.writeFile('/p/sheets/ground.png', await rawImageCodec.encode(repainted))
    const edited = await openProject(fs, '/p', rawImageCodec)
    expect(edited.warnings).toEqual([])
    expect(edited.project.images[0].hash).toBe(await hashBytes(await fs.readFile('/p/sheets/ground.png')))
    expect(edited.project.images[0].hash).not.toBe(created.project.images[0].hash)

    // Edited AND moved: nothing matches, so it is missing, and the artist relinks by hand.
    await fs.writeFile('/p/sheets/kit/terrain.png', await rawImageCodec.encode(placeholder(2).image))
    project.images[0].path = 'sheets/ground-old.png'
    project.images[0].hash = 'sha256:0000'
    await fs.writeFile('/p/papercut.json', JSON.stringify(project))
    const lost = await openProject(fs, '/p', rawImageCodec)
    expect(lost.warnings).toEqual([expect.stringMatching(/^sheets\/ground-old\.png: /)])
    expect(lost.sets).toEqual([])
  })

  it('refuses a folder with no project file', async () => {
    const fs = new MemoryFs()
    await fs.mkdir('/empty')
    await expect(openProject(fs, '/empty', rawImageCodec)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('adds a map under a slug that does not collide, copies an image in with its grid, and lists a file already in the folder', async () => {
    const fs = new MemoryFs()
    const { project } = await createProjectFolder(fs, '/p', { name: 'P', texelDensity: 4, placeholder: placeholder() }, rawImageCodec)
    expect(slugOf('  Harbour   Road! ')).toBe('harbour-road')
    expect(slugOf('???')).toBe('map')
    expect(mapPathFor(project, 'P')).toBe('maps/p-2.map.json')
    const added = await addMap(fs, '/p', project, createMap(8, 8, 'Cliff Path'))
    expect(added.path).toBe('maps/cliff-path.map.json')
    expect(added.project.maps).toEqual(['maps/p.map.json', 'maps/cliff-path.map.json'])
    expect(parseProject(await fs.readTextFile('/p/papercut.json')).maps).toEqual(added.project.maps)
    await writeMap(fs, '/p', added.path, createMap(2, 2, 'Cliff Path'))
    expect((await readMap(fs, '/p', added.path)).structures.ground).toMatchObject({ size: { width: 2, height: 2 } })

    const cliffs = placeholder(4)
    const withImage = await addImage(fs, '/p', added.project, { file: 'cliffs.png', bytes: await rawImageCodec.encode(cliffs.image), grid: plainGrid(4), name: 'Cliff faces', terrain: terrainOf(cliffs.set) })
    expect(withImage.images.map((i) => i.path)).toEqual(['sheets/ground.png', 'sheets/cliffs.png'])
    expect(withImage.images[1]).toMatchObject({ path: 'sheets/cliffs.png', name: 'Cliff faces', kind: 'tileset', grid: plainGrid(4) })
    expect(withImage.images[1].terrain.terrains.map((t) => t.id)).toEqual(['grass'])
    const reopened = await openProject(fs, '/p', rawImageCodec)
    expect(reopened.sets.map((s) => s.set.sheet)).toEqual(['ground.png', 'cliffs.png'])
    // Adding an image of the same file name replaces its file and grid and keeps its name and tags: what Replace image… does.
    const replaced = await addImage(fs, '/p', withImage, { file: 'cliffs.png', bytes: await rawImageCodec.encode(cliffs.image), grid: plainGrid(2) })
    expect(replaced.images.map((i) => i.path)).toEqual(['sheets/ground.png', 'sheets/cliffs.png'])
    expect(replaced.images[1]).toMatchObject({ name: 'Cliff faces', grid: plainGrid(2) })
    expect(replaced.images[1].terrain).toEqual(withImage.images[1].terrain)

    // A file dropped into sheets/ by hand is listed in place, hashed, with an empty set; and not twice.
    await fs.writeFile('/p/sheets/props.png', await rawImageCodec.encode(placeholder(2).image))
    expect((await openProject(fs, '/p', rawImageCodec)).unlisted).toEqual(['sheets/props.png'])
    const listed = await listImage(fs, '/p', replaced, 'sheets/props.png', plainGrid(2))
    expect(listed.images[2]).toMatchObject({ path: 'sheets/props.png', name: 'props', kind: 'tileset', terrain: { terrains: [], tiles: {} } })
    expect(listed.images[2].hash).toMatch(/^sha256:/)
    await expect(listImage(fs, '/p', listed, 'sheets/props.png', plainGrid(2))).rejects.toThrow(/already listed/)
    expect((await openProject(fs, '/p', rawImageCodec)).unlisted).toEqual([])
  })
})

describe('an image laid out to a convention', () => {
  it('derives its tags from its layout, and the entry\'s own tags win over them', async () => {
    const fs = new MemoryFs()
    const { project } = await createProjectFolder(fs, '/p', { name: 'P', texelDensity: 8, placeholder: placeholder(8) }, rawImageCodec)
    const terrains = [{ id: 'a', name: 'A', color: '#6aa84f' }, { id: 'b', name: 'B', color: '#d9c27e' }]
    const template = renderTemplate('corner-blocks', terrains, { tile: 8 })
    const next = await addImage(fs, '/p', project, {
      file: 'kit.png',
      bytes: await rawImageCodec.encode(template.image),
      grid: plainGrid(8),
      name: 'Kit',
      layout: { convention: 'corner-blocks', origin: { x: 0, y: 0 }, terrains: ['a', 'b'], unauthored: [] },
      terrain: { terrains, tiles: {} },
    })
    // The entry stays small: the layout is the tags, not a list of them.
    expect(next.images[1].terrain.tiles).toEqual({})
    expect(next.images[1].layout).toEqual({ convention: 'corner-blocks', origin: { x: 0, y: 0 }, terrains: ['a', 'b'], unauthored: [] })

    const opened = await openProject(fs, '/p', rawImageCodec)
    expect(opened.warnings).toEqual([])
    const kit = opened.sets.find((s) => s.set.sheet === 'kit.png')
    expect(kit).toBeDefined()
    expect(kit?.set.tiles.size).toBe(CORNER_BLOCKS.tiles(2).length)
    // Every corner of one or two of these terrains is answered by a real tile.
    expect(exactTile(kit!.set, ['a', 'a', 'a', 'a'])).not.toBeNull()
    expect(exactTile(kit!.set, ['a', null, null, null])).not.toBeNull()
    expect(exactTile(kit!.set, ['a', 'b', 'a', 'b'])).not.toBeNull()

    // An entry tag on the same tile wins; a block named unauthored stops tagging at all.
    const reopened = parseProject(await fs.readTextFile('/p/papercut.json'))
    const image = reopened.images[1]
    image.terrain.tiles['0'] = ['b', 'b', 'b', 'b']
    image.layout!.unauthored = ['1+2']
    await fs.writeFile('/p/papercut.json', JSON.stringify(reopened))
    const again = await openProject(fs, '/p', rawImageCodec)
    const set = again.sets.find((s) => s.set.sheet === 'kit.png')!.set
    expect(set.tiles.get(0)).toEqual(['b', 'b', 'b', 'b'])
    // The a+b block is gone, so a corner where both meet has no tile of its own any more.
    expect(exactTile(set, ['a', 'b', 'a', 'b'])).toBeNull()
    expect(exactTile(set, ['a', null, null, null])).not.toBeNull()
  })
})

describe('recents', () => {
  it('keeps one entry per folder, most recent first, capped, and believes a stored list only as far as it parses', () => {
    let list = remember([], { name: 'A', folder: '/a', openedAt: 1 })
    list = remember(list, { name: 'B', folder: '/b', openedAt: 2 })
    list = remember(list, { name: 'A2', folder: '/a', openedAt: 3 })
    expect(list.map((r) => r.folder)).toEqual(['/a', '/b'])
    expect(list[0].name).toBe('A2')
    for (let i = 0; i < 20; i++) list = remember(list, { name: `P${i}`, folder: `/p${i}`, openedAt: i })
    expect(list).toHaveLength(10)
    expect(forget(list, '/p19').map((r) => r.folder)).not.toContain('/p19')
    expect(parseRecents(null)).toEqual([])
    expect(parseRecents('nope')).toEqual([])
    expect(parseRecents(JSON.stringify([{ name: 'X', folder: '/x' }, { bad: true }, 3]))).toEqual([{ name: 'X', folder: '/x', openedAt: 0 }])
  })
})
