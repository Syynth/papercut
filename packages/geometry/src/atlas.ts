/**
 * The runtime atlas: the one texture the terrain is drawn with (spec §3).
 *
 * It holds every authored tile of every set the map uses, a blank tile, and
 * the FALLBACK tile. The mesher asks it two things and nothing else: the tile
 * for a corner's four tags, and the UV rectangle of one quadrant of a tile.
 * It never composes pixels.
 *
 * Nothing is composited (ruling of 2026-09-18). A corner used to be answered,
 * when nobody had drawn it, by baking the materials' edge sets over each other
 * in priority order. Terrain paint has explicit material layers now, one dual
 * grid each, so the artist says what stacks on what; a corner no tile answers
 * draws the fallback, a flat colour set in the editor's settings (magenta by
 * default), so a missing tile is visibly missing rather than quietly made up.
 * Each one is still reported, by name, as a transition to author.
 *
 * A tag names a MATERIAL (ruling of 2026-09-17), which is a thing of the
 * project rather than of an image, so the index of authored tiles is built
 * across every set at once. An authored tile is taken wherever it was drawn,
 * however the art is spread over sheets.
 *
 * The atlas's SIZE IS FIXED at construction: `ATLAS_COLUMNS` across, and as
 * many rows as every tagged tile of every set needs. A UV is a fraction of the
 * whole image, so an image that grew taller would move every UV already
 * meshed against it. `version` bumps whenever pixels change, which is what the
 * runtime keys its texture upload on; nothing is ever moved, so a tile id and
 * its UVs are stable for the atlas's life. RPG Maker sheets converted whole
 * tag thousands of tiles, which is why the height is counted rather than
 * assumed.
 *
 * Pure RGBA over plain buffers: no canvas, so the meshing worker and a
 * headless export can build one.
 */

import { materialOfTag, slotOfTag, tagOf, type RgbaImage } from '@papercut/document'

import { FRINGE, PICKET } from './archetype'

import { CORNER_BITS, cornerKey, type CornerTags, type Tag, type TerrainSet } from './terrainset'

/** A terrain set and the pixels of its sheet. */
export interface LoadedSet {
  set: TerrainSet
  /** The tiles edge to edge at the project's density: what the atlas reads. */
  image: RgbaImage
  /** The file's pixels as they are, before the grid was cut and scaled; what a library shows. Absent for a generated set. */
  source?: RgbaImage
}

/** A trim tag, read as the plain tag it also is; any other tag as it is. */
const plainTrim = (tag: Tag): Tag => {
  const slot = slotOfTag(tag)
  return slot === FRINGE || slot === PICKET ? tagOf(materialOfTag(tag) as number) : tag
}

/** What the fallback is until the settings say otherwise. */
export const DEFAULT_FALLBACK = 0xff00ff

/** The four tags at a corner, in `CornerTags` order; `null` is nothing. */
export type CornerKeys = CornerTags

export interface AtlasTile {
  tile: number
  /** No tile is tagged for the combination, so this is the fallback. */
  missing: boolean
  /** The missing combination's name (`MissingReport.combo`), for the mesher to report per chunk. */
  combo?: string
}

export interface MissingReport {
  /** The distinct materials at the corner by name, alphabetical, then "edge" when nothing is among them. */
  combo: string
}

/** How an atlas names and draws what is not drawn. */
export interface AtlasOptions {
  /** What to call a tag in the missing report, the artist's list of transitions to draw. Defaults to the tag itself. */
  nameOf?: (key: Tag) => string
  /** The colour (0xRRGGBB) a corner no tile answers is drawn: `DEFAULT_FALLBACK` unless given. */
  fallback?: number
}

