/**
 * The workspace: what the artist had in hand, kept across a reload (the owner,
 * 2026-09-21: "it's frustrating to have to constantly re-select things").
 *
 * Two kinds of state, both on this machine, neither in the project:
 *
 *   the TOOLS    the active tool, Select's mode, element, footprint and Match,
 *                and every feature's parameters — the brush, the verb, the
 *                material in hand. One set, whatever project is open.
 *   each MAP     where the camera was, the layer view's range, and what was
 *                selected, kept per map and restored when that map opens.
 *
 * Restoring goes through the front door: the tools come back as the same
 * commands a panel would dispatch, ONE FIELD AT A TIME, so each is checked by
 * its own schema and a value a newer build no longer takes is dropped alone
 * rather than refusing the rest. A selection is checked against the map it
 * comes back to, and what the terrain no longer has is let go.
 *
 * Kept in `localStorage` like the preferences beside it; where that is not
 * available the workspace simply lasts the session.
 */

import { pruneRegion, structureOf } from '@papercut/document'
import type { Host, Selection } from '@papercut/editor-host'
import { commands } from '@papercut/registry'

const WORKSPACE_KEY = 'papercut:workspace'
/** How many maps' views are remembered; the least recently touched go first. */
const MAPS_KEPT = 24
/** Parameters that describe a gesture in flight, not a setting: a ramp being dragged out is not something to come back to. */
const TRANSIENT: ReadonlySet<string> = new Set(['rampRun'])

export interface SavedView {
  yaw: number
  pitch: number
  distance: number
  target: [number, number, number]
}

interface SavedMap {
  camera?: SavedView
  layers?: { lo: number; hi: number } | null
  selection?: Selection | null
  touched: number
}

interface Workspace {
  tools: Record<string, unknown>
  features: Record<string, Record<string, unknown>>
  view: Record<string, unknown>
  maps: Record<string, SavedMap>
}

const EMPTY: Workspace = { tools: {}, features: {}, view: {}, maps: {} }

function read(): Workspace {
  try {
    const raw = JSON.parse(localStorage.getItem(WORKSPACE_KEY) ?? 'null') as Partial<Workspace> | null
    if (!raw || typeof raw !== 'object') return { ...EMPTY }
    const object = (value: unknown): Record<string, never> => (value && typeof value === 'object' ? (value as Record<string, never>) : {})
    return { tools: object(raw.tools), features: object(raw.features), view: object(raw.view), maps: object(raw.maps) }
  } catch {
    return { ...EMPTY }
  }
}

let cached: Workspace | null = null
/** The map whose saved view has been put back: until it has, the view actor still holds the last map's selection, which is not this one's to save. */
let adopted: string | null = null
let pending: ReturnType<typeof setTimeout> | null = null

function workspace(): Workspace {
  cached ??= read()
  return cached
}

/**
 * Written a moment after a change, so dragging a scrub field or orbiting the camera is a few writes, not hundreds. A
 * write already on its way is left to land rather than put off: something that changes every frame — the first cut of
 * this put the save off for as long as the camera reported, which is always — must not be able to starve it.
 */
function changed(): void {
  pending ??= setTimeout(flush, 250)
}

function flush(): void {
  pending = null
  try {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(workspace()))
  } catch {
    // A private window, or a full store: the workspace holds for the session.
  }
}

/** The open map, as the workspace keys it: its project's folder and its path in it. `null` while none is open. */
export function mapKeyOf(host: Host): string | null {
  const { folder, map } = host.children.project.getSnapshot().context
  return folder !== null && map !== null ? `${folder}::${map}` : null
}

function mapEntry(key: string): SavedMap {
  const maps = workspace().maps
  const entry = (maps[key] ??= { touched: 0 })
  entry.touched = Date.now()
  const keys = Object.keys(maps)
  if (keys.length > MAPS_KEPT) for (const old of keys.sort((a, b) => maps[a].touched - maps[b].touched).slice(0, keys.length - MAPS_KEPT)) delete maps[old]
  return entry
}

/** The view settings worth coming back to; the rest of the view actor is the machine's preferences, a notice, an open dialog. */
const VIEW_KEPT = ['inspector', 'inspectorCollapsed', 'materialLayersShown', 'materialLayersOpen', 'levelOpen', 'gameCamera'] as const

