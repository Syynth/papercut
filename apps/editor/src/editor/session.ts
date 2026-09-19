/**
 * The project session: where the open project lives and how it gets there.
 *
 * The host holds the project's contents and its location; the files are this
 * module's business. It reads and writes them through `@papercut/project`
 * over one of two filesystems — the desktop shell's, granted folder by
 * folder through its dialogs, or a folder tree in memory for the browser
 * build, which keeps it in `localStorage` and seeds it with the sample
 * project on first run so the Pages deploy and the dev server open on
 * something. The seam is the same either way, so opening a project is one
 * code path with two ways of choosing a folder.
 *
 * Every function here is a SEQUENCE of dispatches around the file work: read
 * the project file, `project.load`; read the first map, `document.load`;
 * hand the viewport the images. Nothing in an actor touches a file.
 */

import { MAPS_DIR, PROJECT_FILE, createMap, slotMaterial, slotOf, plainGrid, serialize, serializeProject, sheetName, type Grid, type ImageEntry, type ImageKind, type MapDoc, type MaterialLayers, type Patch, type ReadonlyMapDoc, type RgbaImage } from '@papercut/document'
import type { Host } from '@papercut/editor-host'
import { createSampleMap, generatePlaceholderTerrainSet } from '@papercut/fixtures'
import { conventionOf, remapTags, renderTemplate, terrainOf, type LoadedSet, type TerrainSet } from '@papercut/geometry'
import { MemoryFs, addImage, addMap, createProjectFolder, forget, hashBytes, joinPath, listImage, openProject, parseRecents, readMap, remember, writeMap, writeProject, type ImageCodec, type OpenedProject, type ProjectFs, type RecentProject } from '@papercut/project'
import { exportGltf } from '@papercut/runtime/export'
import { desktopShell, type MenuCommand, type ShellDialogs, type ShellMenu } from '@papercut/shell-api'

import { artFor, drawableTerrain, listsPlaceholder } from './art'
import { refusal, run } from './commands'
import { encodePngWithCanvas } from './rgba'

const RECENTS_KEY = 'papercut:recents'
const REOPEN_KEY = 'papercut:reopen-last'
const MEMORY_FS_KEY = 'papercut:memory-fs'
/** The folder open when the page last ran, so a reload comes back to it. Cleared on close. */
const OPEN_FOLDER_KEY = 'papercut:open-folder'
/** Per folder, the map that was open there last, so opening a project comes back to it. */
const LAST_MAP_PREFIX = 'papercut:last-map:'
/** How long the browser's memory tree waits for writes to stop before it snapshots itself to localStorage. */
const SNAPSHOT_DELAY_MS = 300
/** Where the browser build keeps its projects: a folder tree that exists only in `localStorage`. */
export const MEMORY_PROJECTS_DIR = '/projects'
const SAMPLE_FOLDER = `${MEMORY_PROJECTS_DIR}/sample-valley`

export interface Session {
  readonly fs: ProjectFs
  readonly codec: ImageCodec
  /** The shell's native dialogs, or `null` in a browser, where a folder is chosen another way. */
  readonly dialogs: ShellDialogs | null
  /** The shell's native menu, or `null` in a browser. */
  readonly menu: ShellMenu | null
  /** When this session last wrote into the project folder, so a watch can tell its own writes from someone else's. */
  lastWriteAt: number
  /** What the last persistence failure said — the browser's storage refusing the memory tree — or `null`; read and cleared by whoever reports it. */
  persistFailure: string | null
  /** What is known about every map in the open project without opening it: size and the materials it uses. */
  readonly summaries: SummaryStore
  /** What the folder holds that the project does not list: image files under sheets/, for the library to offer. */
  readonly library: LibraryStore
}

/** The image files in the folder that no entry lists, as of the last open or reload; a store so the library follows it. */
export class LibraryStore {
  private unlisted: readonly string[] = []
  private readonly listeners = new Set<() => void>()
  get = (): readonly string[] => this.unlisted
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  set(unlisted: readonly string[]): void {
    this.unlisted = unlisted
    for (const listener of this.listeners) listener()
  }
}

/** One map of the project, as read off its file: enough for the menu and the Materials section without opening it. */
export interface MapSummary {
  readonly path: string
  readonly name: string
  readonly width: number
  readonly height: number
  /** The material ids its voxels and face overrides hold. */
  readonly materials: ReadonlySet<number>
}

/** A tiny external store React subscribes to: replaced whole when the project opens, per map as one is saved. */
export class SummaryStore {
  private list: readonly MapSummary[] = []
  private readonly listeners = new Set<() => void>()
  get = (): readonly MapSummary[] => this.list
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  set(list: readonly MapSummary[]): void {
    this.list = list
    for (const listener of this.listeners) listener()
  }
  put(summary: MapSummary): void {
    this.set(this.list.some((s) => s.path === summary.path) ? this.list.map((s) => (s.path === summary.path ? summary : s)) : [...this.list, summary])
  }
}

