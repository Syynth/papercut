/**
 * The placeholder rail sheet: a banister, its landings and a ramp's side,
 * drawn from VECTOR SHAPES (rulings of 2026-09-19).
 *
 * Every tile is a short list of filled polygons in the tile's own unit
 * square, x across and y down as an SVG has them. The same list is
 * rasterised to the sheet at any texel density, with no canvas, and written
 * out as an SVG document (`railSheetSvg`), so the placeholder is a drawing an
 * artist can open, measure and draw over rather than a loop over pixels.
 * Every measure is a sixteenth of a tile, so it lands on whole pixels at 16,
 * 32 and 48.
 *
 * A rail is tagged as a patch seen from the side — the corners BELOW its top
 * edge carry the `rail` slot — so its tiles are the arrangements any material
 * has, laid out as the 4 × 4 block Place block writes. There are two
 * balusters to a tile, one to each half, because the map draws a rail half a
 * tile at a time and any half must be able to follow any other.
 *
 * The HANDRAIL is one path, mitred where it turns.
 *
 *   sloped    the map turns the whole tile to lie along the slope, so the
 *             handrail is drawn level.
 *   upright   the map stands each half of a tile straight, half a tile lower
 *             than the last, so the handrail is drawn FALLING half a tile
 *             across each half. A tile's two halves stand at different
 *             heights on the map, which is why they do not meet inside the
 *             tile; on the map they are one line. The BENDS are where that
 *             line turns: `[ –, –, landing, rail ]` runs level over the
 *             landing and turns down at the middle of the tile, and
 *             `[ –, –, rail, landing ]` comes down and runs level out.
 *
 * An upright rail's BODY is a stringer: its upper half is cut along the
 * slope, which crosses each half tile corner to corner, with the baluster
 * carried down to it; its lower half is plain board, which the map repeats
 * to the ground. Its edge strip stands ABOVE the slope line, so the corner
 * of it that leaves the body at every step lands in the rail's own tile.
 *
 * Beside each rail block is the material's SIDE block: the triangle under a
 * slope, tiled like a wall and cut along the slope, drawn as boards that run
 * with a slope falling to the right and tagged for that direction, so the
 * map mirrors it for a slope that falls to the left.
 */

import { tagOf, type RailStyle, type RgbaImage, type Tag } from '@papercut/document'
import { createTerrainSet, stampTemplate, tagCorner, type TerrainSet } from '@papercut/geometry'

/** The sheet the generated rail art goes by. */
export const RAIL_SHEET = 'rails.png'

/** A material's placeholder rail: which material, and the style its art is drawn for. */
export interface RailArt {
  material: number
  style: RailStyle
}

/** The default materials that have placeholder rail art: Dirt, whose rail is sloped, and Stone, whose rail is upright with landings. */
export const RAIL_ART: readonly RailArt[] = [
  { material: 1, style: 'sloped' },
  { material: 2, style: 'upright' },
]
export const RAIL_MATERIALS: readonly number[] = RAIL_ART.map((a) => a.material)

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

/** A sixteenth of a tile: the unit every measure here is a multiple of. */
const U = 1 / 16
/** The handrail's centre line, down from the tile's top, where it is level or where a falling half begins. */
const RAIL_Y = 2 * U
const RAIL_THICK = 2 * U
const BALUSTER_WIDE = 2 * U
const NEWEL_WIDE = 3 * U
/** How far the stringer's edge strip stands above the slope, measured straight up. */
const STRIP = 2 * U

type Point = readonly [number, number]

/** One filled polygon of a tile, in the tile's unit square, shown only between `clip[0]` and `clip[1]` across. */
export interface RailShape {
  points: readonly Point[]
  fill: number
  clip: readonly [number, number]
}

const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]

/** A path stroked to a polygon, mitred at its turns. Its ends are cut square to the path, so a path that leaves the tile is drawn past the edge and clipped. */
function stroke(path: readonly Point[], thick: number): Point[] {
  const h = thick / 2
  const normals = path.slice(1).map(([x, y], i): Point => {
    const [dx, dy] = [x - path[i][0], y - path[i][1]]
    const len = Math.hypot(dx, dy)
    return [-dy / len, dx / len]
  })
  const offset = (side: number): Point[] =>
    path.map(([x, y], i): Point => {
      const a = normals[Math.max(0, i - 1)]
      const b = normals[Math.min(normals.length - 1, i)]
      // The mitre: along the two normals' sum, as far as keeps the stroke its thickness on both sides of the turn.
      const [mx, my] = [a[0] + b[0], a[1] + b[1]]
      const scale = (side * h * 2) / (mx * mx + my * my)
      return [x + mx * scale, y + my * scale]
    })
  return [...offset(1), ...offset(-1).reverse()]
}

