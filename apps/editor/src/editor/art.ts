/**
 * The placeholder art: the terrain set, the sprites and the sketch textures
 * the generators draw for the project's texel density.
 *
 * Generated once per change of what it is generated from, and shared: the
 * stage draws with it, export writes it. Each keeps the last result for the
 * inputs it was made from, so three regions asking for the same art get the
 * same images — which the runtime's texture cache is keyed by — rather than
 * three copies.
 *
 * The project's own sheets, loaded from its folder, live on the viewport
 * actor; they are drawn beside the generated placeholder, standing in for it
 * where they share a name. A sheet at another tile size than the profile's
 * is left out here — the atlas is one tile size — and reported by the
 * project settings instead.
 * When the artist can configure terrains and sheets live, this is the one
 * place that learns where the art comes from.
 */

import { useMemo } from 'react'

import { PLACEHOLDER_SHEET, sheetName, type ReadonlyProjectDoc, type RgbaImage, type SpriteAsset, type SpriteDef } from '@papercut/document'
import { useProject, useViewportSelector } from '@papercut/editor-host'
import { generatePlaceholderTerrainSet, generateRailSet } from '@papercut/fixtures'
// Behind its own subpath (#48): the sprite generator draws with a canvas, and the package root stays DOM-free.
import { generateSketchTextures, generateSprites } from '@papercut/fixtures/textures'
import { projectSprites, type LoadedSet } from '@papercut/geometry'

/**
 * One result per density, kept: a density changed and changed back — the Resolution field, a project reopened —
 * costs nothing the second time, and a sheet at 64 px is a few megabytes, not a concern for the handful a session
 * sees.
 */
function perDensity<V>(make: (density: number) => V): (density: number) => V {
  const made = new Map<number, V>()
  return (density) => {
    let value = made.get(density)
    if (value === undefined) {
      value = make(density)
      made.set(density, value)
    }
    return value
  }
}

// The ground sheet, and the rail sheet beside it: a banister, its landings and a ramp's side for the default materials that have them.
const terrainFor = perDensity((density: number): LoadedSet[] => [generatePlaceholderTerrainSet(density), generateRailSet(density)])
const spritesFor = perDensity((density: number): Record<string, SpriteAsset> => generateSprites(density))
const texturesFor = perDensity((density: number): Record<string, RgbaImage> => generateSketchTextures(density))

export interface GeneratedArt {
  /** The placeholder terrain set, which the default materials point into. */
  readonly generatedTerrain: LoadedSet[]
  readonly sprites: Record<string, SpriteAsset>
  readonly textures: Record<string, RgbaImage>
}

/** The generated art for a project as it stands: for a click handler, which reads rather than subscribes. */
export function artFor(project: ReadonlyProjectDoc): GeneratedArt {
  const density = project.resolution.texelDensity
  return { generatedTerrain: terrainFor(density), sprites: spritesFor(density), textures: texturesFor(density) }
}

export interface Art extends GeneratedArt {
  /** What the terrain draws with: the project's sheets at the profile's tile size, the generated placeholder standing in for what is missing. */
  readonly terrain: LoadedSet[]
  /** The project's sheets as they loaded, every tile size, for the settings to list. */
  readonly loadedTerrain: readonly LoadedSet[]
  readonly terrainWarning: string | null
}

const densityOf = (project: ReadonlyProjectDoc): number => project.resolution.texelDensity

/**
 * What the terrain draws with: the project's sheets at the profile's tile size, with the generated placeholder
 * standing in for the placeholder sheet when the project lists it and has not supplied its own. A sheet at another
 * tile size is left out — the atlas is one tile size — and reported by the project settings instead.
 *
 * The placeholder is tagged for the default materials, by their ids; a project that does not list it has materials of
 * its own under those same ids, and the placeholder joining first would draw them with its art (found building a map
 * from RPG Maker sheets: its meadow and dirt drew as the placeholder's grass and dirt).
 */
export function drawableTerrain(generated: readonly LoadedSet[], loaded: readonly LoadedSet[], density: number, placeholder = true): LoadedSet[] {
  const usable = loaded.filter((s) => s.set.tile === density)
  if (!placeholder) return usable
  const names = new Set(usable.map((s) => s.set.sheet))
  return [...generated.filter((s) => !names.has(s.set.sheet)), ...usable]
}

const spriteDefsOf = (project: ReadonlyProjectDoc): readonly SpriteDef[] => project.sprites

/** The generated sprites with the project's own laid over them by name: what objects draw with. */
export function withProjectSprites(generated: Record<string, SpriteAsset>, defs: readonly SpriteDef[], loaded: readonly LoadedSet[]): Record<string, SpriteAsset> {
  if (defs.length === 0) return generated
  return { ...generated, ...projectSprites(defs, loaded).sprites }
}

/** Whether the project lists the placeholder sheet, the one the generated set stands in for. */
export const listsPlaceholder = (project: ReadonlyProjectDoc): boolean => project.images.some((i) => sheetName(i.path) === PLACEHOLDER_SHEET)

/** The art, re-rendering only when what it is made from changes. */
export function useArt(): Art {
  const density = useProject(densityOf)
  // The host holds what this app loaded, in the narrowest shape that says what it is; this is the one reader.
  const loaded = useViewportSelector((snapshot) => snapshot.context.loadedTerrain) as readonly LoadedSet[]
  const terrainWarning = useViewportSelector((snapshot) => snapshot.context.terrainWarning)
  const generatedTerrain = terrainFor(density)
  const placeholder = useProject(listsPlaceholder)
  const spriteDefs = useProject(spriteDefsOf)
  // The loaded sets join the generated one rather than replacing it: the default materials point into the placeholder
  // sheet, and would draw as nothing without it. A set named like a generated one stands in for it.
  const terrain = useMemo(() => drawableTerrain(generatedTerrain, loaded, density, placeholder), [loaded, generatedTerrain, density, placeholder])
  // The project's own sprites stand in for generated ones of the same name, and add their own (ruling of 2026-09-18).
  const sprites = useMemo(() => withProjectSprites(spritesFor(density), spriteDefs, loaded), [density, spriteDefs, loaded])
  return { terrain, loadedTerrain: loaded, generatedTerrain, sprites, textures: texturesFor(density), terrainWarning }
}
