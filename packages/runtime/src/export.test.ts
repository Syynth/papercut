import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_MATERIALS, PLACEHOLDER_SHEET, createMap, defaultFacing, tagOf, type RgbaImage, type SpriteAsset } from '@papercut/document'
import { createTerrainSet, stampTemplate, type LoadedSet } from '@papercut/geometry'
import { buildExportScene, exportGltf, type ExportOptions } from './export'

// `parse` needs to be reconfigurable per test (success vs. error), and
// `vi.mock` factories are hoisted above imports, so the mock function itself
// has to be hoisted alongside it rather than declared as a normal local.
const { parseMock } = vi.hoisted(() => ({ parseMock: vi.fn() }))

vi.mock('three/examples/jsm/exporters/GLTFExporter.js', () => ({
  GLTFExporter: class {
    parse = parseMock
    register = vi.fn()
  },
}))

// Nothing else is mocked. Before #47 this file had to stub out `./textures`
// and `./billboard` because building the scene reached for
// `document.createElement('canvas')`, which Node does not have and which this
// repo has ruled against shimming in (see "No native binary dependencies for
// tooling" in docs/decision-log.md). The terrain sets and sprites are inputs
// now, so the fixtures below are raw pixels made by hand and the real texture,
// atlas and sprite/light code runs under vitest's plain Node environment. That
// is the acceptance test for the boundary: if anything in `buildExportScene`
// touched a DOM API again, the sprite tests here would throw `document is not
// defined`.

function solid(width: number, height: number, rgba: [number, number, number, number]): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i)
  return { width, height, data }
}

const TILE = 4

/**
 * A stand-in for the placeholder terrain set the default materials draw from:
 * the five materials, each with an edge set stamped on its own 4×4 block of a
 * 16-column sheet, over one flat colour.
 */
function terrainSet(rgba: [number, number, number, number] = [0, 255, 0, 255]): LoadedSet {
  let set = createTerrainSet(PLACEHOLDER_SHEET, TILE, 16, 8)
  // A tag names a material of the project (ruling of 2026-09-17), so the blocks are the default materials by id.
  DEFAULT_MATERIALS.forEach((material, i) => {
    set = stampTemplate(set, (i % 4) * 4, Math.floor(i / 4) * 4, null, tagOf(material.id))
  })
  return { set, image: solid(16 * TILE, 8 * TILE, rgba) }
}

function sprite(name: string, facings: number, emissive = false): SpriteAsset {
  return {
    name,
    facings: Array.from({ length: facings }, (_, i) => solid(4, 6, [i * 40, 0, 0, 255])),
    widthTiles: 1,
    heightTiles: 1.5,
    emissive,
  }
}

const sprites: Record<string, SpriteAsset> = {
  rock: sprite('rock', 1),
  statue: sprite('statue', 4),
  lamp: sprite('lamp', 1, true),
}

