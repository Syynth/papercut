/**
 * The stage: the canvas, the viewport that draws into it, and the overlays on
 * top of it.
 *
 * The one place that holds the `Viewport` object. Everything the viewport
 * reports — the surface under the pointer, the brush cells, the camera, the
 * frame stats — goes to the host's viewport actor, and the regions that show
 * it select from there; everything the viewport is told comes from the
 * actors, pushed in from here. Pointer-rate data never touches React state:
 * the hover highlight and brush preview go from the viewport actor straight
 * back into the viewport, and the status bar selects the one field it shows.
 *
 * Commands that move the camera (`viewport.frame`, `viewport.sweep`) arrive
 * as events the viewport actor emits, so the top bar and a keybinding reach
 * the camera without holding the viewport.
 */

import { useEffect, useMemo, useRef, type RefObject } from 'react'

import {
  HALF,
  MAX_HEIGHT,
  MIN_HEIGHT,
  MATERIAL_LAYERS,
  NO_WATER,
  frameOf,
  levelBounds,
  structureOf,
  toWorld,
  type MaterialDef,
  type ReadonlyMapDoc,
  type ReadonlyProjectDoc,
  type ReadonlyVoxel,
  type SurfaceAddress,
  columnHeights,
  slotMaterial,
} from '@papercut/document'
import {
  regionUnder,
  selectionSubject,
  useDocument,
  useDocumentSelector,
  useHost,
  useHostSelector,
  useProject,
  useToolsSelector,
  useViewSelector,
  useViewportSelector,
  type BrushCells,
  type Host,
} from '@papercut/editor-host'
import { currentSketch, sketchPointHeight } from '@papercut/feature-sketch'
// The brush preview draws the cells a terrain stroke will touch, so it calls the same function the stroke does. An app
// is the only thing that may import a feature (#35), and this file is an app.
import { rampRunCells, strokeCells } from '@papercut/feature-terrain'
import { chordFor, type Platform } from '@papercut/registry'
import { Kbd, LayerRange, MaterialLayers, Overlay, Pill, type MaterialLayerRow } from '@papercut/ui'
import { Viewport, type SketchOverlay } from '@papercut/viewport'

import { useArt } from './art'
import { run } from './commands'
import { mergeParams } from './params'

const NO_CELLS: BrushCells = []
const same = Object.is
const ALL_LAYERS = [true, true, true, true] as const
const isPlaying = (snapshot: { value: unknown }): boolean => snapshot.value === 'play'
const wholeDocument = (doc: ReadonlyMapDoc): ReadonlyMapDoc => doc
const atmosphereOf = (doc: ReadonlyMapDoc): ReadonlyMapDoc['atmosphere'] => doc.atmosphere
const materialsOf = (project: ReadonlyProjectDoc): readonly MaterialDef[] => project.materials
const filteringOf = (project: ReadonlyProjectDoc): 'nearest' | 'linear' => project.resolution.filtering

function firstVoxel(doc: ReadonlyMapDoc): ReadonlyVoxel | undefined {
  for (const id of doc.structureOrder) {
    const s = doc.structures[id]
    if (s && s.kind === 'voxel') return s
  }
  return undefined
}

/** The cells a terrain stroke at `surface` would touch, read off the live tool parameters and any open stroke's origin. */
function brushCellsAt(host: Host, surface: SurfaceAddress | null): BrushCells {
  const tools = host.children.tools.getSnapshot().context
  if (tools.tool !== 'terrain' || isPlaying(host.actor.getSnapshot())) return NO_CELLS
  const params = mergeParams(tools)
  // A ramp being dragged out previews its run, wherever the pointer is.
  if (params.rampRun) return rampRunCells(params.rampRun)
  if (!surface) return NO_CELLS
  const voxel = structureOf(host.reader.doc, surface.structure, 'voxel') ?? firstVoxel(host.reader.doc)
  return voxel ? strokeCells(voxel, params, surface, host.input.strokeOrigin()) : NO_CELLS
}

