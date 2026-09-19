/**
 * What a material draws, asked of the tags (rulings of 2026-09-17 and 2026-09-19).
 *
 * Nothing is stored about a material's art or about a transition: the tiles
 * tagged with exactly these materials ARE it, the arrangements no tile answers
 * are what is left to draw, and where the art sits is wherever those tiles
 * turned up. Everything the Materials section shows — a coverage number, the
 * cells of its grid, the faces a material has art for, the crop of the sheet
 * its tiles sit on — is one of these queries, across every loaded sheet at once.
 *
 * Pure, and the app's rather than geometry's only because it is the screen's
 * vocabulary (a SUBJECT, a CROP); it reads nothing but loaded sets.
 */

import { archetypeOfTag, materialOfTag, tagOf, withArchetype, type ArchetypeId, type Tag } from '@papercut/document'
import { CORNER_BITS, CORNER_BLOCKS, archetypes, arrangements, exactTile, templateTags, type CornerTags, type LoadedSet } from '@papercut/geometry'

/** A tile, by the sheet it is on. */
export interface Found {
  loaded: LoadedSet
  index: number
}

/** What the section is looking at: a material on its own, or meeting another. */
export interface Subject {
  material: number
  other: number | null
}

/** The tile tagged exactly so, on the first sheet that has it, in the project's image order — the rule the atlas follows. */
export function findTile(sets: readonly LoadedSet[], tags: CornerTags): Found | null {
  for (const loaded of sets) {
    const index = exactTile(loaded.set, tags)
    if (index !== null) return { loaded, index }
  }
  return null
}

/**
 * The tile that answers a corner on a face of `archetype`, the way the atlas answers it: the art named for that
 * archetype, then the art named for any. With no archetype asked for, any tile at all counts — named for any face
 * first, then for each in turn — which is what "has anyone drawn this" means in a list.
 */
export function answerFor(sets: readonly LoadedSet[], tags: CornerTags, archetype: ArchetypeId | null): Found | null {
  const named = (a: ArchetypeId | null): Found | null => findTile(sets, tags.map((t) => withArchetype(t, a)) as unknown as CornerTags)
  if (archetype !== null) return named(archetype) ?? named(null)
  for (const a of [null, ...archetypes().map((x) => x.id)]) {
    const found = named(a)
    if (found) return found
  }
  return null
}

/** How much of a subject's art has been drawn: the arrangements it owes, and where each one's tile is. */
export interface Coverage {
  /** The arrangement masks this subject owes. Fifteen for a material alone; fourteen for a pairing. */
  masks: readonly number[]
  /** Per mask, the tile that draws it. */
  tiles: ReadonlyMap<number, Found | null>
  drawn: number
}

/** The plain tags of a subject: the material's, and what it meets — the other material, or nothing. */
export function subjectTags(subject: Subject): { mine: Tag; theirs: Tag } {
  return { mine: tagOf(subject.material), theirs: subject.other === null ? null : tagOf(subject.other) }
}

export function coverageOf(sets: readonly LoadedSet[], subject: Subject, archetype: ArchetypeId | null): Coverage {
  const { mine, theirs } = subjectTags(subject)
  // Mask 15 is every corner this material and none of the other: the material's OWN tile, not something a pairing owes.
  const masks = arrangements()
    .map((a) => a.mask)
    .filter((mask) => theirs === null || mask !== 15)
  const tiles = new Map<number, Found | null>()
  let drawn = 0
  for (const mask of masks) {
    const found = answerFor(sets, templateTags(mask, theirs, mine), archetype)
    tiles.set(mask, found)
    if (found !== null) drawn += 1
  }
  return { masks, tiles, drawn }
}

/** How a material stands with one kind of face: art of its own for it, art for any face that therefore draws there too, or nothing. */
export type FaceArt = 'own' | 'any' | 'none'

/** The faces a material has art for, read off the tags: there is no field that says (ruling of 2026-09-18). */
export function facesOf(sets: readonly LoadedSet[], material: number): Record<ArchetypeId, FaceArt> {
  const named = new Set<ArchetypeId>()
  let any = false
  for (const loaded of sets) {
    for (const tags of loaded.set.tiles.values()) {
      for (const tag of tags) {
        if (materialOfTag(tag) !== material) continue
        const archetype = archetypeOfTag(tag)
        if (archetype) named.add(archetype)
        else any = true
      }
    }
  }
  const of = (id: ArchetypeId): FaceArt => (named.has(id) ? 'own' : any ? 'any' : 'none')
  return { floor: of('floor'), wall: of('wall'), ramp: of('ramp') }
}

/** The archetype a pairing's art names, when every tile of it that names one names the same; `null` when its art is for any face, or disagrees. */
export function pairingFace(cover: Coverage): ArchetypeId | null {
  const named = new Set<ArchetypeId>()
  for (const found of cover.tiles.values()) {
    if (!found) continue
    for (const tag of found.loaded.set.tiles.get(found.index) ?? []) {
      const archetype = archetypeOfTag(tag)
      if (archetype) named.add(archetype)
    }
  }
  return named.size === 1 ? [...named][0] : null
}

// --- the crop ------------------------------------------------------------------------

/** One cell of a crop: an arrangement, where it sits in the crop, and the tile that draws it, if one does. */
export interface CropCell {
  mask: number
  column: number
  row: number
  found: Found | null
}

/**
 * A subject's tiles as a crop of the sheet they sit on (ruling of 2026-09-19): the rectangle of tiles that holds
 * them, and each arrangement's cell in it. `placed` cells are the missing arrangements put where they would go,
 * which is only known when the drawn ones sit in a layout papercut knows.
 */