/** What a map's file says about it. */
export function summarise(path: string, doc: ReadonlyMapDoc): MapSummary {
  const materials = new Set<number>()
  let width = 0
  let height = 0
  for (const id of doc.structureOrder) {
    const s = doc.structures[id]
    if (!s || s.kind !== 'voxel') continue
    if (s.parent === null) {
      width = Math.max(width, s.size.width)
      height = Math.max(height, s.size.height)
    }
    for (const stack of Object.values(s.paint.faces)) {
      for (const slot of stack) {
        const m = slotMaterial(slot)
        if (m !== null) materials.add(m)
      }
    }
  }
  return { path, name: doc.name, width, height, materials }
}

/** The browser's PNG codec: the canvas encodes, an `Image` decodes. */
const canvasCodec: ImageCodec = {
  encode: encodePngWithCanvas,
  async decode(bytes) {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }))
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image()
        element.onload = () => resolve(element)
        element.onerror = () => reject(new Error('Could not decode the image.'))
        element.src = url
      })
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('2D canvas unavailable')
      ctx.drawImage(image, 0, 0)
      const data: RgbaImage['data'] = ctx.getImageData(0, 0, image.width, image.height).data
      return { width: image.width, height: image.height, data }
    } finally {
      URL.revokeObjectURL(url)
    }
  },
}

function storage(): Storage | null {
  try {
    return localStorage
  } catch {
    return null
  }
}

