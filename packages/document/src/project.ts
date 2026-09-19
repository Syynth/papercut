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

import { DEFAULT_MATERIALS, MAX_PICKET_DISTANCE, PLACEHOLDER_SHEET, defaultCameraRig, type CameraRig, type DeepReadonly, type MaterialDef } from './document'
import { LoadError } from './io'

export const PROJECT_FORMAT_VERSION = 3
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

// --- tags, as an image carries them --------------------------------------------

/**
 * What a corner of a tile shows (ruling of 2026-09-17): a MATERIAL, and
 * optionally a SLOT of that material's archetype. `null` is nothing — the
 * edge of the ground, the air beside a cliff.
 *
 * Spelled as a string, `"3"` or `"3:convex"`, for two reasons. A tag is
 * compared far more often than it is read apart: the atlas interns it, the
 * mesher packs four of them into one number, and the tagger asks whether two
 * corners are the same thing. A primitive makes every one of those an `===`.
 * And the tiles record is the bulkiest thing in a project file, four tags per
 * tile over hundreds of tiles, so the compact spelling is what gets written.
 *
 * The slot is ALLOWED on every tag and expected on almost none. Absent, a tag
 * means the material's ordinary surface, which is what an artist tags all day;
 * a wall's seam is inferred from the geometry rather than authored. It is
 * carried here from the start because retrofitting a field onto every tag in
 * every project later is worse than carrying an empty one now, and the cases
 * are known: seams, and later alternates and alternate shapes.
 */
export type Tag = string | null
/** The four corners of a tile, in the order NW, NE, SW, SE. */
export type CornerTags = readonly [Tag, Tag, Tag, Tag]

/** The tag for a material, and a slot of its archetype when the ordinary surface is not what is meant. */
export function tagOf(material: number, slot?: string | null): Tag {
  return slot ? `${material}:${slot}` : String(material)
}

/** The material a tag names, or `null` for nothing. */
export function materialOfTag(tag: Tag): number | null {
  if (tag === null) return null
  const colon = tag.indexOf(':')
  const id = Number(colon === -1 ? tag : tag.slice(0, colon))
  return Number.isInteger(id) && id >= 0 ? id : null
}

/** The slot a tag names, or `null` for the material's ordinary surface. */
export function slotOfTag(tag: Tag): string | null {
  if (tag === null) return null
  const colon = tag.indexOf(':')
  return colon === -1 ? null : tag.slice(colon + 1)
}

/** What an image's tiles are, tagged by corner, as the project file holds it. Tile indexes are row-major on the image's grid. */
export interface ImageTerrain {
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
  /** The materials it lays out, by id, in the convention's order; a block is named by their indexes. */
  materials: number[]
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
  /** The project's own sprites, cut from its images (ruling of 2026-09-18); each stands in for a generated one of its name. */
  sprites: SpriteDef[]
}

/**
 * A sprite the project draws from one of its images: a name, the image it is
 * cut from, and a rectangle on that image's tile grid. Named like a generated
 * sprite — `tree`, `barrel` — it stands in for that one wherever an object
 * names it; any other name is a sprite of the project's own. One facing for
 * now; its footprint in the world is its rectangle, one tile to a tile.
 */
export interface SpriteDef {
  name: string
  /** The image's path, as the project lists it. */
  image: string
  /** In the image's tiles, from its top-left: where the sprite is and how big. */
  rect: { x: number; y: number; w: number; h: number }
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
  return { tiles: {} }
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
    sprites: [],
  }
}

