import type { AsepriteFile, BlendMode, Cel, Layer, Tileset } from '@papercut/aseprite'
import { describe, expect, it } from 'vitest'
import { blenderFor, merge, normal, renderFrame, rgba } from './index'

/**
 * Models built by hand: the renderer reads only the parser's model, so its
 * tests need no bytes. Real Aseprite output is checked against in the repo's
 * `tests/aseprite-golden.test.ts`.
 */

function makeLayer(index: number, name: string, over: Partial<Layer> & { visible?: boolean; background?: boolean; reference?: boolean } = {}): Layer {
  const { visible = true, background = false, reference = false, ...rest } = over
  return {
    index,
    name,
    type: 'image',
    flags: { visible, editable: true, lockMovement: false, background, preferLinkedCels: false, collapsed: false, reference },
    childLevel: 0,
    parent: null,
    blendMode: 'normal',
    opacity: 255,
    tilesetId: null,
    uuid: null,
    userData: null,
    ...rest,
  }
}

function makeFile(width: number, height: number, layers: Layer[], frames: Cel[][], over: Partial<AsepriteFile> = {}): AsepriteFile {
  return {
    width,
    height,
    colorMode: 'rgba',
    flags: { layerOpacity: true, groupBlending: false, layerUuids: false },
    transparentIndex: 0,
    colorCount: 0,
    pixelRatio: { width: 1, height: 1 },
    grid: null,
    speed: 100,
    layers,
    frames: frames.map((cels) => ({ duration: 100, cels, paletteChanges: [] })),
    tags: [],
    slices: [],
    tilesets: [],
    colorProfile: null,
    externalFiles: [],
    userData: null,
    warnings: [],
    ...over,
  }
}

function image(layer: number, x: number, y: number, width: number, height: number, px: number[], over: { opacity?: number; zIndex?: number; frame?: number } = {}): Cel {
  return { kind: 'image', layer, frame: over.frame ?? 0, x, y, opacity: over.opacity ?? 255, zIndex: over.zIndex ?? 0, precise: null, userData: null, width, height, pixels: Uint8Array.from(px) }
}

const RED = [255, 0, 0, 255]
const GREEN = [0, 255, 0, 255]
const BLUE = [0, 0, 255, 255]
const CLEAR = [0, 0, 0, 0]

const px = (out: { data: Uint8ClampedArray }, i: number): number[] => [...out.data.subarray(i * 4, i * 4 + 4)]

describe('blend functions', () => {
  it('normal over transparent keeps the source colour and scales its alpha', () => {
    expect(normal(0, rgba(10, 20, 30, 200), 128)).toBe(rgba(10, 20, 30, 100))
  })

  it('normal with a transparent source leaves the backdrop', () => {
    expect(normal(rgba(1, 2, 3, 4), rgba(9, 9, 9, 0), 255)).toBe(rgba(1, 2, 3, 4))
  })

  it('normal, opaque over opaque, at half opacity, truncates like C', () => {
    // Sa = 128, Ra = 255; Rr = 255 + (0 - 255)·128/255 = 255 - 128.0 = 127 (C truncation toward zero of -128.00)
    expect(normal(rgba(255, 0, 0, 255), rgba(0, 0, 255, 255), 128)).toBe(rgba(127, 0, 128, 255))
  })

  it('merge interpolates alpha too, and clears colour when alpha ends at zero', () => {
    expect(merge(rgba(100, 100, 100, 255), rgba(200, 0, 50, 255), 255)).toBe(rgba(200, 0, 50, 255))
    expect(merge(rgba(100, 100, 100, 0), rgba(200, 0, 50, 0), 128)).toBe(0)
  })

  it('every mode is plain normal over a transparent backdrop', () => {
    const modes: BlendMode[] = ['multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity', 'addition', 'subtract', 'divide']
    for (const mode of modes) expect(blenderFor(mode)(0, rgba(40, 80, 120, 200), 255)).toBe(normal(0, rgba(40, 80, 120, 200), 255))
  })

  it('opaque multiply, screen and difference over opaque give the textbook channels', () => {
    const b = rgba(200, 100, 0, 255)
    const s = rgba(100, 255, 50, 255)
    expect(blenderFor('multiply')(b, s, 255)).toBe(rgba(78, 100, 0, 255))
    expect(blenderFor('screen')(b, s, 255)).toBe(rgba(222, 255, 50, 255))
    expect(blenderFor('difference')(b, s, 255)).toBe(rgba(100, 155, 50, 255))
  })

  it('grey sprites use Aseprite’s grey table: addition is exclusion, HSL modes are normal', () => {
    const b = rgba(100, 100, 100, 255)
    const s = rgba(200, 200, 200, 255)
    expect(blenderFor('addition', true)(b, s, 255)).toBe(blenderFor('exclusion')(b, s, 255))
    expect(blenderFor('hue', true)(b, s, 255)).toBe(normal(b, s, 255))
  })
})

