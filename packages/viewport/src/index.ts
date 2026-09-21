/**
 * The viewport package's public surface — the editor's GL shell.
 *
 * Issue #3's reason for the cut: a feature module must not be able to reach the
 * `WebGLRenderer`, or "contribute an overlay" degrades into "grab the scene
 * graph" on the first feature in a hurry. So the renderer, the composer and the
 * passes are module-private and only the class that owns them is exported.
 *
 * Two absences are deliberate:
 *
 * - No React, and no dependency that could bring it. The class is imperative
 *   because bulk terrain geometry changes on every brush tick; that property is
 *   load-bearing and the package boundary is what keeps it honest.
 * - No `@papercut/viewport-contrib`. Issue #3 puts the overlay-contribution
 *   surface in its own package so a feature cannot resolve the renderer, but
 *   nothing contributes an overlay yet and its surface is undesigned, so an
 *   empty shell would claim a boundary nothing enforces.
 *
 * Written out rather than `export *`, matching the other packages.
 */

export { FixtureView } from './fixture'
export { Viewport } from './viewport'
export type { Gesture, PlaySession, PointerModifiers, PointerMotion, PointerPress, EditorPick, MoveAxis, SketchHandle, SketchOverlay, ViewportHandlers, ViewportOptions } from './viewport'
