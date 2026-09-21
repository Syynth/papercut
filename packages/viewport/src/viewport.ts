/**
 * The 3D viewport.
 *
 * Managed imperatively rather than through react-three-fiber, because bulk
 * terrain geometry changes on every brush tick and React has no business in
 * that loop. React owns the panels; this owns the canvas.
 *
 * Everything visible here is rendered by the runtime package. The only things
 * this adds are editor overlays — grid, hover highlight, brush preview — which
 * are exactly the things that must NOT ship in the game.
 */

import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

import { TerrainGrid } from './grid'
import { ViewCube, type CubePiece } from './cube'
import { FrameProfile, GpuTimer, type FrameProfileReport } from './profile'

import {
  AIR,
  DIR_VECTORS,
  FACE_BOTTOM,
  FACE_TOP,
  SURFACE_CLIFF,
  SURFACE_TOP,
  SURFACE_UNDER,
  columnTopAt,
  cornerHeights,
  cornerHeightsAt,
  faceNear,
  parseEdgeKey,
  parseFaceKey,
  parseVoxelKey,
  shapeHeight,
  voxelAt,
  type Region,
  groundHeight,
  inBounds,
  type DocumentReader,
  type SurfaceAddress,
  type CameraRig,
  type DeepReadonly,
  structureOf,
  type ReadonlyVoxel,
  frameOf,
  levelCentre,
  toWorld,
  type DocumentTarget,
  topHeight,
  type MaterialDef,
} from '@papercut/document'
import {
  Character,
  Picker,
  RuntimeScene,
  applyRig,
  clampToBounds,
  createCamera,
  panToHold,
  sampleYawEnvelope,
  updateCameraProjection,
  withinBounds,
  wrapDegrees,
  type ObjectViewContext,
  type PickResult,
  type SceneAssets,
  type LayerRange,
} from '@papercut/runtime'
import type { SpriteAsset } from '@papercut/document'
import type { LoadedSet } from '@papercut/runtime'

/** Tilt-shift: a cheap vertical-gradient blur, the HD-2D miniature look. */
export interface PointerModifiers {
  shift: boolean
  alt: boolean
  ctrl: boolean
}

/**
 * Which gesture a press turned out to be — the arbitration actor's answer,
 * not a flag this class keeps (#11). The `dragging` union that used to live
 * here SPLIT: deciding which gesture a press is, and replaying an alt press
 * that never travelled as a click, went to `editor-host`'s gesture actor;
 * the per-frame yaw, pitch and pan deltas stayed, because sixty round trips
 * a second through an actor is not what an actor is for.
 */
export type Gesture = 'none' | 'pending' | 'stroke' | 'orbit' | 'pan'

export interface PointerPress {
  x: number
  y: number
  /** DOM button: 0 left, 1 middle, 2 right. */
  button: number
  modifiers: PointerModifiers
  /**
   * What is under a left press, picked HERE and picked ONCE. The old code
   * kept the press event and re-picked it at release to replay an alt click,
   * against a scene the drag may have moved; carrying the pick with the press
   * is what makes the replay land on the cell that was actually pressed.
   */
  pick: EditorPick | null
  /** Which press of a run of quick presses in one place this is: 2 for a double-click. */
  clicks: number
}

export interface PointerMotion {
  x: number
  y: number
  modifiers: PointerModifiers
}

/**
 * A stroke tick's pick, plus where the pointer's ray meets the horizontal
 * plane through the PRESS's hit. A drag that moves something wants the
 * second and not the first: what is under the cursor mid-drag is whatever
 * the drag put there — the dragged sprite itself, a cliff face the ray
 * crossed — and following it makes the motion lurch along that surface. The
 * plane is fixed at the press, so the pointer's travel maps to ground travel
 * the same way for the whole gesture. `null` when the ray misses the plane
 * (a near-horizontal camera) or the press hit nothing.
 */
/** A press or a hover: the raycast, plus the sketch point under the pointer if one is drawn there. */
export interface EditorPick extends PickResult {
  /**
   * The overlay handle within a few pixels of the pointer, hit-tested where it
   * is DRAWN: the dots are screen-sized and sit on the cap, so a raycast
   * through one lands on the wall or the ground behind, nowhere near it.
   */
  handle: SketchHandle | null
  /** The Move handle within a few pixels of the pointer, hit-tested on screen like a sketch's dots: which axis it drags along. */
  axis: MoveAxis | null
}

/** One of Move's three handles: east, up, south. */
export type MoveAxis = 'x' | 'y' | 'z'

export interface SketchHandle {
  readonly structure: string
  readonly index: number
}

export interface StrokePick extends EditorPick {
  plane: { x: number; z: number } | null
}

export interface ViewportHandlers {
  /** A press on the canvas. What gesture it became is not answered here: a press moves nothing, and the next move asks. */
  onPointerDown(press: PointerPress): void
  /** Motion anywhere; the answer is the gesture now in progress, which is what the deltas below are applied against. */
  onPointerMove(motion: PointerMotion): Gesture
  onPointerUp(release: { x: number; y: number }): void
  /** One tick of an open stroke: only sent while `onPointerMove` answers `'stroke'`. */
  onStrokeMove(pick: StrokePick, modifiers: PointerModifiers): void
  /** What the open stroke is carrying: the pick looks past these ids so it answers what they would land on. */
  carrying(): ReadonlySet<string>
  /**
   * Keys held right now, lower-cased. Read every frame for WASD; the set
   * itself lives in the gesture actor and is fed by the app's one keydown
   * dispatcher (#14). This class installed its own `keydown`/`keyup` pair
   * until #66 step 6 — two independent listeners on `window` was the thing
   * that ticket exists to remove.
   */
  heldKeys(): ReadonlySet<string>
  onHover(pick: EditorPick): void
  onCameraChange(state: { yaw: number; pitch: number; distance: number; inBounds: boolean }): void
  /** The view cube was clicked on the view the camera already has: flip the editor's projection. */
  onProjectionToggle(): void
  onStats(stats: { fps: number; triangles: number; meshMs: number; missingTransitions: readonly string[] }): void
}

/** Where a play session puts the character down, in world units. The host's play actor computes it. */
export interface PlaySession {
  readonly start: readonly [number, number, number]
}

export interface ViewportOptions {
  /** Cells the brush would affect, previewed under the cursor. */
  brushPreview: ReadonlyArray<readonly [number, number]>
  showGrid: boolean
  /** Mark every corner no tile answers: the transitions still to draw. */
  showMissing: boolean
  /** The colour a face with nothing on it, and a corner no tile answers, is drawn. */
  fallback: number
  /** Which material layers are drawn, bottom first; a hidden one is still in the document. */
  materialLayers: readonly boolean[]
  /** Clamp the editor camera to what the game rig allows. */
  gameCamera: boolean
  /** How the free editor camera projects. Under `gameCamera` and in play the rig's own projection is used instead. */
  projection: CameraRig['projection']
  /**
   * The play session, or `null` while editing (#11). Not a boolean: the
   * session is an ACTOR in the host, spawned by `mode.play` and stopped by
   * `mode.edit`, and where the hero starts is the one thing it reads off the
   * document when it starts. Taking the start from the session rather than
   * recomputing it here is what makes the session's lifetime and the
   * character's the same lifetime.
   */
  play: PlaySession | null
  /** Hovered surface, highlighted. */
  hover: SurfaceAddress | null
  /** What is selected, as the scene knows it: framed with a box, whatever its kind. */
  selection: DocumentTarget | null
  /** The region selected: some of a voxel volume's edges, faces or voxels, drawn as themselves (rulings of 2026-09-12 and 2026-09-20). */
  region: Region | null
  /** What a click where the pointer is would take, drawn lighter than the selection: see it before you take it (design pass of 2026-09-20). */
  regionPreview: Region | null
  /** Where Move's three axis handles stand, in the world, or `null` when there is nothing to move: drawn over everything, and pressed to drag along one axis. */
  moveHandles: readonly [number, number, number] | null
  /** The height range drawn, in half-tiles, or `null` for all of it — the layer view. */
  layers: LayerRange | null
  /** The sketch being drawn or edited: its points in world space, whether its outline closes, and which point is selected. */
  sketch: SketchOverlay | null
}

