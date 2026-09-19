/**
 * Builds `.aseprite` bytes for tests, chunk by chunk, following the spec.
 *
 * Tests need files Aseprite 1.2 cannot make (tilemaps, z-indexes, property
 * maps) and malformed ones Aseprite never makes. Writing them from a
 * description keeps each test's input next to its assertion instead of in a
 * binary fixture nobody can read. Not published; `tsconfig.json` leaves it out.
 */

import { zlibSync } from 'fflate'

interface Utf8 {
  TextEncoder: new () => { encode(input: string): Uint8Array }
}

const utf8 = new (globalThis as unknown as Utf8).TextEncoder()

export class Bytes {
  private out: number[] = []

  byte(v: number): this {
    this.out.push(v & 0xff)
    return this
  }
  word(v: number): this {
    return this.byte(v).byte(v >> 8)
  }
  short(v: number): this {
    return this.word(v & 0xffff)
  }
  dword(v: number): this {
    return this.word(v & 0xffff).word((v >>> 16) & 0xffff)
  }
  long(v: number): this {
    return this.dword(v >>> 0)
  }
  fixed(v: number): this {
    return this.long(Math.round(v * 65536))
  }
  zeros(n: number): this {
    for (let i = 0; i < n; i++) this.byte(0)
    return this
  }
  bytes(data: ArrayLike<number>): this {
    for (let i = 0; i < data.length; i++) this.byte(data[i] ?? 0)
    return this
  }
  string(s: string): this {
    const encoded = utf8.encode(s)
    return this.word(encoded.length).bytes(encoded)
  }
  get length(): number {
    return this.out.length
  }
  build(): Uint8Array {
    return Uint8Array.from(this.out)
  }
}

export interface Chunk {
  type: number
  data: Uint8Array
}

export function chunk(type: number, fill: (b: Bytes) => void): Chunk {
  const b = new Bytes()
  fill(b)
  return { type, data: b.build() }
}

export interface FileSpec {
  width: number
  height: number
  depth?: 32 | 16 | 8
  /** Header flags; defaults to 1 (layer opacity valid), as every modern file sets. */
  flags?: number
  speed?: number
  transparentIndex?: number
  colorCount?: number
  pixelRatio?: [number, number]
  grid?: [number, number, number, number]
  frames: Array<{ duration?: number; chunks: Chunk[]; oldChunkCountOnly?: boolean }>
}

export function writeAseprite(spec: FileSpec): Uint8Array {
  const frames = spec.frames.map((frame) => {
    const body = new Bytes()
    for (const c of frame.chunks) body.dword(c.data.length + 6).word(c.type).bytes(c.data)
    const header = new Bytes()
      .dword(body.length + 16)
      .word(0xf1fa)
      .word(Math.min(frame.chunks.length, 0xffff))
      .word(frame.duration ?? 100)
      .zeros(2)
      .dword(frame.oldChunkCountOnly === true ? 0 : frame.chunks.length)
    return [...header.build(), ...body.build()]
  })
  const size = 128 + frames.reduce((n, f) => n + f.length, 0)
  const [gx, gy, gw, gh] = spec.grid ?? [0, 0, 16, 16]
  const header = new Bytes()
    .dword(size)
    .word(0xa5e0)
    .word(spec.frames.length)
    .word(spec.width)
    .word(spec.height)
    .word(spec.depth ?? 32)
    .dword(spec.flags ?? 1)
    .word(spec.speed ?? 100)
    .zeros(8)
    .byte(spec.transparentIndex ?? 0)
    .zeros(3)
    .word(spec.colorCount ?? 0)
    .byte(spec.pixelRatio?.[0] ?? 1)
    .byte(spec.pixelRatio?.[1] ?? 1)
    .short(gx)
    .short(gy)
    .word(gw)
    .word(gh)
    .zeros(84)
  return Uint8Array.from([...header.build(), ...frames.flat()])
}

export interface LayerSpec {
  name: string
  type?: 0 | 1 | 2
  /** Defaults to visible + editable (3). */
  flags?: number
  childLevel?: number
  blendMode?: number
  opacity?: number
  tilesetId?: number
  uuid?: number[]
}

export const layer = (l: LayerSpec): Chunk =>
  chunk(0x2004, (b) => {
    b.word(l.flags ?? 3)
      .word(l.type ?? 0)
      .word(l.childLevel ?? 0)
      .word(0)
      .word(0)
      .word(l.blendMode ?? 0)
      .byte(l.opacity ?? 255)
      .zeros(3)
      .string(l.name)
    if ((l.type ?? 0) === 2) b.dword(l.tilesetId ?? 0)
    if (l.uuid !== undefined) b.bytes(l.uuid)
  })

export interface CelSpec {
  layer: number
  x?: number
  y?: number
  opacity?: number
  zIndex?: number
}

function celHeader(b: Bytes, c: CelSpec, type: number): Bytes {
  return b
    .word(c.layer)
    .short(c.x ?? 0)
    .short(c.y ?? 0)
    .byte(c.opacity ?? 255)
    .word(type)
    .short(c.zIndex ?? 0)
    .zeros(5)
}

/** A compressed image cel (type 2), or raw (type 0) when `raw` is set. */
export const imageCel = (c: CelSpec & { width: number; height: number; pixels: ArrayLike<number>; raw?: boolean }): Chunk =>
  chunk(0x2005, (b) => {
    celHeader(b, c, c.raw === true ? 0 : 2)
      .word(c.width)
      .word(c.height)
      .bytes(c.raw === true ? c.pixels : zlibSync(Uint8Array.from(c.pixels)))
  })