/** Which half of a tile: the left, 0, or the right, 1. */
type Half = 0 | 1

/** What a half of a top-edge tile holds besides its handrail. */
type Post = 'baluster' | 'newel-near' | 'newel-far' | 'none'

/**
 * One half of a tile of the rail's top edge. `falls` is an upright rail's half on a ramp, whose handrail comes down
 * half a tile across it; a level half is a sloped rail's, or a landing. A newel stands at the half's near edge (the
 * tile's middle) or its far edge (the tile's own).
 */
function topHalf(half: Half, falls: boolean, post: Post, path: readonly Point[]): RailShape[] {
  const x0 = half * 0.5
  const clip = [x0, x0 + 0.5] as const
  /** The handrail's centre line at `x`, within this half. */
  const railAt = (x: number): number => RAIL_Y + (falls ? x - x0 : 0)
  const shapes: RailShape[] = []
  if (post === 'baluster') {
    const cx = x0 + 0.25
    shapes.push({ points: rect(cx - BALUSTER_WIDE / 2, railAt(cx), cx + BALUSTER_WIDE / 2, 1), fill: BALUSTER, clip })
  }
  // Where the half falls, a stringer under it has an edge strip standing above the slope; the strip's first corner is up here, in this tile's foot.
  if (falls) shapes.push({ points: [[x0, 1 - STRIP - U / 2], [x0 + STRIP + U / 2, 1], [x0 + U / 2, 1], [x0, 1 - U / 2]], fill: SEAM, clip })
  shapes.push({ points: stroke(path, RAIL_THICK), fill: HANDRAIL, clip })
  if (post === 'newel-near' || post === 'newel-far') {
    const atMiddle = post === 'newel-near'
    const nx = atMiddle === (half === 1) ? x0 : x0 + 0.5 - NEWEL_WIDE
    // A newel stands a little proud of the handrail where it meets it.
    const top = Math.max(0, railAt(nx + NEWEL_WIDE / 2) - RAIL_THICK)
    shapes.push({ points: rect(nx, top, nx + NEWEL_WIDE, 1), fill: NEWEL, clip })
  }
  return shapes
}

/** A handrail's path across one half, drawn past both of the half's edges so the clip cuts it clean. */
const halfPath = (half: Half, falls: boolean): Point[] => {
  const x0 = half * 0.5
  return falls ? [[x0 - 0.25, RAIL_Y - 0.25], [x0 + 0.75, RAIL_Y + 0.75]] : [[x0 - 0.25, RAIL_Y], [x0 + 0.75, RAIL_Y]]
}

/** The shapes of one tile of a rail block, by its mask: which of NW, NE, SW, SE (1, 2, 4, 8) are rail. */
export function railTile(mask: number, style: RailStyle): RailShape[] {
  const falls = style === 'upright'
  if (mask === 12) return [...topHalf(0, falls, 'baluster', halfPath(0, falls)), ...topHalf(1, falls, 'baluster', halfPath(1, falls))]
  // A cap is drawn from one half only: a start cap from its right, where the rail sets off; an end cap from its left.
  if (mask === 8) return topHalf(1, falls, 'newel-near', halfPath(1, falls))
  if (mask === 4) return topHalf(0, falls, 'newel-near', halfPath(0, falls))
  return stringer(mask, falls)
}

/** The two bends of an upright rail with landings: the landing's half is level and ends in a newel, and the handrail is one path through the turn. */
export function bendTile(atHead: boolean): RailShape[] {
  if (atHead) {
    // Level over the landing, then down the ramp from the middle of the tile: both halves stand at the same height, so the turn is in the tile.
    const path: Point[] = [[-0.25, RAIL_Y], [0.5, RAIL_Y], [1.25, RAIL_Y + 0.75]]
    return [...topHalf(0, false, 'newel-far', path), ...topHalf(1, true, 'baluster', path)]
  }
  // Down the ramp, then level out over the landing. The landing's half stands half a tile lower on the map, so its level run is drawn where the fall began.
  return [...topHalf(0, true, 'baluster', halfPath(0, true)), ...topHalf(1, false, 'newel-far', [[-0.25, RAIL_Y - 0.75], [0.5, RAIL_Y], [1.25, RAIL_Y]])]
}