export function Stage({ platform }: { platform: Platform }) {
  const host = useHost()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewportRef = useRef<Viewport | null>(null)

  const playing = useHostSelector(isPlaying)
  const tool = useToolsSelector((snapshot) => snapshot.context.tool)
  const showGrid = useViewSelector((snapshot) => snapshot.context.showGrid)
  const showMissing = useViewSelector((snapshot) => snapshot.context.showMissing)
  const fallback = useViewSelector((snapshot) => snapshot.context.fallback)
  const paintingTerrain = useToolsSelector((snapshot) => snapshot.context.tool === 'terrain' && mergeParams(snapshot.context).terrainMode === 'paint')
  // Hiding a layer is part of painting: out of Paint mode, with the widget gone, every layer draws again.
  const layersShown = useViewSelector((snapshot) => snapshot.context.materialLayersShown)
  const materialLayers = paintingTerrain ? layersShown : ALL_LAYERS
  const gameCamera = useViewSelector((snapshot) => snapshot.context.gameCamera)
  const projection = useViewSelector((snapshot) => snapshot.context.projection)
  const selection = useViewSelector((snapshot) => snapshot.context.selection)
  const layers = useViewSelector((snapshot) => snapshot.context.layers)
  const atmosphere = useDocumentSelector(atmosphereOf, { equal: same })
  const art = useArt()
  const materials = useProject(materialsOf)
  const filtering = useProject(filteringOf)

  // What the viewport is constructed with; the effects below push every later change.
  const artRef = useRef(art)
  artRef.current = art
  const lookRef = useRef({ materials, filtering })
  lookRef.current = { materials, filtering }

  // --- lifecycle --------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observed = host.children.viewport
    // Pointer input is not a command: it goes straight to the host's gesture actor, which answers with what the press
    // turned out to be (#11).
    const viewport = new Viewport(canvas, host.reader, { terrain: artRef.current.terrain, sprites: artRef.current.sprites, textures: artRef.current.textures, materials: lookRef.current.materials, filtering: lookRef.current.filtering }, {
      onPointerDown: (press) => void host.input.pointerDown(press),
      onPointerMove: (motion) => host.input.pointerMove(motion),
      onPointerUp: (release) => host.input.pointerUp(release),
      onStrokeMove: (pick, modifiers) => host.input.strokeMove(pick, modifiers),
      carrying: () => host.input.carrying(),
      heldKeys: () => host.input.heldKeys(),
      onHover: (pick) => {
        observed.send({ type: 'hover', surface: pick.surface, cells: brushCellsAt(host, pick.surface) })
        // What a click here would take, under Select's region half; with ctrl held, what a double-click would.
        const range = host.children.view.getSnapshot().context.layers
        const span = range === null ? null : { lo: Math.floor(range.lo / 2), hi: Math.ceil(range.hi / 2) }
        const editing = !isPlaying(host.actor.getSnapshot()) && host.input.gesture() === 'none'
        viewportRef.current?.setOptions({ regionPreview: editing ? regionUnder(host.reader.doc, host.children.tools.getSnapshot().context, pick, span, host.input.heldKeys().has('control') ? 'whole' : false) : null })
      },
      onCameraChange: (camera) => observed.send({ type: 'camera', camera }),
      onStats: (stats) => observed.send({ type: 'stats', stats }),
      // The view cube's second click on the view the camera is already at: a view setting, not a document edit.
      onProjectionToggle: () => {
        const current = host.children.view.getSnapshot().context.projection
        void host.dispatch('view.set', { projection: current === 'perspective' ? 'orthographic' : 'perspective' })
      },
    })
    viewportRef.current = viewport
    observed.send({ type: 'renderer', software: viewport.softwareRenderer })

    // The hover highlight and the brush preview, from the actor straight back into the viewport: shown under the
    // terrain tool, and the preview only while editing.
    const pushHover = (): void => {
      const { hover } = observed.getSnapshot().context
      const terrain = host.children.tools.getSnapshot().context.tool === 'terrain'
      const editing = !isPlaying(host.actor.getSnapshot())
      // Recomputed here rather than read back from the actor: a parameter change (a ramp drag growing its run, `]`
      // widening the brush) moves the preview without the pointer moving.
      viewport.setOptions({ hover: terrain ? hover : null, brushPreview: terrain && editing ? brushCellsAt(host, hover) : NO_CELLS })
    }
    const subscriptions = [
      observed.subscribe(pushHover),
      host.children.tools.subscribe(pushHover),
      host.actor.subscribe(pushHover),
      observed.on('frame', () => viewport.frameMap()),
      observed.on('sweep', () => viewport.startSweep()),
    ]

    // Scripting hook: scripts/tour.mjs, probe.mjs and perf.mjs drive the real editor in a headless browser, and it is
    // handy from the console. Nothing in the app reads it (scripts/global.ts types it); `__host` is App's, since a
    // project can be open with no stage.
    const scripting = window as unknown as Record<string, unknown>
    scripting.__viewport = viewport
    viewport.frameMap()
    return () => {
      for (const subscription of subscriptions) subscription.unsubscribe()
      viewport.dispose()
      viewportRef.current = null
    }
  }, [host])

  // --- settings, pushed in ----------------------------------------------------
  // The play session is an actor the host spawns for the duration of play (#11); what the viewport needs from it is
  // where the character stands up, read at the transition.
  const play = useMemo(() => (playing ? host.playSession() : null), [host, playing])
  useEffect(() => {
    viewportRef.current?.setOptions({ showGrid, showMissing, fallback, materialLayers, gameCamera, projection, play, selection: selectionSubject(selection), region: selection?.kind === 'region' ? selection : null, layers })
  }, [showGrid, showMissing, fallback, materialLayers, gameCamera, projection, play, selection, layers])

  useEffect(() => {
    if (tool !== 'sketch') viewportRef.current?.setOptions({ sketch: null })
  }, [tool])

  useEffect(() => {
    viewportRef.current?.refreshAtmosphere()
  }, [atmosphere])

  useEffect(() => {
    viewportRef.current?.loadTerrain(art.terrain)
  }, [art.terrain])
  useEffect(() => {
    viewportRef.current?.loadSprites(art.sprites)
  }, [art.sprites])
  useEffect(() => {
    viewportRef.current?.setMaterials(materials)
  }, [materials])
  useEffect(() => {
    viewportRef.current?.setFiltering(filtering)
  }, [filtering])

  return (
    <>
      <canvas ref={canvasRef} className={`stage-canvas ${playing ? 'is-playing' : ''}`} />
      {tool === 'sketch' ? <SketchOverlaySync viewport={viewportRef} /> : null}
      <Overlay at="top-left">
        <LevelSize />
      </Overlay>
      {playing ? null : <EnvelopeWarning platform={platform} />}
      {playing || !paintingTerrain ? null : (
        <Overlay at="bottom-left">
          <MaterialLayersWidget />
        </Overlay>
      )}
      {playing ? null : (
        <Overlay at="right">
          <LayerSlider />
        </Overlay>
      )}
      {playing ? (
        <Overlay at="bottom-center">
          <Pill>
            <Kbd>WASD</Kbd> walk <Kbd>{chordFor('mode.edit', undefined, platform) ?? 'P'}</Kbd> stop
          </Pill>
        </Overlay>
      ) : (
        <Overlay at="bottom-right">
          <Pill>
            <span>
              <Kbd>⌥ drag</Kbd> orbit
            </span>
            <span>
              <Kbd>right drag</Kbd> pan
            </span>
            <span>
              <Kbd>scroll</Kbd> zoom
            </span>
          </Pill>
        </Overlay>
      )}
    </>
  )
}

