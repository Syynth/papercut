/**
 * The project: what every map in a folder shares (decision-log, 2026-09-14
 * and 2026-09-17).
 *
 * A project is a folder anchored on `papercut.json`. The file holds every
 * definition and every piece of metadata — the images the project draws
 * from with their names, grids, hashes and terrain sets; the material
 * library; the resolution profile; the camera rig; the maps in order. Binary
 * assets live on disk beside it, referenced by path; maps live on disk one
 * file each; everything else is in here (ruling of 2026-09-17: "binary
 * assets on disk, map files on their own, everything else in the project
 * file"). There are no sidecars.
 *
 * Plain data, read strictly: one format version and no migrations until a
 * project worth keeping exists. Paths in the file are relative to the
 * folder, forward-slashed. An image is IDENTIFIED by its file name —
 * `sheets/ground.png` is the image `ground.png`, which is what a material's
 * `TerrainRef` says — and NAMED by its `name`, which is what the app shows
 * and which changes freely without touching a reference (ruling of
 * 2026-09-17).
 */

import { DEFAULT_MATERIALS, PLACEHOLDER_SHEET, defaultCameraRig, type CameraRig, type DeepReadonly, type MaterialDef, type TerrainRef } from './document'
import { LoadError } from './io'

export const PROJECT_FORMAT_VERSION = 2
/** The file a project is anchored on, at the root of its folder. */
export const PROJECT_FILE = 'papercut.json'
/** Where a project keeps its maps and its images, relative to the folder. */
export const MAPS_DIR = 'maps'
export const SHEETS_DIR = 'sheets'

export interface ResolutionProfile {
  /** Pixels per tile. Texture detail only — never world scale. */
  texelDensity: number
  filtering: 'nearest' | 'linear'
}

// --- terrain sets, as an image carries them ------------------------------------

/** A corner's terrain: an id in the image's `terrains`, or `null` for nothing — the edge of the ground, the top of a cliff. */
export type Tag = string | null
/** The four corners of a tile, in the order NW, NE, SW, SE. */
export type CornerTags = readonly [Tag, Tag, Tag, Tag]

export interface TerrainDef {
  id: string
  name: string
  /** `#rrggbb`, the swatch and the fallback fill. */
  color: string
}

/** What an image's tiles are, tagged by corner: the terrain set, as the project file holds it. Tile indexes are row-major on the image's grid. */
export interface ImageTerrain {
  terrains: TerrainDef[]
  tiles: Record<string, [Tag, Tag, Tag, Tag]>
}

// --- images ----------------------------------------------------------------------

export type ImageKind = 'tileset' | 'sprites' | 'texture'

export interface Axes {
  x: number
  y: number
}

/** How an image is cut into tiles (ruling of 2026-09-17): square tiles of `tile` px, after `margin` px, `spacing` px apart. Whatever lies past the last whole tile is ignored. */
export interface Grid {
  tile: number
  margin: Axes
  spacing: Axes
}

/**
 * How an image is laid out, when it was laid out to a convention papercut
 * knows (ruling of 2026-09-17). The tags are derived from this; the entry's
 * `terrain.tiles` are overrides applied on top.
 */
export interface ImageLayout {
  /** A convention in `@papercut/geometry`'s registry: `corner-blocks`. */
  convention: string
  /** Where its first block starts, in tiles from the image's top-left. */
  origin: Axes
  /** The terrains it lays out, in the convention's order; a block is named by their indexes. */
  terrains: string[]
  /** Blocks the artist has not drawn, by the convention's key for them, so they tag nothing and are listed as still to author. */
  unauthored: string[]
}

/** An image the project draws from, and everything the project knows about it. */
export interface ImageEntry {
  /** Relative to the project folder: `sheets/ground.png`. The file name is the image's identity. */
  path: string
  /** What the app calls it; free to change. */
  name: string
  kind: ImageKind
  /** The file's content hash as last seen — `sha256:<hex>` — or `null` before it has been read; how a moved file is found again. */
  hash: string | null
  grid: Grid
  /** The convention it was laid out to, or `null` for an image tagged by hand. */
  layout: ImageLayout | null
  terrain: ImageTerrain
}

export interface ProjectDoc {
  formatVersion: number
  name: string
  resolution: ResolutionProfile
  images: ImageEntry[]
  /** The library, in priority order (see `MaterialDef`). */
  materials: MaterialDef[]
  /** The rig every new map starts from. */
  camera: CameraRig
  /** The maps, by path relative to the folder, in the order the project shows them. */
  maps: string[]
}

export type ReadonlyProjectDoc = DeepReadonly<ProjectDoc>

/** The name an image goes by — its file name — from its path in the project. */
export function sheetName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** A file's stem — `Outside_A2.png` → `Outside_A2` — the name an image starts with. */
export function stemOf(path: string): string {
  return sheetName(path).replace(/\.[^.]+$/, '')
}