describe('renderFrame', () => {
  it('draws layers bottom to top, clipped to the canvas', () => {
    const file = makeFile(2, 1, [makeLayer(0, 'a'), makeLayer(1, 'b')], [[image(0, 0, 0, 2, 1, [...RED, ...RED]), image(1, 1, 0, 2, 1, [...GREEN, ...GREEN])]])
    const out = renderFrame(file, 0)
    expect(px(out, 0)).toEqual(RED)
    expect(px(out, 1)).toEqual(GREEN)
  })

  it('draws a cel at a negative position', () => {
    const file = makeFile(1, 1, [makeLayer(0, 'a')], [[image(0, -1, 0, 2, 1, [...RED, ...BLUE])]])
    expect(px(renderFrame(file, 0), 0)).toEqual(BLUE)
  })

  it('multiplies cel and layer opacity, and ignores layer opacity when the header says it is invalid', () => {
    const layers = [makeLayer(0, 'a', { opacity: 128 })]
    const frames = [[image(0, 0, 0, 1, 1, RED, { opacity: 128 })]]
    expect(px(renderFrame(makeFile(1, 1, layers, frames), 0), 0)).toEqual([255, 0, 0, 64])
    expect(px(renderFrame(makeFile(1, 1, layers, frames, { flags: { layerOpacity: false, groupBlending: false, layerUuids: false } }), 0), 0)).toEqual([255, 0, 0, 128])
  })

  it('leaves out hidden layers, layers in hidden groups, and reference layers', () => {
    const layers = [
      makeLayer(0, 'shown'),
      makeLayer(1, 'hidden', { visible: false }),
      makeLayer(2, 'group', { type: 'group', visible: false }),
      makeLayer(3, 'in hidden group', { parent: 2, childLevel: 1 }),
      makeLayer(4, 'reference', { reference: true }),
    ]
    const frames = [[image(0, 0, 0, 1, 1, RED), image(1, 0, 0, 1, 1, GREEN), image(3, 0, 0, 1, 1, GREEN), image(4, 0, 0, 1, 1, GREEN)]]
    const file = makeFile(1, 1, layers, frames)
    expect(px(renderFrame(file, 0), 0)).toEqual(RED)
    expect(px(renderFrame(file, 0, { referenceLayers: true }), 0)).toEqual(GREEN)
    expect(px(renderFrame(file, 0, { include: (l) => l.index !== 4 }), 0)).toEqual(GREEN)
  })

  it('draws the background first whatever its place in the file', () => {
    const file = makeFile(1, 1, [makeLayer(0, 'top'), makeLayer(1, 'bg', { background: true, opacity: 10, blendMode: 'difference' })], [[image(0, 0, 0, 1, 1, [0, 255, 0, 128]), image(1, 0, 0, 1, 1, RED)]])
    // Background opacity and mode are ignored; the half-green goes over the red.
    expect(px(renderFrame(file, 0), 0)).toEqual(px({ data: new Uint8ClampedArray(new Uint32Array([normal(rgba(255, 0, 0, 255), rgba(0, 255, 0, 128), 255)]).buffer) }, 0))
  })

  it('moves a cel among the layers by its z-index', () => {
    const layers = [makeLayer(0, 'a'), makeLayer(1, 'b'), makeLayer(2, 'c')]
    const file = makeFile(1, 1, layers, [[image(0, 0, 0, 1, 1, RED, { zIndex: 2 }), image(1, 0, 0, 1, 1, GREEN), image(2, 0, 0, 1, 1, BLUE)]])
    // a moves to order 1+2 = 3, tying c (3); the tie goes to the larger z-index, so a draws last.
    expect(px(renderFrame(file, 0), 0)).toEqual(RED)
  })

  it('flattens groups unless the file composites them, then applies the group’s opacity once', () => {
    const layers = [makeLayer(0, 'g', { type: 'group', opacity: 128 }), makeLayer(1, 'x', { parent: 0, childLevel: 1 }), makeLayer(2, 'y', { parent: 0, childLevel: 1 })]
    const frames = [[image(1, 0, 0, 1, 1, RED), image(2, 0, 0, 1, 1, GREEN)]]
    expect(px(renderFrame(makeFile(1, 1, layers, frames), 0), 0)).toEqual(GREEN)
    const composed = makeFile(1, 1, layers, frames, { flags: { layerOpacity: true, groupBlending: true, layerUuids: false } })
    expect(px(renderFrame(composed, 0), 0)).toEqual([0, 255, 0, 128])
  })

  it('follows linked cels', () => {
    const layers = [makeLayer(0, 'a')]
    const frames: Cel[][] = [[image(0, 0, 0, 1, 1, RED)], [{ kind: 'linked', layer: 0, frame: 1, x: 1, y: 0, opacity: 255, zIndex: 0, precise: null, userData: null, linkedFrame: 0 }]]
    const out = renderFrame(makeFile(2, 1, layers, frames), 1)
    expect(px(out, 0)).toEqual(CLEAR)
    expect(px(out, 1)).toEqual(RED)
  })

  it('reads grayscale pixels as grey', () => {
    const file = makeFile(1, 1, [makeLayer(0, 'a')], [[image(0, 0, 0, 1, 1, [90, 200])]], { colorMode: 'grayscale' })
    expect(px(renderFrame(file, 0), 0)).toEqual([90, 90, 90, 200])
  })

  it('reads indexed pixels through the frame’s palette, skipping the transparent index', () => {
    const file = makeFile(2, 1, [makeLayer(0, 'a')], [[image(0, 0, 0, 2, 1, [1, 0])]], { colorMode: 'indexed', transparentIndex: 0 })
    file.frames[0]?.paletteChanges.push({ size: 2, from: 0, entries: [{ r: 9, g: 9, b: 9, a: 255, name: null }, { r: 0, g: 0, b: 255, a: 255, name: null }] })
    const out = renderFrame(file, 0)
    expect(px(out, 0)).toEqual(BLUE)
    expect(px(out, 1)).toEqual(CLEAR)
  })

  it('fills an indexed sprite with a background with the transparent index’s colour', () => {
    const file = makeFile(2, 1, [makeLayer(0, 'bg', { background: true })], [[image(0, 0, 0, 1, 1, [1])]], { colorMode: 'indexed', transparentIndex: 0 })
    file.frames[0]?.paletteChanges.push({ size: 2, from: 0, entries: [{ r: 9, g: 8, b: 7, a: 255, name: null }, { r: 0, g: 0, b: 255, a: 255, name: null }] })
    const out = renderFrame(file, 0)
    expect(px(out, 0)).toEqual(BLUE)
    expect(px(out, 1)).toEqual([9, 8, 7, 255])
  })

  it('draws tilemaps, skipping the empty tile and honouring flips', () => {
    // One 2×2 tile: red, green / blue, clear. Tile 0 is the empty tile.
    const tile = [...CLEAR, ...CLEAR, ...CLEAR, ...CLEAR, ...RED, ...GREEN, ...BLUE, ...CLEAR]
    const set: Tileset = { id: 7, name: 't', tileWidth: 2, tileHeight: 2, tileCount: 2, baseIndex: 1, zeroIsEmpty: true, matchFlips: { x: false, y: false, diagonal: false }, external: null, pixels: Uint8Array.from(tile), userData: null, tileUserData: [] }
    const masks = { id: 0x1fffffff, xFlip: 0x20000000, yFlip: 0x40000000, diagonalFlip: 0x80000000 }
    const cel: Cel = { kind: 'tilemap', layer: 0, frame: 0, x: 0, y: 0, opacity: 255, zIndex: 0, precise: null, userData: null, width: 3, height: 1, bitsPerTile: 32, masks, tiles: Uint32Array.from([1, (1 | masks.xFlip) >>> 0, (1 | masks.diagonalFlip) >>> 0]) }
    const file = makeFile(6, 2, [makeLayer(0, 'map', { type: 'tilemap', tilesetId: 7 })], [[cel]], { tilesets: [set] })
    const out = renderFrame(file, 0)
    const row = (y: number): number[][] => [0, 1, 2, 3, 4, 5].map((x) => px(out, y * 6 + x))
    expect(row(0)).toEqual([RED, GREEN, GREEN, RED, RED, BLUE])
    expect(row(1)).toEqual([BLUE, CLEAR, CLEAR, BLUE, GREEN, CLEAR])
  })

  it('warns about a tilemap whose tileset is missing', () => {
    const cel: Cel = { kind: 'tilemap', layer: 0, frame: 0, x: 0, y: 0, opacity: 255, zIndex: 0, precise: null, userData: null, width: 1, height: 1, bitsPerTile: 32, masks: { id: 0xff, xFlip: 0, yFlip: 0, diagonalFlip: 0 }, tiles: Uint32Array.from([1]) }
    const warnings: string[] = []
    renderFrame(makeFile(1, 1, [makeLayer(0, 'map', { type: 'tilemap', tilesetId: 3 })], [[cel]]), 0, { warn: (m) => warnings.push(m) })
    expect(warnings).toEqual(['Layer "map" uses tileset 3, which the file does not have; it is not drawn.'])
  })

  it('refuses a frame the file does not have', () => {
    expect(() => renderFrame(makeFile(1, 1, [], [[]]), 1)).toThrow(RangeError)
  })
})
