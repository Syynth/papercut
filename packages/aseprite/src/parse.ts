/**
 * Bytes to `AsepriteFile`. One pass over the header, then each frame's
 * chunks; every chunk is read inside its own declared bounds, so an unknown or
 * newer chunk is skipped whole and never desynchronises the rest.
 */

import { unzlibSync } from 'fflate'
import { AsepriteError, Reader } from './reader'
import {
  BLEND_MODES,
  type AsepriteFile,
  type BlendMode,
  type Cel,
  type CelBase,
  type ColorMode,
  type ColorProfile,
  type ExternalFile,
  type ExternalFileType,
  type Frame,
  type Layer,
  type LayerType,
  type LoopDirection,
  type PaletteChange,
  type PaletteEntry,
  type Slice,
  type SliceKey,
  type Tag,
  type Tileset,
  type UserData,
} from './types'
import { readUserData } from './user-data'

const FILE_MAGIC = 0xa5e0
const FRAME_MAGIC = 0xf1fa
const HEADER_SIZE = 128

const CHUNK = {
  oldPalette: 0x0004,
  oldPalette64: 0x0011,
  layer: 0x2004,
  cel: 0x2005,
  celExtra: 0x2006,
  colorProfile: 0x2007,
  externalFiles: 0x2008,
  mask: 0x2016,
  path: 0x2017,
  tags: 0x2018,
  palette: 0x2019,
  userData: 0x2020,
  oldSlices: 0x2021,
  slice: 0x2022,
  tileset: 0x2023,
} as const

/** Chunks the format defines but deprecates or never uses; skipping them is not worth a warning. */
const SILENT_SKIPS = new Set<number>([CHUNK.mask, CHUNK.path, CHUNK.oldSlices])

const LOOP_DIRECTIONS: readonly LoopDirection[] = ['forward', 'reverse', 'ping-pong', 'ping-pong-reverse']
const LAYER_TYPES: readonly LayerType[] = ['image', 'group', 'tilemap']
const EXTERNAL_TYPES: readonly ExternalFileType[] = ['palette', 'tileset', 'extension-properties', 'extension-tile-management']

export interface ParseOptions {
  /**
   * Decompress a zlib stream (RFC 1950). Defaults to fflate's `unzlibSync`;
   * supply your own to share a decompressor the host already has.
   */
  inflate?: (data: Uint8Array) => Uint8Array
}

/** Whether `bytes` start like an Aseprite file: the magic number at offset 4. */
export function isAseprite(bytes: Uint8Array): boolean {
  return bytes.length >= 6 && bytes[4] === (FILE_MAGIC & 0xff) && bytes[5] === FILE_MAGIC >> 8
}

