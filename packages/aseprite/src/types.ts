/**
 * The model an `.aseprite` file parses into.
 *
 * It follows the file closely, not an editor's idea of a sprite: every field
 * the format stores is here under a readable name, pixel data stays in the
 * file's own colour mode, linked cels stay links, and palette changes stay on
 * the frame that makes them. Anything that interprets the file — rendering,
 * following links, working out a frame's palette — is a function over this
 * model, not a field in it.
 *
 * Field meanings follow Aseprite's own specification,
 * https://github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md.
 */

/** 32 bpp RGBA, 16 bpp grey+alpha, or 8 bpp palette indices. */
export type ColorMode = 'rgba' | 'grayscale' | 'indexed'

/** Layer blend modes, in the order the file numbers them (0–18). */
export const BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
  'addition',
  'subtract',
  'divide',
] as const

export type BlendMode = (typeof BLEND_MODES)[number]

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface Rect extends Point, Size {}

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

export interface AsepriteFile {
  width: number
  height: number
  colorMode: ColorMode
  /** Header flags, decoded. */
  flags: HeaderFlags
  /**
   * The palette index that is transparent in every non-background layer.
   * Only meaningful in indexed files; 0 otherwise.
   */
  transparentIndex: number
  /** The number of colours the header declares (0 in old files means 256). */
  colorCount: number
  /** Pixel aspect ratio; 1:1 when the file leaves it unset. */
  pixelRatio: Size
  /** The sprite's grid, or null when the file has none (width or height 0). */
  grid: Rect | null
  /**
   * The header's frame duration in milliseconds. Deprecated by the format in
   * favour of each frame's own duration, which already falls back to this.
   */
  speed: number
  /** Every layer, in file order: a cel's `layer` is an index into this. */
  layers: Layer[]
  frames: Frame[]
  tags: Tag[]
  slices: Slice[]
  /** Tilesets by the id tilemap layers refer to them with. */
  tilesets: Tileset[]
  colorProfile: ColorProfile | null
  externalFiles: ExternalFile[]
  /** The sprite's own user data (Aseprite 1.3+), if any. */
  userData: UserData | null
  /**
   * What the parser skipped or could not interpret without failing: unknown
   * chunk types, unknown enum values, unreadable user-data properties.
   * Empty for a file Aseprite itself would load without complaint.
   */
  warnings: string[]
}

export interface HeaderFlags {
  /** Layer opacity fields are valid; when false every layer is fully opaque. */
  layerOpacity: boolean
  /** Group layers carry a valid blend mode and opacity, and are composited as a unit first. */
  groupBlending: boolean
  /** Every layer carries a UUID. */
  layerUuids: boolean
}

export interface LayerFlags {
  visible: boolean
  editable: boolean
  lockMovement: boolean
  background: boolean
  preferLinkedCels: boolean
  collapsed: boolean
  reference: boolean
}

export type LayerType = 'image' | 'group' | 'tilemap'

export interface Layer {
  /** Position in `AsepriteFile.layers`, which is the index cels use. */
  index: number
  name: string
  type: LayerType
  flags: LayerFlags
  /** Depth in the layer tree: 0 at the top level. */
  childLevel: number
  /** The index of the enclosing group layer, or null at the top level. */
  parent: number | null
  /**
   * As stored. Aseprite ignores it on background layers, and on groups unless
   * `flags.groupBlending` is set; the renderer applies those rules.
   */
  blendMode: BlendMode
  /** As stored (0–255). Only valid when `flags.layerOpacity` is set. */
  opacity: number
  /** For tilemap layers: the id of their tileset. */
  tilesetId: number | null
  /** 16 bytes, when the file stores layer UUIDs. */
  uuid: Uint8Array | null
  userData: UserData | null
}

export interface Frame {
  /** Milliseconds. */
  duration: number
  /** The frame's cels, in the order the file lists them. */
  cels: Cel[]
  /** Palette changes this frame makes, in order; usually none after frame 0. See `paletteAt`. */
  paletteChanges: PaletteChange[]
}

export interface CelBase {
  layer: number
  frame: number
  x: number
  y: number
  /** 0–255. */
  opacity: number
  /** Render-order offset relative to the cel's layer (Aseprite 1.3+). */
  zIndex: number
  /** Sub-pixel placement, from a Cel Extra chunk. */
  precise: PreciseBounds | null
  userData: UserData | null
}

/** A cel holding its own pixels, row-major in the file's colour mode. */
export interface ImageCel extends CelBase {
  kind: 'image'
  width: number
  height: number
  /** 4 bytes a pixel (RGBA), 2 (value, alpha) or 1 (palette index). */
  pixels: Uint8Array
}

