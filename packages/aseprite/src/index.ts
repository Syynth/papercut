/**
 * Read Aseprite files. `parseAseprite` turns the bytes of an `.ase` or
 * `.aseprite` file into a typed model of everything the format stores; the
 * helpers answer the questions the model only answers indirectly. Rendering a
 * frame to pixels is `@papercut/aseprite-render`'s job, not this package's.
 *
 * Written out rather than `export *`, matching the other packages.
 */

export { isAseprite, parseAseprite } from './parse'
export type { ParseOptions } from './parse'
export { AsepriteError } from './reader'
export { ancestors, celAt, childrenOf, decodeTile, isVisibleInTree, paletteAt, resolveCel } from './model'
export type { ResolvedCel, Tile } from './model'
export { BLEND_MODES } from './types'
export type {
  AsepriteFile,
  BlendMode,
  Cel,
  CelBase,
  ColorMode,
  ColorProfile,
  ExternalFile,
  ExternalFileType,
  Frame,
  HeaderFlags,
  ImageCel,
  Layer,
  LayerFlags,
  LayerType,
  LinkedCel,
  LoopDirection,
  PaletteChange,
  PaletteEntry,
  Point,
  PreciseBounds,
  PropertyMap,
  PropertyValue,
  Rect,
  Rgba,
  Size,
  Slice,
  SliceKey,
  Tag,
  TileMasks,
  TilemapCel,
  Tileset,
  UserData,
} from './types'