/** A grid with no margin and no spacing: tiles edge to edge from the top-left corner. */
export function plainGrid(tile: number): Grid {
  return { tile, margin: { x: 0, y: 0 }, spacing: { x: 0, y: 0 } }
}

export function emptyTerrain(): ImageTerrain {
  return { terrains: [], tiles: {} }
}

/** The placeholder image's entry: the image the default materials point into, tagged as `terrain` says. */
export function placeholderImage(tile: number, terrain: ImageTerrain = emptyTerrain()): ImageEntry {
  return { path: `${SHEETS_DIR}/${PLACEHOLDER_SHEET}`, name: 'Ground', kind: 'tileset', hash: null, grid: plainGrid(tile), layout: null, terrain }
}

/** A project with the placeholder image and the default materials, and no maps yet. */
export function createProject(name = 'Untitled Project', texelDensity = 16, placeholderTerrain: ImageTerrain = emptyTerrain()): ProjectDoc {
  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    name,
    resolution: { texelDensity, filtering: 'nearest' },
    images: [placeholderImage(texelDensity, placeholderTerrain)],
    materials: DEFAULT_MATERIALS.map((m) => ({ ...m })),
    camera: defaultCameraRig(),
    maps: [],
  }
}

/** A material names its terrains or it is not a material; the rest defaults. Ids are unique, or the list is refused. */
export function normaliseMaterials(raw: unknown): MaterialDef[] {
  if (!Array.isArray(raw)) return DEFAULT_MATERIALS.map((m) => ({ ...m }))
  if (raw.length === 0) throw new LoadError('A project has at least one material.')
  const ids = new Set<number>()
  return raw.map((value, index) => {
    const m = value as Partial<MaterialDef>
    const top = m.top as Partial<TerrainRef> | undefined
    if (!top || typeof top.sheet !== 'string' || typeof top.terrain !== 'string') throw new LoadError(`Material ${index} names no terrain.`)
    const side = m.side as Partial<TerrainRef> | undefined
    const id = typeof m.id === 'number' && Number.isInteger(m.id) && m.id >= 0 ? m.id : index
    if (ids.has(id)) throw new LoadError(`Two materials share the id ${id}.`)
    ids.add(id)
    return {
      id,
      name: typeof m.name === 'string' ? m.name : `Material ${index + 1}`,
      color: typeof m.color === 'number' ? m.color : 0x808080,
      role: m.role === 'top' || m.role === 'wall' ? m.role : 'any',
      top: { sheet: top.sheet, terrain: top.terrain },
      ...(side && typeof side.sheet === 'string' && typeof side.terrain === 'string' ? { side: { sheet: side.sheet, terrain: side.terrain } } : {}),
    }
  })
}

const isRelativePath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..')
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

function normaliseAxes(raw: unknown, what: string, where: string): Axes {
  if (raw === undefined) return { x: 0, y: 0 }
  // One number is both axes: the common case, and what a hand-written file says.
  if (isCount(raw)) return { x: raw, y: raw }
  const a = raw as Partial<Axes>
  if (!isCount(a.x) || !isCount(a.y)) throw new LoadError(`Image ${where} has a ${what} that is not a whole number of pixels.`)
  return { x: a.x, y: a.y }
}

/** A layout names a convention and the terrains it lays out; anything else is refused rather than half-read. */
export function normaliseLayout(raw: unknown, where: string): ImageLayout | null {
  if (raw === undefined || raw === null) return null
  const l = raw as Partial<ImageLayout>
  if (typeof l.convention !== 'string' || l.convention.length === 0) throw new LoadError(`Image ${where} has a layout that names no convention.`)
  if (!Array.isArray(l.terrains) || !l.terrains.every((t) => typeof t === 'string' && t.length > 0)) throw new LoadError(`Image ${where}'s layout does not list its terrains.`)
  if (new Set(l.terrains).size !== l.terrains.length) throw new LoadError(`Image ${where}'s layout lists a terrain twice.`)
  const unauthored = l.unauthored === undefined ? [] : l.unauthored
  if (!Array.isArray(unauthored) || !unauthored.every((b) => typeof b === 'string')) throw new LoadError(`Image ${where}'s layout does not name its unauthored blocks.`)
  return { convention: l.convention, origin: normaliseAxes(l.origin, 'origin', where), terrains: [...l.terrains], unauthored: [...unauthored] }
}

/** A grid's tile is a positive whole number of pixels; margin and spacing default to none. */
export function normaliseGrid(raw: unknown, where: string): Grid {
  const g = (raw ?? {}) as Partial<Grid>
  if (!isCount(g.tile) || g.tile <= 0) throw new LoadError(`Image ${where} has no tile size.`)
  return { tile: g.tile, margin: normaliseAxes(g.margin, 'margin', where), spacing: normaliseAxes(g.spacing, 'spacing', where) }
}