/** A cel that shows the cel of the same layer at another frame. */
export interface LinkedCel extends CelBase {
  kind: 'linked'
  linkedFrame: number
}

/** A cel of a tilemap layer: a grid of tile references into the layer's tileset. */
export interface TilemapCel extends CelBase {
  kind: 'tilemap'
  /** In tiles. */
  width: number
  /** In tiles. */
  height: number
  bitsPerTile: number
  masks: TileMasks
  /** Row-major raw tile values; decode them with `decodeTile`. */
  tiles: Uint32Array
}

export type Cel = ImageCel | LinkedCel | TilemapCel

export interface TileMasks {
  id: number
  xFlip: number
  yFlip: number
  diagonalFlip: number
}

export interface PreciseBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface PaletteEntry extends Rgba {
  name: string | null
}

/**
 * Set `entries` into the palette starting at index `from`. A Palette chunk
 * also makes the palette exactly `size` entries long; the old FLI colour
 * chunks carry no size (`null`) and only grow the palette to fit.
 */
export interface PaletteChange {
  size: number | null
  from: number
  entries: PaletteEntry[]
}

export type LoopDirection = 'forward' | 'reverse' | 'ping-pong' | 'ping-pong-reverse'

export interface Tag {
  name: string
  /** Inclusive. */
  from: number
  /** Inclusive. */
  to: number
  direction: LoopDirection
  /** 0 means unspecified (loop in the editor, play once on export). */
  repeat: number
  /** The pre-1.3 tag colour stored in the chunk itself; 1.3+ keeps it in `userData.color`. */
  color: Rgba
  userData: UserData | null
}

export interface Slice {
  name: string
  /** Whether the keys carry nine-patch centres. */
  ninePatch: boolean
  /** Whether the keys carry pivots. */
  hasPivot: boolean
  /** Sorted by frame; each key holds from its frame until the next. */
  keys: SliceKey[]
  userData: UserData | null
}

export interface SliceKey {
  frame: number
  bounds: Rect
  /** Relative to `bounds`. */
  center: Rect | null
  /** Relative to the bounds' origin. */
  pivot: Point | null
}

export interface Tileset {
  id: number
  name: string
  tileWidth: number
  tileHeight: number
  tileCount: number
  /** The number the UI shows for tile index 1 (usually 1). */
  baseIndex: number
  /** When true, tile index 0 is the empty tile (every current file). */
  zeroIsEmpty: boolean
  /** Which flips Aseprite tries when matching tiles in Auto mode. */
  matchFlips: { x: boolean; y: boolean; diagonal: boolean }
  /** A reference to a tileset in another file, from the External Files chunk. */
  external: { fileId: number; tilesetId: number } | null
  /**
   * The tiles' pixels, stacked vertically: `tileCount` tiles of
   * `tileWidth × tileHeight`, in the file's colour mode. Null when the tiles
   * live only in an external file.
   */
  pixels: Uint8Array | null
  userData: UserData | null
  /** User data per tile, by tile index, when the file stores any. */
  tileUserData: (UserData | null)[]
}

export type ColorProfile =
  | { kind: 'none'; gamma: number | null }
  | { kind: 'srgb'; gamma: number | null }
  | { kind: 'icc'; gamma: number | null; icc: Uint8Array }

export type ExternalFileType = 'palette' | 'tileset' | 'extension-properties' | 'extension-tile-management'

export interface ExternalFile {
  id: number
  type: ExternalFileType
  /** A file name, or an extension id like `publisher/ExtensionName`. */
  name: string
}

export interface UserData {
  text: string | null
  color: Rgba | null
  /**
   * Property maps by key: 0 is the user's own properties, any other key is an
   * extension's, by the id its External Files entry has.
   */
  properties: Map<number, PropertyMap>
}

export type PropertyMap = Map<string, PropertyValue>

/**
 * A user-data property. 64-bit integers are `bigint` so they survive exactly;
 * every other number is a `number`.
 */
export type PropertyValue =
  | { type: 'bool'; value: boolean }
  | { type: 'int8' | 'uint8' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'fixed' | 'float' | 'double'; value: number }
  | { type: 'int64' | 'uint64'; value: bigint }
  | { type: 'string'; value: string }
  | { type: 'point'; value: Point }
  | { type: 'size'; value: Size }
  | { type: 'rect'; value: Rect }
  | { type: 'vector'; value: PropertyValue[] }
  | { type: 'map'; value: PropertyMap }
  | { type: 'uuid'; value: Uint8Array }