const ATLAS_COLUMNS = 64
/** Room beyond the tagged tiles: the blank tile and the fallback. */
const SPARE_ROOM = 2
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
  /** Tags interned to small ids; 0 is nothing. */
  private ids = new Map<Tag, number>()
  private sheetTiles = new Map<string, number>() // `<sheet>:<index>` -> atlas tile
  private readonly sets = new Map<string, LoadedSet>()
  /** Every authored tile of every set, by its four tags: one index across the sheets, not one per sheet. */
  private readonly authored = new Map<string, { loaded: LoadedSet; index: number }>()
  private readonly missingCombos = new Set<string>()
  private readonly nameOf: (key: Tag) => string
  private readonly fallbackColor: number
  /** Bumps whenever `image` changes content or size. */
  version = 0

  constructor(sets: readonly LoadedSet[], options: AtlasOptions = {}) {
    this.nameOf = options.nameOf ?? ((key) => String(key))
    this.fallbackColor = options.fallback ?? DEFAULT_FALLBACK
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
    const rows = Math.max(MIN_ROWS, Math.ceil((tagged + SPARE_ROOM) / ATLAS_COLUMNS))
    if (rows * tile > 8192 || rows > MAX_ROWS) throw new Error(`The terrain sets tag ${tagged} tiles of ${tile} px; an atlas that tall (${rows * tile} px) exceeds what a GPU takes.`)
    this.rows = rows
    this.buffer = new Uint8ClampedArray(ATLAS_COLUMNS * tile * rows * tile * 4)
    // Every tagged tile of every set is in the atlas from the start, so an exact answer never grows it.
    // The same pass builds the cross-set index: first tile wins where two sheets drew the same corner,
    // in set order, which is the project's image order.
    for (const loaded of sets) {
      for (const [index, tags] of loaded.set.tiles) {
        this.sheetTile(loaded, index)
        const key = cornerKey(tags)
        if (!this.authored.has(key)) this.authored.set(key, { loaded, index })
        // A fringe or picket tile is also the ordinary edge it is, indexed under its plain tags too, by the same
        // first-drawn-wins order: tagging a tile as trim never hands its corner to a later one.
        const plain = cornerKey(tags.map(plainTrim) as unknown as CornerTags)
        if (plain !== key && !this.authored.has(plain)) this.authored.set(plain, { loaded, index })
      }
    }
  }

  /** The whole atlas; the same buffer every time, so a consumer keys its upload on `version`, not on identity. */
  get image(): RgbaImage {
    return { width: ATLAS_COLUMNS * this.tile, height: this.rows * this.tile, data: this.buffer }
  }

  /** How many of the atlas's tiles are taken. */
  get used(): number {
    return this.next
  }

  /** The tile for a corner: the authored one wherever a set has it, else the fallback. */
  tileFor(keys: CornerKeys): AtlasTile {
    // Four ids of at most 2^12 each pack into 48 bits: one number, no string per corner on the meshing path.
    const packed = ((this.id(keys[0]) * 4096 + this.id(keys[1])) * 4096 + this.id(keys[2])) * 4096 + this.id(keys[3])
    const cached = this.byCorner.get(packed)
    if (cached) return cached
    const answer = this.resolve(keys)
    this.byCorner.set(packed, answer)
    return answer
  }

  private id(key: Tag): number {
    if (key === null) return 0
    let id = this.ids.get(key)
    if (id === undefined) {
      id = this.ids.size + 1
      if (id >= 4096) throw new Error('The atlas addresses at most 4095 distinct tags.')
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

  /**
   * The tile a material's trim is drawn from, or `null` when it has none: its
   * fringe is its bottom edge tagged `fringe` (the material on top, nothing
   * below), its picket its top edge tagged `picket`. `tag` is the material's
   * plain tag, as a face's layer carries it.
   */
  trimTile(tag: Tag, slot: typeof FRINGE | typeof PICKET): number | null {
    const material = materialOfTag(tag)
    if (material === null) return null
    const t = tagOf(material, slot)
    const found = this.authored.get(cornerKey(slot === FRINGE ? [t, t, null, null] : [null, null, t, t]))
    return found ? this.sheetTile(found.loaded, found.index) : null
  }

  /** Every corner no tile answered so far, each combination named once: the artist's list of tiles to draw. */
  missingReport(): readonly MissingReport[] {
    return [...this.missingCombos].map((combo) => ({ combo }))
  }

  private resolve(keys: CornerKeys): AtlasTile {
    const tags = [...new Set(keys.filter((k): k is string => k !== null))]
    if (tags.length === 0) return { tile: this.blankTile(), missing: false }
    // Wherever it was drawn. A tag names a material, so nothing about a corner is local to a sheet.
    const found = this.authored.get(cornerKey(keys))
    if (found) return { tile: this.sheetTile(found.loaded, found.index), missing: false }
    // By name, so one transition is one entry however its corners are arranged.
    const names = tags.map((k) => this.nameOf(k)).sort()
    if (keys.includes(null)) names.push('edge')
    const combo = names.join(' · ')
    this.missingCombos.add(combo)
    return { tile: this.fallbackTile(), missing: true, combo }
  }

  /** The tile a face with nothing on it draws, and a corner no tile answers: flat, the fallback colour. */
  fallbackTile(): number {
    if (this.fallback === null) {
      this.fallback = this.allocate()
      this.fill(this.fallback, 15, this.fallbackColor)
    }
    return this.fallback
  }

  /** The atlas tile holding a sheet's tile, copied in on first use. */
  private sheetTile(loaded: LoadedSet, index: number): number {
    const key = `${loaded.set.sheet}:${index}`
    const known = this.sheetTiles.get(key)
    if (known !== undefined) return known
    const tile = this.allocate()
    const sx = (index % loaded.set.columns) * this.tile
    const sy = Math.floor(index / loaded.set.columns) * this.tile
    this.blit(loaded.image, sx, sy, tile)
    this.sheetTiles.set(key, tile)
    return tile
  }

  private blank: number | null = null
  private fallback: number | null = null

  /** The tile a layer with nothing at a corner draws: transparent. */
  blankTile(): number {
    if (this.blank === null) this.blank = this.allocate()
    return this.blank
  }

  /** A fresh, transparent tile. The atlas does not grow. */
  private allocate(): number {
    if (this.next >= ATLAS_COLUMNS * this.rows) throw new Error(`The terrain atlas is full: ${ATLAS_COLUMNS * this.rows} tiles.`)
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

  /** Copy one tile of `source` at (`sx`, `sy`) onto atlas tile `tile`. */
  private blit(source: RgbaImage, sx: number, sy: number, tile: number): void {
    const t = this.tile
    const dx = (tile % ATLAS_COLUMNS) * t
    const dy = Math.floor(tile / ATLAS_COLUMNS) * t
    const width = ATLAS_COLUMNS * t
    for (let y = 0; y < t; y++) {
      const si = ((sy + y) * source.width + sx) * 4
      this.buffer.set(source.data.subarray(si, si + t * 4), ((dy + y) * width + dx) * 4)
    }
    this.version += 1
  }
}
