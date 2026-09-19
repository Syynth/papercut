/**
 * Render frames of a parsed Aseprite file (`@papercut/aseprite`) to RGBA,
 * matching Aseprite's own compositing: its blend modes to the bit, opacity,
 * groups, z-indexes, reference layers and tilemaps.
 *
 * Written out rather than `export *`, matching the other packages.
 */

export { renderFrame } from './render'
export type { RenderOptions, RgbaPixels } from './render'
export { blenderFor, getA, getB, getG, getR, merge, normal, rgba } from './blend'
export type { Blender, Color } from './blend'
