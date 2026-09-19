/**
 * A small view of a small map: the Materials section's 3D view (decision of
 * 2026-09-19).
 *
 * The section shows a material, or two meeting, on a fixture — a plateau, its
 * walls, a ramp — and the point of it is that NOTHING IS MOCKED: the scene is
 * the runtime's own `RuntimeScene`, fed the project's real loaded sets and
 * materials, so the atlas, the mesher, the fringe flaps, the pickets and the
 * fallback are the map's. Show missing is on, so a corner no tile answers
 * carries the same mark it would carry in the level.
 *
 * Imperative for the same reason `Viewport` is, and much less of it: no
 * tools, no picking, no post chain. It draws when something changes — the
 * fixture, the art, the size, a drag — rather than every frame, because a
 * preview in a settings modal should cost nothing while it sits there.
 */

import * as THREE from 'three'

import type { ReadonlyMapDoc } from '@papercut/document'
import { RuntimeScene, applyRig, createCamera, updateCameraProjection, type RigState, type SceneAssets } from '@papercut/runtime'

const MIN_PITCH = 12
const MAX_PITCH = 80

export class FixtureView {
  private renderer: THREE.WebGLRenderer
  private scene: RuntimeScene
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera
  private orbit: RigState = { yaw: 35, pitch: 34, distance: 26, target: new THREE.Vector3() }
  private doc: ReadonlyMapDoc
  private assets: SceneAssets
  private frame = 0
  private disposed = false
  private drag: { x: number; y: number } | null = null
  private observer: ResizeObserver

  constructor(private canvas: HTMLCanvasElement, doc: ReadonlyMapDoc, assets: SceneAssets) {
    this.doc = doc
    this.assets = assets
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.localClippingEnabled = true
    this.renderer.setClearColor(0x000000, 0)
    this.scene = this.build()
    this.camera = createCamera(doc.camera, this.aspect(), 'perspective')
    this.frameFixture()

    canvas.addEventListener('pointerdown', this.onDown)
    canvas.addEventListener('pointermove', this.onMove)
    canvas.addEventListener('pointerup', this.onUp)
    canvas.addEventListener('pointercancel', this.onUp)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(canvas)
    this.resize()
  }

  /** A new fixture: the subject changed. The camera keeps its angle and re-centres on the new map. */
  setDocument(doc: ReadonlyMapDoc): void {
    if (doc === this.doc) return
    this.doc = doc
    this.rebuild()
  }

  /** New art or a new material list: the look changes, so the scene is built again against it. */
  setAssets(assets: SceneAssets): void {
    if (assets === this.assets) return
    this.assets = assets
    this.rebuild()
  }

  /** The transitions no tile answers on the fixture, named once each: what the marks are. */
  missing(): readonly string[] {
    return this.scene.missingTransitions()
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.frame)
    this.observer.disconnect()
    this.canvas.removeEventListener('pointerdown', this.onDown)
    this.canvas.removeEventListener('pointermove', this.onMove)
    this.canvas.removeEventListener('pointerup', this.onUp)
    this.canvas.removeEventListener('pointercancel', this.onUp)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.scene.dispose()
    this.renderer.dispose()
  }

  private build(): RuntimeScene {
    const scene = new RuntimeScene(this.doc, this.assets)
    // No sky dome behind a preview: the stage shows through.
    scene.sky.group.visible = false
    scene.scene.background = null
    scene.scene.fog = null
    scene.setShowMissing(true)
    scene.rebuildAll()
    return scene
  }

  private rebuild(): void {
    this.scene.dispose()
    this.scene = this.build()
    this.frameFixture()
    this.draw()
  }

  private frameFixture(): void {
    this.orbit.target.copy(this.scene.mapCentre())
    this.orbit.target.y += 0.75
    applyRig(this.camera, this.orbit)
  }

  private aspect(): number {
    return this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight)
  }

  private resize(): void {
    const width = Math.max(1, this.canvas.clientWidth)
    const height = Math.max(1, this.canvas.clientHeight)
    this.renderer.setSize(width, height, false)
    updateCameraProjection(this.camera, this.doc.camera, width / height, this.orbit.distance)
    this.draw()
  }

  /** One frame, soon: however many things asked for it. */
  private draw(): void {
    if (this.disposed || this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      if (this.disposed) return
      applyRig(this.camera, this.orbit)
      this.renderer.render(this.scene.scene, this.camera)
    })
  }

  private onDown = (event: PointerEvent): void => {
    this.drag = { x: event.clientX, y: event.clientY }
    this.canvas.setPointerCapture(event.pointerId)
  }

  private onMove = (event: PointerEvent): void => {
    if (!this.drag) return
    this.orbit.yaw -= (event.clientX - this.drag.x) * 0.4
    this.orbit.pitch = Math.min(MAX_PITCH, Math.max(MIN_PITCH, this.orbit.pitch + (event.clientY - this.drag.y) * 0.3))
    this.drag = { x: event.clientX, y: event.clientY }
    this.draw()
  }

  private onUp = (event: PointerEvent): void => {
    this.drag = null
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId)
  }

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    this.orbit.distance = Math.min(60, Math.max(6, this.orbit.distance * (event.deltaY > 0 ? 1.1 : 0.9)))
    updateCameraProjection(this.camera, this.doc.camera, this.aspect(), this.orbit.distance)
    this.draw()
  }
}