/**
 * The sketch under the Sketch tool — being drawn, or selected — as the viewport draws it: its points in world space on
 * its cap. Mounted only under the Sketch tool, so the per-revision document read happens only there, and pushed by
 * content rather than identity: the overlay object is new every render, its key only when the sketch changed.
 */
function SketchOverlaySync({ viewport }: { viewport: RefObject<Viewport | null> }) {
  const doc = useDocument(wholeDocument)
  const tools = useToolsSelector((snapshot) => snapshot.context)
  const params = useMemo(() => mergeParams(tools), [tools])
  const selection = useViewSelector((snapshot) => snapshot.context.selection)

  const overlay = ((): SketchOverlay | null => {
    const sketch = currentSketch(doc, params, selection)
    if (!sketch) return null
    const frame = frameOf(doc, sketch.id)
    const y = sketchPointHeight(doc, sketch) + 0.05
    const points = sketch.points.map((p) => {
      const [x, z] = toWorld(frame, p.x, p.z)
      return [x, y, z] as const
    })
    const selected = selection?.kind === 'sketchPoint' && selection.structure === sketch.id ? selection.index : null
    return { structure: sketch.id, points, closed: sketch.closed, selected }
  })()
  const key = overlay ? `${overlay.structure}:${overlay.closed}:${overlay.selected}:${overlay.points.map((p) => p.join(',')).join(';')}` : ''
  const overlayRef = useRef(overlay)
  overlayRef.current = overlay

  useEffect(() => {
    viewport.current?.setOptions({ sketch: overlayRef.current })
  }, [key, viewport])
  return null
}

/**
 * What the open map holds on each material layer, bottom first: every material id that layer carries on any
 * face, most used first. Walks every face, so it is selected settled.
 */
function materialsByLayer(doc: ReadonlyMapDoc): number[][] {
  const counts = Array.from({ length: MATERIAL_LAYERS }, () => new Map<number, number>())
  for (const id of doc.structureOrder) {
    const s = doc.structures[id]
    if (!s || s.kind !== 'voxel') continue
    for (const stack of Object.values(s.paint.faces)) {
      stack.forEach((slot, layer) => {
        const m = slotMaterial(slot)
        if (m !== null) counts[layer].set(m, (counts[layer].get(m) ?? 0) + 1)
      })
    }
  }
  return counts.map((c) => [...c].sort((a, b) => b[1] - a[1]).map(([m]) => m))
}

