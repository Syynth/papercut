/**
 * The runtime atlas: the one texture the terrain is drawn with (spec §3).
 *
 * It holds every authored tile of every terrain set the map uses, and one
 * baked tile per distinct corner combination nobody authored — a composite
 * of the terrains' edge sets in priority order. The mesher asks it two
 * things and nothing else: the tile for a corner's four terrains, and the
 * UV rectangle of one quadrant of a tile. It never composes pixels.
 *
 * Terrains are addressed across sets by key, `<sheet>/<terrain>`, so a map
 * can draw from several sheets. An exact tile can only come from one set,
 * where every terrain at the corner lives; a composite may mix sets.
 *
 * The atlas fills as strokes create combinations it has not seen, and its
 * SIZE IS FIXED at construction: `ATLAS_COLUMNS` across, and as many rows as
 * every tagged tile of every set needs plus room for composites. A UV is a
 * fraction of the whole image, so an image that grew taller would move every
 * UV already meshed against it (the first cut of this did exactly that, and
 * the first chunks of a map sampled the wrong rows). Filling bumps `version`,
 * which is what the runtime keys its texture upload on; nothing is ever
 * moved, so a tile id and its UVs are stable for the atlas's life. RPG Maker
 * sheets converted whole tag thousands of tiles, which is why the height is
 * counted rather than assumed.
 *
 * Pure RGBA over plain buffers: no canvas, so the meshing worker and a
 * headless export can build one.
 */

import type { RgbaImage } from '@papercut/document'

import { CORNER_BITS, exactTile, edgeTile, templateTags, type CornerTags, type TerrainSet } from './terrainset'

/** `<sheet>/<terrain>`: a terrain named across sets. */
export type TerrainKey = string

export function terrainKey(sheet: string, terrain: string): TerrainKey {
  return `${sheet}/${terrain}`
}

/** A terrain set and the pixels of its sheet. */
export interface LoadedSet {
  set: TerrainSet
  /** The tiles edge to edge at the project's density: what the atlas reads. */
  image: RgbaImage
  /** The file's pixels as they are, before the grid was cut and scaled; what a library shows. Absent for a generated set. */
  source?: RgbaImage
}

/** The four terrains at a corner, in `CornerTags` order; `null` is nothing. */
export type CornerKeys = readonly [TerrainKey | null, TerrainKey | null, TerrainKey | null, TerrainKey | null]

export interface AtlasTile {
  tile: number
  /** Baked from edge sets because no tile is tagged for the combination. */
  composite: boolean
  /** The composited combination's name (`CompositeReport.combo`), for the mesher to report per chunk. */
  combo?: string
}

export interface CompositeReport {
  /** The distinct terrains at the corner, highest priority last, then "edge" when nothing is among them. */
  combo: string
  /** The first tile baked for it; the same combination in another arrangement of corners bakes another. */
  tile: number
}

const ATLAS_COLUMNS = 64
/** Room kept for corners nobody drew, beyond the tagged tiles: more than a level's worth of transitions. */
const COMPOSITE_ROOM = 1024
const MIN_ROWS = 16
/** GPUs stop at 8192 px a side; at 16 px that is 512 rows. */
const MAX_ROWS = 8192 / 16

export class TerrainAtlas {
  readonly tile: number
  /** The atlas's height in tiles, fixed at construction. */
  readonly rows: number
  private next = 0
  private readonly buffer: Uint8ClampedArray<ArrayBuffer>
  /** Corners answered so far, keyed by the four interned terrain ids packed into one number. */
  private byCorner = new Map<number, AtlasTile>()
  /** Terrain keys interned to small ids; 0 is nothing. */
  private ids = new Map<TerrainKey, number>()
  private sheetTiles = new Map<string, number>() // `<sheet>:<index>` -> atlas tile
  private readonly sets = new Map<string, LoadedSet>()
  private composites: CompositeReport[] = []
  /** Bumps whenever `image` changes content or size. */
  version = 0

  /**
   * @param priority Where a terrain stands in the map's material order; a
   * higher number draws over a lower one in a composite. Unknown terrains
   * count as lowest.
   */
  /**
   * @param colorOf The flat colour (0xRRGGBB) a terrain falls back to when its set is not loaded — its material's
   * swatch — or `null` for a terrain nothing names, which draws magenta so the hole is seen rather than missed.
   */
  constructor(
    sets: readonly LoadedSet[],
    private readonly priority: (key: TerrainKey) => number,
    private readonly colorOf: (key: TerrainKey) => number | null = () => null,
  ) {
    const tile = sets[0]?.set.tile ?? 16
    for (const loaded of sets) {
      if (loaded.set.tile !== tile) throw new Error(`Terrain set ${loaded.set.sheet} has ${loaded.set.tile} px tiles; the atlas is ${tile} px.`)
      if (loaded.image.width !== loaded.set.columns * tile || loaded.image.height !== loaded.set.rows * tile) {
        throw new Error(`Sheet ${loaded.set.sheet} is ${loaded.image.width}×${loaded.image.height} px; its terrain set says ${loaded.set.columns * tile}×${loaded.set.rows * tile}.`)
      }
      this.sets.set(loaded.set.sheet, loaded)
    }
    this.tile = tile
    const tagged = sets.reduce((n, loaded) => n + loaded.set.tiles.size, 0)
    const rows = Math.max(MIN_ROWS, Math.ceil((tagged + COMPOSITE_ROOM) / ATLAS_COLUMNS))
    if (rows * tile > 8192 || rows > MAX_ROWS) throw new Error(`The terrain sets tag ${tagged} tiles of ${tile} px; an atlas that tall (${rows * tile} px) exceeds what a GPU takes.`)
    this.rows = rows
    this.buffer = new Uint8ClampedArray(ATLAS_COLUMNS * tile * rows * tile * 4)
    // Every tagged tile of every set is in the atlas from the start, so an exact answer never grows it.
    for (const loaded of sets) for (const index of loaded.set.tiles.keys()) this.sheetTile(loaded, index)
  }