/** Parse an `.ase`/`.aseprite` file. Throws `AsepriteError` when the bytes are not one or are cut short. */
export function parseAseprite(bytes: Uint8Array, options: ParseOptions = {}): AsepriteFile {
  const inflate = options.inflate ?? ((data: Uint8Array) => unzlibSync(data))
  const r = new Reader(bytes)
  if (bytes.length < HEADER_SIZE) throw new AsepriteError(`Too short to be an Aseprite file: ${bytes.length} bytes`)
  r.dword() // file size; the frames' own sizes are what matter
  if (r.word() !== FILE_MAGIC) throw new AsepriteError('Not an Aseprite file: the magic number is wrong', 4)
  const frameCount = r.word()
  const width = r.word()
  const height = r.word()
  const depth = r.word()
  const colorMode: ColorMode | undefined = depth === 32 ? 'rgba' : depth === 16 ? 'grayscale' : depth === 8 ? 'indexed' : undefined
  if (colorMode === undefined) throw new AsepriteError(`Unsupported colour depth: ${depth} bits per pixel`, 12)
  const headerFlags = r.dword()
  const speed = r.word()
  r.skip(8)
  const transparent = r.byte()
  r.skip(3)
  const colorCount = r.word()
  const pixelWidth = r.byte()
  const pixelHeight = r.byte()
  const gridX = r.short()
  const gridY = r.short()
  const gridWidth = r.word()
  const gridHeight = r.word()

  const file: AsepriteFile = {
    width,
    height,
    colorMode,
    flags: { layerOpacity: (headerFlags & 1) !== 0, groupBlending: (headerFlags & 2) !== 0, layerUuids: (headerFlags & 4) !== 0 },
    transparentIndex: colorMode === 'indexed' ? transparent : 0,
    colorCount,
    pixelRatio: pixelWidth === 0 || pixelHeight === 0 ? { width: 1, height: 1 } : { width: pixelWidth, height: pixelHeight },
    grid: gridWidth === 0 || gridHeight === 0 ? null : { x: gridX, y: gridY, width: gridWidth, height: gridHeight },
    speed,
    layers: [],
    frames: [],
    tags: [],
    slices: [],
    tilesets: [],
    colorProfile: null,
    externalFiles: [],
    userData: null,
    warnings: [],
  }
  const state: State = { file, inflate, bytesPerPixel: depth / 8, attach: null, levelStack: [], lastCel: null }

  let offset = HEADER_SIZE
  for (let index = 0; index < frameCount; index++) {
    const fr = new Reader(bytes, offset)
    const frameSize = fr.dword()
    if (frameSize < 16 || offset + frameSize > bytes.length) throw new AsepriteError(`Frame ${index} claims ${frameSize} bytes`, offset)
    fr.limit = offset + frameSize
    if (fr.word() !== FRAME_MAGIC) throw new AsepriteError(`Frame ${index} has the wrong magic number`, offset + 4)
    const oldChunks = fr.word()
    const duration = fr.word()
    fr.skip(2)
    const newChunks = fr.dword()
    const chunkCount = newChunks === 0 ? oldChunks : newChunks
    const frame: Frame = { duration: duration > 0 ? duration : speed, cels: [], paletteChanges: [] }
    file.frames.push(frame)
    readChunks(fr, state, frame, index, chunkCount)
    offset += frameSize
  }
  return file
}

interface State {
  file: AsepriteFile
  inflate: (data: Uint8Array) => Uint8Array
  bytesPerPixel: number
  /** Where the next User Data chunk goes: the last object that can carry one. */
  attach: ((data: UserData) => void) | null
  /** The layers along the current branch of the tree, by child level. */
  levelStack: number[]
  /** The cel the last Cel chunk produced, for a Cel Extra chunk to land on. */
  lastCel: Cel | null
}

