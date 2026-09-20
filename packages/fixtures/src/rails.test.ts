import { describe, expect, it } from 'vitest'

import { tagOf } from '@papercut/document'
import { TerrainAtlas, exactTile } from '@papercut/geometry'

import { RAIL_ART, generateRailSet, railSheetSvg } from './rails'

const HANDRAIL = [0xc8, 0xa3, 0x6a]
const BALUSTER = [0x9a, 0x7a, 0x4a]

describe('the placeholder rail sheet', () => {
  const { set, image } = generateRailSet()
  const T = set.tile
  const pixel = (index: number, x: number, y: number): number[] => {
    const at = ((Math.floor(index / set.columns) * T + y) * image.width + (index % set.columns) * T + x) * 4
    return [...image.data.slice(at, at + 4)]
  }
  const alpha = (index: number, x: number, y: number): number => pixel(index, x, y)[3]
  const is = (index: number, x: number, y: number, rgb: number[]): boolean => pixel(index, x, y).slice(0, 3).join() === rgb.join() && alpha(index, x, y) === 255
  /** The rows of column `x` that are handrail. */
  const railRows = (index: number, x: number): number[] => Array.from({ length: T }, (_, y) => y).filter((y) => is(index, x, y, HANDRAIL))
  const [sloped, upright] = RAIL_ART.map((a) => tagOf(a.material, 'rail'))
  const landing = tagOf(RAIL_ART[1].material, 'landing')

  it('tags a rail block and a side block for each material that has a rail, and the two bends for an upright one', () => {
    expect(image.width).toBe(set.columns * T)
    expect(image.height).toBe(set.rows * T)
    for (const { material, style } of RAIL_ART) {
      const rail = tagOf(material, 'rail')
      const side = tagOf(material, 'side', 'ramp', 'e')
      for (const tags of [[null, null, rail, rail], [null, null, null, rail], [null, null, rail, null], [rail, rail, rail, rail], [null, rail, null, rail], [rail, null, rail, null]] as const) expect(exactTile(set, tags)).not.toBeNull()
      expect(exactTile(set, [side, side, side, side])).not.toBeNull()
      expect(exactTile(set, [null, null, tagOf(material, 'landing'), rail]) !== null).toBe(style === 'upright')
      expect(exactTile(set, [null, null, rail, tagOf(material, 'landing')]) !== null).toBe(style === 'upright')
    }
  })

  it('stands two balusters to a tile, one to each half, so any half can follow any other', () => {
    for (const rail of [sloped, upright]) {
      const middle = exactTile(set, [null, null, rail, rail]) as number
      const foot = Array.from({ length: T }, (_, x) => is(middle, x, T - 1, BALUSTER))
      // Two runs of baluster along the tile's foot, and the same in each half.
      expect(foot.filter((on, x) => on && !foot[x - 1])).toHaveLength(2)
      expect(foot.slice(0, T / 2)).toEqual(foot.slice(T / 2))
    }
  })

  it("stands each cap's newel in the half of the tile the map draws, and nothing in the other", () => {
    for (const rail of [sloped, upright]) {
      const start = exactTile(set, [null, null, null, rail]) as number
      const end = exactTile(set, [null, null, rail, null]) as number
      for (let y = 0; y < T; y++) {
        for (let x = 0; x < T / 2; x++) {
          expect(alpha(start, x, y)).toBe(0)
          expect(alpha(end, T / 2 + x, y)).toBe(0)
        }
      }
      expect(alpha(start, T / 2, T - 1)).toBe(255)
      expect(alpha(end, T / 2 - 1, T - 1)).toBe(255)
    }
  })

  it('draws a sloped rail level, and an upright one falling half a tile across each half', () => {
    const level = exactTile(set, [null, null, sloped, sloped]) as number
    expect(railRows(level, 0)).toEqual(railRows(level, T - 1))
    const falling = exactTile(set, [null, null, upright, upright]) as number
    const top = (x: number): number => railRows(falling, x)[0]
    // A pixel down for a pixel across, within a half; and the next half starts where this one did, because the map stands it half a tile lower.
    expect(top(T / 2 - 1) - top(0)).toBe(T / 2 - 1)
    expect(top(T / 2)).toBe(top(0))
  })

  it('carries the handrail through a bend as one line: level over the landing, turning at the middle of the tile', () => {
    const head = exactTile(set, [null, null, landing, upright]) as number
    const foot = exactTile(set, [null, null, upright, landing]) as number
    const middle = exactTile(set, [null, null, upright, upright]) as number
    // At the head both halves stand at one height, so the turn is in the tile: level to the middle, then the same fall a plain half has.
    // Clear of the newel at the landing's far end, which stands over the handrail.
    expect(railRows(head, T / 4)).toEqual(railRows(head, T / 2 - 2))
    expect(railRows(head, T / 4)).not.toHaveLength(0)
    for (let x = T / 2 + 1; x < T; x++) expect(railRows(head, x)).toEqual(railRows(middle, x))
    // No break at the turn: the rows of handrail either side of the middle overlap.
    expect(railRows(head, T / 2 - 1).some((y) => railRows(head, T / 2).includes(y))).toBe(true)
    // At the foot the landing's half stands half a tile lower, so its level run is drawn where a fall begins: on the map that is where the fall before it ended.
    expect(railRows(foot, T / 2 + 2)).toEqual(railRows(head, T / 4))
    for (let x = 0; x < T / 2 - 1; x++) expect(railRows(foot, x)).toEqual(railRows(middle, x))
  })

  it("runs the stringer's edge strip unbroken down the steps: above the slope line, with the corner that leaves the body drawn in the rail's own tile", () => {
    const SEAM = [0x46, 0x35, 0x19]
    const body = exactTile(set, [upright, upright, upright, upright]) as number
    const middle = exactTile(set, [null, null, upright, upright]) as number
    for (const x0 of [0, T / 2]) {
      // Along the cut, the strip is the two texels over the slope line, to the very end of the half.
      for (let x = 2; x < T / 2; x++) for (const up of [1, 2]) expect(is(body, x0 + x, x - up, SEAM), `body ${x0 + x},${x - up}`).toBe(true)
      // Its first corner is over the top of the body, at the foot of the rail tile that stands on it.
      expect(is(middle, x0, T - 1, SEAM)).toBe(true)
      expect(is(middle, x0, T - 2, SEAM)).toBe(true)
      expect(is(middle, x0 + 1, T - 1, SEAM)).toBe(true)
      // And nothing of it is left to the plain board that repeats to the ground.
      for (let x = 0; x < T / 2; x++) expect(is(body, x0 + x, T / 2, SEAM)).toBe(false)
    }
  })

  it('goes into an atlas, and is the same drawing as its SVG', () => {
    expect(() => new TerrainAtlas([{ set, image }])).not.toThrow()
    const svg = railSheetSvg(48)
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    // A group per drawn tile: fifteen of rail and fifteen of side a material, and an upright one's two bends.
    expect(svg.match(/<g /g)).toHaveLength(RAIL_ART.length * 30 + 2)
    expect(svg).toContain('#c8a36a')
  })
})