  /** The whole atlas; the same buffer every time, so a consumer keys its upload on `version`, not on identity. */
  get image(): RgbaImage {
    return { width: ATLAS_COLUMNS * this.tile, height: this.rows * this.tile, data: this.buffer }
  }

  /** How many of the atlas's tiles are taken. */
  get used(): number {
    return this.next
  }

  /** The tile for a corner: exact when a set has it, else a composite baked on first sight. */
  tileFor(keys: CornerKeys): AtlasTile {
    // Four ids of at most 2^12 each pack into 48 bits: one number, no string per corner on the meshing path.
    const packed = ((this.id(keys[0]) * 4096 + this.id(keys[1])) * 4096 + this.id(keys[2])) * 4096 + this.id(keys[3])
    const cached = this.byCorner.get(packed)
    if (cached) return cached
    const answer = this.resolve(keys)
    this.byCorner.set(packed, answer)
    return answer
  }

  private id(key: TerrainKey | null): number {
    if (key === null) return 0
    let id = this.ids.get(key)
    if (id === undefined) {
      id = this.ids.size + 1
      if (id >= 4096) throw new Error('The atlas addresses at most 4095 terrains.')
      this.ids.set(key, id)
    }
    return id
  }

  /** UV rectangle [u0, v0, u1, v1] of quadrant `q` (0 NW, 1 NE, 2 SW, 3 SE) of a tile, or the whole tile for -1; v from the bottom the way GL samples. */
  uv(tile: number, quadrant: number): [number, number, number, number] {
    const column = tile % ATLAS_COLUMNS
    const row = Math.floor(tile / ATLAS_COLUMNS)
    const rows = this.rows
    const half = quadrant < 0 ? 1 : 0.5
    const qx = quadrant < 0 ? 0 : quadrant % 2 ? 0.5 : 0
    const qy = quadrant < 0 ? 0 : quadrant > 1 ? 0.5 : 0
    const insetU = 0.5 / (ATLAS_COLUMNS * this.tile)
    const insetV = 0.5 / (rows * this.tile)
    const u0 = (column + qx) / ATLAS_COLUMNS + insetU
    const u1 = (column + qx + half) / ATLAS_COLUMNS - insetU
    const v1 = 1 - (row + qy) / rows - insetV
    const v0 = 1 - (row + qy + half) / rows + insetV
    return [u0, v0, u1, v1]
  }

  /** Every transition composed so far, each named once however many arrangements of it were baked: the artist's list of tiles to draw. */
  compositeReport(): readonly CompositeReport[] {
    const seen = new Map<string, CompositeReport>()
    for (const c of this.composites) if (!seen.has(c.combo)) seen.set(c.combo, c)
    return [...seen.values()]
  }

  private resolve(keys: CornerKeys): AtlasTile {
    const terrains = [...new Set(keys.filter((k): k is TerrainKey => k !== null))]
    if (terrains.length === 0) return { tile: this.blankTile(), composite: false }
    // An exact tile lives in one set, where every terrain at the corner is.
    const sheets = new Set(terrains.map((k) => k.slice(0, k.lastIndexOf('/'))))
    if (sheets.size === 1) {
      const loaded = this.sets.get([...sheets][0])
      if (loaded) {
        const tags = keys.map((k) => (k === null ? null : k.slice(k.lastIndexOf('/') + 1))) as unknown as CornerTags
        const index = exactTile(loaded.set, tags)
        if (index !== null) return { tile: this.sheetTile(loaded, index), composite: false }
      }
    }
    const tile = this.composite(keys, terrains)
    return { tile, composite: true, combo: this.composites[this.composites.length - 1].combo }
  }

  /** The atlas tile holding a sheet's tile, copied in on first use. */
  private sheetTile(loaded: LoadedSet, index: number): number {
    const key = `${loaded.set.sheet}:${index}`
    const known = this.sheetTiles.get(key)
    if (known !== undefined) return known
    const tile = this.allocate()
    const sx = (index % loaded.set.columns) * this.tile
    const sy = Math.floor(index / loaded.set.columns) * this.tile
    this.blit(loaded.image, sx, sy, tile, null, false)
    this.sheetTiles.set(key, tile)
    return tile
  }