export interface SketchOverlay {
  readonly structure: string
  readonly points: ReadonlyArray<readonly [number, number, number]>
  readonly closed: boolean
  readonly selected: number | null
}

/** Move's three handles: which way each points, and its colour — red east, green up, blue south, as every 3D tool has them. */
const MOVE_AXES: ReadonlyArray<{ readonly id: MoveAxis; readonly direction: readonly [number, number, number]; readonly color: number }> = [
  { id: 'x', direction: [1, 0, 0], color: 0xe5636f },
  { id: 'y', direction: [0, 1, 0], color: 0x7bc47f },
  { id: 'z', direction: [0, 0, 1], color: 0x5b8def },
]
/** How long a handle is, as a share of the view's height: about a ninth of it, wherever the camera stands. */
const MOVE_HANDLE_SCREEN = 0.11

/** How solid the view cube is drawn while the pointer is elsewhere. */
const CUBE_REST_OPACITY = 0.4

const DEFAULT_OPTIONS: ViewportOptions = {
  brushPreview: [],
  showGrid: true,
  showMissing: false,
  fallback: 0xff00ff,
  materialLayers: [true, true, true, true],
  gameCamera: false,
  projection: 'perspective',
  play: null,
  hover: null,
  selection: null,
  region: null,
  regionPreview: null,
  moveHandles: null,
  layers: null,
  sketch: null,
}

/**
 * Software rasterizers (SwiftShader in headless Chromium, llvmpipe on a
 * machine with no GPU driver) render the bloom pass as a black frame: the
 * scene itself draws correctly, and putting UnrealBloomPass in front of it
 * turns the whole image black. Measured, not guessed — see FINDINGS.md.
 *
 * Rather than lose the whole viewport on such a machine, detect it and drop
 * post-processing. The editor says so in the status bar so nobody concludes
 * the atmosphere sliders are broken.
 */
/** A texture, typed as three's default texture rather than the `any`-parameterised one `instanceof` narrows to. */
function isTexture(value: unknown): value is THREE.Texture {
  return value instanceof THREE.Texture
}

function isSoftwareRenderer(renderer: THREE.WebGLRenderer): boolean {
  try {
    const gl = renderer.getContext()
    // Firefox answers the real name to the plain query and deprecates the
    // extension; Chrome masks the plain query and needs the extension.
    const plain = String(gl.getParameter(gl.RENDERER))
    const masked = /webkit webgl|^mozilla$/i.test(plain)
    const info = masked ? gl.getExtension('WEBGL_debug_renderer_info') : null
    const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : plain
    return /swiftshader|llvmpipe|software|mesa offscreen/i.test(name)
  } catch {
    return false
  }
}

// window.__viewport (wired in apps/editor) exposes this class's *ForProbe
// methods to an unlinted, untypechecked consumer — see the "scripting hooks"
// section below for which scripts and why a rename needs a grep first.
export class Viewport {
  /** True when post-processing had to be switched off. */
  readonly softwareRenderer: boolean
  private renderer: THREE.WebGLRenderer
  private composer: EffectComposer
  private bloom: UnrealBloomPass
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera
  private scene: RuntimeScene
  private filtering: 'nearest' | 'linear'
  private picker = new Picker()
  /** World height of the current left press's hit — the plane `StrokePick.plane` is measured on. */
  private strokePlaneY: number | null = null
  /**
   * What a right press grabbed: the world point under the cursor, on the
   * horizontal plane a pan slides along. Null while no pan holds anything, or
   * when the press had nothing under it — a pan then falls back to sliding by
   * pixels, since there is no point to keep.
   */
  private panGrab: THREE.Vector3 | null = null
  private reader: DocumentReader

  private orbit = { yaw: 45, pitch: 35, distance: 26, target: new THREE.Vector3() }
  private options: ViewportOptions = { ...DEFAULT_OPTIONS }
  private handlers: ViewportHandlers

  private sizeObserver: ResizeObserver | null = null
  private lastPress: { at: number; x: number; y: number; button: number; clicks: number } | null = null
  private regionMesh: THREE.Mesh
  private regionLines: THREE.LineSegments
  private moveHandles = new THREE.Group()
  private previewMesh: THREE.Mesh
  private previewLines: THREE.LineSegments
  private drawnPreview: Region | null = null
  private drawnPreviewRevision = -1
  private drawnRegion: Region | null = null
  private drawnRegionRevision = -1
  private overlay = new THREE.Group()
  /** The terrain grid, chunked like the terrain and updated chunk by chunk (`grid.ts`). */
  private grid = new TerrainGrid()
  private brushMesh: THREE.Mesh
  private hoverMesh: THREE.Mesh
  private sketchLine: THREE.Line
  private sketchPoints: THREE.Points
  private sketchSelected: THREE.Points
  private selectionBox: THREE.Box3Helper

  private character: Character | null = null

  private lastPointer = { x: 0, y: 0 }
  private frameHandle = 0
  private lastTime = performance.now()
  private fpsAccumulator = 0
  private fpsFrames = 0
  private sweep: { active: boolean; t: number; yaws: number[] } = { active: false, t: 0, yaws: [] }
  /** A view-cube alignment in flight: the pose it left and the one it is going to, eased over a fraction of a second. */
  private glide: { t: number; from: { yaw: number; pitch: number }; to: { yaw: number; pitch: number } } | null = null
  /** The view cube in the corner, and the press it holds while the pointer is down on it. */
  private cube = new ViewCube()
  private cubePress: { piece: CubePiece | null; x: number; y: number; moved: boolean } | null = null
  /** The pointer is over the cube. With a press held, the cube is drawn solid; otherwise it fades back. */
  private cubeHot = false
  private cubeOpacity = CUBE_REST_OPACITY
  private renderPass: RenderPass
  private disposed = false
  /**
   * The `reader.generation` this viewport last drew. `syncDirty` compares it
   * every frame, so a `document.load` or `document.new` from ANY dispatcher
   * re-points the scene; nothing has to remember to call `reset()` beside the
   * dispatch.
   */
  private drawnGeneration = 0