function readChunks(fr: Reader, state: State, frame: Frame, frameIndex: number, count: number): void {
  const { file } = state
  // Old colour chunks are only a fallback: a frame with a Palette chunk ignores them.
  const oldPalette: PaletteChange[] = []
  let sawPalette = false
  for (let i = 0; i < count; i++) {
    const start = fr.offset
    const size = fr.dword()
    if (size < 6 || start + size > fr.limit) throw new AsepriteError(`Frame ${frameIndex}: a chunk claims ${size} bytes`, start)
    const type = fr.word()
    const r = new Reader(fr.bytes, fr.offset, start + size)
    const warn = (message: string): void => {
      file.warnings.push(`Frame ${frameIndex}: ${message}`)
    }
    switch (type) {
      case CHUNK.oldPalette:
      case CHUNK.oldPalette64:
        oldPalette.push(...readOldPalette(r, type === CHUNK.oldPalette64))
        if (frameIndex === 0) state.attach = (data) => (file.userData = data)
        break
      case CHUNK.palette:
        sawPalette = true
        frame.paletteChanges.push(readPalette(r))
        if (frameIndex === 0) state.attach = (data) => (file.userData = data)
        break
      case CHUNK.layer: {
        const layer = readLayer(r, state, warn)
        file.layers.push(layer)
        state.attach = (data) => (layer.userData = data)
        break
      }
      case CHUNK.cel: {
        const cel = readCel(r, state, frameIndex, warn)
        state.lastCel = cel
        if (cel === null) {
          state.attach = null
          break
        }
        frame.cels.push(cel)
        state.attach = (data) => (cel.userData = data)
        break
      }
      case CHUNK.celExtra: {
        const cel = state.lastCel
        const flags = r.dword()
        const bounds = { x: r.fixed(), y: r.fixed(), width: r.fixed(), height: r.fixed() }
        if (cel !== null && flags & 1) cel.precise = bounds
        break
      }
      case CHUNK.colorProfile:
        file.colorProfile = readColorProfile(r, warn)
        break
      case CHUNK.externalFiles:
        file.externalFiles.push(...readExternalFiles(r, warn))
        break
      case CHUNK.tags: {
        const tags = readTags(r, warn)
        file.tags.push(...tags)
        let next = 0
        state.attach = (data) => {
          const tag = tags[next++]
          if (tag !== undefined) tag.userData = data
        }
        break
      }
      case CHUNK.userData: {
        const data = readUserData(r, warn)
        if (state.attach === null) warn('a User Data chunk follows nothing it can belong to, so it is dropped.')
        else state.attach(data)
        break
      }
      case CHUNK.slice: {
        const slice = readSlice(r)
        file.slices.push(slice)
        state.attach = (data) => (slice.userData = data)
        break
      }
      case CHUNK.tileset: {
        const tileset = readTileset(r, state)
        file.tilesets.push(tileset)
        // The first User Data after a tileset is the tileset's; the rest are its tiles', in order.
        let next = -1
        state.attach = (data) => {
          if (next === -1) tileset.userData = data
          else if (next < tileset.tileCount) tileset.tileUserData[next] = data
          next++
        }
        break
      }
      default:
        if (!SILENT_SKIPS.has(type)) warn(`skipped an unknown chunk of type 0x${type.toString(16).padStart(4, '0')}.`)
    }
    fr.offset = start + size
  }
  if (!sawPalette) frame.paletteChanges.push(...oldPalette)
}

function readOldPalette(r: Reader, sixBit: boolean): PaletteChange[] {
  const changes: PaletteChange[] = []
  const packets = r.word()
  let index = 0
  for (let p = 0; p < packets; p++) {
    index += r.byte()
    const count = r.byte() || 256
    const entries: PaletteEntry[] = []
    for (let c = 0; c < count; c++) {
      const [red, green, blue] = [r.byte(), r.byte(), r.byte()]
      // 0–63 to 0–255 the way Aseprite scales it: shift up, fill the low bits from the top.
      const scale = (v: number): number => (sixBit ? (v << 2) | (v >> 4) : v)
      entries.push({ r: scale(red), g: scale(green), b: scale(blue), a: 255, name: null })
    }
    changes.push({ size: null, from: index, entries })
    index += count
  }
  return changes
}

function readPalette(r: Reader): PaletteChange {
  const size = r.dword()
  const from = r.dword()
  const to = r.dword()
  r.skip(8)
  const entries: PaletteEntry[] = []
  for (let i = from; i <= to; i++) {
    const flags = r.word()
    const entry: PaletteEntry = { r: r.byte(), g: r.byte(), b: r.byte(), a: r.byte(), name: null }
    if (flags & 1) entry.name = r.string()
    entries.push(entry)
  }
  return { size, from, entries }
}

function blendMode(value: number, warn: (message: string) => void, what: string): BlendMode {
  const mode = BLEND_MODES[value]
  if (mode !== undefined) return mode
  warn(`${what} has unknown blend mode ${value}; it is read as normal.`)
  return 'normal'
}