/**
 * Bring the tools and the view back, and keep them from here on. Called once at boot, after the features are installed
 * (their commands have to exist to be dispatched) and before anything is drawn.
 */
export function installWorkspace(host: Host): void {
  // A fresh start, as a page load is: whatever an earlier host in this realm held is let go.
  cached = read()
  adopted = null
  const saved = workspace()
  for (const [key, value] of Object.entries(saved.tools)) host.dispatch('tools.set', { [key]: value })
  for (const [owner, params] of Object.entries(saved.features)) {
    // The command a feature's panels write its parameters with: the one of its owner's that ends `.params`.
    const command = commands.all().find((decl) => decl.id.endsWith('.params') && commands.ownerOf(decl.id) === owner)
    if (command) for (const [key, value] of Object.entries(params)) if (!TRANSIENT.has(key)) host.dispatch(command.id, { [key]: value })
  }
  for (const key of VIEW_KEPT) if (saved.view[key] !== undefined) host.dispatch('view.set', { [key]: saved.view[key] })

  host.children.tools.subscribe((snapshot) => {
    const { features, ...own } = snapshot.context
    const space = workspace()
    space.tools = own
    space.features = Object.fromEntries(Object.entries(features).map(([owner, params]) => [owner, Object.fromEntries(Object.entries(params).filter(([key]) => !TRANSIENT.has(key)))]))
    changed()
  })
  host.children.view.subscribe((snapshot) => {
    const space = workspace()
    space.view = Object.fromEntries(VIEW_KEPT.map((key) => [key, snapshot.context[key]]))
    // What is selected, and the layer view, belong to the map that is open.
    const key = mapKeyOf(host)
    if (key !== null && adopted === key) {
      const entry = mapEntry(key)
      entry.selection = snapshot.context.selection
      entry.layers = snapshot.context.layers
    }
    changed()
  })
  window.addEventListener('pagehide', flush)
}

/** Where the camera was on a map, to be put back when it opens; `null` for a map not seen before. */
export function savedCamera(key: string): SavedView | null {
  const camera = workspace().maps[key]?.camera
  const numbers = (values: unknown[]): boolean => values.every((v) => typeof v === 'number' && Number.isFinite(v))
  return camera && numbers([camera.yaw, camera.pitch, camera.distance]) && Array.isArray(camera.target) && camera.target.length === 3 && numbers(camera.target) ? camera : null
}

export function saveCamera(key: string, camera: SavedView): void {
  if (adopted !== key) return
  // The viewport reports its camera every frame; only a camera that has moved is news.
  const last = workspace().maps[key]?.camera
  if (last && last.yaw === camera.yaw && last.pitch === camera.pitch && last.distance === camera.distance && last.target.every((v, i) => v === camera.target[i])) return
  mapEntry(key).camera = camera
  changed()
}

/**
 * Put back what was selected on the map that has just opened, and its layer view. The selection is checked against
 * the map as it is now: an object or a structure that is gone is let go, and a region keeps what the terrain still has.
 */
export function adoptMap(host: Host, key: string): void {
  // Read first, and only then call the map adopted: putting the layer view back changes the view actor, and the save
  // hook above would write this map's selection over with the nothing the view still holds (it did, in the first cut).
  const entry = workspace().maps[key]
  const selection = entry?.selection ?? null
  const layers = entry?.layers
  adopted = null
  if (layers !== undefined) host.dispatch('view.set', { layers })
  host.dispatch('selection.select', { selection: stillThere(host, selection) })
  adopted = key
}

function stillThere(host: Host, selection: Selection | null): Selection | null {
  const doc = host.reader.doc
  switch (selection?.kind) {
    case 'object':
      return doc.objects[selection.id] ? selection : null
    case 'structure':
      return doc.structures[selection.id] ? selection : null
    case 'sketchPoint': {
      const sketch = structureOf(doc, selection.structure, 'sketch')
      return sketch?.points[selection.index] ? selection : null
    }
    case 'region': {
      const voxel = structureOf(doc, selection.structure, 'voxel')
      const kept = voxel ? pruneRegion(voxel, selection) : null
      return kept ? { kind: 'region', ...kept } : null
    }
    default:
      return null
  }
}
