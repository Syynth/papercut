import { unzlibSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { AsepriteError, childrenOf, decodeTile, isAseprite, isVisibleInTree, paletteAt, parseAseprite, resolveCel } from './index'
import {
  Bytes,
  TILE_MASKS,
  celExtra,
  chunk,
  imageCel,
  layer,
  linkedCel,
  oldPalette,
  palette,
  slice,
  tags,
  tilemapCel,
  tileset,
  userData,
  writeAseprite,
} from './testing/writer'

const red = [255, 0, 0, 255]
const pixels = (count: number, px: number[]): number[] => Array.from({ length: count }, () => px).flat()

describe('parseAseprite: header', () => {
  it('reads size, colour mode, flags, ratio and grid', () => {
    const file = parseAseprite(
      writeAseprite({ width: 32, height: 24, depth: 16, flags: 1 | 2 | 4, speed: 80, pixelRatio: [2, 1], grid: [3, -4, 8, 12], frames: [{ chunks: [] }] }),
    )
    expect(file).toMatchObject({
      width: 32,
      height: 24,
      colorMode: 'grayscale',
      flags: { layerOpacity: true, groupBlending: true, layerUuids: true },
      pixelRatio: { width: 2, height: 1 },
      grid: { x: 3, y: -4, width: 8, height: 12 },
      speed: 80,
      warnings: [],
    })
  })

  it('has no grid when either grid dimension is zero, and a 1:1 ratio when unset', () => {
    const file = parseAseprite(writeAseprite({ width: 4, height: 4, pixelRatio: [0, 0], grid: [0, 0, 0, 16], frames: [{ chunks: [] }] }))
    expect(file.grid).toBeNull()
    expect(file.pixelRatio).toEqual({ width: 1, height: 1 })
  })

  it('keeps the transparent index only for indexed files', () => {
    expect(parseAseprite(writeAseprite({ width: 1, height: 1, depth: 8, transparentIndex: 7, frames: [] })).transparentIndex).toBe(7)
    expect(parseAseprite(writeAseprite({ width: 1, height: 1, depth: 32, transparentIndex: 7, frames: [] })).transparentIndex).toBe(0)
  })

  it('recognises the magic number, and refuses anything else', () => {
    const bytes = writeAseprite({ width: 1, height: 1, frames: [] })
    expect(isAseprite(bytes)).toBe(true)
    expect(isAseprite(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe(false)
    const wrong = bytes.slice()
    wrong[4] = 0
    expect(() => parseAseprite(wrong)).toThrow(AsepriteError)
    expect(() => parseAseprite(bytes.subarray(0, 60))).toThrow(/Too short/)
  })

  it('refuses an unknown colour depth', () => {
    const bytes = writeAseprite({ width: 1, height: 1, frames: [] })
    bytes[12] = 24
    expect(() => parseAseprite(bytes)).toThrow(/colour depth: 24/)
  })
})

describe('parseAseprite: frames', () => {
  it('uses the header speed for a frame with no duration of its own', () => {
    const file = parseAseprite(writeAseprite({ width: 1, height: 1, speed: 125, frames: [{ duration: 0, chunks: [] }, { duration: 40, chunks: [] }] }))
    expect(file.frames.map((f) => f.duration)).toEqual([125, 40])
  })

  it('falls back to the old chunk count when the new one is zero', () => {
    const file = parseAseprite(writeAseprite({ width: 1, height: 1, frames: [{ chunks: [layer({ name: 'a' })], oldChunkCountOnly: true }] }))
    expect(file.layers.map((l) => l.name)).toEqual(['a'])
  })

  it('refuses a frame that claims more bytes than the file has', () => {
    const bytes = writeAseprite({ width: 1, height: 1, frames: [{ chunks: [layer({ name: 'a' })] }] })
    new DataView(bytes.buffer).setUint32(128, 99999, true)
    expect(() => parseAseprite(bytes)).toThrow(/Frame 0 claims 99999 bytes/)
  })

  it('refuses a chunk that runs past its frame', () => {
    const bytes = writeAseprite({ width: 1, height: 1, frames: [{ chunks: [layer({ name: 'a' })] }] })
    new DataView(bytes.buffer).setUint32(128 + 16, 5000, true)
    expect(() => parseAseprite(bytes)).toThrow(/a chunk claims 5000 bytes/)
  })

  it('skips an unknown chunk whole, with a warning, and reads the next one', () => {
    const file = parseAseprite(
      writeAseprite({ width: 1, height: 1, frames: [{ chunks: [chunk(0x7777, (b) => b.dword(1).dword(2)), layer({ name: 'after' })] }] }),
    )
    expect(file.layers.map((l) => l.name)).toEqual(['after'])
    expect(file.warnings).toEqual(['Frame 0: skipped an unknown chunk of type 0x7777.'])
  })

  it('skips the deprecated mask and path chunks silently', () => {
    const file = parseAseprite(writeAseprite({ width: 1, height: 1, frames: [{ chunks: [chunk(0x2016, (b) => b.zeros(10)), chunk(0x2017, () => undefined)] }] }))
    expect(file.warnings).toEqual([])
  })
})

describe('parseAseprite: layers', () => {
  const file = parseAseprite(
    writeAseprite({
      width: 1,
      height: 1,
      flags: 1 | 4,
      frames: [
        {
          chunks: [
            layer({ name: 'Background', flags: 1 | 2 | 8, uuid: pixels(16, [1]) }),
            layer({ name: 'Group', type: 1, flags: 1 | 32, uuid: pixels(16, [2]) }),
            layer({ name: 'Inner', childLevel: 1, blendMode: 1, opacity: 128, uuid: pixels(16, [3]) }),
            layer({ name: 'Hidden group', type: 1, childLevel: 1, flags: 0, uuid: pixels(16, [4]) }),
            layer({ name: 'Deep', childLevel: 2, uuid: pixels(16, [5]) }),
            layer({ name: 'Reference', flags: 1 | 64, uuid: pixels(16, [6]) }),
          ],
        },
      ],
    }),
  )

  it('reads names, types, flags, blend modes, opacity and UUIDs', () => {
    expect(file.layers.map((l) => [l.name, l.type, l.blendMode, l.opacity])).toEqual([
      ['Background', 'image', 'normal', 255],
      ['Group', 'group', 'normal', 255],
      ['Inner', 'image', 'multiply', 128],
      ['Hidden group', 'group', 'normal', 255],
      ['Deep', 'image', 'normal', 255],
      ['Reference', 'image', 'normal', 255],
    ])
    expect(file.layers[0]?.flags).toMatchObject({ visible: true, editable: true, background: true, reference: false })
    expect(file.layers[1]?.flags.collapsed).toBe(true)
    expect(file.layers[5]?.flags.reference).toBe(true)
    expect([...(file.layers[4]?.uuid ?? [])]).toEqual(pixels(16, [5]))
  })

  it('builds the tree from child levels', () => {
    expect(file.layers.map((l) => l.parent)).toEqual([null, null, 1, 1, 3, null])
    expect(childrenOf(file, null).map((l) => l.name)).toEqual(['Background', 'Group', 'Reference'])
    expect(childrenOf(file, file.layers[1] ?? null).map((l) => l.name)).toEqual(['Inner', 'Hidden group'])
  })

  it('hides a layer whose group is hidden', () => {
    expect(file.layers.map((l) => isVisibleInTree(file, l))).toEqual([true, true, true, false, false, true])
  })

  it('treats a layer nested under a non-group as top-level, with a warning', () => {
    const odd = parseAseprite(writeAseprite({ width: 1, height: 1, frames: [{ chunks: [layer({ name: 'a' }), layer({ name: 'b', childLevel: 1 })] }] }))
    expect(odd.layers[1]?.parent).toBeNull()
    expect(odd.warnings[0]).toMatch(/"b" is nested under something that is not a group/)
  })

  it('reads an unknown blend mode as normal, with a warning', () => {
    const odd = parseAseprite(writeAseprite({ width: 1, height: 1, frames: [{ chunks: [layer({ name: 'a', blendMode: 40 })] }] }))
    expect(odd.layers[0]?.blendMode).toBe('normal')
    expect(odd.warnings).toEqual(['Frame 0: Layer "a" has unknown blend mode 40; it is read as normal.'])
  })

  it('reads a UTF-8 name', () => {
    expect(parseAseprite(writeAseprite({ width: 1, height: 1, frames: [{ chunks: [layer({ name: 'hé 🌱' })] }] })).layers[0]?.name).toBe('hé 🌱')
  })
})

describe('parseAseprite: cels', () => {
  const file = parseAseprite(
    writeAseprite({
      width: 4,
      height: 4,
      frames: [
        {
          chunks: [
            layer({ name: 'a' }),
            layer({ name: 'b' }),
            imageCel({ layer: 0, x: -1, y: 2, opacity: 200, zIndex: -1, width: 2, height: 1, pixels: [...red, 0, 0, 255, 255] }),
            celExtra(0.5, 1.25, 2, 1),
            imageCel({ layer: 1, width: 1, height: 1, pixels: red, raw: true }),
          ],
        },
        { chunks: [linkedCel({ layer: 0, frame: 0, x: 3, opacity: 100 })] },
      ],
    }),
  )

  it('reads compressed and raw image cels', () => {
    const [a, b] = file.frames[0]?.cels ?? []
    expect(a).toMatchObject({ kind: 'image', layer: 0, frame: 0, x: -1, y: 2, opacity: 200, zIndex: -1, width: 2, height: 1 })
    expect(a?.kind === 'image' && [...a.pixels]).toEqual([...red, 0, 0, 255, 255])
    expect(b).toMatchObject({ kind: 'image', layer: 1, width: 1, height: 1 })
  })

  it('puts a Cel Extra chunk on the cel before it', () => {
    expect(file.frames[0]?.cels[0]?.precise).toEqual({ x: 0.5, y: 1.25, width: 2, height: 1 })
    expect(file.frames[0]?.cels[1]?.precise).toBeNull()
  })

  it('keeps a linked cel a link, and resolves it to the content at its own placement', () => {
    expect(file.frames[1]?.cels[0]).toMatchObject({ kind: 'linked', linkedFrame: 0 })
    const resolved = resolveCel(file, 0, 1)
    expect(resolved).toMatchObject({ kind: 'image', frame: 1, x: 3, y: 0, opacity: 100, width: 2 })
    expect(resolveCel(file, 1, 1)).toBeNull()
  })

  it('resolves a link cycle to nothing instead of looping', () => {
    const cyclic = parseAseprite(
      writeAseprite({ width: 1, height: 1, frames: [{ chunks: [layer({ name: 'a' }), linkedCel({ layer: 0, frame: 1 })] }, { chunks: [linkedCel({ layer: 0, frame: 0 })] }] }),
    )
    expect(resolveCel(cyclic, 0, 0)).toBeNull()
  })

  it('drops a cel for a layer that does not exist, with a warning', () => {
    const odd = parseAseprite(writeAseprite({ width: 1, height: 1, frames: [{ chunks: [imageCel({ layer: 3, width: 1, height: 1, pixels: red })] }] }))
    expect(odd.frames[0]?.cels).toEqual([])
    expect(odd.warnings[0]).toMatch(/layer 3, which does not exist/)
  })

  it('refuses a compressed cel with too few pixels when its pixels are read', () => {
    const bytes = writeAseprite({ width: 4, height: 4, frames: [{ chunks: [layer({ name: 'a' }), imageCel({ layer: 0, width: 2, height: 2, pixels: red })] }] })
    const cel = parseAseprite(bytes).frames[0]?.cels[0]
    expect(() => cel?.kind === 'image' && cel.pixels).toThrow(/expected 16 bytes of pixels, found 4/)
  })

  it('inflates a cel once, on first read, and never touches the caller’s buffer again', () => {
    const bytes = writeAseprite({ width: 1, height: 1, frames: [{ chunks: [layer({ name: 'a' }), imageCel({ layer: 0, width: 1, height: 1, pixels: red })] }] })
    let inflated = 0
    const file = parseAseprite(bytes, { inflate: (data) => (inflated++, unzlibSync(data)) })
    expect(inflated).toBe(0)
    bytes.fill(0)
    const cel = file.frames[0]?.cels[0]
    if (cel?.kind !== 'image') throw new Error('not an image cel')
    expect([...cel.pixels]).toEqual(red)
    expect(cel.pixels).toBe(cel.pixels)
    expect(inflated).toBe(1)
  })

  it('reads grayscale and indexed pixels at their own widths', () => {
    const gray = parseAseprite(writeAseprite({ width: 2, height: 1, depth: 16, frames: [{ chunks: [layer({ name: 'a' }), imageCel({ layer: 0, width: 2, height: 1, pixels: [9, 255, 7, 0] })] }] }))
    expect(gray.frames[0]?.cels[0]).toMatchObject({ kind: 'image', pixels: Uint8Array.from([9, 255, 7, 0]) })
    const indexed = parseAseprite(writeAseprite({ width: 2, height: 1, depth: 8, frames: [{ chunks: [layer({ name: 'a' }), imageCel({ layer: 0, width: 2, height: 1, pixels: [3, 4] })] }] }))
    expect(indexed.frames[0]?.cels[0]).toMatchObject({ kind: 'image', pixels: Uint8Array.from([3, 4]) })
  })
})

describe('parseAseprite: tilemaps and tilesets', () => {
  const tilePixels = [...pixels(4, red), ...pixels(4, [0, 255, 0, 255])]
  const file = parseAseprite(
    writeAseprite({
      width: 4,
      height: 2,
      frames: [
        {
          chunks: [
            tileset({ id: 0, name: 'ground', tileWidth: 2, tileHeight: 2, tileCount: 2, pixels: tilePixels }),
            userData({ text: 'the set' }),
            userData({ text: 'tile 0' }),
            userData({ text: 'tile 1' }),
            layer({ name: 'map', type: 2, tilesetId: 0 }),
            tilemapCel({ layer: 0, width: 2, height: 1, tiles: [1, 0 | TILE_MASKS.xFlip | TILE_MASKS.diagonalFlip] }),
          ],
        },
      ],
    }),
  )

  it('reads the tileset, its pixels and its user data', () => {
    const [set] = file.tilesets
    expect(set).toMatchObject({ id: 0, name: 'ground', tileWidth: 2, tileHeight: 2, tileCount: 2, zeroIsEmpty: true, baseIndex: 1, external: null })
    expect([...(set?.pixels ?? [])]).toEqual(tilePixels)
    expect(set?.userData?.text).toBe('the set')
    expect(set?.tileUserData.map((u) => u?.text)).toEqual(['tile 0', 'tile 1'])
  })

  it('reads the tilemap layer and its cel', () => {
    expect(file.layers[0]).toMatchObject({ type: 'tilemap', tilesetId: 0 })
    const cel = file.frames[0]?.cels[0]
    expect(cel).toMatchObject({ kind: 'tilemap', width: 2, height: 1, bitsPerTile: 32, masks: TILE_MASKS })
    if (cel?.kind !== 'tilemap') throw new Error('not a tilemap')
    expect(decodeTile(cel.tiles[0] ?? 0, cel.masks)).toEqual({ index: 1, xFlip: false, yFlip: false, diagonalFlip: false })
    expect(decodeTile(cel.tiles[1] ?? 0, cel.masks)).toEqual({ index: 0, xFlip: true, yFlip: false, diagonalFlip: true })
  })

  it('reads 8- and 16-bit tiles', () => {
    for (const bitsPerTile of [8, 16] as const) {
      const small = parseAseprite(
        writeAseprite({
          width: 2,
          height: 2,
          frames: [{ chunks: [tileset({ id: 0, name: 't', tileWidth: 1, tileHeight: 1, tileCount: 1, pixels: red }), layer({ name: 'm', type: 2 }), tilemapCel({ layer: 0, width: 2, height: 1, tiles: [1, 0], bitsPerTile })] }],
        }),
      )
      const cel = small.frames[0]?.cels[0]
      expect(cel?.kind === 'tilemap' && [...cel.tiles]).toEqual([1, 0])
    }
  })

  it('reads a tileset that lives in an external file', () => {
    const ext = parseAseprite(writeAseprite({ width: 1, height: 1, frames: [{ chunks: [tileset({ id: 3, name: 'x', tileWidth: 8, tileHeight: 8, tileCount: 10, external: [5, 2] })] }] }))
    expect(ext.tilesets[0]).toMatchObject({ id: 3, external: { fileId: 5, tilesetId: 2 }, pixels: null })
  })
})

describe('parseAseprite: palettes', () => {
  it('reads a Palette chunk with names, and ignores the old chunk beside it', () => {
    const file = parseAseprite(
      writeAseprite({ width: 1, height: 1, depth: 8, frames: [{ chunks: [oldPalette([{ skip: 0, colors: [[1, 2, 3]] }]), palette([[10, 20, 30, 255], [40, 50, 60, 128, 'glass']])] }] }),
    )
    expect(paletteAt(file, 0)).toEqual([
      { r: 10, g: 20, b: 30, a: 255, name: null },
      { r: 40, g: 50, b: 60, a: 128, name: 'glass' },
    ])
  })

  it('falls back to the old chunks, scaling six-bit colours to eight', () => {
    const file = parseAseprite(writeAseprite({ width: 1, height: 1, depth: 8, frames: [{ chunks: [oldPalette([{ skip: 1, colors: [[63, 0, 32]] }], true)] }] }))
    expect(paletteAt(file, 0)).toEqual([
      { r: 0, g: 0, b: 0, a: 255, name: null },
      { r: 255, g: 0, b: 130, a: 255, name: null },
    ])
  })

  it('applies later frames’ changes on top of earlier ones', () => {
    const file = parseAseprite(
      writeAseprite({ width: 1, height: 1, depth: 8, frames: [{ chunks: [palette([[1, 1, 1, 255], [2, 2, 2, 255]])] }, { chunks: [] }, { chunks: [palette([[9, 9, 9, 255]], 1, 3)] }] }),
    )
    expect(paletteAt(file, 1).map((e) => e.r)).toEqual([1, 2])
    expect(paletteAt(file, 2).map((e) => e.r)).toEqual([1, 9, 0])
  })
})

describe('parseAseprite: tags, slices and user data', () => {
  it('reads tags and gives each the user data that follows, in order', () => {
    const file = parseAseprite(
      writeAseprite({
        width: 1,
        height: 1,
        frames: [
          {
            chunks: [
              tags([
                { name: 'walk', from: 0, to: 3, direction: 2, repeat: 4, color: [1, 2, 3] },
                { name: 'idle', from: 4, to: 4 },
              ]),
              userData({ color: [9, 8, 7, 255] }),
              userData({ text: 'idle notes' }),
            ],
          },
        ],
      }),
    )
    expect(file.tags).toMatchObject([
      { name: 'walk', from: 0, to: 3, direction: 'ping-pong', repeat: 4, color: { r: 1, g: 2, b: 3, a: 255 }, userData: { color: { r: 9, g: 8, b: 7, a: 255 } } },
      { name: 'idle', from: 4, to: 4, direction: 'forward', repeat: 0, userData: { text: 'idle notes' } },
    ])
  })

  it('reads slices with nine-patch centres and pivots, keys sorted by frame', () => {
    const file = parseAseprite(
      writeAseprite({
        width: 1,
        height: 1,
        frames: [
          {
            chunks: [
              slice('door', [
                { frame: 2, bounds: [5, 6, 7, 8], center: [1, 1, 5, 6], pivot: [3, 8] },
                { frame: 0, bounds: [-1, 0, 16, 32] },
              ]),
              userData({ text: 'hinge left' }),
            ],
          },
        ],
      }),
    )
    expect(file.slices[0]).toEqual({
      name: 'door',
      ninePatch: true,
      hasPivot: true,
      keys: [
        { frame: 0, bounds: { x: -1, y: 0, width: 16, height: 32 }, center: { x: 0, y: 0, width: 0, height: 0 }, pivot: { x: 0, y: 0 } },
        { frame: 2, bounds: { x: 5, y: 6, width: 7, height: 8 }, center: { x: 1, y: 1, width: 5, height: 6 }, pivot: { x: 3, y: 8 } },
      ],
      userData: { text: 'hinge left', color: null, properties: new Map() },
    })
  })

  it('gives the sprite the user data that follows the first palette', () => {
    const file = parseAseprite(writeAseprite({ width: 1, height: 1, frames: [{ chunks: [palette([[0, 0, 0, 255]]), userData({ text: 'sprite' }), layer({ name: 'a' }), userData({ text: 'layer' })] }] }))
    expect(file.userData?.text).toBe('sprite')
    expect(file.layers[0]?.userData?.text).toBe('layer')
  })

  it('drops user data that follows nothing, with a warning', () => {
    const file = parseAseprite(writeAseprite({ width: 1, height: 1, frames: [{ chunks: [userData({ text: 'orphan' })] }] }))
    expect(file.warnings).toEqual(['Frame 0: a User Data chunk follows nothing it can belong to, so it is dropped.'])
  })

  it('reads every property type, nested maps and vectors included', () => {
    const body = new Bytes()
      .dword(0) // user properties
      .dword(8)
      .string('flag')
      .word(0x01)
      .byte(1)
      .string('small')
      .word(0x02)
      .byte(0xff)
      .string('wide')
      .word(0x08)
      .dword(0xffffffff)
      .dword(0xffffffff)
      .string('ratio')
      .word(0x0a)
      .fixed(1.5)
      .string('label')
      .word(0x0d)
      .string('hi')
      .string('box')
      .word(0x10)
      .long(1)
      .long(-2)
      .long(3)
      .long(4)
      .string('list')
      .word(0x11)
      .dword(2)
      .word(0)
      .word(0x05)
      .word(7)
      .word(0x0d)
      .string('x')
      .string('nested')
      .word(0x12)
      .dword(1)
      .string('inner')
      .word(0x03)
      .byte(200)
    const file = parseAseprite(writeAseprite({ width: 1, height: 1, frames: [{ chunks: [layer({ name: 'a' }), userData({ properties: { count: 1, body: body.build() } })] }] }))
    const props = file.layers[0]?.userData?.properties.get(0)
    expect(props).toEqual(
      new Map<string, unknown>([
        ['flag', { type: 'bool', value: true }],
        ['small', { type: 'int8', value: -1 }],
        ['wide', { type: 'int64', value: -1n }],
        ['ratio', { type: 'fixed', value: 1.5 }],
        ['label', { type: 'string', value: 'hi' }],
        ['box', { type: 'rect', value: { x: 1, y: -2, width: 3, height: 4 } }],
        [
          'list',
          {
            type: 'vector',
            value: [
              { type: 'uint16', value: 7 },
              { type: 'string', value: 'x' },
            ],
          },
        ],
        ['nested', { type: 'map', value: new Map([['inner', { type: 'uint8', value: 200 }]]) }],
      ]),
    )
  })

  it('keeps reading after a property type it does not know', () => {
    const body = new Bytes().dword(0).dword(2).string('ok').word(0x03).byte(1).string('future').word(0x99).dword(0)
    const file = parseAseprite(
      writeAseprite({ width: 1, height: 1, frames: [{ chunks: [layer({ name: 'a' }), userData({ text: 't', properties: { count: 1, body: body.build() } }), layer({ name: 'b' })] }] }),
    )
    expect(file.layers.map((l) => l.name)).toEqual(['a', 'b'])
    expect(file.layers[0]?.userData?.text).toBe('t')
    expect(file.warnings[0]).toMatch(/Unknown user data property type 0x99/)
  })
})

describe('parseAseprite: colour profile and external files', () => {
  it('reads both', () => {
    const file = parseAseprite(
      writeAseprite({
        width: 1,
        height: 1,
        frames: [
          {
            chunks: [
              chunk(0x2007, (b) => b.word(2).word(1).fixed(2.2).zeros(8).dword(3).bytes([7, 8, 9])),
              chunk(0x2008, (b) => b.dword(2).zeros(8).dword(1).byte(1).zeros(7).string('tiles.aseprite').dword(4).byte(2).zeros(7).string('me/Ext')),
            ],
          },
        ],
      }),
    )
    expect(file.colorProfile?.kind).toBe('icc')
    expect(file.colorProfile?.gamma).toBeCloseTo(2.2, 4)
    expect(file.colorProfile?.kind === 'icc' && [...file.colorProfile.icc]).toEqual([7, 8, 9])
    expect(file.externalFiles).toEqual([
      { id: 1, type: 'tileset', name: 'tiles.aseprite' },
      { id: 4, type: 'extension-properties', name: 'me/Ext' },
    ])
  })
})
