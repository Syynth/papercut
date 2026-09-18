/**
 * Tile sets: what every tile on a sheet is (spec §2).
 *
 * A set is part of its image's entry in the project file (ruling of
 * 2026-09-17; there are no sidecars). It tags each tile with the MATERIAL at
 * each of its four corners, or nothing. That is the whole model: a tile is
 * authored as the transition it shows — half grass, half path — and tagged
 * so; position on the sheet means nothing to anyone but the artist. The
 * renderer's one question is `exactTile`: the tile tagged exactly like a
 * corner.
 *
 * A tag names a material rather than something local to this image (ruling of
 * 2026-09-17), which is why a set no longer carries a list of its own. It
 * also means two materials can meet in an authored tile whatever image each
 * one's other art is on, and why the atlas can look across every set it has
 * rather than inside one.
 *
 * The template is the RPG Maker half of the story: `stampTemplate` tags a
 * 4×4 block from position for a pair of terrains, so art drawn to the
 * template is wired in one placement. Art that was not is tagged one corner
 * at a time with `tagCorner`. Both return a new set; a set is a value.
 *
 * Nothing here touches pixels. The atlas (`atlas.ts`) is what pairs a set
 * with its image.
 */

import { materialOfTag, type CornerTags, type ImageTerrain, type Tag } from '@papercut/document'

export type { CornerTags, Tag }

/** The bit each corner holds in a template mask, in `CornerTags` order. */
export const CORNER_BITS = [1, 2, 4, 8] as const

export interface TerrainSet {
  /** The image's file name: its identity in the project. */
  sheet: string
  /** Pixels per tile, square — the project's density, once the image's grid has been cut and scaled. */
  tile: number
  /** The image's size in tiles. */
  columns: number
  rows: number
  /** Tile index (row-major on the image) → corner tags. Untagged tiles are absent. */
  tiles: ReadonlyMap<number, CornerTags>
}

export class TerrainSetError extends Error {}

/**
 * The set an image's entry describes, over an image known to be `columns` × `rows` tiles. A tag on a tile past the
 * edge — the image shrank, or the grid changed — is dropped and reported by index rather than refused, since the
 * rest of the set is still right.
 */
export function terrainSetFrom(sheet: string, tile: number, columns: number, rows: number, terrain: ImageTerrain): { set: TerrainSet; dropped: number[] } {
  const count = columns * rows
  const tiles = new Map<number, CornerTags>()
  const dropped: number[] = []
  for (const [key, tags] of Object.entries(terrain.tiles)) {
    const index = Number(key)
    if (index >= count) dropped.push(index)
    else tiles.set(index, [...tags])
  }
  return { set: { sheet, tile, columns, rows, tiles }, dropped: dropped.sort((x, y) => x - y) }
}

/** The set as the project file holds it: the tags by tile index, in order. */
export function terrainOf(set: TerrainSet): ImageTerrain {
  const tiles: Record<string, [Tag, Tag, Tag, Tag]> = {}
  for (const index of [...set.tiles.keys()].sort((x, y) => x - y)) tiles[String(index)] = [...(set.tiles.get(index) as CornerTags)] as [Tag, Tag, Tag, Tag]
  return { tiles }
}

/** A fresh set for a sheet, with nothing tagged. */
export function createTerrainSet(sheet: string, tile: number, columns: number, rows: number): TerrainSet {
  return { sheet, tile, columns, rows, tiles: new Map() }
}

/** The tags a template gives the tile at `mask` within its block: `over` at each corner whose bit is set, `under` elsewhere. */
export function templateTags(mask: number, under: Tag, over: Tag): CornerTags {
  return CORNER_BITS.map((bit) => (mask & bit ? over : under)) as unknown as CornerTags
}

/**
 * Place the template on the 4×4 block whose top-left tile is
 * (`column`, `row`): the sixteen tiles are tagged by position, tile `mask`
 * at (`column + (mask & 3)`, `row + (mask >> 2)`). `under` may be `null`,
 * which makes `over`'s edge set. Refused when the block leaves the sheet.
 */
