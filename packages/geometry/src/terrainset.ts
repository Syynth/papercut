/**
 * Terrain sets: what every tile on a sheet is (spec §2).
 *
 * A terrain set is the sidecar beside a sheet image. It names the terrains
 * the sheet draws and tags each tile with the terrain at each of its four
 * corners, or nothing. That is the whole model: a tile is authored as the
 * transition it shows — half grass, half path — and tagged so; position on
 * the sheet means nothing to anyone but the artist. The renderer's one
 * question is `exactTile`: the tile tagged exactly like a corner.
 *
 * The template is the RPG Maker half of the story: `stampTemplate` tags a
 * 4×4 block from position for a pair of terrains, so art drawn to the
 * template is wired in one placement. Art that was not is tagged one corner
 * at a time with `tagCorner`. Both return a new set; a set is a value.
 *
 * Nothing here touches pixels. The atlas (`atlas.ts`) is what pairs a set
 * with its image.
 */

/** A corner's terrain: an id in the set's `terrains`, or `null` for nothing — the edge of the ground, the top of a cliff. */
export type Tag = string | null

/** The four corners of a tile, in the order NW, NE, SW, SE. */
export type CornerTags = readonly [Tag, Tag, Tag, Tag]

/** The bit each corner holds in a template mask, in `CornerTags` order. */
export const CORNER_BITS = [1, 2, 4, 8] as const

export interface TerrainDef {
  id: string
  name: string
  /** `#rrggbb`, the swatch and the fallback fill. */
  color: string
}

export interface TerrainSet {
  /** The sheet image's file name, relative to the sidecar. */
  sheet: string
  /** Pixels per tile, square. */
  tile: number
  /** The sheet's size in tiles. */
  columns: number
  rows: number
  terrains: TerrainDef[]
  /** Tile index (row-major on the sheet) → corner tags. Untagged tiles are absent. */
  tiles: ReadonlyMap<number, CornerTags>
}

export const TERRAIN_SET_VERSION = 1

export class TerrainSetError extends Error {}

/** The sidecar's shape on disk. */
export interface TerrainSetFile {
  version: number
  sheet: string
  tile: number
  columns: number
  rows: number
  terrains: TerrainDef[]
  tiles: Record<string, [Tag, Tag, Tag, Tag]>
}

function must(condition: boolean, message: string): asserts condition {
  if (!condition) throw new TerrainSetError(message)
}

/** Read a sidecar, strictly: a wrong shape is refused with a message, never half-read. */
export function parseTerrainSet(raw: unknown): TerrainSet {
  must(typeof raw === 'object' && raw !== null, 'A terrain set is a JSON object.')
  const file = raw as Partial<TerrainSetFile>
  must(file.version === TERRAIN_SET_VERSION, `Terrain set version ${String(file.version)}; this build reads ${TERRAIN_SET_VERSION}.`)
  must(typeof file.sheet === 'string' && file.sheet.length > 0, 'A terrain set names its sheet.')
  for (const key of ['tile', 'columns', 'rows'] as const) {
    const value = file[key]
    must(typeof value === 'number' && Number.isInteger(value) && value > 0, `Terrain set ${key} is a positive integer.`)
  }
  must(Array.isArray(file.terrains), 'A terrain set lists its terrains.')
  const ids = new Set<string>()
  const terrains: TerrainDef[] = []
  for (const t of file.terrains as unknown[]) {
    const def = t as Partial<TerrainDef>
    must(typeof def.id === 'string' && def.id.length > 0, 'Every terrain has an id.')
    must(!ids.has(def.id), `Terrain ${def.id} is listed twice.`)
    ids.add(def.id)
    terrains.push({ id: def.id, name: typeof def.name === 'string' ? def.name : def.id, color: typeof def.color === 'string' ? def.color : '#808080' })
  }
  const count = (file.columns as number) * (file.rows as number)
  const tiles = new Map<number, CornerTags>()
  must(typeof file.tiles === 'object' && file.tiles !== null, 'A terrain set tags its tiles.')
  for (const [key, tags] of Object.entries(file.tiles as Record<string, unknown>)) {
    const index = Number(key)
    must(Number.isInteger(index) && index >= 0 && index < count, `Tile ${key} is not on a ${file.columns}×${file.rows} sheet.`)
    must(Array.isArray(tags) && tags.length === 4, `Tile ${key} has four corner tags.`)
    for (const tag of tags as unknown[]) must(tag === null || (typeof tag === 'string' && ids.has(tag)), `Tile ${key} names a terrain the set does not have.`)
    tiles.set(index, [...(tags as [Tag, Tag, Tag, Tag])])
  }
  return { sheet: file.sheet, tile: file.tile as number, columns: file.columns as number, rows: file.rows as number, terrains, tiles }
}

export function serializeTerrainSet(set: TerrainSet): string {
  const tiles: Record<string, [Tag, Tag, Tag, Tag]> = {}
  for (const index of [...set.tiles.keys()].sort((a, b) => a - b)) tiles[String(index)] = [...(set.tiles.get(index) as CornerTags)] as [Tag, Tag, Tag, Tag]
  const file: TerrainSetFile = { version: TERRAIN_SET_VERSION, sheet: set.sheet, tile: set.tile, columns: set.columns, rows: set.rows, terrains: set.terrains, tiles }
  return JSON.stringify(file, null, 2)
}