/** A rail's body: a stringer board. Under an upright rail its upper half is cut along the slope, corner to corner of each half. */
function stringer(mask: number, cut: boolean): RailShape[] {
  const shapes: RailShape[] = []
  for (const half of [0, 1] as const) {
    const x0 = half * 0.5
    const clip = [x0, x0 + 0.5] as const
    const [upper, lower] = [(mask & (1 << half)) !== 0, (mask & (4 << half)) !== 0]
    // The body's end: a post down the side where the rail stops, which is the side of the tile's middle.
    const ends = mask === 10 || mask === 5
    const postAt = half === 1 ? x0 : x0 + 0.5 - BALUSTER_WIDE
    if (upper) {
      // Under a cut the board runs up behind the strip, so no pixel between the two is left open.
      shapes.push({ points: cut ? [[x0, -STRIP], [x0 + 0.5, 0.5 - STRIP], [x0 + 0.5, 0.5], [x0, 0.5]] : rect(x0, 0, x0 + 0.5, 0.5), fill: BOARD, clip })
      if (cut) {
        // The baluster carried down to the slope, and the stringer's edge strip along it. The strip stands ABOVE the
        // slope line, not under it: a strip has thickness, so at every step its corner spills out of this piece, and
        // above the line the piece it spills into is always the rail's own tile, which draws it (`topHalf`). Under
        // the line it spilled into the plain board that repeats to the ground, which cannot draw it once and not again.
        const cx = x0 + 0.25
        // Its foot is cut along the strip it stands on, so nothing of it shows under the strip.
        const [l, r] = [cx - BALUSTER_WIDE / 2, cx + BALUSTER_WIDE / 2]
        shapes.push({ points: [[l, 0], [r, 0], [r, r - x0 - U / 2], [l, l - x0 - U / 2]], fill: BALUSTER, clip })
        shapes.push({ points: [[x0, -STRIP - U / 2], [x0 + 0.5, 0.5 - STRIP - U / 2], [x0 + 0.5, 0.5 - U / 2], [x0, -U / 2]], fill: SEAM, clip })
      } else shapes.push({ points: rect(x0, 0.5 - U, x0 + 0.5, 0.5), fill: SEAM, clip })
    }
    if (lower) {
      shapes.push({ points: rect(x0, 0.5, x0 + 0.5, 1), fill: BOARD, clip })
      shapes.push({ points: rect(x0, 1 - U, x0 + 0.5, 1), fill: SEAM, clip })
    }
    if (ends && lower) shapes.push({ points: rect(postAt, cut && upper ? 0.5 : upper ? 0 : 0.5, postAt + BALUSTER_WIDE, 1), fill: NEWEL, clip })
    // Under a cut, the head's post runs on up to the slope. The foot's would be a stub two texels tall, where the cut meets the ground, so it has none.
    if (mask === 10 && cut && upper) shapes.push({ points: [[postAt, postAt - x0], [postAt + BALUSTER_WIDE, postAt - x0 + BALUSTER_WIDE], [postAt + BALUSTER_WIDE, 0.5], [postAt, 0.5]], fill: NEWEL, clip })
  }
  return shapes
}

/** A tile of a ramp's side: boards that run with a slope falling to the right, in the quadrants of `mask`. */
export function sideTile(mask: number): RailShape[] {
  const shapes: RailShape[] = []
  for (let q = 0; q < 4; q++) {
    if (!(mask & (1 << q))) continue
    const [x0, y0] = [(q % 2) * 0.5, q > 1 ? 0.5 : 0]
    const clip = [x0, x0 + 0.5] as const
    shapes.push({ points: rect(x0, y0, x0 + 0.5, y0 + 0.5), fill: SIDE_BOARD, clip })
    // A seam every half tile, along the slope; cut to the quadrant by hand, since a shape's clip is only across.
    for (const k of [-0.5, 0, 0.5]) {
      const seam: Point[] = [[x0, x0 + k], [x0 + 0.5, x0 + 0.5 + k], [x0 + 0.5, x0 + 0.5 + k + U], [x0, x0 + k + U]]
      const cut = seam.map(([x, y]): Point => [x, Math.min(y0 + 0.5, Math.max(y0, y))])
      if (Math.max(...cut.map((p) => p[1])) - Math.min(...cut.map((p) => p[1])) > U) shapes.push({ points: cut, fill: SIDE_SEAM, clip })
    }
  }
  return shapes
}

/** Whether a point is inside a polygon, by crossings: every point is on exactly one side of every edge, so shapes that share an edge neither overlap nor gap. */
function inside(points: readonly Point[], x: number, y: number): boolean {
  let within = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]
    const [xj, yj] = points[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) within = !within
  }
  return within
}