const sameLayers = (a: number[][], b: number[][]): boolean => a.length === b.length && a.every((l, i) => l.length === b[i].length && l.every((m, j) => m === b[i][j]))

/** How many materials a layer's row names before it says how many more. */
const NAMED = 2

/**
 * The Material Layers widget (ruling of 2026-09-18): which layer painting goes to, which layers the stage draws, and
 * what each holds. The active layer is a terrain parameter, so the brush reads it; visibility is the view's.
 */
function MaterialLayersWidget() {
  const host = useHost()
  const active = useToolsSelector((snapshot) => mergeParams(snapshot.context).materialLayer)
  const shown = useViewSelector((snapshot) => snapshot.context.materialLayersShown)
  const open = useViewSelector((snapshot) => snapshot.context.materialLayersOpen)
  const materials = useProject(materialsOf)
  const held = useDocumentSelector(materialsByLayer, { equal: sameLayers, settled: true })
  const rows: MaterialLayerRow[] = held.map((ids, layer) => {
    const named = ids.map((id) => materials.find((m) => m.id === id)).filter((m): m is MaterialDef => m !== undefined)
    const summary = named.length === 0 ? 'empty' : named.slice(0, NAMED).map((m) => m.name).join(' · ') + (named.length > NAMED ? ` +${named.length - NAMED}` : '')
    return { summary, swatch: named[0] ? `#${named[0].color.toString(16).padStart(6, '0')}` : null, visible: shown[layer] }
  })
  return (
    <MaterialLayers
      rows={rows}
      active={active}
      open={open}
      onOpen={(next) => void run(host, 'view.set', { materialLayersOpen: next })}
      onSelect={(layer) => void run(host, 'terrain.params', { materialLayer: layer })}
      onToggle={(layer) => void run(host, 'view.set', { materialLayersShown: shown.map((v, i) => (i === layer ? !v : v)) })}
    />
  )
}

function levelSize(doc: ReadonlyMapDoc): string {
  const b = levelBounds(doc)
  return b ? `${Math.round(b.maxX - b.minX)} × ${Math.round(b.maxZ - b.minZ)}` : '—'
}

function LevelSize() {
  const size = useDocumentSelector(levelSize, { equal: same, settled: true })
  return (
    <Pill>
      <span className="ui-num">{size}</span>
    </Pill>
  )
}

function EnvelopeWarning({ platform }: { platform: Platform }) {
  const inBounds = useViewportSelector((snapshot) => snapshot.context.camera.inBounds)
  if (inBounds) return null
  return (
    <Overlay at="top-center">
      <Pill warn>
        Outside the game's camera envelope <Kbd>{chordFor('view.set', { gameCamera: true }, platform) ?? 'G'}</Kbd> clamps
      </Pill>
    </Overlay>
  )
}

/**
 * The tallest thing in the map, in half-tiles: the top of the layer view's slider. The map's own height rather than the
 * document's ceiling, which is ten times taller than any map here and made the slider useless.
 */
function tallestPoint(doc: ReadonlyMapDoc): number {
  let top = MIN_HEIGHT
  for (const id of doc.structureOrder) {
    const s = doc.structures[id]
    if (!s) continue
    const base = Math.round(frameOf(doc, id).y / HALF)
    if (s.kind === 'voxel') {
      for (const height of columnHeights(s)) if (base + height > top) top = base + height
      for (const water of s.water) if (water !== NO_WATER && base + water > top) top = base + water
    } else if (s.closed) top = Math.max(top, base + s.layers)
  }
  return top
}

/**
 * The layer view. The slider spans the map's own height with a little headroom (room to paint a layer above the top),
 * never the document's ceiling. `null` on the actor is the whole range, which is what the top of the slider means — so a
 * map that grows taller stays wholly visible.
 */
function LayerSlider() {
  const host = useHost()
  const tallest = useDocumentSelector(tallestPoint, { equal: same, settled: true })
  const range = useViewSelector((snapshot) => snapshot.context.layers)
  const top = Math.min(MAX_HEIGHT, Math.max(4, tallest + 2))
  const lo = range ? Math.min(range.lo, top) : MIN_HEIGHT
  const hi = range ? Math.min(range.hi, top) : top
  return (
    <LayerRange
      max={top}
      lo={lo}
      hi={hi}
      onChange={(next) => run(host, 'view.set', { layers: next.lo === MIN_HEIGHT && next.hi >= top ? null : next })}
    />
  )
}