function options(overrides: Partial<ExportOptions> = {}): ExportOptions {
  return {
    textures: {},
    merge: false,
    terrain: [terrainSet()],
    materials: DEFAULT_MATERIALS,
    resolution: { texelDensity: 16, filtering: 'nearest' },
    sprites,
    encodePng: () => Promise.resolve(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
    ...overrides,
  }
}

function withObjects(names: string[]) {
  const doc = createMap(4, 4, 'Objects')
  names.forEach((name, i) => {
    const id = `o${i}`
    doc.objects[id] = {
      id,
      name,
      sprite: name,
      position: [1 + i, 0, 1],
      rotationY: 0,
      scale: 1,
      display: 'fixed',
      facing: { ...defaultFacing(), facings: name === 'statue' ? 4 : 1 },
      anchorCell: null,
      seed: 0,
      locked: false,
      hidden: false,
    }
    doc.objectOrder.push(id)
  })
  return doc
}

interface TexturedNode {
  name: string
  material: { name: string; map: { image: { width: number; height: number; data: Uint8Array } } }
  userData: { atlas: { frames: number } }
}

function nodeNamed(scene: { children: { name: string; children: unknown[] }[] }, root: string, name?: string) {
  const group = scene.children.find((child) => child.name === root)
  const nodes = (group?.children ?? []) as TexturedNode[]
  return name === undefined ? nodes[0] : nodes.find((child) => child.name === name)
}

beforeEach(() => {
  parseMock.mockReset()
})

describe('buildExportScene', () => {
  it('returns the scene directly rather than a promise', () => {
    // Regression guard for #28: `buildExportScene` used to be declared
    // `async` with nothing to await, which silently changed its return type
    // to `Promise<Scene>`. Revert that fix and this goes back to failing.
    const doc = createMap(4, 4, 'Sync Check')
    const result = buildExportScene(doc, options())
    expect(result).not.toBeInstanceOf(Promise)
  })

  it('builds a terrain root and no water root when the map has no water', () => {
    const doc = createMap(4, 4, 'Structure Check')
    const scene = buildExportScene(doc, options())

    const terrain = scene.children.find((child) => child.name === 'Terrain')
    const water = scene.children.find((child) => child.name === 'Water')
    expect(terrain).toBeDefined()
    expect(terrain?.children.length).toBeGreaterThan(0)
    expect(water).toBeUndefined()

    // Scene extras are the one thing every consumer (the editor's importer,
    // docs/extras-spec.md) actually reads back out.
    const extras = scene.userData.mapEditor as { extrasVersion: number; name: string }
    expect(extras.name).toBe('Structure Check')
    expect(extras.extrasVersion).toBe(1)
  })

  it('textures the terrain with the atlas built from the supplied terrain sets, not a generated one', () => {
    const scene = buildExportScene(createMap(4, 4), options({ terrain: [terrainSet([7, 8, 9, 255])] }))
    const terrain = nodeNamed(scene, 'Terrain')
    const image = terrain?.material.map.image
    // The atlas is 32 tiles across, and its first tile is the set's first authored tile, copied pixel for pixel.
    expect(image?.width).toBe(64 * TILE)
    expect(image?.height).toBeGreaterThanOrEqual(TILE)
    expect([...(image?.data.slice(0, 4) ?? [])]).toEqual([7, 8, 9, 255])
  })

  it('builds sprite nodes, atlases and lights without a canvas', () => {
    // Would have thrown `document is not defined` before #47: `atlasFor`
    // created a canvas for every multi-facing sprite.
    const doc = withObjects(['statue', 'lamp'])
    const scene = buildExportScene(doc, options())

    const statue = nodeNamed(scene, 'Objects', 'statue')
    // Four 4px facings side by side.
    expect(statue?.material.map.image.width).toBe(16)
    expect(statue?.material.map.image.height).toBe(6)
    expect(statue?.userData.atlas.frames).toBe(4)

    // An emissive prop carries its own punctual light.
    expect(nodeNamed(scene, 'Objects', 'lamp_light')).toBeDefined()
  })

  it('falls back to the rock sprite for a name the library lacks', () => {
    const doc = withObjects(['nonesuch'])
    const node = nodeNamed(buildExportScene(doc, options()), 'Objects')
    expect(node?.userData.atlas.frames).toBe(1)
    expect(node?.material.name).toBe('sprite_nonesuch')
  })
})

describe('exportGltf', () => {
  it('wraps a non-Error rejection from the exporter in an Error', async () => {
    // Regression guard for #28: the GLTFExporter callback is typed as
    // `ErrorEvent`, not `Error`, and the old code rejected with it verbatim.
    // Revert that fix and this rejects with the plain `ErrorEvent`-shaped
    // object instead, failing the `toBeInstanceOf` assertion.
    parseMock.mockImplementation((_scene: unknown, _onDone: unknown, onError: (error: unknown) => void) => {
      onError({ message: 'boom' })
    })
    const doc = createMap(4, 4, 'Error Check')

    await expect(exportGltf(doc, options())).rejects.toBeInstanceOf(Error)
    await expect(exportGltf(doc, options())).rejects.toThrow('boom')
  })

  it('falls back to a fixed message when the rejection has no .message', async () => {
    // Regression guard: three's `writer.writeAsync(...).catch(onError)` can
    // hand `onError` a plain string (whatever was thrown), not the `ErrorEvent`
    // the typings promise. `new Error(error.message)` on a string reads
    // `.message` off `undefined`, producing an `Error` with an empty message —
    // revert the fallback and this asserts a message that's no longer there.
    parseMock.mockImplementation((_scene: unknown, _onDone: unknown, onError: (error: unknown) => void) => {
      onError('a thrown string, not an ErrorEvent')
    })
    const doc = createMap(4, 4, 'String Rejection Check')

    await expect(exportGltf(doc, options())).rejects.toBeInstanceOf(Error)
    await expect(exportGltf(doc, options())).rejects.toThrow('glTF export failed')
  })

  it('resolves to the .glb bytes on success', async () => {
    parseMock.mockImplementation((_scene: unknown, onDone: (result: ArrayBuffer) => void) => {
      onDone(new ArrayBuffer(4))
    })
    const doc = createMap(4, 4, 'Success Check')

    const bytes = await exportGltf(doc, options())
    // An `ArrayBuffer`, not a `Blob`: `Blob` is a DOM type and this package
    // compiles without `DOM`. Wrapping for download is the editor's job.
    expect(bytes).toBeInstanceOf(ArrayBuffer)
    expect(bytes.byteLength).toBe(4)
  })
})