/** Every tile of the sheet as its place and its shapes: what both the pixels and the SVG are made from. */
function layout(art: readonly RailArt[]): Array<{ column: number; row: number; shapes: RailShape[] }> {
  const tiles: Array<{ column: number; row: number; shapes: RailShape[] }> = []
  art.forEach(({ style }, i) => {
    const column = i * BLOCK
    for (let mask = 1; mask < 16; mask++) {
      tiles.push({ column: column + (mask & 3), row: mask >> 2, shapes: railTile(mask, style) })
      tiles.push({ column: column + 4 + (mask & 3), row: mask >> 2, shapes: sideTile(mask) })
    }
    if (style === 'upright') {
      tiles.push({ column, row: 4, shapes: bendTile(true) })
      tiles.push({ column: column + 1, row: 4, shapes: bendTile(false) })
    }
  })
  return tiles
}

export function generateRailSet(tile = 16, art: readonly RailArt[] = RAIL_ART): { set: TerrainSet; image: RgbaImage } {
  const width = COLUMNS * tile
  const height = ROWS * tile
  const data = new Uint8ClampedArray(width * height * 4)
  let set = createTerrainSet(RAIL_SHEET, tile, COLUMNS, ROWS)

  art.forEach(({ material, style }, i) => {
    const column = i * BLOCK
    const rail = tagOf(material, 'rail')
    const landing = tagOf(material, 'landing')
    set = stampTemplate(set, column, 0, null, rail)
    set = stampTemplate(set, column + 4, 0, null, tagOf(material, 'side', 'ramp', 'e'))
    if (style !== 'upright') return
    const bend = (at: number, tags: readonly [Tag, Tag]): void => {
      const index = 4 * COLUMNS + column + at
      set = tagCorner(tagCorner(set, index, 2, tags[0]), index, 3, tags[1])
    }
    bend(0, [landing, rail])
    bend(1, [rail, landing])
  })

  for (const { column, row, shapes } of layout(art)) {
    for (let py = 0; py < tile; py++) {
      for (let px = 0; px < tile; px++) {
        const [x, y] = [(px + 0.5) / tile, (py + 0.5) / tile]
        // The last shape over a pixel is the one seen, as in the drawing.
        let fill: number | null = null
        for (const shape of shapes) if (x >= shape.clip[0] && x < shape.clip[1] && inside(shape.points, x, y)) fill = shape.fill
        if (fill === null) continue
        const i = ((row * tile + py) * width + column * tile + px) * 4
        data[i] = (fill >> 16) & 0xff
        data[i + 1] = (fill >> 8) & 0xff
        data[i + 2] = fill & 0xff
        data[i + 3] = 255
      }
    }
  }
  return { set, image: { width, height, data } }
}

/** The same sheet as an SVG document, a tile to `tile` units: the drawing the pixels are made from, for an artist to open and draw over. */
export function railSheetSvg(tile = 48, art: readonly RailArt[] = RAIL_ART): string {
  const hex = (color: number): string => `#${color.toString(16).padStart(6, '0')}`
  const n = (v: number): string => String(Math.round(v * tile * 1000) / 1000)
  const tiles = layout(art).map(({ column, row, shapes }) => {
    // Each half is its own clipped viewport, so a path drawn past the half's edge is cut clean there.
    const halves = ([0, 0.5] as const).map((x0) => {
      const inHalf = shapes.filter((s) => s.clip[0] === x0)
      if (inHalf.length === 0) return ''
      const polygons = inHalf.map((s) => `<polygon fill="${hex(s.fill)}" points="${s.points.map(([x, y]) => `${n(x)},${n(y)}`).join(' ')}"/>`).join('')
      return `<svg x="${n(x0)}" y="0" width="${n(0.5)}" height="${n(1)}" viewBox="${n(x0)} 0 ${n(0.5)} ${n(1)}" overflow="hidden">${polygons}</svg>`
    })
    return `<g transform="translate(${column * tile} ${row * tile})">${halves.join('')}</g>`
  })
  const grid = `<path fill="none" stroke="#000" stroke-opacity=".15" stroke-width=".5" d="${Array.from({ length: COLUMNS + 1 }, (_, c) => `M${c * tile} 0V${ROWS * tile}`).join('')}${Array.from({ length: ROWS + 1 }, (_, r) => `M0 ${r * tile}H${COLUMNS * tile}`).join('')}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${COLUMNS * tile} ${ROWS * tile}" width="${COLUMNS * tile}" height="${ROWS * tile}" shape-rendering="crispEdges">\n${tiles.join('\n')}\n${grid}\n</svg>\n`
}