export interface Crop {
  loaded: LoadedSet
  /** In tiles, on the sheet. */
  column: number
  row: number
  columns: number
  rows: number
  cells: readonly CropCell[]
  /** Arrangements with no tile and no known place in the crop. */
  unplaced: readonly number[]
}

/** The shapes a block of pair tiles is laid out in: the corner-blocks convention's 5 × 3, and the 4 × 4 mask block (column mask % 4, row mask / 4) that generated and converted sheets use. */
const PAIR_SHAPES: ReadonlyArray<ReadonlyMap<number, { column: number; row: number }>> = (() => {
  const blocks = new Map<number, { column: number; row: number }>()
  for (const cell of CORNER_BLOCKS.blockShape(2)?.cells ?? []) {
    const mask = cell.corners.reduce((m, v, k) => (v === 1 ? m | CORNER_BITS[k] : m), 0)
    blocks.set(mask, { column: cell.column, row: cell.row })
  }
  const masks = new Map<number, { column: number; row: number }>()
  for (let mask = 0; mask < 16; mask++) masks.set(mask, { column: mask % 4, row: Math.floor(mask / 4) })
  return [blocks, masks]
})()

/**
 * The crop for a coverage, or `null` when its tiles are on more than one sheet, or none is drawn — the cases the
 * section falls back to a wrapping grid of tiles for.
 */
export function cropOf(cover: Coverage): Crop | null {
  const drawn = [...cover.tiles].filter((entry): entry is [number, Found] => entry[1] !== null)
  if (drawn.length === 0) return null
  const loaded = drawn[0][1].loaded
  if (drawn.some(([, found]) => found.loaded !== loaded)) return null
  const at = (found: Found): { column: number; row: number } => ({ column: found.index % loaded.set.columns, row: Math.floor(found.index / loaded.set.columns) })

  // A known layout puts every arrangement somewhere, the missing ones included.
  for (const shape of PAIR_SHAPES) {
    const [firstMask, first] = drawn[0]
    const cell = shape.get(firstMask)
    if (!cell) continue
    const origin = { column: at(first).column - cell.column, row: at(first).row - cell.row }
    const fits = drawn.every(([mask, found]) => {
      const c = shape.get(mask)
      const p = at(found)
      return c !== undefined && p.column === origin.column + c.column && p.row === origin.row + c.row
    })
    if (!fits) continue
    const places = cover.masks.map((mask) => ({ mask, ...(shape.get(mask) as { column: number; row: number }) }))
    const c0 = Math.min(...places.map((p) => p.column))
    const r0 = Math.min(...places.map((p) => p.row))
    if (origin.column + c0 < 0 || origin.row + r0 < 0) continue
    return {
      loaded,
      column: origin.column + c0,
      row: origin.row + r0,
      columns: Math.max(...places.map((p) => p.column)) - c0 + 1,
      rows: Math.max(...places.map((p) => p.row)) - r0 + 1,
      cells: places.map((p) => ({ mask: p.mask, column: p.column - c0, row: p.row - r0, found: cover.tiles.get(p.mask) ?? null })),
      unplaced: [],
    }
  }

  // No layout: the rectangle that holds what is drawn, and the rest said beside it.
  const positions = drawn.map(([mask, found]) => ({ mask, found, ...at(found) }))
  const c0 = Math.min(...positions.map((p) => p.column))
  const r0 = Math.min(...positions.map((p) => p.row))
  return {
    loaded,
    column: c0,
    row: r0,
    columns: Math.max(...positions.map((p) => p.column)) - c0 + 1,
    rows: Math.max(...positions.map((p) => p.row)) - r0 + 1,
    cells: positions.map((p) => ({ mask: p.mask, column: p.column - c0, row: p.row - r0, found: p.found })),
    unplaced: cover.masks.filter((mask) => !cover.tiles.get(mask)),
  }
}

// --- the assembled patch -----------------------------------------------------------------

/** One corner of an assembled patch, with the tile that draws it. */
export interface Assembled {
  column: number
  row: number
  corners: CornerTags
  found: Found | null
}

/** Lay a patch of cells out through the dual grid and find each corner's tile across every sheet, as a face of `archetype` would. */
export function assembleAcross(sets: readonly LoadedSet[], cells: ReadonlyArray<ReadonlyArray<Tag>>, archetype: ArchetypeId | null): Assembled[] {
  const rows = cells.length
  const columns = rows === 0 ? 0 : cells[0].length
  const at = (r: number, c: number): Tag => (r < 0 || c < 0 || r >= rows || c >= columns ? null : (cells[r][c] ?? null))
  const out: Assembled[] = []
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= columns; c++) {
      const corners: CornerTags = [at(r - 1, c - 1), at(r - 1, c), at(r, c - 1), at(r, c)]
      out.push({ column: c, row: r, corners, found: corners.every((t) => t === null) ? null : answerFor(sets, corners, archetype) })
    }
  }
  return out
}

/**
 * Which arrangement a corner of the patch is, in the subject being shown: the bits of the corner that are THIS
 * material, provided every other corner is what it meets. `null` for a corner that belongs to a different subject:
 * the outside edge in a pairing, the inside of the other material's island, and the solid tile in a pairing.
 */
export function maskAt(corner: Assembled, mine: Tag, theirs: Tag): number | null {
  let mask = 0
  for (let i = 0; i < 4; i++) {
    const tag = corner.corners[i]
    if (tag === mine) mask |= CORNER_BITS[i]
    else if (tag !== theirs) return null
  }
  if (mask === 0) return null
  if (mask === 15 && theirs !== null) return null
  return mask
}