/** The in-memory folder tree, restored from `localStorage` and persisted once writes settle; a failure is kept for the session to report. */
function memoryFs(onFailure: (message: string) => void): MemoryFs {
  const store = storage()
  let fs: MemoryFs
  try {
    const saved = store?.getItem(MEMORY_FS_KEY)
    fs = saved ? MemoryFs.restore(saved) : new MemoryFs()
  } catch {
    fs = new MemoryFs()
  }
  let pending: ReturnType<typeof setTimeout> | undefined
  const persist = (): void => {
    pending = undefined
    try {
      store?.setItem(MEMORY_FS_KEY, fs.snapshot())
    } catch (error) {
      // Quota or a private window: the tree lives on in memory for the session, and the editor says so.
      onFailure(`This browser cannot keep the project: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  fs.onChange = () => {
    clearTimeout(pending)
    pending = setTimeout(persist, SNAPSHOT_DELAY_MS)
  }
  window.addEventListener('pagehide', () => {
    if (pending !== undefined) {
      clearTimeout(pending)
      persist()
    }
  })
  return fs
}

/** The session for this build: the shell's filesystem and dialogs when there is a shell, the memory tree otherwise. */
export async function createSession(): Promise<Session> {
  const shell = desktopShell()
  if (shell) return { fs: shell.fs, codec: canvasCodec, dialogs: shell.dialogs, menu: shell.menu ?? null, lastWriteAt: 0, persistFailure: null, summaries: new SummaryStore(), library: new LibraryStore() }
  const session: Session = { fs: new MemoryFs(), codec: canvasCodec, dialogs: null, menu: null, lastWriteAt: 0, persistFailure: null, summaries: new SummaryStore(), library: new LibraryStore() }
  const fs = memoryFs((message) => {
    session.persistFailure = message
  })
  ;(session as { fs: ProjectFs }).fs = fs
  // First run in a browser: the sample project, so there is something to open.
  if (!(await fs.exists(`${SAMPLE_FOLDER}/papercut.json`))) {
    const placeholder = generatePlaceholderTerrainSet(16)
    await createProjectFolder(fs, SAMPLE_FOLDER, { name: 'Sample Valley', texelDensity: 16, placeholder, firstMap: createSampleMap() }, canvasCodec)
  }
  return session
}

// --- recents ---------------------------------------------------------------

export function recents(): RecentProject[] {
  return parseRecents(storage()?.getItem(RECENTS_KEY) ?? null)
}

function saveRecents(list: readonly RecentProject[]): void {
  storage()?.setItem(RECENTS_KEY, JSON.stringify(list))
  void desktopShell()?.menu?.setRecents(list.map((r) => ({ name: r.name, folder: r.folder }))).catch(() => undefined)
}

export function reopenLast(): boolean {
  return storage()?.getItem(REOPEN_KEY) === '1'
}

export function setReopenLast(on: boolean): void {
  storage()?.setItem(REOPEN_KEY, on ? '1' : '0')
}

/** The folder that was open when the page last ran, or `null`: what a reload comes back to. */
export function openFolder(): string | null {
  return storage()?.getItem(OPEN_FOLDER_KEY) ?? null
}

function rememberOpen(folder: string | null): void {
  if (folder === null) storage()?.removeItem(OPEN_FOLDER_KEY)
  else storage()?.setItem(OPEN_FOLDER_KEY, folder)
}

function lastMapIn(folder: string): string | null {
  return storage()?.getItem(LAST_MAP_PREFIX + folder) ?? null
}

/** A write per path at a time: the autosave and an explicit save landing together cannot interleave on one file. */
const inFlight = new Map<string, Promise<unknown>>()
function queued<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = inFlight.get(path) ?? Promise.resolve()
  const next = previous.then(work, work)
  inFlight.set(path, next.catch(() => undefined))
  return next
}

// --- opening ---------------------------------------------------------------


/**
 * Put an opened project and its sheets in front of the editor: the map first — the one open there last, else the
 * first listed map that is in the folder — read and checked BEFORE the project is switched, so a project whose maps
 * cannot be read is refused whole rather than opened onto a placeholder that nothing would ever write.
 */
async function install(host: Host, session: Session, folder: string, opened: OpenedProject): Promise<void> {
  let project = opened.project
  const candidates = [lastMapIn(folder), ...project.maps].filter((p): p is string => p !== null && project.maps.includes(p))
  let path: string | null = null
  for (const candidate of candidates) {
    if (await session.fs.exists(joinPath(folder, candidate))) {
      path = candidate
      break
    }
  }
  let doc
  if (path === null) {
    // A project with no readable map is not one the editor made, but it is not refused: it gets a first map.
    doc = createMap(32, 32, project.name)
    const added = await addMap(session.fs, folder, project, doc)
    path = added.path
    project = added.project
  } else {
    try {
      doc = await readMap(session.fs, folder, path)
    } catch (error) {
      throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }
  const json = serialize(doc)
  const loaded = refusal(host.dispatch('project.load', { folder, json: serializeProject(project) }))
  if (loaded !== null) throw new Error(loaded)
  const why = refusal(host.dispatch('document.load', { json }))
  if (why !== null) {
    host.dispatch('project.close')
    throw new Error(`${path}: ${why}`)
  }
  host.dispatch('project.current', { map: path })
  rememberOpen(folder)
  publish(host, session, opened)
  saveRecents(remember(recents(), { name: project.name, folder, openedAt: Date.now() }))
  await refreshSummaries(host, session)
}

/** Read every listed map's file for its summary; the open map's comes from the document. A map that will not read is left out. */
export async function refreshSummaries(host: Host, session: Session): Promise<void> {
  const { folder, map, project } = host.children.project.getSnapshot().context
  if (folder === null) {
    session.summaries.set([])
    return
  }
  const list: MapSummary[] = []
  for (const path of project.maps) {
    if (path === map) {
      list.push(summarise(path, host.reader.doc))
      continue
    }
    try {
      list.push(summarise(path, await readMap(session.fs, folder, path)))
    } catch {
      // Reported by the open's warnings; nothing to summarise.
    }
  }
  session.summaries.set(list)
}

/** Whether an error says the thing is simply not there, as opposed to unreadable. */
function isMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\[ENOENT\]/.test(message)
}

/** Open the project in `folder`, saving the one that is open first. Throws with a message the startup screen shows; a folder that is not there is dropped from recents. */
export async function openProjectAt(host: Host, session: Session, folder: string): Promise<void> {
  let opened
  try {
    opened = await openProject(session.fs, folder, session.codec)
  } catch (error) {
    if (isMissing(error)) saveRecents(forget(recents(), folder))
    throw new Error(`Could not open ${folder}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (host.children.project.getSnapshot().context.folder !== null) await saveNow(host, session)
  await install(host, session, folder, opened)
}

export interface NewProjectSpec {
  folder: string
  name: string
  texelDensity: number
}

/** Create a project folder and open it. */
export async function createProjectAt(host: Host, session: Session, spec: NewProjectSpec): Promise<void> {
  const placeholder = generatePlaceholderTerrainSet(spec.texelDensity)
  const created = await createProjectFolder(session.fs, spec.folder, { name: spec.name, texelDensity: spec.texelDensity, placeholder }, session.codec)
  if (host.children.project.getSnapshot().context.folder !== null) await saveNow(host, session)
  await install(host, session, spec.folder, created)
}

function location(host: Host): { folder: string; map: string | null } {
  const { folder, map } = host.children.project.getSnapshot().context
  if (folder === null) throw new Error('No project is open.')
  return { folder, map }
}

/** Open one of the project's maps as the document, saving the one that was open first. */
export async function openMapAt(host: Host, session: Session, path: string): Promise<void> {
  const { folder, map } = location(host)
  // The open map is open: nothing to reload, and reloading it would drop the undo history.
  if (map === path) return
  if (map !== null) await saveNow(host, session)
  const doc = await readMap(session.fs, folder, path)
  const why = refusal(host.dispatch('document.load', { json: serialize(doc) }))
  if (why !== null) throw new Error(why)
  host.dispatch('project.current', { map: path })
  storage()?.setItem(LAST_MAP_PREFIX + folder, path)
}

/** A new, empty map in the project, listed last and opened. */
export async function newMapIn(host: Host, session: Session, name: string, width = 32, height = 32): Promise<void> {
  const { folder } = location(host)
  const project = host.children.project.getSnapshot().context.project
  const added = await addMap(session.fs, folder, project, createMap(width, height, name))
  host.dispatch('project.maps.set', { maps: added.project.maps })
  await openMapAt(host, session, added.path)
  session.summaries.put(summarise(added.path, host.reader.doc))
}

/** Write the document to its map file, and the project to its file. What the Save button and the autosave do. */
export async function saveNow(host: Host, session: Session): Promise<string> {
  const { folder, map } = location(host)
  session.lastWriteAt = Date.now()
  // Both writes start at once, the map's first: on `pagehide` the page may not live to see a second one begin.
  const project = host.children.project.getSnapshot().context.project
  const doc = host.reader.doc
  await Promise.all([
    map === null ? Promise.resolve() : queued(joinPath(folder, map), () => writeMap(session.fs, folder, map, doc)),
    queued(joinPath(folder, 'papercut.json'), () => writeProject(session.fs, folder, project)),
  ])
  if (map !== null) session.summaries.put(summarise(map, doc))
  return map ?? 'papercut.json'
}

/** Hand the viewport what an open or a reload loaded, and the library what it found unlisted. */
function publish(host: Host, session: Session, opened: OpenedProject): void {
  host.children.viewport.send({ type: 'terrain', sets: opened.sets, warning: opened.warnings.length ? opened.warnings.join('\n') : null })
  session.library.set(opened.unlisted)
}

/**
 * Reload the project's images from its folder into the viewport, after something in `sheets/` or in the list
 * changed. Opening may have refreshed a hash or relinked a moved file; the project actor takes that too, so the
 * file on disk and the project in memory say the same thing.
 */
async function reloadImages(host: Host, session: Session, folder: string): Promise<void> {
  const reopened = await openProject(session.fs, folder, session.codec)
  const current = host.children.project.getSnapshot().context.project
  if (JSON.stringify(current.images) !== JSON.stringify(reopened.project.images)) host.dispatch('project.images.set', { images: reopened.project.images })
  publish(host, session, reopened)
}

const entryOf = (host: Host, file: string): ImageEntry => {
  const entry = host.children.project.getSnapshot().context.project.images.find((i) => sheetName(i.path) === file)
  if (!entry) throw new Error(`${file} is not an image of this project.`)
  return entry
}

/** Write the project's image list as the actor now has it. */
async function writeImages(host: Host, session: Session, images: readonly ImageEntry[]): Promise<void> {
  const { folder } = location(host)
  session.lastWriteAt = Date.now()
  host.dispatch('project.images.set', { images })
  await writeProject(session.fs, folder, host.children.project.getSnapshot().context.project)
}

/** A picked file's pixels, decoded now so the import dialog can show them and offer the sizes that fit. */
export async function inspectImageFile(session: Session, file: File): Promise<{ bytes: Uint8Array; image: RgbaImage }> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  return { bytes, image: await session.codec.decode(bytes) }
}

export interface ImportSpec {
  /** The file name it goes by in `sheets/`: its identity. */
  file: string
  bytes: Uint8Array
  grid: Grid
  name?: string
  kind?: ImageKind
}

/** Copy an image into the project's `sheets/` and list it with its grid — Import image…, a drop, Replace image… and Relink… all end here. Reloads what the viewport draws with. */
export async function importImage(host: Host, session: Session, spec: ImportSpec): Promise<void> {
  const { folder } = location(host)
  const project = host.children.project.getSnapshot().context.project
  session.lastWriteAt = Date.now()
  const next = await addImage(session.fs, folder, project, { file: spec.file, bytes: spec.bytes, grid: spec.grid, ...(spec.name === undefined ? {} : { name: spec.name }), ...(spec.kind === undefined ? {} : { kind: spec.kind }) })
  host.dispatch('project.images.set', { images: next.images })
  await reloadImages(host, session, folder)
}

export interface TemplateSpec {
  /** The file it is written as, in `sheets/`. */
  file: string
  name: string
  convention: string
  /** The materials it lays out, by id, in the convention's order. */
  materials: readonly number[]
}

/**
 * Write a template image for a convention and list it, its layout and all (ruling of 2026-09-17).
 *
 * The image is drawn at the project's density with every block of the convention in place, so the
 * sheet an artist opens already says what belongs in each cell — and, because its entry carries the
 * layout rather than hundreds of tags, every corner it covers is answered before a pixel is drawn.
 *
 * The blocks are of MATERIALS (ruling of 2026-09-17), so the template is drawn in their swatches and
 * its tags name them. Placing one is the automation a transition is: the tags it writes are the
 * transition, and there is nothing else kept beside them.
 */
export async function newTemplateImage(host: Host, session: Session, spec: TemplateSpec): Promise<{ columns: number; rows: number }> {
  const { folder } = location(host)
  const project = host.children.project.getSnapshot().context.project
  const convention = conventionOf(spec.convention)
  if (!convention) throw new Error(`No layout convention called ${spec.convention}.`)
  if (project.images.some((i) => sheetName(i.path) === spec.file)) throw new Error(`An image called ${spec.file} is already listed.`)
  const tile = project.resolution.texelDensity
  const swatch = (id: number): string => `#${(project.materials.find((m) => m.id === id)?.color ?? 0x808080).toString(16).padStart(6, '0')}`
  const template = renderTemplate(spec.convention, spec.materials.map((id) => ({ id, color: swatch(id) })), { tile })
  session.lastWriteAt = Date.now()
  const next = await addImage(session.fs, folder, project, {
    file: spec.file,
    bytes: await session.codec.encode(template.image),
    grid: plainGrid(tile),
    name: spec.name,
    kind: 'tileset',
    layout: { convention: spec.convention, origin: { x: 0, y: 0 }, materials: [...spec.materials] },
    terrain: { tiles: {} },
  })
  host.dispatch('project.images.set', { images: next.images })
  await reloadImages(host, session, folder)
  return { columns: template.columns, rows: template.rows }
}

/** List a file already in `sheets/` — one the library found unlisted — with its grid, without copying it. */
export async function listUnlistedImage(host: Host, session: Session, path: string, grid: Grid, name?: string): Promise<void> {
  const { folder } = location(host)
  const project = host.children.project.getSnapshot().context.project
  session.lastWriteAt = Date.now()
  const next = await listImage(session.fs, folder, project, path, grid, name === undefined ? {} : { name })
  host.dispatch('project.images.set', { images: next.images })
  await reloadImages(host, session, folder)
}

/**
 * Change what the project says about an image: its name, its kind, its grid.
 *
 * A grid change takes the TAGS with it: a tag belongs to the pixels of the tile it was put on, not
 * to an index, so every tag is moved to whichever tile of the new grid starts on the same pixel
 * (`remapTags`). Changing a margin or a spacing — the change an artist actually makes, on noticing
 * a gutter — shifts every tile alike and so loses nothing. A tag the new grid has no tile for is
 * dropped, and the count comes back so the caller can say so. The images reload either way, since
 * the tiles are cut by the grid.
 */
export async function setImageProps(host: Host, session: Session, file: string, changes: Partial<Pick<ImageEntry, 'name' | 'kind' | 'grid'>>): Promise<{ moved: number; dropped: number } | null> {
  const { folder } = location(host)
  const entry = entryOf(host, file)
  let moved: { moved: number; dropped: number } | null = null
  let next: ImageEntry = { ...entry, ...changes }
  if (changes.grid !== undefined && Object.keys(entry.terrain.tiles).length > 0) {
    const loaded = host.children.viewport.getSnapshot().context.loadedTerrain.find((s) => s.set.sheet === file)
    const source = loaded?.source ?? loaded?.image
    if (source) {
      const remapped = remapTags(entry.terrain, entry.grid, changes.grid, source.width, source.height)
      next = { ...next, terrain: remapped.terrain }
      moved = { moved: remapped.moved, dropped: remapped.dropped }
    }
  }
  const images = host.children.project.getSnapshot().context.project.images.map((i) => (sheetName(i.path) === file ? next : i))
  await writeImages(host, session, images)
  if (changes.grid !== undefined) await reloadImages(host, session, folder)
  return moved
}

/** Write an image's terrain set into its entry, and swap the set in over its pixels: what every stroke of the tagger does. */
export async function setImageTerrain(host: Host, session: Session, file: string, set: TerrainSet): Promise<void> {
  const { folder } = location(host)
  const entry = entryOf(host, file)
  const images = host.children.project.getSnapshot().context.project.images.map((i) => (sheetName(i.path) === file ? { ...entry, terrain: terrainOf(set) } : (i)))
  await writeImages(host, session, images)
  // The one set, swapped in over its image: no other image is re-read for a tag.
  const { loadedTerrain, terrainWarning } = host.children.viewport.getSnapshot().context
  const swapped = loadedTerrain.some((s) => s.set.sheet === file)
  if (swapped) host.children.viewport.send({ type: 'terrain', sets: loadedTerrain.map((s) => (s.set.sheet === file ? { ...s, set: { ...set, sheet: file } } : s)), warning: terrainWarning })
  else await reloadImages(host, session, folder)
}

/** Take an image off the project's list. The file stays in the folder, and shows as unlisted; the materials that pointed into it draw from the placeholder or as colour. */
export async function unlistImage(host: Host, session: Session, file: string): Promise<void> {
  const { folder } = location(host)
  const images = host.children.project.getSnapshot().context.project.images.filter((i) => sheetName(i.path) !== file).map((i) => i)
  await writeImages(host, session, images)
  await reloadImages(host, session, folder)
}

/** Replace a listed image's file with a picked one, keeping its name, grid and terrain set, so every material and tag pointing at it still holds. Also how a missing file is relinked from outside the folder. */
export async function replaceImageFile(host: Host, session: Session, file: string, picked: File): Promise<void> {
  const entry = entryOf(host, file)
  const bytes = new Uint8Array(await picked.arrayBuffer())
  await session.codec.decode(bytes)
  await importImage(host, session, { file, bytes, grid: entry.grid })
}

/** Point a listed image whose file is missing at a file already in the folder — one the library found unlisted — keeping everything the entry knows. */
export async function relinkImage(host: Host, session: Session, file: string, path: string): Promise<void> {
  const { folder } = location(host)
  const entry = entryOf(host, file)
  const hash = await hashBytes(await session.fs.readFile(joinPath(folder, path)))
  const images = host.children.project.getSnapshot().context.project.images.map((i) => (sheetName(i.path) === file ? { ...entry, path, hash } : (i)))
  await writeImages(host, session, images)
  await reloadImages(host, session, folder)
}

/** Save, then close: back to the startup screen. A save that fails keeps the project open, and says so. */
export async function closeProject(host: Host, session: Session): Promise<void> {
  try {
    await saveNow(host, session)
  } catch (error) {
    throw new Error(`Not closed — the project could not be saved: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  host.dispatch('project.close')
  // The document too: a closed project's map must not linger to be written into the next one.
  host.dispatch('document.new', { width: 2, height: 2, name: 'No map' })
  rememberOpen(null)
  session.summaries.set([])
  session.library.set([])
  host.children.viewport.send({ type: 'terrain', sets: [], warning: null })
}

/** Show a path of the project in the OS's file browser. Nothing in a browser, where there is no folder to show. */
export async function revealInFolder(host: Host, path: string): Promise<void> {
  const reveal = desktopShell()?.reveal
  if (!reveal) throw new Error('There is no folder to show in a browser; the desktop app reveals files.')
  const { folder } = location(host)
  await reveal.reveal(joinPath(folder, path))
}

/** A face's layers with every `from` swapped for `to`, or `null` when none held it. */
function repainted(stack: Readonly<MaterialLayers>, from: number, to: number): MaterialLayers | null {
  if (!stack.some((slot) => slotMaterial(slot) === from)) return null
  return stack.map((slot) => (slotMaterial(slot) === from ? slotOf(to) : slot)) as MaterialLayers
}

/**
 * Take a material out of the library, repainting everything that uses it — in the open map through the document,
 * in every other map through its file — as `to`. The one edit that touches every map, so it is one call.
 */
export async function repaintAndDeleteMaterial(host: Host, session: Session, from: number, to: number): Promise<void> {
  const { folder, map, project } = host.children.project.getSnapshot().context
  if (folder === null) throw new Error('No project is open.')
  if (!project.materials.some((m) => m.id === to) || from === to) throw new Error('Pick another material to repaint with.')
  // The open map: one labelled edit, undoable like any stroke.
  const doc = host.reader.doc
  const patches: Patch[] = []
  for (const id of doc.structureOrder) {
    const s = doc.structures[id]
    if (!s || s.kind !== 'voxel') continue
    for (const [key, stack] of Object.entries(s.paint.faces)) {
      const next = repainted(stack, from, to)
      if (next) patches.push({ t: 'voxelPaint', id, layer: 'faces', key, value: next })
    }
  }
  if (patches.length > 0) host.children.document.send({ type: 'patch', label: 'Repaint material', patches })
  // Every other map: read, repaint, write.
  for (const path of project.maps) {
    if (path === map) continue
    let other: MapDoc
    try {
      other = await readMap(session.fs, folder, path)
    } catch {
      continue
    }
    let touched = false
    for (const id of other.structureOrder) {
      const s = other.structures[id]
      if (!s || s.kind !== 'voxel') continue
      for (const [key, stack] of Object.entries(s.paint.faces)) {
        const next = repainted(stack, from, to)
        if (next) {
          s.paint.faces[key] = next
          touched = true
        }
      }
    }
    if (touched) {
      session.lastWriteAt = Date.now()
      await queued(joinPath(folder, path), () => writeMap(session.fs, folder, path, other))
      session.summaries.put(summarise(path, other))
    }
  }
  host.dispatch('project.materials.set', { materials: project.materials.filter((m) => m.id !== from).map((m) => ({ ...m })) })
  await saveNow(host, session)
}

/** The open map as a `.glb`: into the project's `build/` in the desktop app, handed to the browser to save otherwise. */
export async function exportCurrentMap(host: Host, session?: Session): Promise<string> {
  const doc = host.reader.doc
  const project = host.children.project.getSnapshot().context.project
  // The same sets the stage draws with — the project's sheets, the generated placeholder standing in — so what is exported is what was seen.
  const art = artFor(project)
  const terrain = drawableTerrain(art.generatedTerrain, host.children.viewport.getSnapshot().context.loadedTerrain as readonly LoadedSet[], project.resolution.texelDensity, listsPlaceholder(project))
  const bytes = await exportGltf(doc, { merge: false, textures: art.textures, terrain, materials: project.materials, resolution: project.resolution, sprites: art.sprites, encodePng: encodePngWithCanvas })
  const file = `${doc.name.replace(/\s+/g, '-').toLowerCase()}.glb`
  const { folder } = host.children.project.getSnapshot().context
  if (session && desktopShell() && folder !== null) {
    await session.fs.mkdir(joinPath(folder, 'build'), { recursive: true })
    session.lastWriteAt = Date.now()
    await session.fs.writeFile(joinPath(folder, 'build', file), new Uint8Array(bytes))
    return `Exported build/${file} (${(bytes.byteLength / 1024).toFixed(0)} KB)`
  }
  const blob = new Blob([bytes], { type: 'model/gltf-binary' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = file
  link.click()
  URL.revokeObjectURL(url)
  return `Exported ${file} (${(blob.size / 1024).toFixed(0)} KB)`
}

/**
 * The shell's native menu, wired: its commands become the same session calls the page's own controls make, and it is
 * told whether a project is open. Recents reach it through `saveRecents`. No-op in a browser.
 */
export function installShellMenu(host: Host, session: Session): () => void {
  const { menu } = session
  if (!menu) return () => undefined
  const notify = (notice: string): void => run(host, 'view.set', { notice })
  const attempt = (work: Promise<unknown>): void => void work.catch((error: unknown) => notify(error instanceof Error ? error.message : String(error)))
  const onCommand = (command: MenuCommand): void => {
    const open = host.children.project.getSnapshot().context.folder !== null
    if (!open && (command.id === 'map.new' || command.id === 'file.save' || command.id === 'file.export' || command.id === 'project.settings' || command.id === 'project.close')) return
    switch (command.id) {
      case 'project.new':
        run(host, 'view.set', { dialog: 'new-project' })
        return
      case 'project.open':
        attempt(session.dialogs?.openFolder({ title: 'Open a project folder' }).then((folder) => (folder ? openProjectAt(host, session, folder) : undefined)) ?? Promise.resolve())
        return
      case 'project.openRecent':
        attempt(openProjectAt(host, session, command.folder))
        return
      case 'project.close':
        attempt(closeProject(host, session))
        return
      case 'map.new':
        run(host, 'view.set', { dialog: 'new-map' })
        return
      case 'file.save':
        attempt(saveNow(host, session).then(() => notify('Saved')))
        return
      case 'file.export':
        attempt(exportCurrentMap(host, session).then(notify))
        return
      case 'project.settings':
        run(host, 'view.set', { settings: 'general' })
        return
    }
  }
  const stopCommands = menu.onCommand(onCommand)
  void menu.setRecents(recents().map((r) => ({ name: r.name, folder: r.folder }))).catch(() => undefined)
  let open: boolean | null = null
  const state = host.children.project.subscribe((snapshot) => {
    const now = snapshot.context.folder !== null
    if (now === open) return
    open = now
    void menu.setState({ projectOpen: now }).catch(() => undefined)
  })
  void menu.setState({ projectOpen: host.children.project.getSnapshot().context.folder !== null }).catch(() => undefined)
  return () => {
    stopCommands()
    state.unsubscribe()
  }
}

/** Ignore a watch event this soon after the session's own write into the folder. */
const OWN_WRITE_WINDOW_MS = 1500
const WATCH_SETTLE_MS = 400

/**
 * Take the project file as it now is on disk into the open project, WITHOUT touching where it is or which map is
 * open: the settings are replaced one list at a time rather than through `project.load`, which would forget the
 * open map. The document itself is never touched — a map is its own file, edited on its own.
 */
async function reloadProject(host: Host, session: Session, folder: string): Promise<void> {
  const opened = await openProject(session.fs, folder, session.codec)
  const current = host.children.project.getSnapshot().context.project
  const next = opened.project
  const changed = (a: unknown, b: unknown): boolean => JSON.stringify(a) !== JSON.stringify(b)
  if (changed(current.name, next.name) || changed(current.resolution, next.resolution) || changed(current.camera, next.camera)) {
    host.dispatch('project.set', { name: next.name, resolution: next.resolution, camera: next.camera })
  }
  if (changed(current.materials, next.materials)) host.dispatch('project.materials.set', { materials: next.materials })
  if (changed(current.images, next.images)) host.dispatch('project.images.set', { images: next.images })
  if (changed(current.maps, next.maps)) {
    host.dispatch('project.maps.set', { maps: next.maps })
    await refreshSummaries(host, session)
  }
  publish(host, session, opened)
}

/**
 * Watch the open project's folder for a change made outside the app — an artist saving a sheet, a script rewriting
 * `papercut.json`, a file arriving in `sheets/` — and take it as it settles. The session's own writes are ignored
 * for a moment after each one, so this never chases its own tail.
 *
 * The project file is re-read into the open project; anything else under the folder reloads the images. The open
 * MAP is left alone either way: it is the document, held in memory with its undo history, and taking a file over it
 * would throw away work that is not on disk yet.
 *
 * Only where the filesystem can watch (the shell's); the memory tree has nothing outside it.
 */
export function watchProjectFolder(host: Host, session: Session): () => void {
  const watch = session.fs.watch?.bind(session.fs)
  if (!watch) return () => undefined
  let stop: (() => void) | null = null
  let watching: string | null = null
  let generation = 0
  let settle: ReturnType<typeof setTimeout> | undefined
  let wantsProject = false
  const start = (folder: string): void => {
    watching = folder
    const mine = ++generation
    watch(
      folder,
      (event) => {
        if (Date.now() - session.lastWriteAt < OWN_WRITE_WINDOW_MS) return
        // A map file changing under us is the one thing left alone: the open one is the document.
        const path = event.path ?? ''
        if (path.includes(`/${MAPS_DIR}/`) || path.endsWith('.map.json')) return
        wantsProject ||= path === '' || path.endsWith(PROJECT_FILE)
        clearTimeout(settle)
        settle = setTimeout(() => {
          const project = wantsProject
          wantsProject = false
          const work = project ? reloadProject(host, session, folder) : reloadImages(host, session, folder)
          void work
            .then(() => host.dispatch('view.set', { notice: project ? 'Project reloaded — it changed on disk' : 'Images reloaded — the folder changed' }))
            .catch(() => undefined)
        }, WATCH_SETTLE_MS)
      },
      { recursive: true },
    )
      .then((end) => {
        if (generation === mine) stop = end
        else end()
      })
      .catch(() => undefined)
  }
  const end = (): void => {
    clearTimeout(settle)
    wantsProject = false
    generation += 1
    stop?.()
    stop = null
    watching = null
  }
  const subscription = host.children.project.subscribe((snapshot) => {
    const { folder } = snapshot.context
    if (folder === watching) return
    end()
    if (folder !== null) start(folder)
  })
  const initial = host.children.project.getSnapshot().context.folder
  if (initial !== null) start(initial)
  return () => {
    subscription.unsubscribe()
    end()
  }
}

/** Every folder under the browser's projects directory that holds a project: what "Open…" offers when there is no shell dialog. */
export async function memoryProjects(session: Session): Promise<Array<{ folder: string; name: string }>> {
  if (!(await session.fs.exists(MEMORY_PROJECTS_DIR))) return []
  const found: Array<{ folder: string; name: string }> = []
  for (const entry of await session.fs.readDir(MEMORY_PROJECTS_DIR)) {
    if (entry.kind !== 'directory') continue
    const folder = `${MEMORY_PROJECTS_DIR}/${entry.name}`
    try {
      const { name } = JSON.parse(await session.fs.readTextFile(`${folder}/papercut.json`)) as { name?: string }
      found.push({ folder, name: typeof name === 'string' ? name : entry.name })
    } catch {
      // Not a project; not offered.
    }
  }
  return found
}
