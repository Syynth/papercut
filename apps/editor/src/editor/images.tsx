/**
 * The Images section of Project settings: the image library (decisions of
 * 2026-09-17). Every image the project draws from, down the left with its
 * kind; the chosen one big in the middle with its grid drawn over it; what
 * the project knows about it — name, grid, terrain set, file — as a form
 * beside it, every control being what its value is. Files found in
 * `sheets/` that nothing lists sit at the foot of the list with Add.
 *
 * Importing — the button, a drop anywhere on the section, or Add on an
 * unlisted file — goes through one dialog: the picked pixels with the grid
 * drawn live, the tile sizes that fit offered beside a typed size, margin
 * and spacing as linked pairs, and what it comes to. A missing file is
 * recovered through a picker of the folder's unlisted files, ranked by
 * likeness of name, with Browse… to any file.
 *
 * An `.aseprite` file is an image like any other (decision-log 2026-09-19):
 * its visible layers flattened, at the frame the entry names. Its own grid
 * is what an import starts from, and a file with frames gets a Frame slider
 * that previews as it moves and commits when it is let go.
 *
 * Tilesets are worked through; Sprites, Textures and Animations are tabs
 * that say what they will hold. The section is the app's rather than a
 * package's for the reason the tagger is: the pixels live on the viewport.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'

import { sheetName, stemOf, type DeepReadonly, type Grid, type ImageEntry, type ImageKind, type RgbaImage } from '@papercut/document'
import { useHost, useProject } from '@papercut/editor-host'
import { conventionOf, conventions, fitsOf, gridCells, type LoadedSet } from '@papercut/geometry'
import { IMAGE_FILE, decodeImage } from '@papercut/project'
import { Action, Derived, Dialog, Field, FileButton, Library, LibraryGroup, LibraryItem, LibraryTab, Note, PairInput, Select, Slider, TextInput } from '@papercut/ui'

import { run } from './commands'
import { rgbaToCanvas, rgbaToDataUrl } from './rgba'
import { importImage, inspectImageFile, listUnlistedImage, newTemplateImage, relinkImage, replaceImageFile, revealInFolder, setImageProps, unlistImage, type Session } from './session'

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
/** A terrain's id from what it is called, the way a map's file name comes from its name. */
const slugOfTerrain = (name: string): string => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
const ZOOMS = [0.25, 0.5, 1, 2, 3, 4] as const
type Entry = DeepReadonly<ImageEntry>

const KIND_TITLES: Record<ImageKind, string> = { tileset: 'Tileset', sprites: 'Sprite sheet', texture: 'Texture' }

/** What the file pickers offer: anything the browser calls an image, and Aseprite's files, which it does not. */
const ACCEPT = 'image/png,image/*,.aseprite,.ase'

/** A loaded image's pixels as a data URL, once per image: the list's thumbnail and the picker's. */
const thumbs = new WeakMap<RgbaImage, string>()
export function thumbOf(loaded: LoadedSet): string {
  const image = loaded.source ?? loaded.image
  const known = thumbs.get(image)
  if (known) return known
  const url = rgbaToDataUrl(image)
  thumbs.set(image, url)
  return url
}

const canvases = new WeakMap<RgbaImage, HTMLCanvasElement>()
function canvasOf(image: RgbaImage): HTMLCanvasElement {
  const known = canvases.get(image)
  if (known) return known
  const canvas = rgbaToCanvas(image)
  canvases.set(image, canvas)
  return canvas
}

/** The image at `scale` with its grid drawn over it: the tiles' outlines, and the margin and gutters left bare. */
function drawGrid(canvas: HTMLCanvasElement, image: RgbaImage, grid: Grid, scale: number): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const width = Math.round(image.width * scale)
  const height = Math.round(image.height * scale)
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(canvasOf(image), 0, 0, width, height)
  const cells = gridCells(image.width, image.height, grid)
  if (cells.columns === 0 || cells.rows === 0) return
  const t = grid.tile * scale
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let r = 0; r < cells.rows; r++) {
    for (let c = 0; c < cells.columns; c++) {
      const x = (grid.margin.x + c * (grid.tile + grid.spacing.x)) * scale
      const y = (grid.margin.y + r * (grid.tile + grid.spacing.y)) * scale
      ctx.rect(x + 0.5, y + 0.5, t - 1, t - 1)
    }
  }
  ctx.stroke()
  // What the grid ignores, dimmed: past the last whole tile on the right and the bottom.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)'
  const usedX = (grid.margin.x + cells.columns * grid.tile + (cells.columns - 1) * grid.spacing.x) * scale
  const usedY = (grid.margin.y + cells.rows * grid.tile + (cells.rows - 1) * grid.spacing.y) * scale
  if (usedX < width) ctx.fillRect(usedX, 0, width - usedX, height)
  if (usedY < height) ctx.fillRect(0, usedY, usedX, height - usedY)
}