/** A material is an id and a name; the rest defaults. Ids are unique, or the list is refused. */
export function normaliseMaterials(raw: unknown): MaterialDef[] {
  if (!Array.isArray(raw)) return DEFAULT_MATERIALS.map((m) => ({ ...m }))
  if (raw.length === 0) throw new LoadError('A project has at least one material.')
  const ids = new Set<number>()
  const out: MaterialDef[] = raw.map((value, index): MaterialDef => {
    const m = value as Partial<MaterialDef>
    const id = typeof m.id === 'number' && Number.isInteger(m.id) && m.id >= 0 ? m.id : index
    if (ids.has(id)) throw new LoadError(`Two materials share the id ${id}.`)
    ids.add(id)
    return {
      id,
      name: typeof m.name === 'string' ? m.name : `Material ${index + 1}`,
      color: typeof m.color === 'number' ? m.color : 0x808080,
      archetype: m.archetype === 'wall' || m.archetype === 'ramp' ? m.archetype : 'floor',
      ...(typeof m.fringeAngle === 'number' && m.fringeAngle >= 0 && m.fringeAngle <= 90 ? { fringeAngle: m.fringeAngle } : {}),
      ...(typeof m.picketDistance === 'number' && m.picketDistance >= 0 && m.picketDistance <= MAX_PICKET_DISTANCE ? { picketDistance: m.picketDistance } : {}),
    }
  })
  return out
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

/** A layout names a convention and the materials it lays out; anything else is refused rather than half-read. */
export function normaliseLayout(raw: unknown, where: string): ImageLayout | null {
  if (raw === undefined || raw === null) return null
  const l = raw as Partial<ImageLayout>
  if (typeof l.convention !== 'string' || l.convention.length === 0) throw new LoadError(`Image ${where} has a layout that names no convention.`)
  if (!Array.isArray(l.materials) || !l.materials.every((m) => typeof m === 'number' && Number.isInteger(m) && m >= 0)) throw new LoadError(`Image ${where}'s layout does not list its materials.`)
  if (new Set(l.materials).size !== l.materials.length) throw new LoadError(`Image ${where}'s layout lists a material twice.`)
  return { convention: l.convention, origin: normaliseAxes(l.origin, 'origin', where), materials: [...l.materials] }
}

/** A grid's tile is a positive whole number of pixels; margin and spacing default to none. */
export function normaliseGrid(raw: unknown, where: string): Grid {
  const g = (raw ?? {}) as Partial<Grid>
  if (!isCount(g.tile) || g.tile <= 0) throw new LoadError(`Image ${where} has no tile size.`)
  return { tile: g.tile, margin: normaliseAxes(g.margin, 'margin', where), spacing: normaliseAxes(g.spacing, 'spacing', where) }
}

/**
 * An image's tags as the project file holds it: four per tile, each naming a
 * material or nothing. Whether the materials exist is the project's business
 * and is checked once the whole file is read; whether the tile indexes fit is
 * the image's, and is checked when its pixels load.
 */
export function normaliseTerrain(raw: unknown, where: string): ImageTerrain {
  const t = (raw ?? {}) as Partial<ImageTerrain>
  const tiles: Record<string, [Tag, Tag, Tag, Tag]> = {}
  if (t.tiles !== undefined) {
    if (typeof t.tiles !== 'object' || t.tiles === null || Array.isArray(t.tiles)) throw new LoadError(`Image ${where} tags its tiles as something that is not a map.`)
    for (const [key, tags] of Object.entries(t.tiles as Record<string, unknown>)) {
      const index = Number(key)
      if (!Number.isInteger(index) || index < 0) throw new LoadError(`Image ${where} tags a tile ${key}, which is not a tile index.`)
      if (!Array.isArray(tags) || tags.length !== 4) throw new LoadError(`Image ${where}, tile ${key}: four corner tags, NW NE SW SE.`)
      for (const tag of tags as unknown[]) {
        if (tag === null) continue
        if (typeof tag !== 'string' || materialOfTag(tag) === null) throw new LoadError(`Image ${where}, tile ${key} has a corner tag that names no material.`)
      }
      // A tile tagged nothing everywhere is held: the template tags one so on purpose (the all-under tile).
      tiles[String(index)] = [...(tags as [Tag, Tag, Tag, Tag])]
    }
  }
  return { tiles }
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
  const project: ProjectDoc = {
    formatVersion: PROJECT_FORMAT_VERSION,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : 'Untitled Project',
    resolution: normaliseResolution(raw.resolution),
    images: normaliseImages(raw.images),
    materials: normaliseMaterials(raw.materials),
    camera: { ...defaultCameraRig(), ...((raw.camera as Partial<CameraRig>) ?? {}) },
    maps: [...((raw.maps) ?? [])],
    sprites: [],
  }
  project.sprites = normaliseSprites(raw.sprites, project.images)
  checkTags(project)
  return project
}

/**
 * A project's sprites, checked the way everything a file holds is: a name,
 * unique; an image the project lists; a rectangle of whole tiles, at least
 * one each way. Anything else refuses the file, saying which.
 */
export function normaliseSprites(raw: unknown, images: readonly ImageEntry[]): SpriteDef[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new LoadError('The sprite list is not a list.')
  const names = new Set<string>()
  const paths = new Set(images.map((i) => i.path))
  return raw.map((value, index): SpriteDef => {
    const s = value as Partial<SpriteDef>
    const where = typeof s.name === 'string' ? `Sprite ${s.name}` : `Sprite ${index}`
    if (typeof s.name !== 'string' || !s.name.trim()) throw new LoadError(`${where} has no name.`)
    if (names.has(s.name)) throw new LoadError(`Two sprites are called ${s.name}.`)
    names.add(s.name)
    if (typeof s.image !== 'string' || !paths.has(s.image)) throw new LoadError(`${where} is cut from ${String(s.image)}, which the project does not list.`)
    const r = s.rect
    const whole = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min
    if (!r || !whole(r.x, 0) || !whole(r.y, 0) || !whole(r.w, 1) || !whole(r.h, 1)) throw new LoadError(`${where} has no rectangle of whole tiles.`)
    return { name: s.name, image: s.image, rect: { x: r.x, y: r.y, w: r.w, h: r.h } }
  })
}

/**
 * Every tag names a material the project has, or the file is refused.
 *
 * A tag naming an id nothing defines would send the atlas looking for art
 * that cannot exist, and it would do so silently, one corner at a time, in a
 * map. The editor never writes one: deleting a material clears its tags the
 * same way it repaints its voxels. So a file with one has been edited by hand
 * or written by something older, and saying which tile is wrong beats opening
 * a project that draws the wrong thing.
 */
function checkTags(project: ProjectDoc): void {
  const ids = new Set(project.materials.map((m) => m.id))
  for (const image of project.images) {
    for (const [index, tags] of Object.entries(image.terrain.tiles)) {
      for (const tag of tags) {
        const material = materialOfTag(tag)
        if (material !== null && !ids.has(material)) throw new LoadError(`Image ${sheetName(image.path)}, tile ${index} is tagged with material ${material}, which the project does not have.`)
      }
    }
    if (image.layout) {
      for (const material of image.layout.materials) {
        if (!ids.has(material)) throw new LoadError(`Image ${sheetName(image.path)}'s layout lays out material ${material}, which the project does not have.`)
      }
    }
  }
}

export function serializeProject(project: ReadonlyProjectDoc): string {
  return JSON.stringify(project, null, 2)
}
