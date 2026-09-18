/**
 * A project folder on disk: opening one, creating one, and the maps and
 * images inside it (decision-log 2026-09-14, "The app opens projects only";
 * 2026-09-17, "binary assets on disk, map files on their own, everything
 * else in the project file").
 *
 * The folder is anchored on `papercut.json`; everything else is where the
 * project file says it is, relative to the folder. Opening reads the
 * project file strictly and then each image it lists: the file is read,
 * hashed, cut along its grid and scaled to the project's density, and its
 * terrain set — held in the entry — laid over it. An image that cannot be
 * read is a WARNING, not a failure: the project opens, the image is
 * reported, and the runtime draws the materials that pointed into it from
 * the placeholder set or as flat colour, because a missing PNG is the
 * artist's to relink, not a reason to refuse the level.
 *
 * A missing file is looked for by its last seen hash among the image files
 * in `sheets/` before it is called missing (ruling of 2026-09-17): a rename
 * or a move relinks silently and is reported as such. Hashes are refreshed
 * on every read, and the project file is written back when opening changed
 * an entry.
 *
 * Every write here is whole-file: a map, the project file, an image.
 * Nothing is patched in place, so a crash mid-write loses one file, never a
 * folder.
 */

import { MAPS_DIR, PROJECT_FILE, SHEETS_DIR, createMap, createProject, deserialize, parseProject, serialize, serializeProject, sheetName, stemOf, type Grid, type ImageEntry, type ImageKind, type ImageLayout, type ImageTerrain, type MapDoc, type ProjectDoc, type ReadonlyMapDoc, type ReadonlyProjectDoc, type RgbaImage } from '@papercut/document'
import { cutGrid, terrainFromLayout, terrainOf, terrainSetFrom, type LoadedSet } from '@papercut/geometry'

import type { ImageCodec } from './codec'
import { joinPath, parentPath, type ProjectFs } from './fs'

export interface OpenedProject {
  project: ProjectDoc
  /** The terrain sets that loaded, one per image that could be read and cut, in the project's order. */
  sets: LoadedSet[]
  /** What could not be loaded, or what opening changed, one line each, in the artist's terms. */
  warnings: string[]
  /** Image files under `sheets/` that no entry lists, by path relative to the folder. */
  unlisted: string[]
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const IMAGE_FILE = /\.(png|jpe?g|webp|gif|bmp)$/i

interface Crypto {
  crypto: { subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } }
}

/** A file's content hash as the project records it: `sha256:<hex>`. WebCrypto, which every runtime this package runs in has. */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await (globalThis as unknown as Crypto).crypto.subtle.digest('SHA-256', bytes)
  return `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

/** Every image file under `sheets/`, at any depth, by path relative to the folder. */
export async function listImageFiles(fs: ProjectFs, folder: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (relative: string): Promise<void> => {
    if (!(await fs.exists(joinPath(folder, relative)))) return
    for (const entry of await fs.readDir(joinPath(folder, relative))) {
      const path = `${relative}/${entry.name}`
      if (entry.kind === 'directory') await walk(path)
      else if (entry.kind === 'file' && IMAGE_FILE.test(entry.name)) found.push(path)
    }
  }
  await walk(SHEETS_DIR)
  return found.sort()
}

interface Loaded {
  entry: ImageEntry
  set: LoadedSet | null
  warnings: string[]
  /** Whether the entry is not what the file said: a refreshed hash, or a relinked path. */
  changed: boolean
}

/**
 * Read one image: its bytes — found by hash if its path is gone — then its pixels, cut along its grid and scaled to
 * the density, with its terrain set over them. Every way it can fail is a warning with the image named.
 */
async function loadImage(fs: ProjectFs, folder: string, entry: ImageEntry, density: number, codec: ImageCodec, hashesOfUnlisted: () => Promise<Map<string, string>>): Promise<Loaded> {
  const warnings: string[] = []
  let current = entry
  let bytes: Uint8Array
  try {
    bytes = await fs.readFile(joinPath(folder, entry.path))
  } catch (error) {
    // Not where it was: the same bytes somewhere under sheets/ is the same image, moved.
    const match = entry.hash === null ? undefined : [...(await hashesOfUnlisted()).entries()].find(([, hash]) => hash === entry.hash)?.[0]
    if (match === undefined) return { entry, set: null, warnings: [`${entry.path}: ${messageOf(error)}`], changed: false }
    current = { ...entry, path: match }
    warnings.push(`${entry.path} was not there; ${match} has the same contents, so ${current.name} now points at it.`)
    bytes = await fs.readFile(joinPath(folder, match))
  }
  const name = sheetName(current.path)
  const hash = await hashBytes(bytes)
  const changed = current !== entry || hash !== current.hash
  if (hash !== current.hash) current = { ...current, hash }
  let source: RgbaImage
  try {
    source = await codec.decode(bytes)
  } catch (error) {
    return { entry: current, set: null, warnings: [...warnings, `${current.path}: ${messageOf(error)}`], changed }
  }
  const scale = density / current.grid.tile
  if (!Number.isInteger(scale)) {
    return { entry: current, set: null, warnings: [...warnings, `${name}: ${current.grid.tile} px tiles do not divide the project's ${density} px, so it is not drawn.`], changed }
  }
  const cut = cutGrid(source, current.grid, scale)
  if (cut.columns === 0 || cut.rows === 0) {
    return { entry: current, set: null, warnings: [...warnings, `${name} is ${source.width}×${source.height}: not even one ${current.grid.tile} px tile fits its grid.`], changed }
  }
  // A layout describes the sheet and the entry's own tags correct it (ruling of 2026-09-17).
  const terrain = current.layout === null ? current.terrain : terrainFromLayout(current.layout, current.terrain, cut.columns, cut.rows)
  const { set, dropped } = terrainSetFrom(name, density, cut.columns, cut.rows, terrain)
  if (dropped.length > 0) warnings.push(`${name}: ${dropped.length} tagged ${dropped.length === 1 ? 'tile is' : 'tiles are'} past the edge of its ${cut.columns}×${cut.rows} grid and not drawn.`)
  return { entry: current, set: { set, image: cut.image, source }, warnings, changed }
}

