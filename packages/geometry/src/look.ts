/**
 * The look: how a material becomes a tag on a face (spec §2, §3).
 *
 * Once a tag names a material (ruling of 2026-09-17) this is almost nothing,
 * and that is the point. It used to map a material to a terrain on a sheet,
 * work out a terrain's priority from whichever material claimed it first, and
 * find a fallback colour the same way. All of that existed to cross a join
 * that no longer exists.
 *
 * What is left is almost nothing: a face's material layers name materials
 * directly (ruling of 2026-09-18), so a face's tag is its material's. A
 * voxel's sides used to be cut from another material by `side`; now each
 * face carries its own layers, and a face nobody painted, or a material the
 * project does not have, draws `UNPAINTED`.
 *
 * The look owns the atlas, whose priority order is the map's material order,
 * so a change to the materials or to the loaded sets is a new look and a
 * fresh atlas, and nothing in between caches a stale answer.
 */

import { materialOfTag, tagOf, type MaterialDef, type Tag } from '@papercut/document'

import { TerrainAtlas, UNPAINTED, type LoadedSet } from './atlas'

export interface TerrainLook {
  readonly atlas: TerrainAtlas
  /** The tag a face holding `material` is drawn with; `UNPAINTED` for none, or for an id the project does not have. */
  keyOf(material: number | null): Tag
}

export function createTerrainLook(materials: readonly MaterialDef[], sets: readonly LoadedSet[]): TerrainLook {
  const byId = new Map(materials.map((m, index) => [m.id, index]))
  const tags = materials.map((m) => tagOf(m.id))
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
    keyOf: (material) => {
      const index = material === null ? undefined : byId.get(material)
      return index === undefined ? UNPAINTED : tags[index]
    },
  }
}