function readLayer(r: Reader, state: State, warn: (message: string) => void): Layer {
  const { file } = state
  const flags = r.word()
  const typeValue = r.word()
  const childLevel = r.word()
  r.skip(4) // default width and height, ignored by the format
  const blendValue = r.word()
  const opacity = r.byte()
  r.skip(3)
  const name = r.string()
  const index = file.layers.length
  const type = LAYER_TYPES[typeValue]
  if (type === undefined) throw new AsepriteError(`Layer "${name}" has unknown type ${typeValue}`, r.offset)
  const tilesetId = type === 'tilemap' ? r.dword() : null
  const uuid = file.flags.layerUuids && r.remaining >= 16 ? r.bytesOf(16) : null

  // The child level says how deep this layer sits; the stack holds the
  // layer seen last at each depth, so the parent is the one a level up.
  const stack = state.levelStack
  stack.length = Math.min(stack.length, childLevel)
  const parent = childLevel === 0 ? null : (stack[childLevel - 1] ?? null)
  if (childLevel > 0 && (parent === null || file.layers[parent]?.type !== 'group')) {
    warn(`layer "${name}" is nested under something that is not a group; it is treated as top-level.`)
  }
  stack[childLevel] = index

  return {
    index,
    name,
    type,
    flags: {
      visible: (flags & 1) !== 0,
      editable: (flags & 2) !== 0,
      lockMovement: (flags & 4) !== 0,
      background: (flags & 8) !== 0,
      preferLinkedCels: (flags & 16) !== 0,
      collapsed: (flags & 32) !== 0,
      reference: (flags & 64) !== 0,
    },
    childLevel,
    parent: parent !== null && file.layers[parent]?.type === 'group' ? parent : null,
    blendMode: blendMode(blendValue, warn, `Layer "${name}"`),
    opacity,
    tilesetId,
    uuid,
    userData: null,
  }
}

function readCel(r: Reader, state: State, frame: number, warn: (message: string) => void): Cel | null {
  const layer = r.word()
  const base: CelBase = { layer, frame, x: r.short(), y: r.short(), opacity: r.byte(), zIndex: 0, precise: null, userData: null }
  const type = r.word()
  base.zIndex = r.short()
  r.skip(5)
  if (state.file.layers[layer] === undefined) {
    warn(`a cel refers to layer ${layer}, which does not exist; it is dropped.`)
    return null
  }
  switch (type) {
    case 0: {
      const width = r.word()
      const height = r.word()
      return { ...base, kind: 'image', width, height, pixels: r.bytesOf(width * height * state.bytesPerPixel) }
    }
    case 1:
      return { ...base, kind: 'linked', linkedFrame: r.word() }
    case 2: {
      const width = r.word()
      const height = r.word()
      const pixels = inflateExactly(state, r, width * height * state.bytesPerPixel, `Frame ${frame}, layer ${layer}: cel`)
      return { ...base, kind: 'image', width, height, pixels }
    }
    case 3: {
      const width = r.word()
      const height = r.word()
      const bitsPerTile = r.word()
      const masks = { id: r.dword(), xFlip: r.dword(), yFlip: r.dword(), diagonalFlip: r.dword() }
      r.skip(10)
      if (bitsPerTile !== 8 && bitsPerTile !== 16 && bitsPerTile !== 32) {
        warn(`a tilemap cel uses ${bitsPerTile} bits a tile, which the format does not define; it is dropped.`)
        return null
      }
      const raw = inflateExactly(state, r, width * height * (bitsPerTile / 8), `Frame ${frame}, layer ${layer}: tilemap`)
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
      const tiles = new Uint32Array(width * height)
      for (let i = 0; i < tiles.length; i++) {
        tiles[i] = bitsPerTile === 32 ? view.getUint32(i * 4, true) : bitsPerTile === 16 ? view.getUint16(i * 2, true) : view.getUint8(i)
      }
      return { ...base, kind: 'tilemap', width, height, bitsPerTile, masks, tiles }
    }
    default:
      warn(`a cel has unknown type ${type}; it is dropped.`)
      return null
  }
}

/** Inflate the rest of the chunk, and insist it holds exactly as many bytes as the image needs. */
function inflateExactly(state: State, r: Reader, expected: number, what: string): Uint8Array {
  const at = r.offset
  let out: Uint8Array
  try {
    out = state.inflate(r.view8(r.remaining))
  } catch (error) {
    throw new AsepriteError(`${what}: the compressed data is corrupt (${error instanceof Error ? error.message : String(error)})`, at)
  }
  if (out.length < expected) throw new AsepriteError(`${what}: expected ${expected} bytes of pixels, found ${out.length}`, at)
  return out.length === expected ? out : out.slice(0, expected)
}

