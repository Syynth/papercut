import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { parseAseprite } from '@papercut/aseprite'
import { renderFrame } from '@papercut/aseprite-render'
import { describe, expect, it } from 'vitest'

/**
 * `@papercut/aseprite-render` against Aseprite itself. Each `.aseprite` file
 * in `packages/aseprite-render/fixtures/` was written by Aseprite from
 * `make.lua`, and each `<name>-<frame>.png` beside it is Aseprite's own
 * render of that frame. Rendering the file here must give the same pixels —
 * exactly, not within a tolerance, because the blenders are a port of
 * Aseprite's integer arithmetic.
 *
 * Repo-wide rather than in the package because reading the files needs
 * `node:fs`, and the package compiles with no Node types on purpose.
 */

const FIXTURES = join(new URL('..', import.meta.url).pathname, 'packages/aseprite-render/fixtures')

/**
 * A PNG as RGBA: just enough of the format for what Aseprite writes — 8-bit
 * grey, grey+alpha, RGB, RGBA and palette images, not interlaced. Written out
 * here because the PNG library the export CLI carries may not be declared at
 * the root (see `dependency-direction.test.ts`).
 */
function pngRgba(bytes: Buffer): { width: number; height: number; data: Uint8Array } {
  let width = 0
  let height = 0
  let type = 0
  let palette: number[][] = []
  let alphas: number[] = []
  const idat: Buffer[] = []
  for (let at = 8; at < bytes.length; ) {
    const length = bytes.readUInt32BE(at)
    const kind = bytes.toString('latin1', at + 4, at + 8)
    const body = bytes.subarray(at + 8, at + 8 + length)
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (body[8] !== 8 || body[12] !== 0) throw new Error('only 8-bit, non-interlaced PNGs')
      type = body[9] ?? 0
    } else if (kind === 'PLTE') palette = Array.from({ length: length / 3 }, (_, i) => [body[i * 3] ?? 0, body[i * 3 + 1] ?? 0, body[i * 3 + 2] ?? 0])
    else if (kind === 'tRNS') alphas = [...body]
    else if (kind === 'IDAT') idat.push(body)
    at += 12 + length
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type] ?? 0
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const rows = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x] ?? 0
      const a = x >= channels ? (rows[y * stride + x - channels] ?? 0) : 0
      const b = y > 0 ? (rows[(y - 1) * stride + x] ?? 0) : 0
      const c = x >= channels && y > 0 ? (rows[(y - 1) * stride + x - channels] ?? 0) : 0
      const p = a + b - c
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c
      rows[y * stride + x] = (v + [0, a, b, (a + b) >> 1, paeth][filter]!) & 0xff
    }
  }
  const out = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const at = (k: number): number => rows[i * channels + k] ?? 0
    const rgba =
      type === 0 ? [at(0), at(0), at(0), 255] : type === 4 ? [at(0), at(0), at(0), at(1)] : type === 2 ? [at(0), at(1), at(2), 255] : type === 6 ? [at(0), at(1), at(2), at(3)] : [...(palette[at(0)] ?? [0, 0, 0]), alphas[at(0)] ?? 255]
    out.set(rgba, i * 4)
  }
  return { width, height, data: out }
}

/** Pixels that differ, ignoring the colour of fully transparent ones (a PNG writer may drop it). */
function differences(expected: Uint8Array, actual: Uint8ClampedArray, width: number): string[] {
  const out: string[] = []
  for (let i = 0; i < expected.length / 4; i++) {
    const e = [...expected.subarray(i * 4, i * 4 + 4)]
    const a = [...actual.subarray(i * 4, i * 4 + 4)]
    if (e[3] === 0 && a[3] === 0) continue
    if (e.some((v, c) => v !== a[c])) out.push(`(${i % width}, ${Math.floor(i / width)}): Aseprite ${e.join(',')} vs ours ${a.join(',')}`)
  }
  return out
}

const files = readdirSync(FIXTURES).filter((name) => name.endsWith('.aseprite')).sort()

describe('aseprite-render matches Aseprite', () => {
  it('has fixtures to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const name of files) {
    const file = parseAseprite(readFileSync(join(FIXTURES, name)))
    const stem = name.replace(/\.aseprite$/, '')
    file.frames.forEach((_, frame) => {
      it(`${stem}, frame ${frame}`, () => {
        expect(file.warnings).toEqual([])
        const expected = pngRgba(readFileSync(join(FIXTURES, `${stem}-${frame}.png`)))
        const actual = renderFrame(file, frame)
        expect([actual.width, actual.height]).toEqual([expected.width, expected.height])
        const wrong = differences(expected.data, actual.data, actual.width)
        expect(wrong.slice(0, 10), `${wrong.length} pixels differ`).toEqual([])
      })
    })
  }
})
