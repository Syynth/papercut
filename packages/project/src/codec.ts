/**
 * How a sheet's pixels get to and from disk.
 *
 * A PNG needs a decoder, and the decoders differ by host: the editor has a
 * canvas, the export CLI has `fast-png`, a test wants neither. So the codec
 * is handed in, and this package never names a PNG library. `rawImageCodec`
 * is the test's: eight bytes of size, then the pixels, nothing compressed.
 *
 * An `.aseprite` file needs no host at all — its reader is pure — so it is
 * read here, before the codec is asked (decision-log 2026-09-19).
 * `decodeImage` is the one door every image comes in by.
 */

import { isAsepriteSheet, readAsepriteSheet } from '@papercut/aseprite-sheet'
import type { Grid, RgbaImage } from '@papercut/document'

export interface ImageCodec {
  encode(image: RgbaImage): Promise<Uint8Array>
  decode(bytes: Uint8Array): Promise<RgbaImage>
}

export const rawImageCodec: ImageCodec = {
  encode(image) {
    const out = new Uint8Array(8 + image.data.length)
    new DataView(out.buffer).setUint32(0, image.width, true)
    new DataView(out.buffer).setUint32(4, image.height, true)
    out.set(image.data, 8)
    return Promise.resolve(out)
  },
  decode(bytes) {
    if (bytes.length < 8) return Promise.reject(new Error('Not an image.'))
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const width = view.getUint32(0, true)
    const height = view.getUint32(4, true)
    if (bytes.length !== 8 + width * height * 4) return Promise.reject(new Error('Not an image: the size does not match the pixels.'))
    const data = new Uint8ClampedArray(width * height * 4)
    data.set(bytes.subarray(8))
    return Promise.resolve({ width, height, data })
  },
}

export interface DecodedImage {
  image: RgbaImage
  /** How many frames the file has: 1 for anything but an animated `.aseprite`. */
  frames: number
  /** The frame drawn: `frame` as asked, or the file's last when it has fewer. */
  frame: number
  /** The tile grid the file itself describes, when it does (an `.aseprite`'s grid or tileset); what an import starts from. */
  grid: Grid | null
  /** What did not come through, one line each. */
  warnings: string[]
}

/** Any image file's pixels: an `.aseprite` by its own reader, at `frame`; anything else by the codec. */
export async function decodeImage(codec: ImageCodec, bytes: Uint8Array, frame = 0): Promise<DecodedImage> {
  if (isAsepriteSheet(bytes)) {
    const sheet = readAsepriteSheet(bytes, frame)
    return { image: sheet.image, frames: sheet.frames, frame: sheet.frame, grid: sheet.grid?.grid ?? null, warnings: sheet.warnings }
  }
  return { image: await codec.decode(bytes), frames: 1, frame: 0, grid: null, warnings: [] }
}