export const linkedCel = (c: CelSpec & { frame: number }): Chunk => chunk(0x2005, (b) => celHeader(b, c, 1).word(c.frame))

export const TILE_MASKS = { id: 0x1fffffff, xFlip: 0x20000000, yFlip: 0x40000000, diagonalFlip: 0x80000000 }

export const tilemapCel = (c: CelSpec & { width: number; height: number; tiles: number[]; bitsPerTile?: 8 | 16 | 32 }): Chunk =>
  chunk(0x2005, (b) => {
    const bits = c.bitsPerTile ?? 32
    const raw = new Bytes()
    for (const t of c.tiles) {
      if (bits === 32) raw.dword(t)
      else if (bits === 16) raw.word(t)
      else raw.byte(t)
    }
    celHeader(b, c, 3)
      .word(c.width)
      .word(c.height)
      .word(bits)
      .dword(TILE_MASKS.id)
      .dword(TILE_MASKS.xFlip)
      .dword(TILE_MASKS.yFlip)
      .dword(TILE_MASKS.diagonalFlip)
      .zeros(10)
      .bytes(zlibSync(raw.build()))
  })

export const celExtra = (x: number, y: number, w: number, h: number, flags = 1): Chunk =>
  chunk(0x2006, (b) => b.dword(flags).fixed(x).fixed(y).fixed(w).fixed(h).zeros(16))

export const palette = (entries: Array<[number, number, number, number, string?]>, from = 0, size = from + entries.length): Chunk =>
  chunk(0x2019, (b) => {
    b.dword(size)
      .dword(from)
      .dword(from + entries.length - 1)
      .zeros(8)
    for (const [r, g, bl, a, name] of entries) {
      b.word(name === undefined ? 0 : 1).byte(r).byte(g).byte(bl).byte(a)
      if (name !== undefined) b.string(name)
    }
  })

export const oldPalette = (packets: Array<{ skip: number; colors: Array<[number, number, number]> }>, sixBit = false): Chunk =>
  chunk(sixBit ? 0x0011 : 0x0004, (b) => {
    b.word(packets.length)
    for (const p of packets) {
      b.byte(p.skip).byte(p.colors.length === 256 ? 0 : p.colors.length)
      for (const [r, g, bl] of p.colors) b.byte(r).byte(g).byte(bl)
    }
  })

export const tags = (list: Array<{ name: string; from: number; to: number; direction?: number; repeat?: number; color?: [number, number, number] }>): Chunk =>
  chunk(0x2018, (b) => {
    b.word(list.length).zeros(8)
    for (const t of list) {
      const [r, g, bl] = t.color ?? [0, 0, 0]
      b.word(t.from)
        .word(t.to)
        .byte(t.direction ?? 0)
        .word(t.repeat ?? 0)
        .zeros(6)
        .byte(r)
        .byte(g)
        .byte(bl)
        .byte(0)
        .string(t.name)
    }
  })

/** A User Data chunk; `properties` is written verbatim after the size/count header, so tests can hand-roll it. */
export const userData = (u: { text?: string; color?: [number, number, number, number]; properties?: { count: number; body: Uint8Array } }): Chunk =>
  chunk(0x2020, (b) => {
    const flags = (u.text !== undefined ? 1 : 0) | (u.color !== undefined ? 2 : 0) | (u.properties !== undefined ? 4 : 0)
    b.dword(flags)
    if (u.text !== undefined) b.string(u.text)
    if (u.color !== undefined) b.bytes(u.color)
    if (u.properties !== undefined) b.dword(u.properties.body.length + 8).dword(u.properties.count).bytes(u.properties.body)
  })

export const slice = (
  name: string,
  keys: Array<{ frame: number; bounds: [number, number, number, number]; center?: [number, number, number, number]; pivot?: [number, number] }>,
): Chunk =>
  chunk(0x2022, (b) => {
    const ninePatch = keys.some((k) => k.center !== undefined)
    const pivot = keys.some((k) => k.pivot !== undefined)
    b.dword(keys.length)
      .dword((ninePatch ? 1 : 0) | (pivot ? 2 : 0))
      .dword(0)
      .string(name)
    for (const k of keys) {
      b.dword(k.frame).long(k.bounds[0]).long(k.bounds[1]).dword(k.bounds[2]).dword(k.bounds[3])
      if (ninePatch) {
        const [x, y, w, h] = k.center ?? [0, 0, 0, 0]
        b.long(x).long(y).dword(w).dword(h)
      }
      if (pivot) {
        const [x, y] = k.pivot ?? [0, 0]
        b.long(x).long(y)
      }
    }
  })

export const tileset = (t: { id: number; name: string; tileWidth: number; tileHeight: number; tileCount: number; pixels?: ArrayLike<number>; flags?: number; external?: [number, number] }): Chunk =>
  chunk(0x2023, (b) => {
    const flags = (t.flags ?? 4) | (t.pixels !== undefined ? 2 : 0) | (t.external !== undefined ? 1 : 0)
    b.dword(t.id).dword(flags).dword(t.tileCount).word(t.tileWidth).word(t.tileHeight).short(1).zeros(14).string(t.name)
    if (t.external !== undefined) b.dword(t.external[0]).dword(t.external[1])
    if (t.pixels !== undefined) {
      const compressed = zlibSync(Uint8Array.from(t.pixels))
      b.dword(compressed.length).bytes(compressed)
    }
  })
