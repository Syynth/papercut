/**
 * `.aseprite` files as project images: a chosen frame flattened to
 * `RgbaImage`, with the file's frame count and tile grid beside it.
 *
 * Written out rather than `export *`, matching the other packages.
 */

export { gridOf, isAsepriteSheet, readAsepriteSheet } from './sheet'
export type { AsepriteSheet } from './sheet'
