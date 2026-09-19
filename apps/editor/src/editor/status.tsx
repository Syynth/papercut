/**
 * The status bar: what the pointer and modifiers do under the current tool,
 * and the readouts — the hovered surface, unpainted faces, the layer range, the
 * camera, frame stats, and what undo would undo.
 *
 * Each readout is its own component selecting its own value, because they
 * change at very different rates: the hovered surface at pointer rate, the
 * camera while orbiting, the stats twice a second, unpainted faces once per
 * edit. Before, all of them were the whole editor's state, and each of those
 * changes re-rendered everything.
 */

import { useMemo, useSyncExternalStore } from 'react'

import { SURFACE_CLIFF, SURFACE_SKETCH_CAP, SURFACE_SKETCH_WALL, describeSurface, exposedFacesOf, type ReadonlyMapDoc } from '@papercut/document'
import { sameSurface, useDocumentSelector, useHost, useToolsSelector, useViewSelector, useViewportSelector } from '@papercut/editor-host'
import { Hint, StatusHints, StatusRight } from '@papercut/ui'

import { run } from './commands'
import { mergeParams, type EditorParams } from './params'

/** The snap-off modifier as the status bar names it: Cmd on a Mac, Ctrl elsewhere (the viewport folds both into `ctrl`). */
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'ctrl'

/** The status bar's hints per tool: what the pointer and the modifiers do right now. */
export function hintsFor(params: EditorParams): ReadonlyArray<{ kbd?: string; text: string }> {
  switch (params.tool) {
    case 'select':
      return [
        { kbd: 'click', text: 'select what is under it' },
        { kbd: 'drag', text: 'move it' },
        { kbd: '⇧ drag', text: 'along one axis' },
        { kbd: MOD, text: 'no snapping' },
        { kbd: '← →', text: 'nudge a cell' },
        { kbd: '⌥ click', text: 'pick up a sprite' },
      ]
    case 'object':
      return [
        { kbd: 'click', text: `place ${params.spriteName}` },
        { kbd: 'drag', text: 'move what you placed' },
        { kbd: MOD, text: 'no snapping' },
        { kbd: '⇧ click', text: 'place nothing' },
      ]
    case 'terrain':
      if (params.terrainMode === 'sculpt') {
        switch (params.sculptVerb) {
          case 'raise':
            return [
              { kbd: 'drag', text: `raise by ${params.strength}` },
              { kbd: '⇧ drag', text: 'lower' },
              { kbd: '⌥ click', text: 'pick up a height' },
            ]
          case 'flatten':
            return [
              { kbd: 'drag', text: params.heightPinned ? `flatten to ${params.height}` : 'flatten to the pressed height' },
              { kbd: '⌥ click', text: 'pick up a height and pin it' },
            ]
          case 'smooth':
            return [{ kbd: 'drag', text: `smooth by up to ${params.strength}` }]
          case 'ramp':
            return [
              { kbd: 'press a cliff face', text: 'drag back to cut a ramp' },
              { kbd: 'click a ramp', text: 'remove it' },
            ]
          case 'water':
            return [
              { kbd: 'drag', text: 'pool water' },
              { kbd: '⇧ drag', text: 'drain' },
            ]
        }
      }
      if (params.paintVerb === 'fringe')
        return [
          { kbd: 'drag a wall', text: 'switch its fringe or picket off' },
          { kbd: '⇧ drag', text: 'switch it back on' },
        ]
      return params.paintVerb === 'tint'
        ? [
            { kbd: 'drag', text: 'tint' },
            { kbd: '⇧ drag', text: 'clear the tint' },
            { kbd: '⌥ click', text: 'pick up a colour' },
          ]
        : [
            { kbd: 'drag', text: 'paint the active material layer' },
            { kbd: '⇧ drag', text: 'empty the active material layer' },
            { kbd: '⌥ click', text: 'pick up a material' },
          ]
    case 'sketch':
      return params.sketchMode === 'draw'
        ? [
            { kbd: 'click', text: params.drawing ? 'add a point' : 'start an outline' },
            { kbd: '⌥ click', text: 'a corner point' },
            { kbd: MOD, text: 'no snapping' },
            ...(params.drawing ? [{ kbd: '⏎', text: 'finish' }, { kbd: 'esc', text: 'discard' }] : []),
          ]
        : [
            { kbd: 'drag', text: 'move a point' },
            { kbd: 'click', text: 'select a sketch' },
            { kbd: MOD, text: 'no snapping' },
          ]
    default:
      return []
  }
}

/**
 * Faces that can be seen and hold no material layers, summed over every voxel volume: what draws the fallback. It
 * walks every column, so it is selected settled: counted once a stroke closes, not on every tick of it.
 */