/**
 * Open the project in `folder`: its file, then every image it lists. Throws only when the project file itself is
 * missing or unreadable. Writes the project file back when opening refreshed a hash or relinked a moved file.
 */
export async function openProject(fs: ProjectFs, folder: string, codec: ImageCodec): Promise<OpenedProject> {
  const project = parseProject(await fs.readTextFile(joinPath(folder, PROJECT_FILE)))
  const files = await listImageFiles(fs, folder)
  const listed = new Set(project.images.map((i) => i.path))
  let unlistedHashes: Map<string, string> | null = null
  const hashesOfUnlisted = async (): Promise<Map<string, string>> => {
    if (unlistedHashes) return unlistedHashes
    unlistedHashes = new Map()
    for (const path of files) if (!listed.has(path)) unlistedHashes.set(path, await hashBytes(await fs.readFile(joinPath(folder, path))))
    return unlistedHashes
  }
  const sets: LoadedSet[] = []
  const warnings: string[] = []
  const images: ImageEntry[] = []
  let changed = false
  for (const entry of project.images) {
    const loaded = await loadImage(fs, folder, entry, project.resolution.texelDensity, codec, hashesOfUnlisted)
    images.push(loaded.entry)
    if (loaded.set) sets.push(loaded.set)
    warnings.push(...loaded.warnings)
    changed ||= loaded.changed
  }
  project.images = images
  if (changed) await writeProject(fs, folder, project)
  const now = new Set(images.map((i) => i.path))
  const unlisted = files.filter((path) => !now.has(path))
  for (const map of project.maps) if (!(await fs.exists(joinPath(folder, map)))) warnings.push(`${map} is listed but not in the folder.`)
  // The other way round too (ruling of 2026-09-14): a map file the list does not know is reported, never silently included.
  if (await fs.exists(joinPath(folder, MAPS_DIR))) {
    for (const entry of await fs.readDir(joinPath(folder, MAPS_DIR))) {
      const path = `${MAPS_DIR}/${entry.name}`
      if (entry.kind === 'file' && entry.name.endsWith('.map.json') && !project.maps.includes(path)) warnings.push(`${path} is in the folder but not in the project's map list.`)
    }
  }
  return { project, sets, warnings, unlisted }
}

export async function readMap(fs: ProjectFs, folder: string, path: string): Promise<MapDoc> {
  return deserialize(await fs.readTextFile(joinPath(folder, path)))
}

export async function writeMap(fs: ProjectFs, folder: string, path: string, doc: ReadonlyMapDoc): Promise<void> {
  await fs.writeFile(joinPath(folder, path), serialize(doc))
}

export async function writeProject(fs: ProjectFs, folder: string, project: ReadonlyProjectDoc): Promise<void> {
  await fs.writeFile(joinPath(folder, PROJECT_FILE), serializeProject(project))
}

/** A file name from a map's name: `Harbour Town` → `harbour-town`; never empty. */
export function slugOf(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'map'
}

/** The path a new map takes in the project: `maps/<slug>.map.json`, suffixed until it is not one the project already lists. */
export function mapPathFor(project: ReadonlyProjectDoc, name: string): string {
  const slug = slugOf(name)
  let path = `${MAPS_DIR}/${slug}.map.json`
  for (let n = 2; project.maps.includes(path); n++) path = `${MAPS_DIR}/${slug}-${n}.map.json`
  return path
}

export interface NewProjectOptions {
  name: string
  texelDensity: number
  /** The placeholder terrain set drawn for that density, written into `sheets/` so the folder stands on its own. */
  placeholder: LoadedSet
  /** The first map, written and listed first; an empty 32 × 32 map named for the project when absent. */
  firstMap?: MapDoc
}