/** What a grid comes to on an image, in one line. */
function gridSummary(image: RgbaImage | null, grid: Grid, density: number): string {
  if (!image) return '—'
  const cells = gridCells(image.width, image.height, grid)
  if (cells.columns === 0 || cells.rows === 0) return `not even one ${grid.tile} px tile fits`
  const ignored = cells.ignored.x === 0 && cells.ignored.y === 0 ? 'nothing ignored' : `${[cells.ignored.x ? `${cells.ignored.x} px on the right` : null, cells.ignored.y ? `${cells.ignored.y} px at the bottom` : null].filter(Boolean).join(', ')} ignored`
  const scale = density / grid.tile
  return `${cells.columns} × ${cells.rows} tiles · ${ignored} · ${Number.isInteger(scale) ? `draws at ${scale}×` : `${grid.tile} does not divide ${density}`}`
}

/** Why a tile size will not do in this project, or `null`. */
function tileProblem(tile: number, density: number): string | null {
  if (!Number.isInteger(tile) || tile < 1) return 'A tile is a whole number of pixels.'
  if (tile > density) return `Larger than the project's ${density} px.`
  if (density % tile !== 0) return `${tile} does not divide the project's ${density} px, so it would resample.`
  return null
}

const zoomStep = (scale: number, by: 1 | -1): number => {
  const at = ZOOMS.reduce((best, z, i) => (Math.abs(z - scale) < Math.abs(ZOOMS[best] - scale) ? i : best), 0)
  return ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, at + by))]
}

/** A text field that commits on Enter or blur: a name is typed, then set, not set per keystroke. */
function CommitInput({ value, onCommit, placeholder, bad, mono }: { value: string; onCommit: (value: string) => void; placeholder?: string; bad?: boolean; mono?: boolean }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = (): void => {
    if (draft !== value) onCommit(draft)
  }
  return <input className={`ui-number-field ${bad ? 'is-bad' : ''}`} style={{ width: mono ? undefined : '100%', fontFamily: mono ? undefined : 'inherit' }} value={draft} placeholder={placeholder} onChange={(event) => setDraft(event.currentTarget.value)} onBlur={commit} onKeyDown={(event) => {
    event.stopPropagation()
    if (event.key === 'Enter') commit()
    if (event.key === 'Escape') setDraft(value)
  }} />
}

/** The grid's fields: a typed tile size with validation and the fits beside it, margin and spacing as pairs. Shared by the form and the import dialog. */
function GridFields({ grid, image, density, onChange }: { grid: Grid; image: RgbaImage | null; density: number; onChange: (grid: Grid) => void }) {
  const problem = tileProblem(grid.tile, density)
  const fits = image ? fitsOf(image.width, image.height, grid, density) : []
  const others = fits.filter((f) => f !== grid.tile)
  return (
    <>
      <Field label="Tile size">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <CommitInput mono value={String(grid.tile)} bad={problem !== null} onCommit={(text) => {
            const tile = Number(text)
            if (Number.isInteger(tile) && tile > 0) onChange({ ...grid, tile })
          }} />
          <span className="ui-pair-unit">px</span>
          {problem === null && image ? <span className="ui-tagger-hint" style={{ minHeight: 0 }}>{fits.includes(grid.tile) ? 'fits' : 'fits with leftover'}{others.length ? ` · ${others.slice(0, 3).join(', ')} ${others.length === 1 ? 'fits' : 'fit'} too` : ''}</span> : null}
        </div>
        {problem ? <div className="ui-library-warn">{problem}{fits.length ? ` ${fits.slice(0, 4).join(', ')} would fit.` : ''}</div> : null}
      </Field>
      <PairInput label="Margin" value={grid.margin} onChange={(margin) => onChange({ ...grid, margin })} />
      <PairInput label="Spacing" value={grid.spacing} onChange={(spacing) => onChange({ ...grid, spacing })} />
    </>
  )
}