/** A terrain set as the project file holds it: terrains with unique ids, and tags that name only those. Tile indexes are checked against the image when it loads, not here. */
export function normaliseTerrain(raw: unknown, where: string): ImageTerrain {
  const t = (raw ?? {}) as Partial<ImageTerrain>
  const terrains: TerrainDef[] = []
  const ids = new Set<string>()
  if (t.terrains !== undefined) {
    if (!Array.isArray(t.terrains)) throw new LoadError(`Image ${where} lists its terrains as something that is not a list.`)
    for (const value of t.terrains as unknown[]) {
      const def = value as Partial<TerrainDef>
      if (typeof def.id !== 'string' || def.id.length === 0) throw new LoadError(`Image ${where} has a terrain with no id.`)
      if (ids.has(def.id)) throw new LoadError(`Image ${where} lists the terrain ${def.id} twice.`)
      ids.add(def.id)
      terrains.push({ id: def.id, name: typeof def.name === 'string' && def.name.trim() ? def.name : def.id, color: typeof def.color === 'string' ? def.color : '#808080' })
    }
  }
  const tiles: Record<string, [Tag, Tag, Tag, Tag]> = {}
  if (t.tiles !== undefined) {
    if (typeof t.tiles !== 'object' || t.tiles === null || Array.isArray(t.tiles)) throw new LoadError(`Image ${where} tags its tiles as something that is not a map.`)
    for (const [key, tags] of Object.entries(t.tiles as Record<string, unknown>)) {
      const index = Number(key)
      if (!Number.isInteger(index) || index < 0) throw new LoadError(`Image ${where} tags a tile ${key}, which is not a tile index.`)
      if (!Array.isArray(tags) || tags.length !== 4) throw new LoadError(`Image ${where}, tile ${key}: four corner tags, NW NE SW SE.`)
      for (const tag of tags as unknown[]) if (!(tag === null || (typeof tag === 'string' && ids.has(tag)))) throw new LoadError(`Image ${where}, tile ${key} names a terrain the image does not have.`)
      // A tile tagged nothing everywhere is held: the template tags one so on purpose (the all-under tile).
      tiles[String(index)] = [...(tags as [Tag, Tag, Tag, Tag])]
    }
  }
  return { terrains, tiles }
}

const KINDS: readonly ImageKind[] = ['tileset', 'sprites', 'texture']

export function normaliseImage(raw: unknown, index: number): ImageEntry {
  const i = raw as Partial<ImageEntry>
  if (!isRelativePath(i.path)) throw new LoadError(`Image ${index} has no path inside the project.`)
  const where = sheetName(i.path)
  return {
    path: i.path,
    name: typeof i.name === 'string' && i.name.trim() ? i.name : stemOf(i.path),
    kind: KINDS.includes(i.kind as ImageKind) ? (i.kind as ImageKind) : 'tileset',
    hash: typeof i.hash === 'string' && i.hash.length > 0 ? i.hash : null,
    grid: normaliseGrid(i.grid, where),
    layout: normaliseLayout(i.layout, where),
    terrain: normaliseTerrain(i.terrain, where),
  }
}

function normaliseImages(raw: unknown): ImageEntry[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new LoadError('The image list is not a list.')
  const names = new Set<string>()
  return raw.map((value, index) => {
    const entry = normaliseImage(value, index)
    const name = sheetName(entry.path)
    if (names.has(name)) throw new LoadError(`Two images are both called ${name}; an image is identified by its file name.`)
    names.add(name)
    return entry
  })
}

function normaliseResolution(raw: unknown): ResolutionProfile {
  const r = (raw ?? {}) as Partial<ResolutionProfile>
  const texelDensity = r.texelDensity ?? 16
  if (typeof texelDensity !== 'number' || !Number.isInteger(texelDensity) || texelDensity <= 0) throw new LoadError('The texel density is not a whole number of pixels.')
  return { texelDensity, filtering: r.filtering === 'linear' ? 'linear' : 'nearest' }
}

export function parseProject(text: string): ProjectDoc {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch (error) {
    throw new LoadError(`Not a project file: ${(error as Error).message}`)
  }
  if (!raw || typeof raw !== 'object') throw new LoadError('Not a project file.')
  if (raw.formatVersion !== PROJECT_FORMAT_VERSION) {
    throw new LoadError(`This project is format ${String(raw.formatVersion)}; this build reads format ${PROJECT_FORMAT_VERSION}.`)
  }
  if (raw.maps !== undefined && (!Array.isArray(raw.maps) || !raw.maps.every(isRelativePath))) throw new LoadError('The map list holds something that is not a path inside the project.')
  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : 'Untitled Project',
    resolution: normaliseResolution(raw.resolution),
    images: normaliseImages(raw.images),
    materials: normaliseMaterials(raw.materials),
    camera: { ...defaultCameraRig(), ...((raw.camera as Partial<CameraRig>) ?? {}) },
    maps: [...((raw.maps) ?? [])],
  }
}

export function serializeProject(project: ReadonlyProjectDoc): string {
  return JSON.stringify(project, null, 2)
}