  constructor(
    private canvas: HTMLCanvasElement,
    reader: DocumentReader,
    // The art comes in from the composition root, never from here (#47): the
    // viewport is a GL shell around the runtime and draws nothing itself.
    assets: SceneAssets,
    handlers: ViewportHandlers,
  ) {
    this.reader = reader
    this.handlers = handlers

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.0
    // The layer view is a clipping plane on the scene's materials (`runtime`'s `section.ts`).
    this.renderer.localClippingEnabled = true

    this.filtering = assets.filtering
    this.scene = new RuntimeScene(reader.doc, assets)
    this.scene.rebuildAll()
    this.drawnGeneration = reader.generation

    const centre = this.scene.mapCentre()
    this.orbit.target.copy(centre)
    this.orbit.yaw = reader.doc.camera.yaw
    this.orbit.pitch = reader.doc.camera.pitch
    this.orbit.distance = reader.doc.camera.distance

    this.camera = createCamera(reader.doc.camera, canvas.clientWidth / Math.max(1, canvas.clientHeight))
    applyRig(this.camera, this.orbit)

    // The composer draws the scene into an offscreen target before the passes
    // run, and three gives a plain offscreen target only a 16-bit depth
    // buffer — the canvas gets 24. With the near plane at 0.1 and the far at
    // 500 that is marginal on any GPU and, on one Apple GPU driver (an M5,
    // 2026-09-12), fragments past a certain view depth failed the depth test
    // outright: the level rendered only up close, with a straight cutoff that
    // receded as the camera zoomed in. A multisampled target gets a 24-bit
    // depth buffer in WebGL2, and the post chain gets the antialiasing the
    // canvas's own `antialias` never reached it with.
    const target = new THREE.WebGLRenderTarget(Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight), { type: THREE.HalfFloatType, samples: 4 })
    this.composer = new EffectComposer(this.renderer, target)
    this.renderPass = new RenderPass(this.scene.scene, this.camera)
    this.composer.addPass(this.renderPass)
    // Built at the real size rather than a placeholder that resize() fixes up
    // later. (That was a suspect for the software-GL black frame below; it was
    // not the cause, but sizing it correctly up front is right anyway.)
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight)),
      0.35,
      0.55,
      0.85,
    )
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())

    this.softwareRenderer = isSoftwareRenderer(this.renderer)
    if (this.softwareRenderer) {
      this.bloom.enabled = false
    }

    // --- overlays ---------------------------------------------------------
    const overlayMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.28,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    this.brushMesh = new THREE.Mesh(new THREE.BufferGeometry(), overlayMaterial)
    this.brushMesh.renderOrder = 900
    this.hoverMesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color: 0xffe98a,
        transparent: true,
        opacity: 0.55,
        depthTest: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    )
    this.hoverMesh.renderOrder = 901
    // The selected region, over the terrain it is part of: amber, the app's accent, and see-through so the art reads under it.
    this.regionMesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color: 0xe9a23b, transparent: true, opacity: 0.42, depthTest: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    )
    this.regionMesh.renderOrder = 899
    // Its outline, so a region reads at a glance over busy art: every selected element's own border.
    this.regionLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.9, depthTest: true, depthWrite: false }))
    this.regionLines.renderOrder = 899
    this.previewLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, depthTest: true, depthWrite: false }))
    this.previewLines.renderOrder = 898
    this.previewMesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, depthTest: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    )
    this.previewMesh.renderOrder = 898
    // Move's handles: an arrow an axis, in the colours every 3D tool gives them, over everything so they can always be reached.
    for (const axis of MOVE_AXES) {
      // A shaft and a head, built along +Y and turned to the axis. Solid rather than a line, which is a pixel wide whatever is asked of it.
      const material = new THREE.MeshBasicMaterial({ color: axis.color, depthTest: false, transparent: true, fog: false, toneMapped: false })
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.78, 10), material)
      shaft.position.y = 0.39
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.26, 14), material)
      head.position.y = 0.87
      const arrow = new THREE.Group()
      arrow.add(shaft, head)
      arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...axis.direction))
      for (const part of [shaft, head]) part.renderOrder = 960
      this.moveHandles.add(arrow)
    }
    this.moveHandles.visible = false
    this.selectionBox = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(0x7fd4ff))
    this.selectionBox.visible = false
    // The sketch under the Sketch tool: its outline, its points, the selected point. Drawn on top of everything.
    this.sketchLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xe9a23b, depthTest: false }))
    this.sketchLine.renderOrder = 950
    this.sketchPoints = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xe9a23b, size: 9, sizeAttenuation: false, depthTest: false }))
    this.sketchPoints.renderOrder = 951
    this.sketchSelected = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xffffff, size: 13, sizeAttenuation: false, depthTest: false }))
    this.sketchSelected.renderOrder = 952

    this.overlay.add(this.moveHandles, this.previewMesh, this.previewLines, this.regionMesh, this.regionLines, this.brushMesh, this.hoverMesh, this.selectionBox, this.sketchLine, this.sketchPoints, this.sketchSelected)
    this.overlay.add(this.grid.group)
    // Grid lines above the ceiling go with the terrain they outline.
    this.grid.clipWith(this.scene.section.plane)
    this.scene.scene.add(this.overlay)
    this.grid.rebuildAll(reader.doc)

    this.attachEvents()
    this.resize()
    this.loop()
  }

  // --- public API -------------------------------------------------------------

  setOptions(options: Partial<ViewportOptions>): void {
    const wasPlaying = this.playing
    const wasLayers = this.options.layers
    const wasShowMissing = this.options.showMissing
    const was = this.options
    this.options = { ...this.options, ...options }
    if (this.playing !== wasPlaying) this.togglePlay(this.options.play)
    // The range is a section cut on the GPU: a plane and a uniform, nothing rebuilt.
    const layers = this.options.layers
    if (layers?.lo !== wasLayers?.lo || layers?.hi !== wasLayers?.hi) this.scene.setLayerRange(layers)
    if (this.options.showMissing !== wasShowMissing) this.scene.setShowMissing(this.options.showMissing)
    if (this.options.fallback !== was.fallback) this.scene.setFallback(this.options.fallback)
    if (this.options.materialLayers.some((shown, layer) => shown !== was.materialLayers[layer])) this.scene.setMaterialLayersShown(this.options.materialLayers)
  }

  /** A session is running. The flag this replaced was a second copy of the same fact. */
  private get playing(): boolean {
    return this.options.play !== null
  }

  /**
   * Called when the document changed identity (load, new map) — the one
   * change no patch and no dirty chunk describes.
   *
   * `syncDirty` drives this off `reader.generation`, so it is not something a
   * dispatch site has to remember; it stays public only because a script may
   * want to force a full rebuild.
   */
  reset(): void {
    this.scene.setDocument(this.reader.doc)
    this.scene.applyAtmosphere()
    this.scene.rebuildAll()
    this.grid.rebuildAll(this.reader.doc)
    // Framing, not re-pointing: the previous map's orbit target can sit
    // outside a smaller new map entirely, and the new map carries its own rig.
    this.frameMap()
  }

  /**
   * Rebuild only what the reader says moved — or everything, when what moved
   * is the document itself.
   */
  syncDirty(): void {
    // Identity first. `replace` marks every chunk dirty as well, so draining
    // the queue against the OLD document is exactly what this branch exists
    // to prevent: the keys are sized for the new map, the arrays are not.
    if (this.reader.generation !== this.drawnGeneration) {
      this.drawnGeneration = this.reader.generation
      this.reader.takeDirtyChunks()
      this.reader.takeDirtyStructures()
      this.reader.takeMovedStructures()
      this.reset()
      return
    }
    const structures = this.reader.takeDirtyStructures()
    const moved = this.reader.takeMovedStructures()
    if (!this.reader.hasDirtyChunks() && structures.length === 0 && moved.length === 0) return
    const chunks = this.reader.takeDirtyChunks()
    // A structure that only moved is re-placed, not remeshed: dragging a sketch moves its group and nothing more.
    this.scene.rebuild({ chunks, structures, moved })
    // The grid follows the terrain, chunk for chunk: the same dirty keys rewrite the same chunks' lines, and a structure
    // that changed as a whole — moved, resized — is re-placed or rebuilt with it.
    this.grid.update(this.reader.doc, chunks, structures)
  }

  refreshAtmosphere(): void {
    this.scene.applyAtmosphere()
  }

  loadTerrain(sets: LoadedSet[]): void {
    this.scene.refreshTerrain(sets)
  }

  /** The project's materials: what a voxel's id draws as. Remeshes everything when the list changes. */
  setMaterials(materials: readonly MaterialDef[]): void {
    this.scene.setMaterials(materials)
  }

  /** The project's texture filtering, for every texture the viewport draws. */
  setFiltering(filtering: 'nearest' | 'linear'): void {
    this.filtering = filtering
    this.scene.setFiltering(filtering)
  }

  loadSprites(sprites: Record<string, SpriteAsset>): void {
    this.scene.setSprites(sprites)
  }

  startSweep(): void {
    this.sweep = { active: true, t: 0, yaws: sampleYawEnvelope(this.reader.doc.camera, 64) }
  }

  cameraState(): { yaw: number; pitch: number; distance: number } {
    return { yaw: this.orbit.yaw, pitch: this.orbit.pitch, distance: this.orbit.distance }
  }

  /** Where the free camera is, whole: its orbit and what it orbits. What the app keeps per map across a reload. */
  viewState(): { yaw: number; pitch: number; distance: number; target: [number, number, number] } {
    return { ...this.cameraState(), target: [this.orbit.target.x, this.orbit.target.y, this.orbit.target.z] }
  }

  /** Put the free camera back where `viewState` found it, letting go of any alignment in flight. */
  restoreView(state: { yaw: number; pitch: number; distance: number; target: readonly [number, number, number] }): void {
    this.glide = null
    this.orbit.yaw = state.yaw
    this.orbit.pitch = state.pitch
    this.orbit.distance = state.distance
    this.orbit.target.set(state.target[0], state.target[1], state.target[2])
  }

  // --- scripting hooks --------------------------------------------------------
  //
  // Driven by scripts/tour.mjs and scripts/probe.mjs, which run the editor in a
  // headless browser to capture screenshots and to measure rendering. They are
  // here rather than in test-only code because the thing worth driving is the
  // real viewport; nothing in the app calls them.

  /**
   * Skip the post-processing chain. ON by default (2026-09-12): on one Apple
   * GPU (an M5) anything drawn through the composer's offscreen target came
   * out cut off past a view depth — a 24-bit multisampled target and
   * dropping tilt-shift did not cure it, and the owner would rather have the
   * level on every machine than bloom on most. The composer stays built so a
   * probe can turn it back on and measure it.
   */
  bypassComposer = true

  /** The frame profile being recorded, if one is: see `startFrameProfileForProbe`. */
  private profile: FrameProfile | null = null
  /** Built with the first profile, kept for the next: its queries are pooled. */
  private gpuTimer: GpuTimer | null = null
  private recordGpu = (ms: number): void => this.profile?.gpu(ms)

  /**
   * Start recording per-frame phase timings and GPU time (`profile.ts`),
   * replacing any recording in progress.
   */
  startFrameProfileForProbe(capacity = 8192): void {
    const gl = this.renderer.getContext()
    this.gpuTimer ??= typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? new GpuTimer(gl) : null
    this.profile = new FrameProfile(capacity, this.gpuTimer?.available ?? false)
  }

  /** The canvas's drawing buffer in device pixels: what the GPU fills each frame. */
  drawingBufferForProbe(): { width: number; height: number; pixelRatio: number } {
    const gl = this.renderer.getContext()
    return { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight, pixelRatio: this.renderer.getPixelRatio() }
  }

  /** Stop recording and hand back what was recorded; `null` when nothing was. */
  takeFrameProfileForProbe(): FrameProfileReport | null {
    const report = this.profile?.report() ?? null
    this.profile = null
    return report
  }

  /**
   * What the GPU holds for this scene: three's own counts, the last frame's
   * draw calls, and the bytes behind every geometry and texture reachable
   * from the scene — the part of the footprint the JS heap does not show.
   */
  gpuMemoryForProbe(): { drawCalls: number; triangles: number; geometries: number; textures: number; programs: number; sceneGeometryBytes: number; sceneTextureBytes: number; sceneNodes: number } {
    const geometries = new Set<THREE.BufferGeometry>()
    const textures = new Set<THREE.Texture>()
    let nodes = 0
    this.scene.scene.traverse((node) => {
      nodes += 1
      const mesh = node as THREE.Mesh
      if (mesh.geometry) geometries.add(mesh.geometry)
      const materials = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : []
      for (const material of materials) {
        for (const value of Object.values(material)) if (isTexture(value)) textures.add(value)
        const uniforms = (material as THREE.ShaderMaterial).uniforms
        if (uniforms) for (const uniform of Object.values(uniforms)) if (isTexture(uniform.value)) textures.add(uniform.value)
      }
    })
    let geometryBytes = 0
    for (const geometry of geometries) {
      for (const attribute of Object.values(geometry.attributes)) geometryBytes += (attribute as THREE.BufferAttribute).array.byteLength
      if (geometry.index) geometryBytes += geometry.index.array.byteLength
    }
    let textureBytes = 0
    for (const texture of textures) {
      const image = texture.image as { data?: ArrayBufferView; width?: number; height?: number } | undefined
      const base = image?.data ? image.data.byteLength : (image?.width ?? 0) * (image?.height ?? 0) * 4
      textureBytes += texture.generateMipmaps ? Math.round(base * (4 / 3)) : base
    }
    const info = this.renderer.info
    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      sceneGeometryBytes: geometryBytes,
      sceneTextureBytes: textureBytes,
      sceneNodes: nodes,
    }
  }

  /** What is under a client-space point, as a script needs to find something to press. */
  pickForProbe(clientX: number, clientY: number): { structure: string | null; kind: number | null; objectId: string | null } {
    const rect = this.canvas.getBoundingClientRect()
    const x = ((clientX - rect.left) / rect.width) * 2 - 1
    const y = -((clientY - rect.top) / rect.height) * 2 + 1
    const pick = this.picker.pick(this.scene, this.camera, x, y)
    return { structure: pick.surface?.structure ?? null, kind: pick.surface?.kind ?? null, objectId: pick.objectId }
  }

  /** The WebGL renderer's name as the driver reports it, unmasked where the browser allows. */
  rendererNameForProbe(): string {
    const gl = this.renderer.getContext()
    const plain = String(gl.getParameter(gl.RENDERER))
    const info = /webkit webgl|^mozilla$/i.test(plain) ? gl.getExtension('WEBGL_debug_renderer_info') : null
    return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : plain
  }

  setCameraForProbe(state: Partial<{ yaw: number; pitch: number; distance: number }>): void {
    if (state.yaw !== undefined) this.orbit.yaw = state.yaw
    if (state.pitch !== undefined) this.orbit.pitch = state.pitch
    if (state.distance !== undefined) this.orbit.distance = state.distance
  }

  /** Look at a particular cell, so a script can click something specific. */
  focusCellForProbe(x: number, y: number, distance?: number): void {
    this.orbit.target.set(x + 0.5, groundHeight(this.reader.doc, x + 0.5, y + 0.5), y + 0.5)
    if (distance !== undefined) this.orbit.distance = distance
  }

  /** Aim at an arbitrary world point — a cliff face's middle, say, which is
   *  not the same as the ground height at its cell. */
  setTargetForProbe(x: number, y: number, z: number, distance?: number): void {
    this.orbit.target.set(x, y, z)
    if (distance !== undefined) this.orbit.distance = distance
  }

  hideOverlayForProbe(): void {
    this.overlay.visible = false
  }

  setPassForProbe(name: 'bloom', enabled: boolean): void {
    if (name === 'bloom') this.bloom.enabled = enabled
  }

  /** Adopt the document's rig as the current view, for the "preview" button. */
  applyRigDefaults(): void {
    const rig = this.reader.doc.camera
    this.orbit.yaw = rig.yaw
    this.orbit.pitch = rig.pitch
    this.orbit.distance = rig.distance
  }

  /**
   * Open on the map centre at the rig's own distance.
   *
   * Not a fit-the-whole-map framing: at the narrow field of view this look
   * wants, fitting a 36-tile map means standing 80 units back, where the map's
   * own fog — correctly, for gameplay — has already swallowed everything. The
   * rig distance is what the game will actually use, so it is also the honest
   * thing to open on. Zooming out from there is one scroll away.
   */
  frameMap(): void {
    const [cx, cy, cz] = levelCentre(this.reader.doc)
    const rig = this.reader.doc.camera
    this.orbit.target.set(cx, cy + 1, cz)
    this.orbit.distance = Math.min(rig.bounds.distMax, Math.max(rig.bounds.distMin, rig.distance))
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.frameHandle)
    this.detachEvents()
    this.character?.dispose()
    this.scene.dispose()
    this.grid.dispose()
    this.gpuTimer?.dispose()
    this.cube.dispose()
    this.composer.dispose()
    this.renderer.dispose()
  }

  // --- internals --------------------------------------------------------------

  /** A flat overlay quad hugging a cell's top surface, in world space through the volume's frame. */
  /** A cell's quad, on its column's top; or, with `on`, on the top of the voxel at `layer`, or level at `flat` tiles up — an underside. */
  private cellQuad(voxel: ReadonlyVoxel, x: number, y: number, out: number[], lift = 0.03, on?: { layer: number } | { flat: number }): void {
    if (!inBounds(voxel.size, x, y)) return
    // On the ground, under any water: the water surface neither writes depth
    // nor draws before the overlays (see the scene's water material), so a
    // preview on a lake bed shows through the water rather than under it.
    // Under the layer view, the preview sits on the cap the column was cut to.
    const layers = this.options.layers
    const frame = frameOf(this.reader.doc, voxel.id)
    const at = (lx: number, h: number, lz: number) => {
      const [wx, wz] = toWorld(frame, lx, lz)
      return [wx, frame.y + h, wz]
    }
    const heights = on === undefined ? cornerHeights(voxel, x, y) : 'flat' in on ? [on.flat * 2, on.flat * 2, on.flat * 2, on.flat * 2] : cornerHeightsAt(voxel, x, y, on.layer)
    const [c00, c01, c11, c10] = heights.map((h) => (layers === null ? h : Math.min(h, layers.hi)) * 0.5 + lift)
    out.push(
      ...at(x, c00, y), ...at(x, c01, y + 1), ...at(x + 1, c11, y + 1),
      ...at(x, c00, y), ...at(x + 1, c11, y + 1), ...at(x + 1, c10, y),
    )
  }

  /** The voxel volume a cell-addressed overlay belongs to: the hovered one, else the first. */
  private overlayVoxel(): ReadonlyVoxel | undefined {
    const doc = this.reader.doc
    const hovered = this.options.hover ? structureOf(doc, this.options.hover.structure, 'voxel') : undefined
    if (hovered) return hovered
    for (const id of doc.structureOrder) {
      const s = doc.structures[id]
      if (s && s.kind === 'voxel') return s
    }
    return undefined
  }

  private updateBrushPreview(): void {
    const voxel = this.overlayVoxel()
    const points: number[] = []
    if (voxel) for (const [x, y] of this.options.brushPreview) this.cellQuad(voxel, x, y, points)
    const geometry = this.brushMesh.geometry
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
    geometry.computeBoundingSphere()
    this.brushMesh.visible = points.length > 0 && !this.playing
  }

  private updateHover(): void {
    const address = this.options.hover
    const doc = this.reader.doc
    const points: number[] = []
    const voxel = address ? structureOf(doc, address.structure, 'voxel') : undefined

    if (address && voxel && (address.kind === SURFACE_TOP || address.kind === SURFACE_UNDER) && inBounds(voxel.size, address.x, address.y)) {
      // The top or the underside hovered, which in a column with air in it is not always its highest.
      const under = address.kind === SURFACE_UNDER
      const layer = faceNear(voxel, address.x, address.y, Math.floor(address.level / 2), under ? FACE_BOTTOM : FACE_TOP)
      if (layer !== null) this.cellQuad(voxel, address.x, address.y, points, under ? -0.04 : 0.04, under ? { flat: layer } : { layer })
    } else if (address && voxel && address.kind === SURFACE_CLIFF) {
      // Highlight exactly the band that was picked, so the artist can see the
      // level their paint would land on.
      const frame = frameOf(doc, voxel.id)
      const at = (lx: number, h: number, lz: number) => {
        const [wx, wz] = toWorld(frame, lx, lz)
        return [wx, frame.y + h, wz]
      }
      const geometry = [
        { origin: [1, 1], u: [0, -1] },
        { origin: [0, 1], u: [1, 0] },
        { origin: [0, 0], u: [0, 1] },
        { origin: [1, 0], u: [-1, 0] },
      ][address.dir]
      const ox = address.x + geometry.origin[0]
      const oz = address.y + geometry.origin[1]
      const ex = ox + geometry.u[0]
      const ez = oz + geometry.u[1]
      const bottom = address.level * 0.5
      const top = (address.level + 1) * 0.5
      const nudge = 0.012
      const nx = geometry.u[1] * nudge
      const nz = -geometry.u[0] * nudge
      points.push(
        ...at(ox + nx, bottom, oz + nz), ...at(ex + nx, bottom, ez + nz), ...at(ex + nx, top, ez + nz),
        ...at(ox + nx, bottom, oz + nz), ...at(ex + nx, top, ez + nz), ...at(ox + nx, top, oz + nz),
      )
    }

    const geometry = this.hoverMesh.geometry
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
    geometry.computeBoundingSphere()
    this.hoverMesh.visible = points.length > 0 && !this.playing
  }

  private updateSketch(): void {
    const sketch = this.options.sketch
    const visible = sketch !== null && sketch.points.length > 0 && !this.playing
    this.sketchLine.visible = visible && sketch.points.length > 1
    this.sketchPoints.visible = visible
    this.sketchSelected.visible = visible && sketch.selected !== null && sketch.points[sketch.selected] !== undefined
    if (!visible) return
    const flat = (list: ReadonlyArray<readonly [number, number, number]>) => new THREE.Float32BufferAttribute(list.flatMap((p) => [p[0], p[1], p[2]]), 3)
    const outline = sketch.closed && sketch.points.length > 2 ? [...sketch.points, sketch.points[0]] : sketch.points
    this.sketchLine.geometry.setAttribute('position', flat(outline))
    this.sketchLine.geometry.computeBoundingSphere()
    this.sketchPoints.geometry.setAttribute('position', flat(sketch.points))
    this.sketchPoints.geometry.computeBoundingSphere()
    if (sketch.selected !== null && sketch.points[sketch.selected]) {
      this.sketchSelected.geometry.setAttribute('position', flat([sketch.points[sketch.selected]]))
      this.sketchSelected.geometry.computeBoundingSphere()
    }
  }

  /**
   * The selected region as geometry: a face as the face, a voxel as its six sides, an edge as a ribbon folded over
   * it. Rebuilt only when the region or the document has changed — a region can hold thousands of elements, and
   * unlike the hover it does not move with the pointer.
   */
  private updateRegion(): void {
    const region = this.options.region
    const preview = this.options.regionPreview
    const revision = this.reader.revision
    const handles = this.options.moveHandles
    this.moveHandles.visible = handles !== null && !this.playing
    if (handles) {
      this.moveHandles.position.set(handles[0], handles[1], handles[2])
      this.moveHandles.scale.setScalar(this.handleLength())
    }
    this.regionMesh.visible = region !== null && !this.playing
    this.regionLines.visible = this.regionMesh.visible
    this.previewMesh.visible = preview !== null && !this.playing
    this.previewLines.visible = this.previewMesh.visible
    if (region !== this.drawnRegion || revision !== this.drawnRegionRevision) {
      this.drawnRegion = region
      this.drawnRegionRevision = revision
      this.drawRegion(region, this.regionMesh, this.regionLines)
    }
    if (preview !== this.drawnPreview || revision !== this.drawnPreviewRevision) {
      this.drawnPreview = preview
      this.drawnPreviewRevision = revision
      this.drawRegion(preview, this.previewMesh, this.previewLines)
    }
  }

  private drawRegion(region: Region | null, mesh: THREE.Mesh, outline: THREE.LineSegments): void {
    const points: number[] = []
    const lines: number[] = []
    const voxel = region ? structureOf(this.reader.doc, region.structure, 'voxel') : undefined
    if (region && voxel) {
      const frame = frameOf(this.reader.doc, voxel.id)
      const at = (lx: number, h: number, lz: number): number[] => {
        const [wx, wz] = toWorld(frame, lx, lz)
        return [wx, frame.y + h, wz]
      }
      const quad = (a: number[], b: number[], c: number[], d: number[]): void => {
        points.push(...a, ...b, ...c, ...a, ...c, ...d)
        lines.push(...a, ...b, ...b, ...c, ...c, ...d, ...d, ...a)
      }
      /** A cell-local corner's height on the top of the voxel at layer `y`, in world units: its own surface, so a ramp's top is followed. */
      const cornerAt = (x: number, z: number, y: number, cx: number, cz: number): number => cornerHeightsAt(voxel, x, z, y)[[[0, 1], [3, 2]][cx][cz]] * 0.5
      /** A voxel's top, in world units: a slab or a ramp stands half as high as a cube. */
      const topOf = (x: number, z: number, y: number): number => y + shapeHeight(voxelAt(voxel, x, z, y)) * 0.5
      const side = (dir: number): { ox: number; oz: number; ux: number; uz: number } => {
        const g = [{ o: [1, 1], u: [0, -1] }, { o: [0, 1], u: [1, 0] }, { o: [0, 0], u: [0, 1] }, { o: [1, 0], u: [-1, 0] }][dir]
        return { ox: g.o[0], oz: g.o[1], ux: g.u[0], uz: g.u[1] }
      }
      const face = (x: number, z: number, y: number, dir: number, inflate = 0): void => {
        if (dir === FACE_TOP || dir === FACE_BOTTOM) {
          // A top with air over it follows its slope, wherever in the column it is; a buried one, and every underside, is level.
          const onTop = dir === FACE_TOP && y >= 0 && voxelAt(voxel, x, z, y + 1) === AIR
          const h = (cx: number, cz: number): number => (dir === FACE_BOTTOM ? y - inflate : onTop ? cornerAt(x, z, y, cx, cz) + inflate : (y < 0 ? 0 : topOf(x, z, y)) + inflate)
          quad(at(x, h(0, 0), z), at(x, h(0, 1), z + 1), at(x + 1, h(1, 1), z + 1), at(x + 1, h(1, 0), z))
          return
        }
        const { ox, oz, ux, uz } = side(dir)
        const [nx, nz] = DIR_VECTORS[dir]
        const [x0, z0, x1, z1] = [x + ox + nx * inflate, z + oz + nz * inflate, x + ox + ux + nx * inflate, z + oz + uz + nz * inflate]
        quad(at(x0, y, z0), at(x1, y, z1), at(x1, topOf(x, z, y), z1), at(x0, topOf(x, z, y), z0))
      }
      for (const key of region.keys) {
        if (region.element === 'face') {
          const f = parseFaceKey(key)
          face(f.x, f.z, f.y, f.dir)
        } else if (region.element === 'voxel') {
          const v = parseVoxelKey(key)
          // A hair larger than the voxel, so its sides stand clear of the terrain's own and of the voxel beside it.
          for (const dir of [0, 1, 2, 3, FACE_TOP, FACE_BOTTOM]) face(v.x, v.z, v.y, dir, 0.01)
        } else {
          const e = parseEdgeKey(key)
          const { ox, oz, ux, uz } = side(e.dir)
          const [nx, nz] = DIR_VECTORS[e.dir]
          const RIBBON = 0.12
          // The wall's line: along its top at the column's own heights, or along its foot at the heights of the ground it stands on.
          const [bx, bz] = [e.x + nx, e.z + nz]
          const beside = inBounds(voxel.size, bx, bz)
          const heightAt = (cx: number, cz: number): number => (e.end === 'top' ? cornerAt(e.x, e.z, columnTopAt(voxel, e.x, e.z), cx, cz) : beside ? cornerAt(bx, bz, columnTopAt(voxel, bx, bz), cx - nx, cz - nz) : 0)
          const [h0, h1] = [heightAt(ox, oz), heightAt(ox + ux, oz + uz)]
          const [x0, z0, x1, z1] = [e.x + ox, e.z + oz, e.x + ox + ux, e.z + oz + uz]
          // Folded over the edge: a strip on the wall, and a strip on the level beside it — the top's own for a top, the ground's for a foot.
          const up = e.end === 'top' ? -RIBBON : RIBBON
          const out = e.end === 'top' ? -RIBBON : RIBBON
          quad(at(x0 + nx * 0.01, h0, z0 + nz * 0.01), at(x1 + nx * 0.01, h1, z1 + nz * 0.01), at(x1 + nx * 0.01, h1 + up, z1 + nz * 0.01), at(x0 + nx * 0.01, h0 + up, z0 + nz * 0.01))
          quad(at(x0, h0 + 0.01, z0), at(x1, h1 + 0.01, z1), at(x1 + nx * out, h1 + 0.01, z1 + nz * out), at(x0 + nx * out, h0 + 0.01, z0 + nz * out))
        }
      }
    }
    mesh.geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
    mesh.geometry.computeBoundingSphere()
    outline.geometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3))
    outline.geometry.computeBoundingSphere()
  }

  private updateSelection(): void {
    const target = this.options.selection
    const box = target && !this.playing ? this.scene.boundsOf(target) : null
    if (!box) {
      this.selectionBox.visible = false
      return
    }
    this.selectionBox.box.copy(box)
    this.selectionBox.visible = true
    this.selectionBox.updateMatrixWorld(true)
  }

  private viewContext(): ObjectViewContext {
    return {
      rig: this.reader.doc.camera,
      nearest: this.filtering === 'nearest',
      facingOverride: null,
    }
  }

  private togglePlay(session: PlaySession | null): void {
    if (session && !this.character) {
      const start = new THREE.Vector3(session.start[0], session.start[1], session.start[2])
      this.character = new Character(this.scene.sprites.hero, this.viewContext(), start)
      this.scene.scene.add(this.character.view.group)
      this.orbit.distance = Math.min(this.orbit.distance, 14)
    } else if (!session && this.character) {
      this.scene.scene.remove(this.character.view.group)
      this.character.dispose()
      this.character = null
    }
    this.overlay.visible = session === null
  }

  private ndc(event: PointerEvent): [number, number] {
    const rect = this.canvas.getBoundingClientRect()
    return [
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    ]
  }

  private modifiers(event: PointerEvent | MouseEvent): PointerModifiers {
    return {
      shift: event.shiftKey,
      alt: event.altKey,
      ctrl: event.ctrlKey || event.metaKey,
    }
  }

  private pickAt(event: PointerEvent, lookPast?: ReadonlySet<string>): EditorPick {
    const started = this.profile ? performance.now() : 0
    const [x, y] = this.ndc(event)
    // Carrying something, the pick looks past it and through objects: what matters is where it would land.
    const through = event.ctrlKey || event.metaKey || (lookPast !== undefined && lookPast.size > 0)
    const pick = { ...this.picker.pick(this.scene, this.camera, x, y, through, lookPast), handle: this.handleAt(event), axis: this.axisAt(event) }
    this.profile?.pick(performance.now() - started)
    return pick
  }

  /** Within this many CSS pixels of a drawn point, the pointer is on it. */
  private static readonly HANDLE_PX = 10

  /**
   * How long Move's handles are, in world units, so that they are the same size on screen wherever the camera is: a
   * handle a tile and a half long is a speck from across a map and a wall up close.
   */
  private handleLength(): number {
    const origin = this.options.moveHandles
    if (!origin) return 1
    if (this.camera instanceof THREE.OrthographicCamera) return ((this.camera.top - this.camera.bottom) / this.camera.zoom) * MOVE_HANDLE_SCREEN
    const distance = this.camera.position.distanceTo(new THREE.Vector3(origin[0], origin[1], origin[2]))
    const fov = this.camera instanceof THREE.PerspectiveCamera ? this.camera.fov : 50
    return 2 * distance * Math.tan((fov * Math.PI) / 360) * MOVE_HANDLE_SCREEN
  }

  /** The Move handle under the pointer: the one whose drawn shaft the pointer is within a few pixels of, on screen. */
  private axisAt(event: PointerEvent): MoveAxis | null {
    const origin = this.options.moveHandles
    if (!origin || this.playing) return null
    const rect = this.canvas.getBoundingClientRect()
    const [px, py] = [event.clientX - rect.left, event.clientY - rect.top]
    const onScreen = (x: number, y: number, z: number): [number, number] | null => {
      const p = new THREE.Vector3(x, y, z).project(this.camera)
      return p.z > 1 ? null : [((p.x + 1) / 2) * rect.width, ((1 - p.y) / 2) * rect.height]
    }
    const from = onScreen(origin[0], origin[1], origin[2])
    if (!from) return null
    let best: MoveAxis | null = null
    let bestDistance = Viewport.HANDLE_PX
    const length = this.handleLength()
    for (const axis of MOVE_AXES) {
      const to = onScreen(origin[0] + axis.direction[0] * length, origin[1] + axis.direction[1] * length, origin[2] + axis.direction[2] * length)
      if (!to) continue
      // The pointer's distance from the shaft as drawn; its first fifth is left to whatever is under the handles' meeting point.
      const [dx, dy] = [to[0] - from[0], to[1] - from[1]]
      const along = Math.max(0.2, Math.min(1, ((px - from[0]) * dx + (py - from[1]) * dy) / Math.max(1e-6, dx * dx + dy * dy)))
      const distance = Math.hypot(px - (from[0] + dx * along), py - (from[1] + dy * along))
      if (distance < bestDistance) {
        bestDistance = distance
        best = axis.id
      }
    }
    return best
  }

  private handleAt(event: PointerEvent): SketchHandle | null {
    const sketch = this.options.sketch
    if (!sketch || this.playing) return null
    const rect = this.canvas.getBoundingClientRect()
    const px = event.clientX - rect.left
    const py = event.clientY - rect.top
    let best: SketchHandle | null = null
    let bestDistance = Viewport.HANDLE_PX
    sketch.points.forEach(([x, y, z], index) => {
      const projected = new THREE.Vector3(x, y, z).project(this.camera)
      if (projected.z > 1) return
      const sx = ((projected.x + 1) / 2) * rect.width
      const sy = ((1 - projected.y) / 2) * rect.height
      const distance = Math.hypot(sx - px, sy - py)
      if (distance < bestDistance) {
        bestDistance = distance
        best = { structure: sketch.structure, index }
      }
    })
    return best
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.canvas.setPointerCapture(event.pointerId)
    this.lastPointer = { x: event.clientX, y: event.clientY }
    // Any press takes the camera back from an alignment in flight.
    this.glide = null

    // A left press on the view cube is the cube's, never the level's: it
    // either drags the orbit or, released where it landed, aligns the view.
    const onCube = event.button === 0 && !this.playing ? this.cubePointAt(event) : null
    if (onCube) {
      this.cubePress = { piece: this.cube.pieceAt(onCube[0], onCube[1]), x: event.clientX, y: event.clientY, moved: false }
      return
    }

    // Which gesture this is, is not decided here any more. A left press is
    // picked unconditionally — including an alt press, which may yet turn out
    // to be an eyedropper click rather than an orbit — because the pick has to
    // be taken at the press to be the press's, and one raycast per click is
    // not worth arbitrating over.
    const pick = event.button === 0 ? this.pickAt(event) : null
    const handleY = pick?.handle ? this.options.sketch?.points[pick.handle.index]?.[1] : undefined
    this.strokePlaneY = handleY ?? pick?.point?.y ?? null
    this.panGrab = event.button === 2 ? this.grabAt(event) : null
    // Which press of a run of quick presses in one place this is. A `pointerdown` carries no click count of its own
    // (`detail` is a `click`'s), so it is counted here: within the usual double-click time, and a few pixels.
    const now = performance.now()
    const last = this.lastPress
    const again = last !== null && event.button === last.button && now - last.at < 450 && Math.hypot(event.clientX - last.x, event.clientY - last.y) < 6
    this.lastPress = { at: now, x: event.clientX, y: event.clientY, button: event.button, clicks: again ? last.clicks + 1 : 1 }
    this.handlers.onPointerDown({
      x: event.clientX,
      y: event.clientY,
      button: event.button,
      modifiers: this.modifiers(event),
      pick,
      clicks: this.lastPress.clicks,
    })
  }

  private onPointerMove = (event: PointerEvent): void => {
    const dx = event.clientX - this.lastPointer.x
    const dy = event.clientY - this.lastPointer.y
    this.lastPointer = { x: event.clientX, y: event.clientY }

    if (this.cubePress) {
      if (!this.cubePress.moved && Math.hypot(event.clientX - this.cubePress.x, event.clientY - this.cubePress.y) > 4) this.cubePress.moved = true
      if (this.cubePress.moved) this.turn(dx, dy)
      return
    }

    const gesture = this.handlers.onPointerMove({ x: event.clientX, y: event.clientY, modifiers: this.modifiers(event) })
    // An alt press that crossed the threshold on THIS event answers 'orbit',
    // so its first frame of travel turns the camera rather than being eaten.
    if (gesture === 'orbit') {
      this.turn(dx, dy)
      return
    }
    if (gesture === 'pan') {
      this.pan(event, dx, dy)
      return
    }
    // Still undeclared: no hover either, exactly as before — an alt press
    // jittering under the threshold must not repaint the highlight.
    if (gesture === 'pending') return
    if (this.playing) return

    // Over the cube, the cube lights up and the level under it does not.
    const onCube = gesture === 'none' ? this.cubePointAt(event) : null
    this.cubeHot = onCube !== null
    this.cube.highlight(onCube ? (this.cube.pieceAt(onCube[0], onCube[1])?.id ?? null) : null)
    this.canvas.style.cursor = onCube && this.cube.pieceAt(onCube[0], onCube[1])?.view ? 'pointer' : ''
    if (onCube) {
      this.handlers.onHover({ surface: null, point: null, objectId: null, distance: Infinity, ray: null, handle: null, axis: null })
      return
    }

    const pick = this.pickAt(event, gesture === 'stroke' ? this.handlers.carrying() : undefined)
    this.handlers.onHover(pick)
    if (gesture === 'stroke') {
      const [ndcX, ndcY] = this.ndc(event)
      const onPlane = this.strokePlaneY === null ? null : this.picker.pickPlane(this.camera, ndcX, ndcY, this.strokePlaneY)
      this.handlers.onStrokeMove({ ...pick, plane: onPlane ? { x: onPlane.x, z: onPlane.z } : null }, this.modifiers(event))
    }
  }

  private onPointerUp = (event: PointerEvent): void => {
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId)
    }
    this.panGrab = null
    if (this.cubePress) {
      const { piece, moved } = this.cubePress
      this.cubePress = null
      if (!moved && piece?.view) this.alignTo(piece.view)
      return
    }
    this.handlers.onPointerUp({ x: event.clientX, y: event.clientY })
  }

  /** One orbit step: the middle or alt drag, and a drag on the view cube. */
  private turn(dx: number, dy: number): void {
    this.orbit.yaw = wrapDegrees(this.orbit.yaw - dx * 0.4)
    this.orbit.pitch = Math.min(89, Math.max(-5, this.orbit.pitch + dy * 0.3))
  }

  /**
   * A click on a view-cube piece: glide the camera to its view — or, already
   * there, flip the projection, the way a second press of a view key does in
   * a modelling tool.
   */
  private alignTo(view: { yaw: number; pitch: number }): void {
    if (ViewCube.atView(this.orbit, view)) {
      this.handlers.onProjectionToggle()
      return
    }
    this.glide = { t: 0, from: { yaw: this.orbit.yaw, pitch: this.orbit.pitch }, to: view }
  }

  /** Where the pointer is within the view cube's corner, as fractions of it, or null when it is outside. */
  private cubePointAt(event: PointerEvent): [number, number] | null {
    const rect = this.canvas.getBoundingClientRect()
    const { x, y, size } = this.cubeRect()
    const fx = (event.clientX - rect.left - x) / size
    const fy = (event.clientY - rect.top - y) / size
    return fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1 ? [fx, fy] : null
  }

  /** The cube's corner in CSS pixels from the canvas's top-left: top right, clear of the layer slider's column. */
  private cubeRect(): { x: number; y: number; size: number } {
    const size = Math.min(84, Math.max(56, Math.round(this.canvas.clientHeight * 0.12)))
    return { x: this.canvas.clientWidth - size - Viewport.CUBE_MARGIN_RIGHT, y: Viewport.CUBE_MARGIN_TOP, size }
  }

  private static readonly CUBE_MARGIN_RIGHT = 40
  private static readonly CUBE_MARGIN_TOP = 12

  /**
   * The cube, drawn over the level in its corner: the same renderer, a
   * scissored viewport, the depth cleared so the level never pokes through.
   * Not while playing — the game has no cube.
   */
  private renderCube(dt: number): void {
    if (this.playing) return
    const { x, y, size } = this.cubeRect()
    const height = this.canvas.clientHeight || 1
    this.cube.orient(this.orbit.yaw, this.orbit.pitch)
    // Solid while the pointer is on it or holds it; faded back otherwise, eased so it neither pops nor lags.
    const wanted = this.cubeHot || this.cubePress ? 1 : CUBE_REST_OPACITY
    this.cubeOpacity += (wanted - this.cubeOpacity) * Math.min(1, dt * 12)
    this.cube.setOpacity(this.cubeOpacity)
    const renderer = this.renderer
    renderer.autoClear = false
    renderer.setScissorTest(true)
    renderer.setViewport(x, height - y - size, size, size)
    renderer.setScissor(x, height - y - size, size, size)
    renderer.clearDepth()
    renderer.render(this.cube.scene, this.cube.camera)
    renderer.setScissorTest(false)
    renderer.setViewport(0, 0, this.canvas.clientWidth || 1, height)
    renderer.autoClear = true
  }

  /**
   * The camera the frame wants: the rig's projection under the game camera
   * and in play, the editor's own otherwise. Swapped in place when it
   * changes; the orbit places it and the render pass is re-pointed.
   */
  private ensureProjection(rig: DeepReadonly<CameraRig>): void {
    const wanted = this.options.gameCamera || this.playing ? rig.projection : this.options.projection
    const isOrtho = this.camera instanceof THREE.OrthographicCamera
    if ((wanted === 'orthographic') === isOrtho) return
    this.camera = createCamera(rig, (this.canvas.clientWidth || 1) / (this.canvas.clientHeight || 1), wanted)
    this.renderPass.camera = this.camera
  }

  /**
   * The point a right press takes hold of: whatever surface is under the
   * cursor, objects included, or — over the sky — the point on the plane at
   * the orbit target's height. Null only when the ray misses that plane too
   * (looking up, the plane behind the camera).
   */
  private grabAt(event: PointerEvent): THREE.Vector3 | null {
    const [x, y] = this.ndc(event)
    const hit = this.picker.pick(this.scene, this.camera, x, y).point
    if (hit) return hit.clone()
    return this.picker.pickPlane(this.camera, x, y, this.orbit.target.y)
  }

  /**
   * A pan holds the pixel that was pressed under the cursor: the ray through
   * this event's cursor is cast onto the plane of the grabbed point, and the
   * rig slides by the difference (`panToHold`). The camera is placed at once,
   * not left for the next frame, so a second move landing in the same frame
   * casts from where the rig now is rather than where it was.
   *
   * The ray misses the plane when the cursor is above the horizon; that event
   * slides by pixels instead, scaled by distance, so the pan never freezes.
   */
  private pan(event: PointerEvent, dx: number, dy: number): void {
    if (this.panGrab) {
      const [x, y] = this.ndc(event)
      const under = this.picker.pickPlane(this.camera, x, y, this.panGrab.y)
      if (under) {
        panToHold(this.orbit, this.panGrab, under)
        applyRig(this.camera, this.orbit)
        this.camera.updateMatrixWorld()
        return
      }
    }
    const yaw = this.orbit.yaw * (Math.PI / 180)
    const scale = this.orbit.distance * 0.0016
    this.orbit.target.x -= (Math.cos(yaw) * dx - Math.sin(yaw) * dy) * scale
    this.orbit.target.z += (Math.sin(yaw) * dx + Math.cos(yaw) * dy) * scale
  }

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    const factor = Math.exp(event.deltaY * 0.0012)
    this.orbit.distance = Math.min(200, Math.max(3, this.orbit.distance * factor))
  }

  private onContextMenu = (event: Event): void => event.preventDefault()

  private onPointerLeave = (): void => {
    this.cubeHot = false
    this.cube.highlight(null)
    this.canvas.style.cursor = ''
  }

  private attachEvents(): void {
    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    this.canvas.addEventListener('pointermove', this.onPointerMove)
    this.canvas.addEventListener('pointerleave', this.onPointerLeave)
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerUp)
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.canvas.addEventListener('contextmenu', this.onContextMenu)
    window.addEventListener('resize', this.resize)
    // The canvas changes size without the window doing so: the inspector folding to its strip gives the stage its
    // width (found 2026-09-21: picks landed where the pointer had been, and the view cube sat off the canvas, because
    // the drawing buffer and the camera were still the old size). Watch the canvas itself; jsdom has no observer.
    if (typeof ResizeObserver !== 'undefined') {
      this.sizeObserver = new ResizeObserver(() => this.resize())
      this.sizeObserver.observe(this.canvas)
    }
  }

  private detachEvents(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('pointercancel', this.onPointerUp)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('contextmenu', this.onContextMenu)
    window.removeEventListener('resize', this.resize)
    this.sizeObserver?.disconnect()
    this.sizeObserver = null
  }

  resize = (): void => {
    const width = this.canvas.clientWidth || 1
    const height = this.canvas.clientHeight || 1
    this.renderer.setSize(width, height, false)
    this.composer.setSize(width, height)
    this.bloom.setSize(width, height)
    updateCameraProjection(this.camera, this.reader.doc.camera, width / height, this.orbit.distance)
  }

  private loop = (): void => {
    if (this.disposed) return
    this.frameHandle = requestAnimationFrame(this.loop)

    const profile = this.profile
    profile?.begin()
    const now = performance.now()
    const realDt = (now - this.lastTime) / 1000
    // Simulation uses a clamped step so a long stall does not teleport the
    // character, but the fps readout must use real time — clamping it made a
    // 2 fps software renderer report 20.
    const dt = Math.min(0.05, realDt)
    this.lastTime = now

    const doc = this.reader.doc
    const rig = doc.camera

    // --- camera ------------------------------------------------------------
    if (this.sweep.active) {
      this.sweep.t += dt * 0.25
      if (this.sweep.t >= 1) this.sweep.active = false
      const index = Math.min(
        this.sweep.yaws.length - 1,
        Math.floor(this.sweep.t * this.sweep.yaws.length),
      )
      this.orbit.yaw = this.sweep.yaws[index] ?? this.orbit.yaw
    }

    if (this.glide) {
      this.glide.t = Math.min(1, this.glide.t + dt / 0.3)
      const s = this.glide.t * this.glide.t * (3 - 2 * this.glide.t)
      this.orbit.yaw = wrapDegrees(this.glide.from.yaw + wrapDegrees(this.glide.to.yaw - this.glide.from.yaw) * s)
      this.orbit.pitch = this.glide.from.pitch + (this.glide.to.pitch - this.glide.from.pitch) * s
      if (this.glide.t >= 1) this.glide = null
    }

    if (this.options.gameCamera || this.playing) {
      const clamped = clampToBounds(rig, this.orbit)
      this.orbit.yaw = clamped.yaw
      this.orbit.pitch = clamped.pitch
      this.orbit.distance = clamped.distance
    }

    const insideEnvelope = withinBounds(rig, this.orbit)

    // --- play mode ---------------------------------------------------------
    if (this.playing && this.character) {
      const keys = this.handlers.heldKeys()
      const input = {
        forward: (keys.has('w') ? 1 : 0) - (keys.has('s') ? 1 : 0),
        strafe: (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0),
      }
      this.character.update(doc, input, this.orbit.yaw, dt, this.viewContext())
      // The camera trails the character rather than the map centre.
      this.orbit.target.lerp(
        new THREE.Vector3(this.character.position.x, this.character.position.y + 1, this.character.position.z),
        Math.min(1, dt * 6),
      )
    }

    this.ensureProjection(rig)
    updateCameraProjection(
      this.camera,
      rig,
      (this.canvas.clientWidth || 1) / (this.canvas.clientHeight || 1),
      this.orbit.distance,
    )
    applyRig(this.camera, this.orbit)
    profile?.mark()

    // --- scene -------------------------------------------------------------
    this.syncDirty()
    profile?.mark()
    this.scene.syncObjects(this.viewContext())
    this.scene.updateObjects(this.orbit.yaw, dt, this.viewContext())
    this.scene.sky.update(this.camera.position, this.scene.mapCentre())
    profile?.mark()

    this.grid.group.visible = this.options.showGrid && !this.playing
    this.updateBrushPreview()
    this.updateHover()
    this.updateSelection()
    this.updateRegion()
    this.updateSketch()

    if (!this.softwareRenderer) {
      this.bloom.strength = doc.atmosphere.bloom
    }

    profile?.mark()

    if (profile) this.gpuTimer?.begin()
    if (this.bypassComposer) this.renderer.render(this.scene.scene, this.camera)
    else this.composer.render()
    this.renderCube(dt)
    if (profile) {
      this.gpuTimer?.end()
      this.gpuTimer?.poll(this.recordGpu)
    }
    profile?.mark()

    // --- reporting ---------------------------------------------------------
    this.handlers.onCameraChange({
      yaw: this.orbit.yaw,
      pitch: this.orbit.pitch,
      distance: this.orbit.distance,
      inBounds: insideEnvelope,
    })

    this.fpsAccumulator += realDt
    this.fpsFrames += 1
    if (this.fpsAccumulator >= 0.5) {
      this.handlers.onStats({
        fps: this.fpsFrames / this.fpsAccumulator,
        // Not renderer.info.render.triangles: with a composer that reports the
        // last pass, which is a fullscreen quad.
        triangles: this.scene.stats.triangles,
        meshMs: this.scene.stats.lastMeshMs,
        missingTransitions: this.scene.missingTransitions(),
      })
      this.fpsAccumulator = 0
      this.fpsFrames = 0
    }
    profile?.mark()
    profile?.end()
  }

  /** Where on the ground a screen point lands, for object placement. */
  groundAt(ndcX: number, ndcY: number): THREE.Vector3 | null {
    const hit = this.picker.pick(this.scene, this.camera, ndcX, ndcY, true)
    if (hit.point) return hit.point
    return this.picker.pickPlane(this.camera, ndcX, ndcY, 0)
  }

  cellUnder(address: SurfaceAddress | null): number | null {
    if (!address) return null
    const voxel = structureOf(this.reader.doc, address.structure, 'voxel')
    if (!voxel || !inBounds(voxel.size, address.x, address.y)) return null
    return topHeight(voxel, address.x, address.y)
  }
}
