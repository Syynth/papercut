/**
 * The editor host's public surface: rung 5 of the ladder (#3), the
 * composition spine.
 *
 * An app builds a host with `createHost` and dispatches through it; the
 * React glue reads actors through selectors and the document through
 * `useDocument`; the viewport's pointer handlers are `Host.input` (#11). The
 * child logics are not exported: the host spawns them, and a consumer reaches
 * their state through `Host.children` and the typed selector hooks. Features
 * never import this package (#35) — the contract they implement lives in
 * `registry`, and an app hands them in as `Feature`. The stroke actor runs a
 * feature's handler through that contract, so nothing terrain-shaped is
 * exported here any more: the brush preview's `strokeCells` is the terrain
 * feature's, and the app imports it from there.
 *
 * Written out longhand rather than `export *` (#34): a barrel exports what
 * has an outside consumer plus the types to name what those consumers
 * receive, so narrowing it is a visible edit here.
 */

export { GESTURE_OWNER, HOST_OWNER, createHost, gestureKeys, hostKeys } from './host'
export type {
  Clock,
  DeadLetter,
  EditorFeatureDeps,
  EditorFeatureInstance,
  EditorInput,
  Feature,
  Host,
  HostActor,
  HostChildren,
  HostOptions,
  Mode,
  PlaySession,
} from './host'

// Side-effect-bearing: importing it declares the default keymap (#14). The
// owner id is exported so a test can enumerate what it declared and an app
// could dispose it to install a keymap of its own.
export { CORE_KEYMAP_OWNER } from './keys'

export { ORBIT_DRAG_THRESHOLD } from './gesture'
export type { Gesture, PointerMotion, PointerPress, PointerRelease } from './gesture'

export type { PickSample, PointerModifiers, StrokeSample, ToolsSnapshot } from './strokes'

export { SELECT_DEFAULTS, TOOLS_OWNER, toolKeys } from './tools'
export type { FeatureParams, SelectFootprint, ToolId, ToolSettings, ToolsContext } from './tools'

export { PROJECT_OWNER, projectKeys } from './project'
export type { MaterialsSetArgs, MapsSetArgs, ProjectContext, ProjectCurrentArgs, ProjectLoadArgs, ProjectSettings, ImagesSetArgs } from './project'
export { VIEW_OWNER, selectionSubject, viewKeys } from './view'
export { VIEWPORT_OWNER, sameSurface } from './viewport'
export type { BrushCells, CameraReadout, FrameStats, ViewportState } from './viewport'
export { SETTINGS_SECTIONS } from './view'
export type { Selection, SettingsSection, ViewContext, ViewSettings } from './view'

export { HostProvider, useDocument, useDocumentSelector, useHost, useHostRef, useHostSelector, useProject, useProjectSelector, useToolsSelector, useViewSelector, useViewportSelector } from './react'
export type { DocumentSelectOptions } from './react'