/** The preview: the pixels with the grid drawn, on the checker ground, with a zoom control. */
function GridPreview({ image, grid, scale, onZoom, foot }: { image: RgbaImage | null; grid: Grid; scale: number; onZoom: (scale: number) => void; foot: ReactNode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas && image) drawGrid(canvas, image, grid, scale)
  }, [image, grid, scale])
  if (!image) return null
  return (
    <>
      <div className="ui-library-zoom">
        <Action title="−" disabled={scale <= ZOOMS[0]} onClick={() => onZoom(zoomStep(scale, -1))} />
        <span className="ui-tagger-pct">{Math.round(scale * 100)}%</span>
        <Action title="+" disabled={scale >= ZOOMS[ZOOMS.length - 1]} onClick={() => onZoom(zoomStep(scale, 1))} />
      </div>
      <canvas ref={canvasRef} />
      <div className="ui-tagger-foot">{foot}</div>
    </>
  )
}

// --- import ------------------------------------------------------------------------

interface Pending {
  /** Copy a picked file in, or list a file already in the folder. */
  mode: 'copy' | 'list'
  file: string
  path: string
  bytes: Uint8Array
  image: RgbaImage
  /** The grid the file itself describes (an `.aseprite`'s), which the dialog starts from when it fits the project. */
  fileGrid: Grid | null
  frames: number
}

/** One dialog for a picked file and for a file found in the folder: the grid over the pixels, then Add. */
function ImportDialog({ session, pending, density, taken, onClose }: { session: Session; pending: Pending; density: number; taken: readonly string[]; onClose: () => void }) {
  const host = useHost()
  const fits = fitsOf(pending.image.width, pending.image.height, { margin: { x: 0, y: 0 }, spacing: { x: 0, y: 0 } }, density)
  // The file's own grid when it has one that works here, so it is not entered twice (decision-log 2026-09-19).
  const fileGrid = pending.fileGrid !== null && tileProblem(pending.fileGrid.tile, density) === null && gridCells(pending.image.width, pending.image.height, pending.fileGrid).columns > 0 ? pending.fileGrid : null
  const [grid, setGrid] = useState<Grid>(fileGrid ?? { tile: fits.includes(density) ? density : (fits[0] ?? density), margin: { x: 0, y: 0 }, spacing: { x: 0, y: 0 } })
  const [name, setName] = useState(stemOf(pending.file))
  const [scale, setScale] = useState(pending.image.width > 600 ? 0.5 : 1)
  const [busy, setBusy] = useState(false)
  const problem = tileProblem(grid.tile, density)
  const cells = gridCells(pending.image.width, pending.image.height, grid)
  const clash = pending.mode === 'copy' && taken.includes(pending.file)
  const add = (): void => {
    setBusy(true)
    const work = pending.mode === 'copy' ? importImage(host, session, { file: pending.file, bytes: pending.bytes, grid, name: name.trim() || stemOf(pending.file) }) : listUnlistedImage(host, session, pending.path, grid, name.trim() || undefined)
    work
      .then(() => {
        run(host, 'view.set', { notice: `${name.trim() || stemOf(pending.file)} added to the project` })
        onClose()
      })
      .catch((error: unknown) => {
        setBusy(false)
        run(host, 'view.set', { notice: messageOf(error) })
      })
  }
  return (
    <Dialog opened onClose={onClose} title="Import image" description={[pending.path, `${pending.image.width} × ${pending.image.height}`, pending.frames > 1 ? `frame 1 of ${pending.frames}` : null].filter(Boolean).join(' · ')} width={760} footer={
      <>
        <Action title="Cancel" onClick={onClose} />
        <Action title="Add tileset" tone="accent" disabled={busy || problem !== null || cells.columns === 0 || cells.rows === 0} onClick={add} />
      </>
    }>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 260px', gap: 20, alignItems: 'start' }}>
        <div className="ui-library-stage" style={{ height: 360, borderRadius: 4, border: '1px solid var(--ui-line)' }}>
          <GridPreview image={pending.image} grid={grid} scale={scale} onZoom={setScale} foot={<>{grid.tile} px grid · {gridSummary(pending.image, grid, density)}</>} />
        </div>
        <div style={{ display: 'grid', gap: 12 }}>
          <GridFields grid={grid} image={pending.image} density={density} onChange={setGrid} />
          {fileGrid ? (
            <div className="ui-tagger-hint" style={{ minHeight: 0 }}>
              {grid === fileGrid ? 'The grid is the Aseprite file’s own.' : <button type="button" className="ui-action" onClick={() => setGrid(fileGrid)}>Use the file’s {fileGrid.tile} px grid</button>}
            </div>
          ) : null}
          {fits.length ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {fits.map((fit) => (
                <button key={fit} type="button" className={`ui-action ${fit === grid.tile ? 'is-accent' : ''}`} onClick={() => setGrid({ ...grid, tile: fit })}>
                  {fit} px · {density / fit}×
                </button>
              ))}
            </div>
          ) : null}
          <Field label="Name" hint={pending.mode === 'copy' ? `Copied into sheets/ as ${pending.file}, which is what tags and materials point at.` : `Listed in place as ${pending.path}.`}>
            <TextInput value={name} onChange={setName} placeholder={stemOf(pending.file)} />
          </Field>
          {clash ? <div className="ui-library-warn">An image called {pending.file} is already listed; adding replaces its file and keeps its name, grid and tags.</div> : null}
        </div>
      </div>
    </Dialog>
  )
}

