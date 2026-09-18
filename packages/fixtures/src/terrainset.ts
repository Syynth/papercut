/**
 * The placeholder tile set: a sheet and its tags, drawn without a canvas
 * (spec §6).
 *
 * Every tile is a transition authored the way the prototype drew them: the
 * over-terrain's quadrants are opened and closed by a disc so convex corners
 * round and concave ones fillet, then rimmed; the under-terrain fills the
 * rest, or nothing does for an edge set. A terrain with a `bleed` overshoots
 * the quadrant seam by that many pixels into whatever shares a tile with it,
 * which is what makes the dual grid visible on a placeholder: grass keeps
 * its 3 px so the mechanism stays legible until an artist's sheet replaces
 * this one.
 *
 * Pure RGBA over a plain buffer, so the headless export and a test can draw
 * the same sheet the editor shows; `textures.ts` is the canvas half of the
 * placeholder art and stays behind its own subpath.
 */

import { tagOf, type RgbaImage } from '@papercut/document'
import { createTerrainSet, stampTemplate, type TerrainSet } from '@papercut/geometry'

export interface PlaceholderTerrain {
  /** The MATERIAL this art is for, by id: what its tiles are tagged with. */
  id: number
  name: string
  /** 0xRRGGBB fill, and the rim and speckle derived from it. */
  color: number
  /** Brick lines across the fill, for a terrain meant for cliff faces. */
  wall?: boolean
  /** Pixels this terrain overshoots the quadrant seam by, in every tile it shares. */
  bleed?: number
}

export interface PlaceholderTerrainSet {
  set: TerrainSet
  image: RgbaImage
}

/** Blocks per row of the generated sheet: four 4×4 blocks, sixteen tiles across. */
const BLOCKS_ACROSS = 4
const QUADRANT_BITS = [1, 2, 4, 8]

function channels(color: number): [number, number, number] {
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff]
}

function shade(color: number, factor: number): [number, number, number] {
  return channels(color).map((c) => Math.max(0, Math.min(255, Math.round(c * factor)))) as [number, number, number]
}

function hash(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453
  return n - Math.floor(n)
}

/**
 * Binary morphology on one tile: `grow` dilates by a disc, otherwise erodes.
 * Beyond the tile, erosion sees the nearest edge pixel (the pattern continues
 * into the next tile, so a boundary that reaches the edge stays straight) and
 * dilation sees nothing.
 *
 * Done through a squared Euclidean distance transform (Felzenszwalb and
 * Huttenlocher, rows then columns, linear in the pixels) rather than by
 * scanning a disc at every pixel: a disc scan is quadratic in the radius,
 * and the radius scales with the tile, so at 64 px a sheet took seconds to
 * draw and every change of texel density waited on it. A pixel is eroded
 * where the nearest zero is within the radius, and dilated where the nearest
 * one is — the same disc, answered once per pixel.
 */
function morph(mask: Uint8Array, size: number, radius: number, grow: boolean): Uint8Array {
  const pad = radius + 1
  const n = size + 2 * pad
  // Squared distance to the nearest TARGET pixel: a zero for erosion, a one for dilation. Outside the tile a
  // replicated edge pixel for erosion, nothing (a zero, so not a one) for dilation.
  const INF = 1e9
  const f = new Float64Array(n * n)
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const ox = x - pad
      const oy = y - pad
      const outside = ox < 0 || oy < 0 || ox >= size || oy >= size
      const v = grow && outside ? 0 : mask[Math.min(size - 1, Math.max(0, oy)) * size + Math.min(size - 1, Math.max(0, ox))]
      f[y * n + x] = (grow ? v : !v) ? 0 : INF
    }
  }
  const d = new Float64Array(n * n)
  const line = new Float64Array(n)
  const out1 = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  const transform = (): void => {
    let k = 0
    v[0] = 0
    z[0] = -INF
    z[1] = INF
    for (let q = 1; q < n; q++) {
      let s = ((line[q] + q * q) - (line[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
      while (s <= z[k]) {
        k--
        s = ((line[q] + q * q) - (line[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
      }
      k++
      v[k] = q
      z[k] = s
      z[k + 1] = INF
    }
    k = 0
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++
      out1[q] = (q - v[k]) * (q - v[k]) + line[v[k]]
    }
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) line[x] = f[y * n + x]
    transform()
    for (let x = 0; x < n; x++) d[y * n + x] = out1[x]
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) line[y] = d[y * n + x]
    transform()
    for (let y = 0; y < n; y++) d[y * n + x] = out1[y]
  }
  const out = new Uint8Array(size * size)
  const r2 = radius * radius
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const near = d[(y + pad) * n + (x + pad)] <= r2
      out[y * size + x] = grow ? (near ? 1 : 0) : near ? 0 : 1
    }
  }
  return out
}

/**
 * Draw a sheet holding an edge set for every terrain and a transition block
 * for every pair, and the terrain set that tags it. `pairs` are `[under,
 * over]` by id; the over-terrain is the shape.
 */
