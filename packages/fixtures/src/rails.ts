/**
 * The placeholder rail sheet: a banister, its landings and a ramp's side,
 * drawn without a canvas like the ground sheet beside it (rulings of
 * 2026-09-19).
 *
 * A rail is tagged as a patch seen from the side — the corners BELOW its top
 * edge carry the `rail` slot — so its tiles are the sixteen arrangements any
 * material has, laid out as the 4 × 4 block Place block writes. What the
 * mesher draws of them:
 *
 *   [ –, –, rail, rail ]        the top edge: the handrail and its balusters
 *   [ –, –, –, rail ]           the start cap, of which only the right half is
 *                               ever drawn, so the newel stands in that half
 *   [ –, –, rail, – ]           the end cap, its newel in the left half
 *   [ rail × 4 ], and the two   the body of an upright rail, a stringer board
 *   with rail down one side     that repeats to the ground, and its ends
 *
 * and two tiles no block holds, the BENDS where an upright rail meets its
 * landing: `[ –, –, landing, rail ]` at the head, `[ –, –, rail, landing ]`
 * at the foot. The far half of each is the landing itself, half a tile of
 * level rail ending in a newel.
 *
 * Beside each rail block is the material's SIDE block: the triangle under a
 * slope, tiled like a wall and cut along the slope, drawn here as boards that
 * run with a slope falling to the right and tagged for that direction, so
 * the map mirrors it for a slope that falls to the left.
 *
 * The art repeats at the half tile, which is what lets the mesher follow any
 * half of one tile with any half of another.
 */

import { tagOf, type RgbaImage, type Tag } from '@papercut/document'
import { createTerrainSet, stampTemplate, tagCorner, type TerrainSet } from '@papercut/geometry'

/** The sheet the generated rail art goes by. */
export const RAIL_SHEET = 'rails.png'

/** The default materials that have placeholder rail art, by id: Dirt, whose rail is sloped, and Stone, whose rail is upright with landings. */
export const RAIL_MATERIALS: readonly number[] = [1, 2]

/** Tiles across the sheet: a rail block and a side block per material, side by side. */
const COLUMNS = 16
const BLOCK = 8
/** Four rows of blocks and a fifth for the bends. */
const ROWS = 5

const HANDRAIL = 0xc8a36a
const BALUSTER = 0x9a7a4a
const NEWEL = 0x7a5c34
const BOARD = 0x5a4528
const SEAM = 0x463519
const SIDE_BOARD = 0x6b5a48
const SIDE_SEAM = 0x4a3d30

type Paint = (x: number, y: number) => number | null

export function generateRailSet(tile = 16, materials: readonly number[] = RAIL_MATERIALS): { set: TerrainSet; image: RgbaImage } {
  const width = COLUMNS * tile
  const height = ROWS * tile
  const data = new Uint8ClampedArray(width * height * 4)
  let set = createTerrainSet(RAIL_SHEET, tile, COLUMNS, ROWS)

  const half = tile / 2
  const bar = Math.max(2, Math.round(tile / 8))
  const post = Math.max(1, Math.round(tile / 12))
  const newel = Math.max(2, Math.round(tile / 6))
  /** Where the handrail's top is: an eighth of a tile below the tile's own. */
  const barTop = Math.round(tile / 8)
  const onBaluster = (x: number): boolean => x % half >= Math.round(tile / 8) && x % half < Math.round(tile / 8) + post
  const inMask = (mask: number, x: number, y: number): boolean => (mask & (1 << ((y >= half ? 2 : 0) + (x >= half ? 1 : 0)))) !== 0

  const draw = (column: number, row: number, paint: Paint): void => {
    for (let y = 0; y < tile; y++) {
      for (let x = 0; x < tile; x++) {
        const rgb = paint(x, y)
        if (rgb === null) continue
        const i = ((row * tile + y) * width + column * tile + x) * 4
        data[i] = (rgb >> 16) & 0xff
        data[i + 1] = (rgb >> 8) & 0xff
        data[i + 2] = rgb & 0xff
        data[i + 3] = 255
      }
    }
  }

  /** A banister over the columns `from`–`to`: the handrail, the balusters under it, and a newel where one is asked for. */
  const banister = (from: number, to: number, newelAt: number | null): Paint => (x, y) => {
    if (newelAt !== null && x >= newelAt && x < newelAt + newel && y >= Math.max(0, barTop - bar)) return NEWEL
    if (x < from || x >= to || y < barTop) return null
    if (y < barTop + bar) return HANDRAIL
    return onBaluster(x) ? BALUSTER : null
  }
  /** The stringer: boards across, the balusters' feet carried down it, and an end post where the body stops. */
  const stringer = (mask: number): Paint => (x, y) => {
    if (!inMask(mask, x, y)) return null
    if (mask === 10 && x < half + post * 2) return NEWEL
    if (mask === 5 && x >= half - post * 2) return NEWEL
    if (y % half === half - 1) return SEAM
    return onBaluster(x) ? BALUSTER : BOARD
  }
  /** A ramp's side: boards that run with a slope falling to the right. */
  const side = (mask: number): Paint => (x, y) => {
    if (!inMask(mask, x, y)) return null
    return (((x - y) % half) + half) % half === 0 ? SIDE_SEAM : SIDE_BOARD
  }

  materials.forEach((material, i) => {
    const column = i * BLOCK
    const rail = tagOf(material, 'rail')
    const landing = tagOf(material, 'landing')
    set = stampTemplate(set, column, 0, null, rail)
    set = stampTemplate(set, column + 4, 0, null, tagOf(material, 'side', 'ramp', 'e'))
    for (let mask = 1; mask < 16; mask++) {
      const at = [column + (mask & 3), mask >> 2] as const
      // The top edge and its two caps are the banister; everything else is the body under it.
      const paint = mask === 12 ? banister(0, tile, null) : mask === 8 ? banister(half, tile, half) : mask === 4 ? banister(0, half, half - newel) : stringer(mask)
      draw(at[0], at[1], paint)
      draw(at[0] + 4, at[1], side(mask))
    }
    // The bends: a level rail to the tile's far edge, where its newel stands.
    const bend = (at: number, tags: readonly [Tag, Tag], newelAt: number): void => {
      const index = 4 * COLUMNS + column + at
      set = tagCorner(tagCorner(set, index, 2, tags[0]), index, 3, tags[1])
      draw(column + at, 4, banister(0, tile, newelAt))
    }
    bend(0, [landing, rail], 0)
    bend(1, [rail, landing], tile - newel)
  })

  return { set, image: { width, height, data } }
}