/** Recover a listed image whose file is gone: the folder's unlisted files ranked by likeness of name, or any file. */
function RelinkDialog({ session, entry, unlisted, onClose }: { session: Session; entry: Entry; unlisted: readonly string[]; onClose: () => void }) {
  const host = useHost()
  const stem = stemOf(entry.path).toLowerCase()
  const likeness = (path: string): number => {
    const other = stemOf(path).toLowerCase()
    let n = 0
    while (n < stem.length && n < other.length && stem[n] === other[n]) n++
    return n + (other.includes(stem) || stem.includes(other) ? 100 : 0)
  }
  const candidates = [...unlisted].sort((a, b) => likeness(b) - likeness(a))
  const finish = (work: Promise<void>): void => {
    work
      .then(() => {
        run(host, 'view.set', { notice: `${entry.name} relinked` })
        onClose()
      })
      .catch((error: unknown) => run(host, 'view.set', { notice: messageOf(error) }))
  }
  return (
    <Dialog opened onClose={onClose} title={`Relink ${entry.name}`} description={`${entry.path} is not in the folder and nothing in sheets/ has its contents. Pick the file it is now, or browse for one; its name, grid and tags are kept.`} width={520} footer={
      <>
        <Action title="Cancel" onClick={onClose} />
        <FileButton icon="replace" title="Browse…" accept={ACCEPT} onFile={(file) => finish(replaceImageFile(host, session, sheetName(entry.path), file))} />
      </>
    }>
      {candidates.length === 0 ? <Note>No unlisted image files in sheets/.</Note> : (
        <div className="ui-library-list" style={{ padding: 0, maxHeight: 320 }}>
          {candidates.map((path) => (
            <LibraryItem key={path} name={sheetName(path)} meta={path} tone="muted" onClick={() => finish(relinkImage(host, session, sheetName(entry.path), path))} />
          ))}
        </div>
      )}
    </Dialog>
  )
}

/**
 * New tileset from a template: pick a convention and which materials it lays out, and papercut
 * draws the whole layout at the project's density (rulings of 2026-09-17). What comes back is an
 * image whose corners are already answered — the artist paints over the blocks rather than
 * tagging them.
 *
 * It picks from the project's MATERIALS rather than naming terrains, because a tag names a
 * material and there is nothing else for a block to be about. Drawing the template is what
 * creating a transition means: it writes the tags, and the tags are the whole record.
 */