export function generateTerrainSetArt(sheet: string, terrains: readonly PlaceholderTerrain[], pairs: ReadonlyArray<readonly [number, number]>, tile = 16): PlaceholderTerrainSet {
  const blocks: Array<{ under: PlaceholderTerrain | null; over: PlaceholderTerrain }> = []
  const byId = new Map(terrains.map((t) => [t.id, t]))
  for (const t of terrains) blocks.push({ under: null, over: t })
  for (const [under, over] of pairs) {
    const a = byId.get(under)
    const b = byId.get(over)
    if (!a || !b) throw new Error(`Pair ${under}·${over} names a material the placeholder does not have.`)
    blocks.push({ under: a, over: b })
  }
  const columns = BLOCKS_ACROSS * 4
  const rows = Math.ceil(blocks.length / BLOCKS_ACROSS) * 4
  const width = columns * tile
  const height = rows * tile
  const data = new Uint8ClampedArray(width * height * 4)
  let set = createTerrainSet(sheet, tile, columns, rows)

  const rounding = Math.max(1, Math.round((tile * 3) / 16))
  blocks.forEach((block, b) => {
    const column = (b % BLOCKS_ACROSS) * 4
    const row = Math.floor(b / BLOCKS_ACROSS) * 4
    set = stampTemplate(set, column, row, block.under === null ? null : tagOf(block.under.id), tagOf(block.over.id))
    const bleed = block.over.bleed ? block.over.bleed : block.under?.bleed ? -block.under.bleed : 0
    for (let mask = 0; mask < 16; mask++) {
      const x0 = (column + (mask & 3)) * tile
      const y0 = (row + (mask >> 2)) * tile
      const quadrants = new Uint8Array(tile * tile)
      for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) quadrants[y * tile + x] = mask & QUADRANT_BITS[(y >= tile / 2 ? 2 : 0) + (x >= tile / 2 ? 1 : 0)] ? 1 : 0
      let region = morph(morph(quadrants, tile, rounding, false), tile, rounding, true)
      region = morph(morph(region, tile, rounding, true), tile, rounding, false)
      if (bleed > 0) region = morph(region, tile, bleed, true)
      else if (bleed < 0) region = morph(region, tile, -bleed, false)
      const core = morph(region, tile, 1, false)
      paintTile(data, width, x0, y0, tile, block.under, block.over, region, core, x0 * 31 + y0)
    }
  })
  return { set, image: { width, height, data } }
}

function paintTile(
  data: Uint8ClampedArray,
  width: number,
  x0: number,
  y0: number,
  tile: number,
  under: PlaceholderTerrain | null,
  over: PlaceholderTerrain,
  region: Uint8Array,
  core: Uint8Array,
  seed: number,
): void {
  const overFill = channels(over.color)
  const overDark = shade(over.color, 0.68)
  const overLight = shade(over.color, 1.25)
  const underFill = under ? channels(under.color) : null
  const underDark = under ? shade(under.color, 0.68) : null
  const underLight = under ? shade(under.color, 1.25) : null
  for (let y = 0; y < tile; y++) {
    for (let x = 0; x < tile; x++) {
      const i = ((y0 + y) * width + x0 + x) * 4
      const m = y * tile + x
      let rgb: [number, number, number] | null
      let alpha = 255
      if (region[m]) {
        rgb = core[m] ? overFill : overDark
        if (core[m]) rgb = speckled(rgb, overLight, overDark, over, x, y, seed)
      } else if (underFill) {
        rgb = speckled(underFill, underLight as [number, number, number], underDark as [number, number, number], under as PlaceholderTerrain, x, y, seed + 3)
      } else {
        rgb = null
        alpha = 0
      }
      if (rgb) {
        data[i] = rgb[0]
        data[i + 1] = rgb[1]
        data[i + 2] = rgb[2]
      }
      data[i + 3] = alpha
    }
  }
}

/** A few lighter and darker pixels, and brick lines for a wall terrain, so a flat fill reads as a surface. */
function speckled(fill: [number, number, number], light: [number, number, number], dark: [number, number, number], terrain: PlaceholderTerrain, x: number, y: number, seed: number): [number, number, number] {
  if (terrain.wall && y % 5 === 3 && (x + (Math.floor(y / 5) % 2 ? 4 : 0)) % 8 < 5) return mix(fill, dark, 0.45)
  const n = hash(x, y, seed)
  if (n > 0.93) return mix(fill, light, 0.55)
  if (n < 0.06) return mix(fill, dark, 0.55)
  return fill
}

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)]
}

/** The sample map's placeholder: the four default materials plus a path, and the transitions the sample uses. */
/** By material id, which is `DEFAULT_MATERIALS`: 0 Grass, 1 Dirt, 2 Stone, 3 Sand, 4 Path. */
export const PLACEHOLDER_TERRAINS: readonly PlaceholderTerrain[] = [
  { id: 2, name: 'Stone', color: 0x8e8e8e, wall: true },
  { id: 1, name: 'Dirt', color: 0x8b6b45 },
  { id: 3, name: 'Sand', color: 0xd9c27e },
  { id: 0, name: 'Grass', color: 0x6aa84f, bleed: 3 },
  { id: 4, name: 'Path', color: 0xb08f5e },
]

export const PLACEHOLDER_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [3, 0],
  [1, 3],
  [2, 1],
  [2, 0],
  [2, 3],
  [2, 4],
  [0, 4],
  [1, 4],
  [3, 4],
]

export function generatePlaceholderTerrainSet(tile = 16): PlaceholderTerrainSet {
  return generateTerrainSetArt('ground.png', PLACEHOLDER_TERRAINS, PLACEHOLDER_PAIRS, tile)
}