  private blank: number | null = null

  private blankTile(): number {
    if (this.blank === null) this.blank = this.allocate()
    return this.blank
  }

  /**
   * Bake a corner nobody drew: the lowest terrain from its edge set, masked
   * to the corners that are not nothing, then each higher terrain's edge
   * tile over it. A terrain with no edge tile for a mask lends its full
   * tile, clipped to its own corners.
   */
  private composite(keys: CornerKeys, terrains: TerrainKey[]): number {
    const ordered = terrains.slice().sort((a, b) => this.priority(a) - this.priority(b))
    const tile = this.allocate()
    const present = keys.reduce((mask, k, i) => (k === null ? mask : mask | CORNER_BITS[i]), 0)
    ordered.forEach((key, layer) => {
      const mask = layer === 0 ? present : keys.reduce((m, k, i) => (k === key ? m | CORNER_BITS[i] : m), 0)
      const sheet = key.slice(0, key.lastIndexOf('/'))
      const terrain = key.slice(key.lastIndexOf('/') + 1)
      const loaded = this.sets.get(sheet)
      const edge = loaded ? edgeTile(loaded.set, terrain, mask) : null
      const source = loaded ? (edge ?? exactTile(loaded.set, templateTags(15, null, terrain))) : null
      if (!loaded || source === null) {
        // No sheet, or no tile for it in the sheet: the material's colour fills the terrain's corners, so a
        // material pointing at a sheet the folder lacks is a flat face rather than a hole in the ground.
        this.fill(tile, mask, this.colorOf(key) ?? 0xff00ff)
        return
      }
      const sx = (source % loaded.set.columns) * this.tile
      const sy = Math.floor(source / loaded.set.columns) * this.tile
      this.blit(loaded.image, sx, sy, tile, edge === null ? mask : null, true)
    })
    const names = ordered.map((k) => k.slice(k.lastIndexOf('/') + 1))
    if (present !== 15) names.push('edge')
    this.composites.push({ combo: names.join(' · '), tile })
    return tile
  }

  /** A fresh, transparent tile. The atlas does not grow: a level that composes two thousand distinct corners has a different problem. */
  private allocate(): number {
    if (this.next >= ATLAS_COLUMNS * this.rows) throw new Error(`The terrain atlas is full: ${ATLAS_COLUMNS * this.rows} tiles. Author transitions instead of compositing them.`)
    return this.next++
  }

  /** Paint the quadrants in `mask` of atlas tile `tile` a flat colour, over whatever is there. */
  private fill(tile: number, mask: number, color: number): void {
    const t = this.tile
    const dx = (tile % ATLAS_COLUMNS) * t
    const dy = Math.floor(tile / ATLAS_COLUMNS) * t
    const width = ATLAS_COLUMNS * t
    const half = t / 2
    for (let y = 0; y < t; y++) {
      for (let x = 0; x < t; x++) {
        if (!(mask & CORNER_BITS[(y >= half ? 2 : 0) + (x >= half ? 1 : 0)])) continue
        const di = ((dy + y) * width + dx + x) * 4
        this.buffer[di] = (color >> 16) & 0xff
        this.buffer[di + 1] = (color >> 8) & 0xff
        this.buffer[di + 2] = color & 0xff
        this.buffer[di + 3] = 255
      }
    }
    this.version += 1
  }

  /** Copy one tile of `source` at (`sx`, `sy`) onto atlas tile `tile`: the quadrants in `mask` only (all when null), source-over when `over`. */
  private blit(source: RgbaImage, sx: number, sy: number, tile: number, mask: number | null, over: boolean): void {
    const t = this.tile
    const dx = (tile % ATLAS_COLUMNS) * t
    const dy = Math.floor(tile / ATLAS_COLUMNS) * t
    const width = ATLAS_COLUMNS * t
    const half = t / 2
    for (let y = 0; y < t; y++) {
      for (let x = 0; x < t; x++) {
        if (mask !== null && !(mask & CORNER_BITS[(y >= half ? 2 : 0) + (x >= half ? 1 : 0)])) continue
        const si = ((sy + y) * source.width + sx + x) * 4
        const di = ((dy + y) * width + dx + x) * 4
        const sa = source.data[si + 3] / 255
        if (!over || sa >= 1) {
          this.buffer[di] = source.data[si]
          this.buffer[di + 1] = source.data[si + 1]
          this.buffer[di + 2] = source.data[si + 2]
          this.buffer[di + 3] = source.data[si + 3]
          continue
        }
        if (sa <= 0) continue
        const da = this.buffer[di + 3] / 255
        const oa = sa + da * (1 - sa)
        for (let c = 0; c < 3; c++) this.buffer[di + c] = (source.data[si + c] * sa + this.buffer[di + c] * da * (1 - sa)) / oa
        this.buffer[di + 3] = oa * 255
      }
    }
    this.version += 1
  }
}
