/**
 * The look: how a material becomes a tag on a face (spec §2, §3).
 *
 * Once a tag names a material (ruling of 2026-09-17) this is almost nothing,
 * and that is the point. It used to map a material to a terrain on a sheet,
 * work out a terrain's priority from whichever material claimed it first, and
 * find a fallback colour the same way. All of that existed to cross a join
 * that no longer exists; and with material layers explicit (ruling of
 * 2026-09-18) there is no priority left to derive either.
 *
 * The look owns the atlas, so a change to the materials, to the loaded sets
 * or to the fallback colour is a new look and a fresh atlas, and nothing in
 * between caches a stale answer.
 */

import { DEFAULT_FRINGE_ANGLE, DEFAULT_PICKET_DISTANCE, DEFAULT_RAIL_STYLE, tagOf, type MaterialDef, type RailStyle, type Tag } from '@papercut/document'

import { TerrainAtlas, type LoadedSet } from './atlas'

export interface TerrainLook {
  readonly atlas: TerrainAtlas
  /** The tag a material layer holding `material` is drawn with; `null`, nothing, for an empty one. */
  keyOf(material: number | null): Tag
  /** How a tag's material hangs its fringe and stands its picket (ruling of 2026-09-18): the defaults for one that says nothing. */
  trimOf(tag: Tag): TrimSettings
}

export interface TrimSettings {
  /** Degrees below horizontal the fringe flap hangs at. */
  readonly fringeAngle: number
  /** Pixels of art the picket stands out from its wall. */
  readonly picketDistance: number
  /** How its rail stands on a ramp's open side. */
  readonly railStyle: RailStyle
  /** Whether its upright rail runs onto the level ground at its ends. */
  readonly landings: boolean
}

export function createTerrainLook(materials: readonly MaterialDef[], sets: readonly LoadedSet[], fallback?: number): TerrainLook {
  const names = new Map(materials.map((m) => [tagOf(m.id), m.name]))
  const trims = new Map(materials.map((m) => [tagOf(m.id), { fringeAngle: m.fringeAngle ?? DEFAULT_FRINGE_ANGLE, picketDistance: m.picketDistance ?? DEFAULT_PICKET_DISTANCE, railStyle: m.railStyle ?? DEFAULT_RAIL_STYLE, landings: m.landings === true }]))
  const plain: TrimSettings = { fringeAngle: DEFAULT_FRINGE_ANGLE, picketDistance: DEFAULT_PICKET_DISTANCE, railStyle: DEFAULT_RAIL_STYLE, landings: false }
  return {
    atlas: new TerrainAtlas(sets, { nameOf: (key) => names.get(key) ?? String(key), fallback }),
    keyOf: (material) => (material === null ? null : tagOf(material)),
    trimOf: (tag) => trims.get(tag) ?? plain,
  }
}