/** A fresh set for a sheet, with no terrains and nothing tagged. */
export function createTerrainSet(sheet: string, tile: number, columns: number, rows: number): TerrainSet {
  return { sheet, tile, columns, rows, terrains: [], tiles: new Map() }
}

export function addTerrain(set: TerrainSet, terrain: TerrainDef): TerrainSet {
  if (set.terrains.some((t) => t.id === terrain.id)) throw new TerrainSetError(`Terrain ${terrain.id} is already in the set.`)
  return { ...set, terrains: [...set.terrains, terrain] }
}

/** The tags a template gives the tile at `mask` within its block: `over` at each corner whose bit is set, `under` elsewhere. */
export function templateTags(mask: number, under: Tag, over: string): CornerTags {
  return CORNER_BITS.map((bit) => (mask & bit ? over : under)) as unknown as CornerTags
}

/**
 * Place the template on the 4×4 block whose top-left tile is
 * (`column`, `row`): the sixteen tiles are tagged by position, tile `mask`
 * at (`column + (mask & 3)`, `row + (mask >> 2)`). `under` may be `null`,
 * which makes `over`'s edge set. Refused when the block leaves the sheet.
 */
export function stampTemplate(set: TerrainSet, column: number, row: number, under: Tag, over: string): TerrainSet {
  if (column < 0 || row < 0 || column + 4 > set.columns || row + 4 > set.rows) throw new TerrainSetError(`A 4×4 block at ${column},${row} does not fit a ${set.columns}×${set.rows} sheet.`)
  const tiles = new Map(set.tiles)
  for (let mask = 0; mask < 16; mask++) tiles.set((row + (mask >> 2)) * set.columns + column + (mask & 3), templateTags(mask, under, over))
  return { ...set, tiles }
}

/** Set one corner (0 NW, 1 NE, 2 SW, 3 SE) of one tile. An untagged tile starts as nothing at every corner. */
export function tagCorner(set: TerrainSet, index: number, corner: number, tag: Tag): TerrainSet {
  const current = set.tiles.get(index) ?? [null, null, null, null]
  const next = [...current] as [Tag, Tag, Tag, Tag]
  next[corner] = tag
  const tiles = new Map(set.tiles)
  if (next.every((t) => t === null)) tiles.delete(index)
  else tiles.set(index, next)
  return { ...set, tiles }
}

/** Take a terrain out of the set: its definition, and every corner tagged with it, which becomes nothing. A tile that carried it and is left tagged nothing everywhere is forgotten; a tile the template tagged nothing everywhere on purpose stays. */
export function removeTerrain(set: TerrainSet, id: string): TerrainSet {
  if (!set.terrains.some((t) => t.id === id)) throw new TerrainSetError(`Terrain ${id} is not in the set.`)
  const tiles = new Map<number, CornerTags>()
  for (const [index, tags] of set.tiles) {
    if (!tags.includes(id)) {
      tiles.set(index, tags)
      continue
    }
    const next = tags.map((t) => (t === id ? null : t)) as unknown as CornerTags
    if (next.some((t) => t !== null)) tiles.set(index, next)
  }
  return { ...set, terrains: set.terrains.filter((t) => t.id !== id), tiles }
}

/**
 * The corner under a point on the sheet, in sheet pixels: the tile the point
 * is in and which of its quadrants holds it (0 NW, 1 NE, 2 SW, 3 SE), or
 * `null` off the sheet. What a tagging tool asks on every click and drag.
 */
export function cornerAt(set: TerrainSet, x: number, y: number): { index: number; corner: number } | null {
  if (!(x >= 0 && y >= 0)) return null
  const column = Math.floor(x / set.tile)
  const row = Math.floor(y / set.tile)
  if (column >= set.columns || row >= set.rows) return null
  const half = set.tile / 2
  const corner = (x - column * set.tile < half ? 0 : 1) + (y - row * set.tile < half ? 0 : 2)
  return { index: row * set.columns + column, corner }
}

const tagKey = (tags: CornerTags): string => tags.map((t) => t ?? '').join('|')

const indexCache = new WeakMap<ReadonlyMap<number, CornerTags>, Map<string, number>>()

/** The tile tagged exactly like `tags`, or `null`. The first such tile wins if the artist tagged two the same. */
export function exactTile(set: TerrainSet, tags: CornerTags): number | null {
  let byKey = indexCache.get(set.tiles)
  if (!byKey) {
    byKey = new Map()
    for (const [index, t] of set.tiles) {
      const key = tagKey(t)
      if (!byKey.has(key)) byKey.set(key, index)
    }
    indexCache.set(set.tiles, byKey)
  }
  return byKey.get(tagKey(tags)) ?? null
}

/** A terrain's edge-set tile for a template mask: itself at the set corners, nothing elsewhere. */
export function edgeTile(set: TerrainSet, terrain: string, mask: number): number | null {
  return exactTile(set, templateTags(mask, null, terrain))
}

/** How many of a terrain's sixteen edge-set tiles the set has. */
export function edgeCoverage(set: TerrainSet, terrain: string): number {
  let count = 0
  for (let mask = 0; mask < 16; mask++) if (edgeTile(set, terrain, mask) !== null) count += 1
  return count
}

/** Whether every one of the sixteen tiles between `a` and `b` is tagged, in either role. */
export function pairAuthored(set: TerrainSet, a: string, b: string): boolean {
  for (let mask = 1; mask < 15; mask++) if (exactTile(set, templateTags(mask, a, b)) === null && exactTile(set, templateTags(mask, b, a)) === null) return false
  return true
}