function unpaintedFaces(doc: ReadonlyMapDoc): number {
  let total = 0
  for (const id of doc.structureOrder) {
    const voxel = doc.structures[id]
    if (!voxel || voxel.kind !== 'voxel') continue
    for (let z = 0; z < voxel.size.height; z++) {
      for (let x = 0; x < voxel.size.width; x++) for (const key of exposedFacesOf(voxel, x, z)) if (!voxel.paint.faces[key]) total += 1
    }
  }
  return total
}

export function StatusBar() {
  return (
    <>
      <Hints />
      <StatusRight>
        <HoverReadout />
        <UnpaintedFaces />
        <MissingTransitions />
        <LayersReadout />
        <CameraReadout />
        <FrameStats />
        <UndoReadout />
      </StatusRight>
    </>
  )
}

function Hints() {
  const tools = useToolsSelector((snapshot) => snapshot.context)
  const hints = useMemo(() => hintsFor(mergeParams(tools)), [tools])
  return (
    <StatusHints>
      {hints.map((hint) => (
        <Hint key={hint.text} kbd={hint.kbd}>
          {hint.text}
        </Hint>
      ))}
    </StatusHints>
  )
}

function HoverReadout() {
  const hover = useViewportSelector((snapshot) => snapshot.context.hover, sameSurface)
  const cells = useViewportSelector((snapshot) => snapshot.context.brushCells.length)
  const terrain = useToolsSelector((snapshot) => snapshot.context.tool === 'terrain')
  return (
    <>
      <span>{describeSurface(hover)}</span>
      {terrain ? (
        <span>
          {hover && (hover.kind === SURFACE_SKETCH_CAP || hover.kind === SURFACE_SKETCH_WALL)
            ? 'a sketch — Terrain edits voxel volumes'
            : hover && hover.kind === SURFACE_CLIFF
              ? `band · layer ${Math.floor(hover.level / 2)}`
              : `${cells} cells`}
        </span>
      ) : null}
    </>
  )
}

function UnpaintedFaces() {
  const unpainted = useDocumentSelector(unpaintedFaces, { equal: Object.is, settled: true })
  return <span title="Faces that show and hold no material: they draw the fallback">unpainted {unpainted}</span>
}

/** Corners no tile is authored for, which draw the fallback: the artist's list of transitions to draw (spec §3). */
/** Also the switch for the marks: click to see where on the map each of those corners is. */
function MissingTransitions() {
  const host = useHost()
  const missing = useViewportSelector((snapshot) => snapshot.context.stats.missingTransitions)
  const shown = useViewSelector((snapshot) => snapshot.context.showMissing)
  const names = missing.length ? `\n${missing.join('\n')}` : ''
  return (
    <button
      type="button"
      className={`ui-status-toggle ${shown ? 'is-on' : ''}`}
      title={`${missing.length} transitions nobody has drawn, drawn as the fallback until someone does: each a tile to author. Click to ${shown ? 'hide' : 'show'} where they are.${names}`}
      aria-pressed={shown}
      onClick={() => run(host, 'view.set', { showMissing: !shown })}
    >
      {missing.length} to author
    </button>
  )
}

function LayersReadout() {
  const layers = useViewSelector((snapshot) => snapshot.context.layers)
  if (!layers) return null
  return (
    <span className="ui-num" title="The layer view is narrowed; double-click the slider to see everything">
      layers {layers.lo}–{layers.hi}
    </span>
  )
}

function CameraReadout() {
  const camera = useViewportSelector((snapshot) => snapshot.context.camera)
  return (
    <span className={`ui-num ${camera.inBounds ? '' : 'is-warn'}`}>
      yaw {Math.round(camera.yaw)}° · pitch {Math.round(camera.pitch)}° · {camera.distance.toFixed(1)}u
    </span>
  )
}

function FrameStats() {
  const stats = useViewportSelector((snapshot) => snapshot.context.stats)
  const software = useViewportSelector((snapshot) => snapshot.context.softwareRenderer)
  return (
    <span className="ui-num">
      {stats.fps.toFixed(0)} fps · {(stats.triangles / 1000).toFixed(0)}k tris · mesh {stats.meshMs.toFixed(1)}ms
      {software ? ' · software GL' : ''}
    </span>
  )
}

/**
 * Gated on `canUndo`, not on the label: mid-drag the store refuses undo and reports `canUndo` false while `undoLabel`
 * still names the entry underneath the stroke, so naming it here would advertise something the disabled button will not do.
 */
function UndoReadout() {
  const { reader } = useHost()
  const label = useSyncExternalStore(reader.subscribe, () => (reader.canUndo() ? reader.undoLabel() : 'nothing to undo'))
  return <span>{label}</span>
}