function readColorProfile(r: Reader, warn: (message: string) => void): ColorProfile {
  const type = r.word()
  const flags = r.word()
  const fixedGamma = r.fixed()
  r.skip(8)
  const gamma = flags & 1 ? fixedGamma : null
  switch (type) {
    case 0:
      return { kind: 'none', gamma }
    case 1:
      return { kind: 'srgb', gamma }
    case 2:
      return { kind: 'icc', gamma, icc: r.bytesOf(r.dword()) }
    default:
      warn(`unknown colour profile type ${type}; it is read as none.`)
      return { kind: 'none', gamma }
  }
}

function readExternalFiles(r: Reader, warn: (message: string) => void): ExternalFile[] {
  const count = r.dword()
  r.skip(8)
  const files: ExternalFile[] = []
  for (let i = 0; i < count; i++) {
    const id = r.dword()
    const typeValue = r.byte()
    r.skip(7)
    const name = r.string()
    const type = EXTERNAL_TYPES[typeValue]
    if (type === undefined) warn(`external file "${name}" has unknown type ${typeValue}; it is dropped.`)
    else files.push({ id, type, name })
  }
  return files
}

function readTags(r: Reader, warn: (message: string) => void): Tag[] {
  const count = r.word()
  r.skip(8)
  const tags: Tag[] = []
  for (let i = 0; i < count; i++) {
    const from = r.word()
    const to = r.word()
    const directionValue = r.byte()
    const repeat = r.word()
    r.skip(6)
    const color = { r: r.byte(), g: r.byte(), b: r.byte(), a: 255 }
    r.skip(1)
    const name = r.string()
    const direction = LOOP_DIRECTIONS[directionValue]
    if (direction === undefined) warn(`tag "${name}" has unknown direction ${directionValue}; it is read as forward.`)
    tags.push({ name, from, to, direction: direction ?? 'forward', repeat, color, userData: null })
  }
  return tags
}

function readSlice(r: Reader): Slice {
  const count = r.dword()
  const flags = r.dword()
  r.skip(4)
  const name = r.string()
  const ninePatch = (flags & 1) !== 0
  const hasPivot = (flags & 2) !== 0
  const keys: SliceKey[] = []
  for (let i = 0; i < count; i++) {
    const frame = r.dword()
    const bounds = { x: r.long(), y: r.long(), width: r.dword(), height: r.dword() }
    const center = ninePatch ? { x: r.long(), y: r.long(), width: r.dword(), height: r.dword() } : null
    const pivot = hasPivot ? { x: r.long(), y: r.long() } : null
    keys.push({ frame, bounds, center, pivot })
  }
  keys.sort((a, b) => a.frame - b.frame)
  return { name, ninePatch, hasPivot, keys, userData: null }
}

function readTileset(r: Reader, state: State): Tileset {
  const id = r.dword()
  const flags = r.dword()
  const tileCount = r.dword()
  const tileWidth = r.word()
  const tileHeight = r.word()
  const baseIndex = r.short()
  r.skip(14)
  const name = r.string()
  const external = flags & 1 ? { fileId: r.dword(), tilesetId: r.dword() } : null
  let pixels: Uint8Array | null = null
  if (flags & 2) {
    const length = r.dword()
    const compressed = new Reader(r.bytes, r.offset, r.offset + length)
    pixels = inflateExactly(state, compressed, tileWidth * tileHeight * tileCount * state.bytesPerPixel, `Tileset "${name}"`)
    r.skip(length)
  }
  return {
    id,
    name,
    tileWidth,
    tileHeight,
    tileCount,
    baseIndex,
    zeroIsEmpty: (flags & 4) !== 0,
    matchFlips: { x: (flags & 8) !== 0, y: (flags & 16) !== 0, diagonal: (flags & 32) !== 0 },
    external,
    pixels,
    userData: null,
    tileUserData: [],
  }
}
