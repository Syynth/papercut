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

import { TAG_DIRECTIONS, archetypeOfTag, directionOfTag, materialOfTag, slotOfTag, tagOf, withArchetype, withDirection, type ArchetypeId, type RgbaImage } from '@papercut/document'

import { FRINGE, PICKET } from './archetype'

import { CORNER_BITS, cornerKey, type CornerTags, type Tag, type TerrainSet } from './terrainset'

/** A terrain set and the pixels of its sheet. */
export interface LoadedSet {
  set: TerrainSet
  /** The tiles edge to edge at the project's density: what the atlas reads. */
  image: RgbaImage
  /** The file's pixels as they are, before the grid was cut and scaled; what a library shows. Absent for a generated set. */
  source?: RgbaImage
  /** The id of the project image it was loaded from, which sprites and pasted tiles name it by. Absent for a generated set. */
  imageId?: number
  /** How many frames its file has — more than one for an animated `.aseprite`, of which `source` is the entry's chosen frame. Absent for a generated set. */
  frames?: number
}

/** A trim tag, read as the plain tag it also is — same material, same archetype, no slot; any other tag as it is. */
const plainTrim = (tag: Tag): Tag => {
  const slot = slotOfTag(tag)
  return slot === FRINGE || slot === PICKET ? tagOf(materialOfTag(tag) as number, null, archetypeOfTag(tag) ?? null, directionOfTag(tag) ?? null) : tag
}

/** An archetype as a small number for the corner cache's key: none is 0. */
const ARCHETYPE_INDEX: Record<ArchetypeId, number> = { floor: 1, wall: 2, ramp: 3 }

/** What the fallback is until the settings say otherwise. */
export const DEFAULT_FALLBACK = 0xff00ff

/** Which of a trim's tiles: its straight edge, or, for a fringe, the outer corner where a rim runs in from one side and stops. */
export type TrimPart = 'edge' | 'from-left' | 'from-right'

/** The four tags at a corner, in `CornerTags` order; `null` is nothing. */
export type CornerKeys = CornerTags

/**
 * How a tile drawn for one direction is laid on a face that runs another (ruling of 2026-09-19).
 *
 * `corners[i]` is the corner of the ART that lands on corner `i` of the face, NW NE SW SE, which is also which
 * quadrant of the tile a quarter of the face shows. The three flags say the same thing for the pixels: swap the
 * tile's axes, then flip across, then flip down. Absent on a tile is the identity.
 */
export interface Orientation {
  readonly corners: readonly [number, number, number, number]
  readonly transpose: boolean
  readonly flipU: boolean
  readonly flipV: boolean
}

/**
 * The orientation that lays art drawn for a direction onto a face that runs `turns` quarter turns on from it, in
 * the map's direction order (east, south, west, north — clockwise on a sheet, which is drawn north up).
 *
 * The opposite direction is MIRRORED along the run, not turned half way round: a staircase seen from the other end
 * is its mirror image, and a half turn would put its light on the wrong side as well. `alongY` says which way the
 * art's run lies, which is what decides the mirror's axis.
 */
function orientationFor(turns: number, alongY: boolean): Orientation | undefined {
  // Each as the art's coordinates (a, b) for a point (x, y) of the face, both with y down the sheet.
  const map: ((x: number, y: number) => [number, number]) | null = turns === 0 ? null : turns === 2 ? (alongY ? (x, y) => [x, 1 - y] : (x, y) => [1 - x, y]) : turns === 1 ? (x, y) => [y, 1 - x] : (x, y) => [1 - y, x]
  if (map === null) return undefined
  const corners = [0, 1, 2, 3].map((i) => {
    const [a, b] = map(i & 1, i >> 1)
    return b * 2 + a
  }) as [number, number, number, number]
  return turns === 2 ? { corners, transpose: false, flipU: !alongY, flipV: alongY } : { corners, transpose: true, flipU: turns === 1, flipV: turns === 3 }
}