/** Create a project folder: the project file with the placeholder's terrain set in it, one map, and the placeholder image. Refuses a folder that holds anything already. */
export async function createProjectFolder(fs: ProjectFs, folder: string, options: NewProjectOptions, codec: ImageCodec): Promise<OpenedProject> {
  if (await fs.exists(joinPath(folder, PROJECT_FILE))) throw new Error(`${folder} already holds a project.`)
  if ((await fs.exists(folder)) && (await fs.readDir(folder)).length > 0) throw new Error(`${folder} is not empty; a project gets a folder of its own.`)
  await fs.mkdir(folder, { recursive: true })
  await fs.mkdir(joinPath(folder, MAPS_DIR), { recursive: true })
  await fs.mkdir(joinPath(folder, SHEETS_DIR), { recursive: true })
  const project = createProject(options.name, options.texelDensity, terrainOf(options.placeholder.set))
  const image = project.images[0]
  const bytes = await codec.encode(options.placeholder.image)
  await fs.writeFile(joinPath(folder, image.path), bytes)
  image.hash = await hashBytes(bytes)
  const placeholder: LoadedSet = { set: { ...options.placeholder.set, sheet: sheetName(image.path) }, image: options.placeholder.image, source: options.placeholder.image }
  const first = options.firstMap ?? createMap(32, 32, options.name)
  const path = mapPathFor(project, first.name)
  await writeMap(fs, folder, path, first)
  project.maps = [path]
  await writeProject(fs, folder, project)
  return { project, sets: [placeholder], warnings: [], unlisted: [] }
}

/** Write a new map into the project and list it last. Returns the project as it now is and where the map went. */
export async function addMap(fs: ProjectFs, folder: string, project: ReadonlyProjectDoc, doc: MapDoc): Promise<{ project: ProjectDoc; path: string }> {
  const path = mapPathFor(project, doc.name)
  await fs.mkdir(joinPath(folder, parentPath(path)), { recursive: true })
  await writeMap(fs, folder, path, doc)
  const next: ProjectDoc = { ...(project as ProjectDoc), maps: [...project.maps, path] }
  await writeProject(fs, folder, next)
  return { project: next, path }
}

export interface NewImage {
  /** The file name the image goes by: `cliffs.png`. Its identity. */
  file: string
  /** The image as it will be written, already encoded. */
  bytes: Uint8Array
  grid: Grid
  /** What the app calls it; the file's stem when absent. */
  name?: string
  kind?: ImageKind
  /** Its terrain set; empty when absent, or kept from the entry it replaces. */
  terrain?: ImageTerrain
  /** The convention it was laid out to, for an image papercut generated as a template. */
  layout?: ImageLayout | null
}

function withEntry(project: ReadonlyProjectDoc, entry: ImageEntry): ProjectDoc {
  const file = sheetName(entry.path)
  const known = project.images.some((i) => sheetName(i.path) === file)
  const images = known ? project.images.map((i) => (sheetName(i.path) === file ? entry : { ...(i as ImageEntry) })) : [...project.images.map((i) => ({ ...(i as ImageEntry) })), entry]
  return { ...(project as ProjectDoc), images }
}

/**
 * Copy an image into `sheets/` and list it. An entry of the same file name is replaced, keeping its name, kind and
 * terrain set unless new ones are given — what Replace image… and Relink… do. Returns the project as it now is.
 */
export async function addImage(fs: ProjectFs, folder: string, project: ReadonlyProjectDoc, image: NewImage): Promise<ProjectDoc> {
  const path = `${SHEETS_DIR}/${image.file}`
  await fs.mkdir(joinPath(folder, SHEETS_DIR), { recursive: true })
  await fs.writeFile(joinPath(folder, path), image.bytes)
  const previous = project.images.find((i) => sheetName(i.path) === image.file) as ImageEntry | undefined
  const entry: ImageEntry = {
    path,
    name: image.name ?? previous?.name ?? stemOf(path),
    kind: image.kind ?? previous?.kind ?? 'tileset',
    hash: await hashBytes(image.bytes),
    grid: image.grid,
    layout: image.layout === undefined ? (previous?.layout ?? null) : image.layout,
    terrain: image.terrain ?? previous?.terrain ?? { tiles: {} },
  }
  const next = withEntry(project, entry)
  await writeProject(fs, folder, next)
  return next
}

/** List an image file already in the folder — one `openProject` reported as unlisted — without copying it. Returns the project as it now is. */
export async function listImage(fs: ProjectFs, folder: string, project: ReadonlyProjectDoc, path: string, grid: Grid, options: { name?: string; kind?: ImageKind } = {}): Promise<ProjectDoc> {
  const file = sheetName(path)
  if (project.images.some((i) => sheetName(i.path) === file)) throw new Error(`An image called ${file} is already listed.`)
  const entry: ImageEntry = { path, name: options.name ?? stemOf(path), kind: options.kind ?? 'tileset', hash: await hashBytes(await fs.readFile(joinPath(folder, path))), grid, layout: null, terrain: { tiles: {} } }
  const next = withEntry(project, entry)
  await writeProject(fs, folder, next)
  return next
}