function TemplateDialog({ session, density, taken, onClose, onMade }: { session: Session; density: number; taken: readonly string[]; onClose: () => void; onMade: (file: string) => void }) {
  const host = useHost()
  const materials = useProject((p) => p.materials)
  const [convention, setConvention] = useState(conventions()[0]?.id ?? '')
  const [name, setName] = useState('Terrain kit')
  const [chosenIds, setChosenIds] = useState<number[]>(() => materials.slice(0, 2).map((m) => m.id))
  const [busy, setBusy] = useState(false)
  const chosen = conventionOf(convention)
  const file = `${slugOfTerrain(name) || 'kit'}.png`
  const clash = taken.includes(file)
  const extent = chosen && chosenIds.length > 0 ? chosen.extent(chosenIds.length) : null
  const problem = clash ? `An image called ${file} is already listed.` : chosenIds.length === 0 ? 'Pick at least one material to lay out.' : null
  const toggle = (id: number): void => setChosenIds(chosenIds.includes(id) ? chosenIds.filter((x) => x !== id) : [...chosenIds, id])
  const make = (): void => {
    if (!chosen || problem) return
    setBusy(true)
    newTemplateImage(host, session, { file, name, convention, materials: chosenIds })
      .then((made) => {
        run(host, 'view.set', { notice: `${name} drawn: ${made.columns} × ${made.rows} tiles, ready to paint` })
        onMade(file)
        onClose()
      })
      .catch((error: unknown) => {
        setBusy(false)
        run(host, 'view.set', { notice: messageOf(error) })
      })
  }
  return (
    <Dialog opened onClose={onClose} title="New tileset from a template" description="Papercut draws the layout; you paint over it. Every corner these materials can make is a tile in the sheet, and tagged before you start." width={560} footer={
      <>
        <Action title="Cancel" onClick={onClose} />
        <Action title="Draw the template" tone="accent" disabled={busy || problem !== null || !chosen} onClick={make} />
      </>
    }>
      <Field label="Name" hint={`Written to sheets/${file} at the project's ${density} px.`}>
        <TextInput value={name} onChange={setName} placeholder="Terrain kit" />
      </Field>
      <Field label="Layout" hint={chosen?.note}>
        <Select value={convention} options={conventions().map((c) => ({ value: c.id, label: c.title }))} onChange={setConvention} />
      </Field>
      <Field label="Materials" hint="In the order you pick them, which is the order of the blocks.">
        <div style={{ display: 'grid', gap: 2 }}>
          {materials.map((m) => {
            const order = chosenIds.indexOf(m.id)
            return (
              <div key={m.id} className={`ui-tagger-item ${order >= 0 ? 'is-active' : ''}`}>
                <span className="ui-tagger-swatch" style={{ background: `#${m.color.toString(16).padStart(6, '0')}`, cursor: 'default' }} />
                <button type="button" className="ui-tagger-name" onClick={() => toggle(m.id)}>
                  {m.name}
                </button>
                <span className="ui-tagger-meta">{order >= 0 ? order + 1 : ''}</span>
              </div>
            )
          })}
        </div>
      </Field>
      {extent ? (
        <Derived label="Sheet">
          {extent.columns} × {extent.rows} tiles · {extent.columns * density} × {extent.rows * density} px
        </Derived>
      ) : null}
      {problem ? <div className="ui-library-warn">{problem}</div> : null}
      {chosenIds.length >= 5 ? <div className="ui-library-warn">{chosenIds.length} materials is a big sheet, and every one of them has to be drawn against every other. Four is usually plenty.</div> : null}
    </Dialog>
  )
}

// --- the section --------------------------------------------------------------------

type Tab = 'all' | ImageKind | 'animations'

