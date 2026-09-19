/**
 * A project's own sprites (ruling of 2026-09-18): named regions of its
 * images, cut from the images as they loaded, on the project's tile grid.
 *
 * Each stands in for a generated sprite of the same name wherever an object
 * names it — `tree`, `barrel` — and any other name is a sprite of the
 * project's own. One facing for now; its footprint in the world is its
 * rectangle, one tile to a tile, so it keeps the texel scale every surface
 * shares.
 */

import { sheetName, type RgbaImage, type SpriteAsset, type SpriteDef } from '@papercut/document'

import type { LoadedSet } from './atlas'

export interface ProjectSprites {
  sprites: Record<string, SpriteAsset>
  /** A sprite that could not be cut, and why, in the artist's terms. */
  warnings: string[]
}

/** Cut each sprite from its image's loaded set. A sprite whose image did not load, or whose rectangle leaves it, is skipped and reported. */
export function projectSprites(defs: readonly SpriteDef[], sets: readonly LoadedSet[]): ProjectSprites {
  const sprites: Record<string, SpriteAsset> = {}
  const warnings: string[] = []
  for (const def of defs) {
    const loaded = sets.find((s) => s.set.sheet === sheetName(def.image))
    if (!loaded) {
      warnings.push(`Sprite ${def.name}: ${sheetName(def.image)} did not load.`)
      continue
    }
    const { rect } = def
    const { tile, columns, rows } = loaded.set
    if (rect.x + rect.w > columns || rect.y + rect.h > rows) {
      warnings.push(`Sprite ${def.name}: its rectangle runs past the edge of ${sheetName(def.image)}'s ${columns}×${rows} tiles.`)
      continue
    }
    sprites[def.name] = { name: def.name, facings: [crop(loaded.image, rect.x * tile, rect.y * tile, rect.w * tile, rect.h * tile)], widthTiles: rect.w, heightTiles: rect.h, emissive: false }
  }
  return { sprites, warnings }
}

function crop(image: RgbaImage, x0: number, y0: number, width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    const from = ((y0 + y) * image.width + x0) * 4
    data.set(image.data.subarray(from, from + width * 4), y * width * 4)
  }
  return { width, height, data }
}
