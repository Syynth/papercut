/**
 * The look: how a material becomes a tag on a face (spec §2, §3).
 *
 * Once a tag names a material (ruling of 2026-09-17) this is almost nothing,
 * and that is the point. It used to map a material to a terrain on a sheet,
 * work out a terrain's priority from whichever material claimed it first, and
 * find a fallback colour the same way. All of that existed to cross a join
 * that no longer exists.
 *
 * What is left is the one thing that was never indirection: a voxel's SIDES
 * are made of a different material from its top when `side` says so, because
 * a material belongs to a face rather than to a voxel. Grass-topped dirt is
 * grass whose sides are dirt.
 *
 * The look owns the atlas, whose priority order is the map's material order,
 * so a change to the materials or to the loaded sets is a new look and a
 * fresh atlas, and nothing in between caches a stale answer.
 */

import { materialOfTag, tagOf, type MaterialDef, type Tag } from '@papercut/document'

import { TerrainAtlas, type LoadedSet } from './atlas'

export interface TerrainLook {
  readonly atlas: TerrainAtlas
  /** The tag a face of a material is drawn with: its side material's tag on a side, its own otherwise; `null` for an id the map does not have. */
  keyOf(material: number, side: boolean): Tag
}

export function createTerrainLook(materials: readonly MaterialDef[], sets: readonly LoadedSet[]): TerrainLook {
  const byId = new Map(materials.map((m, index) => [m.id, index]))
  const top = materials.map((m) => tagOf(m.id))
  const side = materials.map((m) => tagOf(m.side ?? m.id))
  /** A tag's material, however the tag is slotted; `undefined` for one the map does not have. */
  const indexOf = (key: Tag): number | undefined => {
    const id = materialOfTag(key)
    return id === null ? undefined : byId.get(id)
  }
  return {
    atlas: new TerrainAtlas(
      sets,
      (key) => indexOf(key) ?? -1,
      (key) => {
        const index = indexOf(key)
        return index === undefined ? null : materials[index].color
      },
      (key) => {
        const index = indexOf(key)
        return index === undefined ? String(key) : materials[index].name
      },
    ),
    keyOf: (material, isSide) => {
      const index = byId.get(material)
      return index === undefined ? null : isSide ? side[index] : top[index]
    },
  }
}