export function ImagesSettings({ session, sets, warning, selected, onSelect }: { session: Session; sets: readonly LoadedSet[]; warning: string | null; selected: string | null; onSelect: (name: string | null) => void }) {
  const host = useHost()
  const project = useProject((p) => p)
  const unlisted = useSyncExternalStore(session.library.subscribe, session.library.get)
  const [tab, setTab] = useState<Tab>('all')
  const [zoom, setZoom] = useState<number | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [relinking, setRelinking] = useState<string | null>(null)
  const [templating, setTemplating] = useState(false)
  /** The frame the slider is on while it moves, and that frame's pixels once decoded; null when nothing is being scrubbed. */
  const [scrub, setScrub] = useState<{ file: string; frame: number; image: RgbaImage | null } | null>(null)
  const scrubBytes = useRef<{ path: string; bytes: Uint8Array } | null>(null)
  const queue = useRef<File[]>([])
  const density = project.resolution.texelDensity
  const warnings = useMemo(() => warning?.split('\n') ?? [], [warning])
  const notify = (notice: string): void => void run(host, 'view.set', { notice })

  const loadedFor = (entry: Entry): LoadedSet | undefined => sets.find((s) => s.set.sheet === sheetName(entry.path))
  const problemOf = (entry: Entry): string | null => {
    const file = sheetName(entry.path)
    const said = warnings.find((w) => w.startsWith(`${entry.path}:`) || w.startsWith(`${file}:`) || w.startsWith(`${file} is `))
    if (said) return said.slice(said.indexOf(':') + 1).trim() || said
    return loadedFor(entry) ? null : 'Not loaded'
  }
  const missing = (entry: Entry): boolean => !loadedFor(entry) && /ENOENT|not there|no such/i.test(problemOf(entry) ?? '')

  const shown = project.images.filter((i) => tab === 'all' || i.kind === tab)
  const chosen = project.images.find((i) => sheetName(i.path) === selected) ?? shown[0] ?? project.images[0]
  const loaded = chosen ? loadedFor(chosen) : undefined
  const scrubbing = scrub !== null && chosen !== undefined && scrub.file === sheetName(chosen.path) ? scrub : null
  const source = scrubbing?.image ?? loaded?.source ?? loaded?.image ?? null
  const frames = loaded?.frames ?? 1
  // The file may have changed on disk since it was read for scrubbing; a reload brings new pixels, so read again.
  useEffect(() => {
    scrubBytes.current = null
  }, [loaded])
  const scale = zoom ?? (source && source.width > 700 ? 1 : 2)
  const taken = project.images.map((i) => sheetName(i.path))

  // Files picked or dropped are imported one after another through the dialog.
  const nextPending = (): void => {
    const file = queue.current.shift()
    if (!file) return
    inspectImageFile(session, file)
      .then(({ bytes, decoded }) => setPending({ mode: 'copy', file: file.name, path: file.name, bytes, image: decoded.image, fileGrid: decoded.grid, frames: decoded.frames }))
      .catch((error: unknown) => {
        notify(`${file.name}: ${messageOf(error)}`)
        nextPending()
      })
  }
  const importFiles = (files: File[]): void => {
    queue.current.push(...files.filter((f) => /^image\//.test(f.type) || IMAGE_FILE.test(f.name)))
    if (!pending) nextPending()
  }
  const addUnlisted = (path: string): void => {
    session.fs
      .readFile(`${host.children.project.getSnapshot().context.folder ?? ''}/${path}`)
      .then(async (bytes) => {
        const decoded = await decodeImage(session.codec, bytes)
        setPending({ mode: 'list', file: sheetName(path), path, bytes, image: decoded.image, fileGrid: decoded.grid, frames: decoded.frames })
      })
      .catch((error: unknown) => notify(`${path}: ${messageOf(error)}`))
  }
  const closePending = (): void => {
    setPending(null)
    setTimeout(nextPending, 0)
  }

  const change = (entry: Entry, changes: Partial<Pick<ImageEntry, 'name' | 'kind' | 'grid'>>): void => {
    setImageProps(host, session, sheetName(entry.path), changes)
      .then((moved) => {
        // The tags came with the grid; only a loss is worth saying out loud.
        if (moved && moved.dropped > 0) notify(`Grid changed — ${moved.moved} ${moved.moved === 1 ? 'tag' : 'tags'} moved with it, ${moved.dropped} had no tile on the new grid and ${moved.dropped === 1 ? 'was' : 'were'} dropped.`)
      })
      .catch((error: unknown) => notify(messageOf(error)))
  }
  const tagged = chosen ? Object.keys(chosen.terrain.tiles).length : 0

  /** Show frame `frame` of the entry's file on the stage without committing it: the file is read once, each frame decoded as the slider reaches it. */
  const scrubTo = (entry: Entry, frame: number): void => {
    const file = sheetName(entry.path)
    setScrub((was) => ({ file, frame, image: was?.file === file ? was.image : null }))
    const cached = scrubBytes.current
    const read = cached?.path === entry.path ? Promise.resolve(cached.bytes) : session.fs.readFile(`${host.children.project.getSnapshot().context.folder ?? ''}/${entry.path}`)
    read
      .then(async (bytes) => {
        scrubBytes.current = { path: entry.path, bytes }
        const decoded = await decodeImage(session.codec, bytes, frame)
        setScrub((now) => (now?.file === file && now.frame === frame ? { ...now, image: decoded.image } : now))
      })
      .catch((error: unknown) => notify(messageOf(error)))
  }
  const commitFrame = (entry: Entry, frame: number): void => {
    if (frame === entry.frame) {
      setScrub(null)
      return
    }
    setImageProps(host, session, sheetName(entry.path), { frame })
      .then(() => setScrub(null))
      .catch((error: unknown) => notify(messageOf(error)))
  }

  const tabs = (
    <>
      <LibraryTab title="All" active={tab === 'all'} onClick={() => setTab('all')} />
      <LibraryTab title="Tilesets" active={tab === 'tileset'} onClick={() => setTab('tileset')} />
      <LibraryTab title="Sprites" soon active={tab === 'sprites'} onClick={() => setTab('sprites')} />
      <LibraryTab title="Textures" soon active={tab === 'texture'} onClick={() => setTab('texture')} />
      <LibraryTab title="Animations" soon active={tab === 'animations'} onClick={() => setTab('animations')} />
    </>
  )
  const side = (
    <>
      <div className="ui-library-list">
        {shown.map((entry) => {
          const set = loadedFor(entry)
          const problem = problemOf(entry)
          const size = set?.source ? `${set.source.width} × ${set.source.height}` : null
          const frameCount = set?.frames !== undefined && set.frames > 1 ? `${set.frames} frames` : null
          const scaleOf = density / entry.grid.tile
          return (
            <LibraryItem
              key={entry.path}
              thumb={set ? thumbOf(set) : undefined}
              name={entry.name}
              badge={tab === 'all' ? entry.kind : undefined}
              meta={problem ?? [sheetName(entry.path), size, frameCount, `${entry.grid.tile} px`, Number.isInteger(scaleOf) && scaleOf !== 1 ? `${scaleOf}×` : null].filter(Boolean).join(' · ')}
              tone={problem ? 'warn' : 'ok'}
              dim={problem !== null}
              active={chosen === entry}
              onClick={() => onSelect(sheetName(entry.path))}
            />
          )
        })}
        {shown.length === 0 && tab !== 'animations' ? <Note>{tab === 'all' ? 'No images listed. Import one, or drop it here.' : `No ${tab === 'tileset' ? 'tilesets' : tab === 'sprites' ? 'sprite sheets' : 'textures'} yet.`}</Note> : null}
        {tab === 'animations' ? <Note>Frame sequences over a sprite or a texture — names, frame lists, rates. Comes with the sprite work.</Note> : null}
        {unlisted.length > 0 && (tab === 'all' || tab === 'tileset') ? (
          <>
            <LibraryGroup>In sheets/, not listed</LibraryGroup>
            {unlisted.map((path) => (
              <LibraryItem key={path} name={sheetName(path)} meta={path} dim trailing={<Action title="Add…" onClick={() => addUnlisted(path)} />} />
            ))}
          </>
        ) : null}
      </div>
      <div className="ui-library-foot" style={{ display: 'grid', gap: 6 }}>
        <Action title="New from template…" tone="accent" onClick={() => setTemplating(true)} />
        <FileButton icon="plus" title="Import image…" accept={ACCEPT} multiple onFiles={importFiles} />
      </div>
    </>
  )
  const stage = chosen ? (
    loaded && source ? (
      <GridPreview image={source} grid={chosen.grid} scale={scale} onZoom={setZoom} foot={<>{gridSummary(source, chosen.grid, density)}</>} />
    ) : (
      <div style={{ padding: 20, display: 'grid', gap: 12, alignContent: 'start' }}>
        <Note tone="warn">{problemOf(chosen) ?? 'Not loaded'}</Note>
        <div style={{ display: 'flex', gap: 6 }}>
          {missing(chosen) ? <Action title="Relink…" tone="accent" onClick={() => setRelinking(sheetName(chosen.path))} /> : null}
          <FileButton icon="replace" title="Replace image…" accept={ACCEPT} onFile={(file) => void replaceImageFile(host, session, sheetName(chosen.path), file).then(() => notify(`${chosen.name} replaced`)).catch((error: unknown) => notify(messageOf(error)))} />
        </div>
      </div>
    )
  ) : null
  const form = chosen ? (
    <>
      <Field label="Name" hint="What the app calls it. The file below is what tags and materials point at.">
        <CommitInput value={chosen.name} onCommit={(name) => (name.trim() ? change(chosen, { name: name.trim() }) : undefined)} />
      </Field>
      <Field label="Kind">
        <Select value={chosen.kind} options={(['tileset', 'sprites', 'texture'] as const).map((k) => ({ value: k, label: KIND_TITLES[k] }))} onChange={(kind) => change(chosen, { kind })} />
      </Field>
      {frames > 1 ? (
        <Field label="Frame" hint="The frame of the Aseprite file the project draws.">
          <Slider
            value={(scrubbing?.frame ?? Math.min(chosen.frame, frames - 1)) + 1}
            min={1}
            max={frames}
            onChange={(shown) => scrubTo(chosen, shown - 1)}
            onChangeEnd={(shown) => commitFrame(chosen, shown - 1)}
            format={(shown) => `${shown} of ${frames}`}
          />
        </Field>
      ) : null}
      <div className="ui-k">Grid</div>
      <GridFields grid={chosen.grid} image={source} density={density} onChange={(grid) => change(chosen, { grid })} />
      <div style={{ display: 'grid', gap: 6, marginTop: 2 }}>
        <Derived label="Scale">{Number.isInteger(density / chosen.grid.tile) ? `${density / chosen.grid.tile}×` : '—'}</Derived>
        <Derived label="Tiles">{source ? `${gridCells(source.width, source.height, chosen.grid).columns} × ${gridCells(source.width, source.height, chosen.grid).rows}` : '—'}</Derived>
        <Derived label="Ignored">{source ? (() => {
          const c = gridCells(source.width, source.height, chosen.grid)
          return c.ignored.x === 0 && c.ignored.y === 0 ? 'none' : `${c.ignored.x} × ${c.ignored.y} px`
        })() : '—'}</Derived>
      </div>
      {chosen.layout ? (
        <>
          <div className="ui-k">Layout</div>
          <Derived label="Convention">{conventionOf(chosen.layout.convention)?.title ?? chosen.layout.convention}</Derived>
          <Derived label="Materials">{chosen.layout.materials.length}</Derived>
          <div className="ui-tagger-hint" style={{ minHeight: 0 }}>Its tags come from the layout; anything tagged in the editor is kept on top.</div>
        </>
      ) : null}
      <div className="ui-k">Tags</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12 }}>
        <span style={{ color: 'var(--ui-ink-2)' }}>{tagged === 0 ? 'nothing tagged yet' : `${tagged} ${tagged === 1 ? 'tile' : 'tiles'} tagged`}</span>
        <Action title="Tag tiles ›" onClick={() => run(host, 'view.set', { settings: 'terrains' })} />
      </div>
      <div className="ui-k">File</div>
      <div className="ui-tagger-hint" style={{ minHeight: 0 }}>
        <code>{chosen.path}</code>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <FileButton icon="replace" title="Replace…" accept={ACCEPT} onFile={(file) => void replaceImageFile(host, session, sheetName(chosen.path), file).then(() => notify(`${chosen.name} replaced`)).catch((error: unknown) => notify(messageOf(error)))} />
        {session.dialogs ? <Action title="Reveal in Finder" onClick={() => void revealInFolder(host, chosen.path).catch((error: unknown) => notify(messageOf(error)))} /> : null}
        <Action title="Remove" tone="danger" onClick={() => void unlistImage(host, session, sheetName(chosen.path)).then(() => onSelect(null)).catch((error: unknown) => notify(messageOf(error)))} />
      </div>
      <div className="ui-tagger-hint" style={{ minHeight: 0 }}>Removing keeps the file in the folder, where it shows as unlisted; materials that point into it draw in their swatch colour until it is listed again.</div>
    </>
  ) : (
    <Note>Nothing chosen.</Note>
  )
  const relinkEntry = relinking ? project.images.find((i) => sheetName(i.path) === relinking) : undefined
  return (
    <>
      <Library tabs={tabs} side={side} stage={stage} form={form} onDropFiles={importFiles} />
      {pending ? <ImportDialog session={session} pending={pending} density={density} taken={taken} onClose={closePending} /> : null}
      {relinkEntry ? <RelinkDialog session={session} entry={relinkEntry} unlisted={unlisted} onClose={() => setRelinking(null)} /> : null}
      {templating ? <TemplateDialog session={session} density={density} taken={taken} onClose={() => setTemplating(false)} onMade={onSelect} /> : null}
    </>
  )
}