export interface AtlasTile {
  tile: number
  /** How the tile is laid on the face, when it was drawn for another direction than the face runs. */
  orient?: Orientation
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
/**
 * Room for tiles pasted whole on faces (ruling of 2026-09-18), which need not be tagged and so are not counted with
 * the tagged ones: four rows, 256 distinct tiles. Past that a pasted tile draws the fallback, reported like a missing
 * corner.
 */
export const PASTE_ROOM = ATLAS_COLUMNS * 4
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
  /** The sets by the id of the project image they were loaded from, for pasted tiles. */
  private readonly byImage = new Map<number, LoadedSet>()
  /** How many pasted tiles have been copied in, against `PASTE_ROOM`. */
  private pasted = 0
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
      if (loaded.imageId !== undefined && !this.byImage.has(loaded.imageId)) this.byImage.set(loaded.imageId, loaded)
    }
    this.tile = tile
    const tagged = sets.reduce((n, loaded) => n + loaded.set.tiles.size, 0)
    const rows = Math.max(MIN_ROWS, Math.ceil((tagged + SPARE_ROOM + PASTE_ROOM) / ATLAS_COLUMNS))
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

  /**
   * The tile for a corner of a face of `archetype`: the authored one wherever a set has it, else the fallback.
   *
   * Specific before general (ruling of 2026-09-18): the tile whose corners name this archetype, then the tile whose
   * corners name none and so mean any. A join drawn across a fold, where the corners name two archetypes, waits on
   * the mesher reading across the fold; until it does, the far side of a fold is nothing, as it has been.
   *
   * `direction` is the way the face runs, as an index into the map's direction order, for a face that has one: a
   * ramp, by the way it descends. Within an archetype the art for this direction comes first, then the opposite
   * direction's mirrored, then another's turned, then art that names no direction (ruling of 2026-09-19).
   */
  tileFor(keys: CornerKeys, archetype: ArchetypeId | null = null, direction: number | null = null): AtlasTile {
    // Four ids of at most 2^12 each pack into 48 bits; the archetype and the direction ride above them in one number, so there is no string per corner on the meshing path.
    const packed = ((((this.id(keys[0]) * 4096 + this.id(keys[1])) * 4096 + this.id(keys[2])) * 4096 + this.id(keys[3])) * 4 + (archetype === null ? 0 : ARCHETYPE_INDEX[archetype])) * 5 + (direction === null ? 0 : direction + 1)
    const cached = this.byCorner.get(packed)
    if (cached) return cached
    const answer = this.resolve(keys, archetype, direction)
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
   *
   * A fringe also has its two outer corners (ruling of 2026-09-18): `'from-left'`
   * is the tile with the material top-left only, where a rim runs in from the
   * left and stops; `'from-right'` the one with it top-right only.
   */
  trimTile(tag: Tag, slot: typeof FRINGE | typeof PICKET, part: TrimPart = 'edge'): number | null {
    const material = materialOfTag(tag)
    if (material === null) return null
    // A trim is the material's FLOOR art hung or stood somewhere else, so the tile named for floors first, then for any.
    for (const archetype of ['floor', null] as const) {
      const t = tagOf(material, slot, archetype, null)
      const corners: CornerTags = slot === PICKET ? [null, null, t, t] : part === 'from-left' ? [t, null, null, null] : part === 'from-right' ? [null, t, null, null] : [t, t, null, null]
      const found = this.authored.get(cornerKey(corners))
      if (found) return this.sheetTile(found.loaded, found.index)
    }
    return null
  }

  /**
   * The atlas tile holding tile `index` of the image with id `image`, pasted whole on a face, or `null` when that
   * image did not load, the index is off its grid, or the room for pasted tiles is used up.
   */
  pastedTile(image: number, index: number): number | null {
    const loaded = this.byImage.get(image)
    if (!loaded || index >= loaded.set.columns * loaded.set.rows) return null
    if (this.sheetTiles.has(`${loaded.set.sheet}:${index}`)) return this.sheetTile(loaded, index)
    // Tagged tiles were counted when the atlas was sized; only an untagged one takes paste room.
    if (!loaded.set.tiles.has(index)) {
      if (this.pasted >= PASTE_ROOM) return null
      this.pasted += 1
    }
    return this.sheetTile(loaded, index)
  }

  /** Every corner no tile answered so far, each combination named once: the artist's list of tiles to draw. */
  missingReport(): readonly MissingReport[] {
    return [...this.missingCombos].map((combo) => ({ combo }))
  }

  private resolve(keys: CornerKeys, archetype: ArchetypeId | null, direction: number | null): AtlasTile {
    const tags = [...new Set(keys.filter((k): k is string => k !== null))]
    if (tags.length === 0) return { tile: this.blankTile(), missing: false }
    // Wherever it was drawn. A tag names a material, so nothing about a corner is local to a sheet.
    // Art drawn for this kind of face first, then art drawn for any; and within each, by direction.
    for (const a of archetype === null ? [null] : [archetype, null]) {
      const named = keys.map((k) => withArchetype(k, a)) as unknown as CornerKeys
      if (direction !== null) {
        // This direction, the opposite mirrored, then the two beside it turned.
        for (const turns of [0, 2, 1, 3]) {
          const from = (direction - turns + 4) % 4
          const orient = orientationFor(turns, from % 2 === 1)
          // The art's corners are the face's, carried back through the orientation.
          const art: Tag[] = [null, null, null, null]
          for (let i = 0; i < 4; i++) art[orient ? orient.corners[i] : i] = withDirection(named[i], TAG_DIRECTIONS[from])
          const found = this.authored.get(cornerKey(art as unknown as CornerKeys))
          if (found) return { tile: this.sheetTile(found.loaded, found.index), missing: false, ...(orient ? { orient } : {}) }
        }
      }
      const found = this.authored.get(cornerKey(named))
      if (found) return { tile: this.sheetTile(found.loaded, found.index), missing: false }
    }
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