export function stampTemplate(set: TerrainSet, column: number, row: number, under: Tag, over: Tag): TerrainSet {
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

/**
 * Every corner tagged with a material becomes nothing, whatever slot it named.
 *
 * What deleting a material does to the art. A tag naming an id the project no
 * longer has would send the atlas looking for something that cannot exist, so
 * deleting clears tags the same way it repaints voxels. A tile left tagged
 * nothing everywhere is forgotten; a tile the template tagged nothing
 * everywhere on purpose stays, because it was never this material's.
 */
export function removeMaterial(set: TerrainSet, material: number): TerrainSet {
  const tiles = new Map<number, CornerTags>()
  for (const [index, tags] of set.tiles) {
    if (!tags.some((t) => materialOfTag(t) === material)) {
      tiles.set(index, tags)
      continue
    }
    const next = tags.map((t) => (materialOfTag(t) === material ? null : t)) as unknown as CornerTags
    if (next.some((t) => t !== null)) tiles.set(index, next)
  }
  return { ...set, tiles }
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

/** One string for a corner's four tags: what an index of authored tiles is keyed on. */
export const cornerKey = (tags: CornerTags): string => tags.map((t) => t ?? '').join('|')

const indexCache = new WeakMap<ReadonlyMap<number, CornerTags>, Map<string, number>>()

/** The tile tagged exactly like `tags`, or `null`. The first such tile wins if the artist tagged two the same. */
export function exactTile(set: TerrainSet, tags: CornerTags): number | null {
  let byKey = indexCache.get(set.tiles)
  if (!byKey) {
    byKey = new Map()
    for (const [index, t] of set.tiles) {
      const key = cornerKey(t)
      if (!byKey.has(key)) byKey.set(key, index)
    }
    indexCache.set(set.tiles, byKey)
  }
  return byKey.get(cornerKey(tags)) ?? null
}

/** A tag's edge-set tile for a template mask: itself at the set corners, nothing elsewhere. */
export function edgeTile(set: TerrainSet, tag: Tag, mask: number): number | null {
  return exactTile(set, templateTags(mask, null, tag))
}

/** How many of a tag's sixteen edge-set tiles the set has. */
export function edgeCoverage(set: TerrainSet, tag: Tag): number {
  let count = 0
  for (let mask = 0; mask < 16; mask++) if (edgeTile(set, tag, mask) !== null) count += 1
  return count
}

/** Whether every one of the sixteen tiles between `a` and `b` is tagged, in either role. */
export function pairAuthored(set: TerrainSet, a: Tag, b: Tag): boolean {
  for (let mask = 1; mask < 15; mask++) if (exactTile(set, templateTags(mask, a, b)) === null && exactTile(set, templateTags(mask, b, a)) === null) return false
  return true
}

/** One corner of an assembled patch: where it sits, what meets there, and the tile that draws it. */
export interface PatchCorner {
  column: number
  row: number
  corners: CornerTags
  /** The tile tagged exactly so, or `null` when nothing is — which is what the atlas would composite. */
  tile: number | null
}

/**
 * Lay a patch of CELLS out through the dual grid and say which tile each corner needs.
 *
 * The editor's preview is this: give it a shape drawn in terrain ids and it answers with the tiles
 * a map would actually use, so what the artist sees is their own art assembled rather than a swatch
 * of the material's colour. A corner nothing is tagged for comes back `null`, which is precisely the
 * hole the atlas fills by compositing — so an incomplete set shows its gaps instead of hiding them.
 *
 * `cells` is row-major and may hold `null` for nothing. The corner grid is one larger in each
 * direction, because corners sit between cells and around the outside.
 */
export function assemble(set: TerrainSet, cells: ReadonlyArray<ReadonlyArray<Tag>>): PatchCorner[] {
  const rows = cells.length
  const columns = rows === 0 ? 0 : cells[0].length
  const at = (r: number, c: number): Tag => (r < 0 || c < 0 || r >= rows || c >= columns ? null : (cells[r][c] ?? null))
  const out: PatchCorner[] = []
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= columns; c++) {
      const corners: CornerTags = [at(r - 1, c - 1), at(r - 1, c), at(r, c - 1), at(r, c)]
      out.push({ column: c, row: r, corners, tile: corners.every((t) => t === null) ? null : exactTile(set, corners) })
    }
  }
  return out
}
