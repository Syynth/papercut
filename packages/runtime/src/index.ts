/**
 * The runtime package's public surface.
 *
 * The three.js reference runtime: the scene the editor previews and play mode
 * drives, plus the camera rig, the billboard/flip machinery, picking and the
 * coverage analysis. Creating a `WebGLRenderer` is not in here — issue #3
 * measured that and the export CLI depends on it staying true. Neither is any
 * DOM API (#47): the scene takes its sheet and sprites as raw `RgbaImage`s
 * from `@papercut/document`, and this package's tsconfig compiles without
 * `DOM` in `lib` to keep it that way.
 *
 * glTF export is deliberately NOT re-exported: it is `@papercut/runtime/export`,
 * so a consumer that only previews a map does not pull `GLTFExporter` in with
 * the scene. That subpath is the package's second entry point and the only one.
 *
 * Written out rather than `export *`, and narrowed to what has a consumer
 * outside this package plus the types needed to name what those consumers
 * receive (#34's rule, applied in #50). `tests/runtime-barrel.test.ts` holds
 * the list to that: an export nothing outside `packages/runtime` references
 * fails the gate. `Sky`, `ObjectView`, `pickFacing`, `rgbaTexture` and the
 * rest of what left in #50 are still exported by their modules — the runtime's
 * own files and tests reach them by relative path — just not republished here.
 *
 * `MapObject` is not re-exported either: it is `document`'s type and every
 * consumer already takes it from there.
 */

export type { ObjectViewContext } from './billboard'

export {
  applyRig,
  clampToBounds,
  createCamera,
  panToHold,
  sampleYawEnvelope,
  updateCameraProjection,
  withinBounds,
  wrapDegrees,
} from './camera'
export type { RigState } from './camera'

export { Character } from './character'

export { analyseCoverage } from './coverage'
export type { CoverageReport } from './coverage'

export { Picker } from './picking'
export type { PickResult } from './picking'

export { RuntimeScene } from './scene'
export type { SceneAssets } from './scene'
/** The terrain sets a scene is textured with: `geometry`'s type, re-exported so the viewport need not reach past the runtime. */
export type { LoadedSet } from '@papercut/geometry'

export type { LayerRange } from './layers'
