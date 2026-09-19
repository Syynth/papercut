/**
 * The runtime scene: what a level looks like, built from the document.
 *
 * Every structure gets a group placed by its frame — its origin, its
 * quarter-turn, the height of what it stands on — and the group holds what
 * the structure's kind meshes to: a voxel volume's chunks (solid and water,
 * in its own local cells), a sketch's five parts (cap, rim, wall body, top
 * and bottom bands), each dressed in the material the document names.
 * Objects and lights are level-level and live beside the structures.
 *
 * A change arrives as dirty keys from the store: a chunk key names one
 * chunk of one voxel volume; a structure id names a structure whose own
 * data, placement or parent changed, which rebuilds it whole (and, because
 * the store marks descendants too, everything standing on it).
 */

import * as THREE from 'three'
import {
  HALF,
  SURFACE_SKETCH_CAP,
  SURFACE_SKETCH_WALL,
  SURFACE_TOP,
  allChunkKeys,
  decodeExtra,
  frameOf,
  levelCentre,
  outlineOf,
  pointInOutline,
  toLocal,
  voxelTop,
  type SurfaceAddress,
  parseStructureChunkKey,
  structureChunkKey,
  type EdgeBand,
  type FillEdgeMaterial,
  type ReadonlyMapDoc,
  type ReadonlySketch,
  type ReadonlyVoxel,
  type RgbaImage,
  type SpriteAsset,
  type DocumentTarget,
  columnHeights,
  type MaterialDef,
} from '@papercut/document'
import { DEFAULT_FALLBACK, createTerrainLook, meshSketch, meshTerrainChunk, type EdgeSpec, type LoadedSet, type MeshBuffers, type SketchMesh, type TerrainLook } from '@papercut/geometry'
import { ObjectView, releaseReplaced, releaseTexture, rgbaTexture, spriteImages, type ObjectViewContext } from './billboard'
import { withinLayers, type LayerRange } from './layers'
import { SectionCut, VoxelCap, type SketchCap } from './section'
import { Sky, sunDirection } from './sky'
import { setStackUvs, stackLayers } from './stack'

function buildGeometry(buffers: MeshBuffers): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(buffers.positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(buffers.normals, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(buffers.uvs, 2))
  setStackUvs(geometry, buffers)
  geometry.setAttribute('color', new THREE.BufferAttribute(buffers.colors, 3))
  geometry.setIndex(new THREE.BufferAttribute(buffers.indices, 1))
  geometry.computeBoundingSphere()
  return geometry
}

interface ChunkView {
  solid: THREE.Mesh
  water: THREE.Mesh | null
  /** The fringes and pickets: geometry of their own, drawn one-sided texture on both sides. */
  trim: THREE.Mesh | null
  trimFaceAddr: Int32Array | null
  /** A dot on every corner no tile answered, shown while the editor asks for them. */
  marks: THREE.Points | null
  /** The distinct combinations no tile answered in this chunk, by name. */
  missing: readonly string[]
  faceAddr: Int32Array
  waterFaceAddr: Int32Array | null
  triangleCount: number
}

interface StructureView {
  group: THREE.Group
  chunks: Map<string, ChunkView>
  /** A sketch's parts, each with the face addresses a pick reads. */
  parts: Map<THREE.Mesh, Int32Array>
  /** What the layer view draws where its ceiling cuts this structure (`section.ts`). */
  cap: VoxelCap | SketchCap | null
  triangleCount: number
}

/**
 * After the viewport's overlays (900–901), so the water surface composites
 * over a preview drawn on the lake bed and the preview reads as under water.
 */
export const WATER_RENDER_ORDER = 1000
/** Above the water, above the caps: a mark is a note on the scene, not part of it. */
const MARK_RENDER_ORDER = 1010

export interface SceneStats {
  chunksBuilt: number
  triangles: number
  lastMeshMs: number
}

/** Whether two material lists draw the same: same ids in the same order, each with the same colour and trim settings. */
export function sameLook(a: readonly MaterialDef[], b: readonly MaterialDef[]): boolean {
  return a.length === b.length && a.every((m, i) => m.id === b[i].id && m.color === b[i].color && m.fringeAngle === b[i].fringeAngle && m.picketDistance === b[i].picketDistance)
}

export interface SceneAssets {
  /** The terrain sets the materials draw from, with their sheets — generated or the artist's. */
  terrain: LoadedSet[]
  /** The project's material library, in priority order: what a voxel's id means. */
  materials: readonly MaterialDef[]
  /** The project's resolution profile's filtering: nearest for pixel art. */
  filtering: 'nearest' | 'linear'
  /** The colour a face with nothing on it, and a corner no tile answers, is drawn: `DEFAULT_FALLBACK` unless given. */
  fallback?: number
  sprites: Record<string, SpriteAsset>
  /** Fill-and-edge textures by the names the document's surface materials use. */
  textures: Record<string, RgbaImage>
}

const SKETCH_PARTS = ['cap', 'rim', 'wallBody', 'wallTop', 'wallBottom'] as const
type SketchPart = (typeof SKETCH_PARTS)[number]

function bandSpec(band: EdgeBand | undefined): EdgeSpec {
  // A material without the band still meshes with a hair-thin one; the part is then not added.
  return band ? { width: band.width, segment: band.segment, repeat: band.repeat } : { width: 0.01, segment: 1, repeat: 'tile' }
}

/** What the mesher needs from a sketch and the two materials it names. */
export function sketchMeshOf(doc: ReadonlyMapDoc, sketch: ReadonlySketch): SketchMesh {
  const cap = doc.surfaceMaterials[sketch.capMaterial] as FillEdgeMaterial | undefined
  const wall = doc.surfaceMaterials[sketch.wallMaterial] as FillEdgeMaterial | undefined
  return meshSketch(
    { points: sketch.points.map((p) => ({ ...p })) },
    {
      height: sketch.layers * HALF,
      cap: { fillScale: cap?.fill.scale ?? 0.5, rim: bandSpec(cap?.rim) },
      wall: { bodyScale: wall?.fill.scale ?? 0.5, top: bandSpec(wall?.top), bottom: bandSpec(wall?.bottom) },
      lip: sketch.lip,
      profile: { points: sketch.wall.points.map((p) => ({ ...p })), smooth: sketch.wall.smooth },
    },
  )
}

/** Which of a sketch's parts a material band dresses, and with what texture; `null` when the material has no such band. */
function textureForPart(doc: ReadonlyMapDoc, sketch: ReadonlySketch, part: SketchPart): string | null {
  const cap = doc.surfaceMaterials[sketch.capMaterial] as FillEdgeMaterial | undefined
  const wall = doc.surfaceMaterials[sketch.wallMaterial] as FillEdgeMaterial | undefined
  switch (part) {
    case 'cap':
      return cap?.fill.texture ?? null
    case 'rim':
      return cap?.rim?.texture ?? null
    case 'wallBody':
      return wall?.fill.texture ?? null
    case 'wallTop':
      return wall?.top?.texture ?? null
    case 'wallBottom':
      return wall?.bottom?.texture ?? null
  }
}

export class RuntimeScene {
  readonly scene = new THREE.Scene()
  /** Every structure's group; picking and export walk this. */
  readonly terrainGroup = new THREE.Group()
  readonly objectGroup = new THREE.Group()
  readonly sky = new Sky()
  sprites: Record<string, SpriteAsset>
  stats: SceneStats = { chunksBuilt: 0, triangles: 0, lastMeshMs: 0 }

  private structures = new Map<string, StructureView>()
  private views = new Map<string, ObjectView>()
  private terrainMaterial: THREE.MeshStandardMaterial
  /** Fringe flaps and pickets: the atlas, one layer, seen from either side, cut out by alpha like the terrain. */
  private trimMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, alphaTest: 0.5, side: THREE.DoubleSide })
  private waterMaterial: THREE.MeshStandardMaterial
  /** The marks on corners no tile answered: drawn over everything, sized in pixels, magenta so they cannot be mistaken for art. */
  private markMaterial = new THREE.PointsMaterial({ color: 0xe04fc0, size: 7, sizeAttenuation: false, depthTest: false, transparent: true })
  private showMissing = false
  private surfaceMaterials = new Map<string, THREE.MeshStandardMaterial>()
  private sets: LoadedSet[]
  /** The look the chunks were meshed with: the atlas and what each material draws with. Replaced whole, never edited. */
  private look: TerrainLook
  /** The project's materials the look was built from. */
  private materials: readonly MaterialDef[]
  private filtering: 'nearest' | 'linear'
  /** The colour a face with nothing on it, and a corner no tile answers, is drawn. */
  private fallback: number
  /** Which material layers the terrain shader draws: one 0-or-1 per layer (`stack.ts`). */
  private stackShown: { value: THREE.Vector4 }
  /** The atlas image on the GPU, and the atlas version it was taken at. */
  private atlasImage: RgbaImage | null = null
  private atlasVersion = -1
  private textures: Record<string, RgbaImage>
  private sun = new THREE.DirectionalLight(0xffffff, 1)
  private hemisphere = new THREE.HemisphereLight(0xffffff, 0x444444, 1)
  private pointLights = new Map<string, THREE.PointLight>()
  private doc: ReadonlyMapDoc
  private layers: LayerRange | null = null
  /** The layer view, cut on the GPU: every solid material clips at its ceiling and caps what it cut (`section.ts`). */
  readonly section = new SectionCut()

  constructor(doc: ReadonlyMapDoc, assets: SceneAssets) {
    this.doc = doc
    this.sets = assets.terrain
    this.materials = assets.materials
    this.filtering = assets.filtering
    this.fallback = assets.fallback ?? DEFAULT_FALLBACK
    this.look = createTerrainLook(this.materials, this.sets, this.fallback)
    this.sprites = assets.sprites
    this.textures = assets.textures

    this.terrainMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: 0,
      alphaTest: 0.5,
    })
    this.waterMaterial = new THREE.MeshStandardMaterial({
      color: 0x3f7fb0,
      transparent: true,
      opacity: 0.66,
      roughness: 0.25,
      metalness: 0,
      // A translucent surface that wrote depth would hide whatever the editor
      // draws on the lake bed under it — the brush preview, the hover. It
      // draws last instead (`WATER_RENDER_ORDER`) and tints what is below.
      depthWrite: false,
    })
    this.section.solid(this.terrainMaterial)
    this.stackShown = stackLayers(this.terrainMaterial)
    this.section.solid(this.trimMaterial)
    this.section.clip(this.waterMaterial)

    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    const shadowCamera = this.sun.shadow.camera
    shadowCamera.near = 0.5
    shadowCamera.far = 200
    shadowCamera.left = -60
    shadowCamera.right = 60
    shadowCamera.top = 60
    shadowCamera.bottom = -60
    this.sun.shadow.bias = -0.0009
    this.sun.shadow.normalBias = 0.02

    this.scene.add(this.sky.group)
    this.scene.add(this.terrainGroup)
    this.scene.add(this.objectGroup)
    this.scene.add(this.sun)
    this.scene.add(this.sun.target)
    this.scene.add(this.hemisphere)

    this.applyAtlas(true)
    this.applyAtmosphere()
  }

  setDocument(doc: ReadonlyMapDoc): void {
    this.doc = doc
  }

  /** Draw the terrain from these terrain sets — an artist's, or the generated one — remeshing every chunk against them. */
  refreshTerrain(sets: LoadedSet[]): void {
    this.sets = sets
    this.relook()
  }

  /** The materials are the look: their terrains and their order. Every chunk was meshed against the old list, so all are remeshed. */
  setMaterials(materials: readonly MaterialDef[]): void {
    if (materials === this.materials) return
    // Only what the look reads — ids, terrains, colours and order — remeshes; a rename lands in the chips alone.
    const same = sameLook(materials, this.materials)
    this.materials = materials
    if (!same) this.relook()
  }

  /** Nearest or linear sampling for every texture: the atlas, the sprites, the sketch fills. */
  setFiltering(filtering: 'nearest' | 'linear'): void {
    if (filtering === this.filtering) return
    this.filtering = filtering
    this.dropViews()
    this.applyAtlas(true)
    for (const material of this.surfaceMaterials.values()) material.dispose()
    this.surfaceMaterials.clear()
    this.sky.apply(this.doc.atmosphere, this.sprites, this.filtering === 'nearest')
  }

  /** The transitions no tile answers somewhere on screen, named once each: the artist's to-do list (spec §3). Counted over the chunks as they stand, so painting a corner over takes it off the list. */
  missingTransitions(): readonly string[] {
    const names = new Set<string>()
    for (const view of this.structures.values()) for (const chunk of view.chunks.values()) for (const combo of chunk.missing) names.add(combo)
    return [...names].sort()
  }

  /** The colour a face with nothing on it, and a corner no tile answers, is drawn: a new atlas, so everything remeshes. */
  setFallback(color: number): void {
    if (color === this.fallback) return
    this.fallback = color
    this.relook()
  }

  /** Show or hide each material layer in the view: four flags, bottom layer first. Nothing is remeshed. */
  setMaterialLayersShown(shown: readonly boolean[]): void {
    this.stackShown.value.set(...([0, 1, 2, 3].map((l) => (shown[l] === false ? 0 : 1)) as [number, number, number, number]))
  }

  private relook(): void {
    this.look = createTerrainLook(this.materials, this.sets, this.fallback)
    for (const [id, view] of this.structures) {
      const voxel = this.doc.structures[id]
      if (!voxel || voxel.kind !== 'voxel') continue
      for (const key of [...view.chunks.keys()]) this.buildChunk(view, voxel, key)
      view.triangleCount = [...view.chunks.values()].reduce((sum, c) => sum + c.triangleCount, 0)
    }
    this.applyAtlas(true)
  }

  /** Draw objects and backdrops with `sprites`, and give back the GPU textures of images the new set no longer has. */
  setSprites(sprites: Record<string, SpriteAsset>): void {
    const previous = this.sprites
    this.sprites = sprites
    this.dropViews()
    this.sky.apply(this.doc.atmosphere, this.sprites, this.filtering === 'nearest')
    releaseReplaced(spriteImages(previous), spriteImages(sprites))
  }

  /**
   * Upload the atlas when it changed: the fallback tile, made the first
   * time a corner needs it, fills it, and a new look replaces it. `force` re-uploads an unchanged atlas, for a
   * filtering change. Each upload is a new image object, so the texture it
   * replaces is released by hand.
   */
  private applyAtlas(force = false): void {
    const { atlas } = this.look
    if (!force && atlas.version === this.atlasVersion) return
    const image = atlas.image
    this.terrainMaterial.map = rgbaTexture(image, this.filtering === 'nearest')
    this.terrainMaterial.needsUpdate = true
    this.trimMaterial.map = this.terrainMaterial.map
    this.trimMaterial.needsUpdate = true
    if (this.atlasImage && this.atlasImage !== image) releaseTexture(this.atlasImage)
    this.atlasImage = image
    this.atlasVersion = atlas.version
  }

  private dropViews(): void {
    for (const view of this.views.values()) view.dispose()
    this.views.clear()
    this.objectGroup.clear()
    this.pointLights.clear()
  }

  applyAtmosphere(): void {
    const atmosphere = this.doc.atmosphere
    this.scene.fog = new THREE.Fog(atmosphere.fogColor, atmosphere.fogNear, atmosphere.fogFar)
    this.sun.color.setHex(atmosphere.sunColor)
    this.sun.intensity = atmosphere.sunIntensity
    const direction = sunDirection(atmosphere)
    const centre = this.mapCentre()
    this.sun.position.copy(centre).addScaledVector(direction, 80)
    this.sun.target.position.copy(centre)
    this.sun.target.updateMatrixWorld()
    this.hemisphere.color.setHex(atmosphere.skyHorizon)
    this.hemisphere.groundColor.setHex(atmosphere.fogColor)
    this.hemisphere.intensity = atmosphere.ambientIntensity
    this.sky.apply(atmosphere, this.sprites, this.filtering === 'nearest')
  }

  /** The middle of the level's extent, derived from its structures. */
  mapCentre(): THREE.Vector3 {
    const [x, , z] = levelCentre(this.doc)
    return new THREE.Vector3(x, 0, z)
  }

  // --- structures -------------------------------------------------------------

  /**
   * Narrow (or widen) the height range drawn: the section cut's plane and uniforms, and which objects show. Nothing
   * is rebuilt — see `section.ts`.
   */
  setLayerRange(range: LayerRange | null): void {
    this.layers = range
    this.section.set(range)
  }

  /** Show or hide the marks on corners no tile answers: the artist's map of which transitions to draw. */
  setShowMissing(show: boolean): void {
    this.showMissing = show
    for (const view of this.structures.values()) for (const chunk of view.chunks.values()) if (chunk.marks) chunk.marks.visible = show
  }

  /**
   * Under the layer view, what the cut shows at a world point: the top of the structure the ceiling passes through
   * there — the one standing highest, if several do — as the surface a pick lands on. `null` with no range set, or
   * where nothing there reaches the ceiling. Picking asks this because the cap on screen is drawn from inner faces
   * below the ceiling, not from geometry at it.
   */
  capAt(worldX: number, worldZ: number): SurfaceAddress | null {
    const ceiling = this.section.ceiling
    if (ceiling === null) return null
    let best: { address: SurfaceAddress; base: number } | null = null
    const extra = decodeExtra(0)
    for (const id of this.doc.structureOrder) {
      const structure = this.doc.structures[id]
      if (!structure) continue
      const frame = frameOf(this.doc, id)
      if (frame.y >= ceiling) continue
      const [lx, lz] = toLocal(frame, worldX, worldZ)
      let address: SurfaceAddress | null = null
      if (structure.kind === 'voxel') {
        const top = voxelTop(structure, lx, lz)
        if (top !== null && frame.y + top > ceiling) address = { structure: id, kind: SURFACE_TOP, x: Math.floor(lx), y: Math.floor(lz), ...extra }
      } else if (structure.closed && structure.points.length >= 3 && frame.y + structure.layers * HALF > ceiling && pointInOutline(outlineOf(structure.points), lx, lz)) {
        address = { structure: id, kind: SURFACE_SKETCH_CAP, x: -1, y: 0, ...extra }
      }
      if (address && (best === null || frame.y >= best.base)) best = { address, base: frame.y }
    }
    return best?.address ?? null
  }

  private dropStructure(id: string): void {
    const view = this.structures.get(id)
    if (!view) return
    for (const chunk of view.chunks.values()) {
      chunk.solid.geometry.dispose()
      chunk.water?.geometry.dispose()
      chunk.trim?.geometry.dispose()
    }
    for (const mesh of view.parts.keys()) mesh.geometry.dispose()
    this.dropCap(view)
    this.terrainGroup.remove(view.group)
    this.structures.delete(id)
  }

  private dropCap(view: StructureView): void {
    if (!view.cap) return
    view.group.remove(view.cap.mesh)
    this.section.forget(view.cap.mesh)
    view.cap.dispose()
    view.cap = null
  }

  /** A voxel volume's cap, made at its footprint or made again when the footprint changed, holding its current heights. */
  private refreshVoxelCap(view: StructureView, voxel: ReadonlyVoxel): void {
    const current = view.cap
    let cap = current instanceof VoxelCap && current.width === voxel.size.width && current.height === voxel.size.height ? current : null
    if (!cap) {
      this.dropCap(view)
      cap = this.section.voxelCap(voxel.size.width, voxel.size.height)
      cap.mesh.userData.structureId = voxel.id
      view.group.add(cap.mesh)
      view.cap = cap
    }
    cap.update(columnHeights(voxel), view.group.position.y)
  }

  private placeGroup(group: THREE.Group, id: string): void {
    const frame = frameOf(this.doc, id)
    group.position.set(frame.x, frame.y, frame.z)
    this.structures.get(id)?.cap?.setBase(frame.y)
    // A quarter turn maps local (x, z) to (−z, x) in the document; three's Y rotation of −90° does the same.
    group.rotation.y = (-frame.yaw * Math.PI) / 2
  }

  private ensureStructure(id: string): StructureView {
    let view = this.structures.get(id)
    if (!view) {
      view = { group: new THREE.Group(), chunks: new Map(), parts: new Map(), cap: null, triangleCount: 0 }
      view.group.userData.structureId = id
      this.terrainGroup.add(view.group)
      this.structures.set(id, view)
    }
    this.placeGroup(view.group, id)
    return view
  }

  private buildChunk(view: StructureView, voxel: ReadonlyVoxel, key: string): void {
    const existing = view.chunks.get(key)
    if (existing) {
      view.group.remove(existing.solid)
      existing.solid.geometry.dispose()
      if (existing.water) {
        view.group.remove(existing.water)
        existing.water.geometry.dispose()
      }
      if (existing.trim) {
        view.group.remove(existing.trim)
        existing.trim.geometry.dispose()
      }
      if (existing.marks) {
        view.group.remove(existing.marks)
        existing.marks.geometry.dispose()
      }
      view.chunks.delete(key)
    }
    const { cx, cy } = parseStructureChunkKey(key)
    const mesh = meshTerrainChunk(voxel, `${cx},${cy}`, this.look)
    if (mesh.solid.triangleCount === 0 && !mesh.water) return

    const solid = new THREE.Mesh(buildGeometry(mesh.solid), this.terrainMaterial)
    solid.castShadow = true
    solid.receiveShadow = true
    solid.userData.chunkKey = key
    solid.userData.surface = 'solid'
    solid.userData.structureId = voxel.id
    view.group.add(solid)

    let water: THREE.Mesh | null = null
    if (mesh.water) {
      water = new THREE.Mesh(buildGeometry(mesh.water), this.waterMaterial)
      water.receiveShadow = true
      water.renderOrder = WATER_RENDER_ORDER
      water.userData.chunkKey = key
      water.userData.surface = 'water'
      water.userData.structureId = voxel.id
      view.group.add(water)
    }
    let trim: THREE.Mesh | null = null
    if (mesh.trim) {
      trim = new THREE.Mesh(buildGeometry(mesh.trim), this.trimMaterial)
      trim.castShadow = true
      trim.receiveShadow = true
      trim.userData.chunkKey = key
      trim.userData.surface = 'trim'
      trim.userData.structureId = voxel.id
      view.group.add(trim)
    }
    let marks: THREE.Points | null = null
    if (mesh.marks.length > 0) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(mesh.marks, 3))
      marks = new THREE.Points(geometry, this.markMaterial)
      marks.visible = this.showMissing
      marks.renderOrder = MARK_RENDER_ORDER
      marks.raycast = () => undefined
      view.group.add(marks)
    }
    view.chunks.set(key, { solid, water, trim, trimFaceAddr: mesh.trim?.faceAddr ?? null, marks, missing: mesh.missing, faceAddr: mesh.solid.faceAddr, waterFaceAddr: mesh.water?.faceAddr ?? null, triangleCount: mesh.solid.triangleCount })
  }

  private surfaceMaterial(textureName: string | null, band: boolean): THREE.MeshStandardMaterial {
    const key = `${textureName ?? '-'}:${band ? 'band' : 'fill'}`
    let material = this.surfaceMaterials.get(key)
    if (!material) {
      const image = textureName ? this.textures[textureName] : undefined
      material = new THREE.MeshStandardMaterial({
        map: image ? rgbaTexture(image, this.filtering === 'nearest') : null,
        color: image ? 0xffffff : 0xb06cd6,
        vertexColors: true,
        roughness: 1,
        metalness: 0,
        // Bands lie on the faces they dress: pushed toward the camera so they win the depth test.
        polygonOffset: band,
        polygonOffsetFactor: band ? -2 : 0,
        polygonOffsetUnits: band ? -2 : 0,
      })
      if (image) {
        const map = material.map as THREE.Texture
        map.wrapS = THREE.RepeatWrapping
        map.wrapT = band ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping
      }
      // Every solid surface is cut by the layer view, bands included: a band is a skin on the part it dresses.
      this.section.solid(material)
      this.surfaceMaterials.set(key, material)
    }
    return material
  }

  private buildSketch(view: StructureView, sketch: ReadonlySketch): void {
    // The cap draws the cap part's geometry, so it goes before that geometry does.
    this.dropCap(view)
    for (const mesh of view.parts.keys()) {
      view.group.remove(mesh)
      mesh.geometry.dispose()
    }
    view.parts.clear()
    if (!sketch.closed || sketch.points.length < 3) return

    const mesh = sketchMeshOf(this.doc, sketch)
    for (const part of SKETCH_PARTS) {
      const buffers = mesh[part]
      if (buffers.triangleCount === 0) continue
      const texture = textureForPart(this.doc, sketch, part)
      const band = part !== 'cap' && part !== 'wallBody'
      // A band the material does not have is not a part of this sketch.
      if (band && texture === null) continue
      // The mesher addresses every face by outline segment; the surface kind says cap or wall.
      const faceAddr = new Int32Array(buffers.faceAddr)
      for (let i = 0; i < faceAddr.length; i += 4) faceAddr[i] = part === 'cap' || part === 'rim' ? SURFACE_SKETCH_CAP : SURFACE_SKETCH_WALL
      const node = new THREE.Mesh(buildGeometry(buffers), this.surfaceMaterial(texture, band))
      node.castShadow = !band
      node.receiveShadow = true
      node.renderOrder = band ? 1 : 0
      node.userData.structureId = sketch.id
      node.userData.surface = 'solid'
      node.userData.part = part
      view.group.add(node)
      view.parts.set(node, faceAddr)
      if (part === 'cap') {
        const cap = this.section.sketchCap(node.geometry, view.group.position.y, sketch.layers * HALF)
        cap.mesh.userData.structureId = sketch.id
        view.group.add(cap.mesh)
        view.cap = cap
      }
    }
  }

  private buildStructure(id: string): void {
    const structure = this.doc.structures[id]
    if (!structure) {
      this.dropStructure(id)
      return
    }
    this.dropStructure(id)
    const view = this.ensureStructure(id)
    if (structure.kind === 'voxel') {
      for (const key of allChunkKeys(structure.size.width, structure.size.height)) {
        this.buildChunk(view, structure, structureChunkKey(id, ...(key.split(',').map(Number) as [number, number])))
      }
      this.refreshVoxelCap(view, structure)
    } else {
      this.buildSketch(view, structure)
    }
    view.triangleCount = [...view.chunks.values()].reduce((sum, c) => sum + c.triangleCount, 0) + [...view.parts.values()].reduce((sum, a) => sum + a.length / 4, 0)
  }

  /** Rebuild everything: the document's set of structures is authoritative. */
  rebuildAll(): void {
    const start = performance.now()
    const wanted = new Set(this.doc.structureOrder)
    for (const id of [...this.structures.keys()]) if (!wanted.has(id)) this.dropStructure(id)
    for (const id of this.doc.structureOrder) this.buildStructure(id)
    this.applyAtlas()
    this.finishStats(start, this.doc.structureOrder.length)
  }

  /**
   * Rebuild what the store marked: chunks of voxel volumes by key, structures whole by id. Structures that only moved
   * are re-placed — their group follows their frame, their meshes are untouched.
   */
  rebuild(dirty: { chunks: readonly string[]; structures: readonly string[]; moved?: readonly string[] }): void {
    const start = performance.now()
    const whole = new Set(dirty.structures)
    for (const id of whole) this.buildStructure(id)
    for (const id of dirty.moved ?? []) {
      const view = this.structures.get(id)
      if (view && !whole.has(id)) this.placeGroup(view.group, id)
    }
    let built = whole.size
    const touched = new Map<string, { view: StructureView; voxel: ReadonlyVoxel }>()
    for (const key of dirty.chunks) {
      const { structure } = parseStructureChunkKey(key)
      if (whole.has(structure)) continue
      const voxel = this.doc.structures[structure]
      if (!voxel || voxel.kind !== 'voxel') continue
      const view = this.ensureStructure(structure)
      this.buildChunk(view, voxel, key)
      view.triangleCount = [...view.chunks.values()].reduce((sum, c) => sum + c.triangleCount, 0)
      touched.set(structure, { view, voxel })
      built += 1
    }
    // Once per volume, not per chunk: the cap's height texture is the whole volume's.
    for (const { view, voxel } of touched.values()) this.refreshVoxelCap(view, voxel)
    // A corner nobody drew grows the atlas on first sight; the GPU copy follows once per rebuild.
    this.applyAtlas()
    this.finishStats(start, built)
  }

  private finishStats(start: number, built: number): void {
    let triangles = 0
    for (const view of this.structures.values()) triangles += view.triangleCount
    this.stats = { chunksBuilt: built, triangles, lastMeshMs: performance.now() - start }
  }

  /** The structure a terrain mesh belongs to — what a pick names alongside the face. */
  structureIdFor(mesh: THREE.Object3D): string {
    return mesh.userData.structureId as string
  }

  faceAddressFor(mesh: THREE.Object3D): Int32Array | null {
    const view = this.structures.get(mesh.userData.structureId as string)
    if (!view) return null
    const part = view.parts.get(mesh as THREE.Mesh)
    if (part) return part
    const chunk = view.chunks.get(mesh.userData.chunkKey as string)
    if (!chunk) return null
    return mesh.userData.surface === 'water' ? chunk.waterFaceAddr : mesh.userData.surface === 'trim' ? chunk.trimFaceAddr : chunk.faceAddr
  }

  /** Every structure mesh, solid and water, across every structure. */
  terrainMeshes(): THREE.Mesh[] {
    const out: THREE.Mesh[] = []
    // The layer view's caps are drawn over the terrain, not part of it: nothing picks, counts or exports them.
    for (const view of this.structures.values())
      for (const child of view.group.children) if ((child as THREE.Mesh).isMesh && child.userData.surface !== 'section') out.push(child as THREE.Mesh)
    return out
  }

  /** The ground alone — what a pick lands on; the water surface is looked through. */
  solidTerrainMeshes(): THREE.Mesh[] {
    return this.terrainMeshes().filter((mesh) => mesh.userData.surface !== 'water')
  }

  // --- objects ----------------------------------------------------------------

  syncObjects(context: ObjectViewContext): void {
    const wanted = new Set(this.doc.objectOrder)
    for (const [id, view] of this.views) {
      if (!wanted.has(id)) {
        this.objectGroup.remove(view.group)
        view.dispose()
        this.views.delete(id)
        const light = this.pointLights.get(id)
        if (light) {
          this.objectGroup.remove(light)
          this.pointLights.delete(id)
        }
      }
    }
    for (const id of this.doc.objectOrder) {
      const object = this.doc.objects[id]
      if (!object) continue
      const asset = this.sprites[object.sprite] ?? this.sprites.rock
      let view = this.views.get(id)
      if (!view) {
        view = new ObjectView(object, asset, context)
        view.group.userData.objectId = id
        this.views.set(id, view)
        this.objectGroup.add(view.group)
      } else if (view.object !== object) {
        view.rebuild(object, asset, context)
        view.group.userData.objectId = id
      }
      view.setPosition(object.position)
      if (asset.emissive) {
        let light = this.pointLights.get(id)
        if (!light) {
          light = new THREE.PointLight(0xffce8a, 0, 9, 1.6)
          this.pointLights.set(id, light)
          this.objectGroup.add(light)
        }
        const nightness = 1 - Math.min(1, this.doc.atmosphere.sunIntensity / 1.2)
        light.intensity = 3.2 * nightness * object.scale
        light.position.set(object.position[0], object.position[1] + asset.heightTiles * object.scale * 0.86, object.position[2])
      }
    }
  }

  updateObjects(cameraYaw: number, dt: number, context: ObjectViewContext): void {
    for (const view of this.views.values()) {
      view.update(cameraYaw, dt, context)
      if (this.layers !== null && !withinLayers(this.layers, view.object.position[1], HALF)) view.group.visible = false
    }
  }

  objectViews(): ObjectView[] {
    return [...this.views.values()]
  }

  /** The scene node a target is drawn as: an object's group, or a structure's. `null` when it is not in the scene. */
  nodeOf(target: DocumentTarget): THREE.Object3D | null {
    if (target.kind === 'object') return this.views.get(target.id)?.group ?? null
    return this.structures.get(target.id)?.group ?? null
  }

  /** The world bounds of a target, for a highlight to frame; `null` when it is not in the scene or draws nothing. */
  boundsOf(target: DocumentTarget): THREE.Box3 | null {
    const node = this.nodeOf(target)
    if (!node) return null
    const box = new THREE.Box3().setFromObject(node)
    return box.isEmpty() ? null : box
  }

  objectGroups(): THREE.Object3D[] {
    return [...this.views.values()].map((view) => view.group)
  }

  dispose(): void {
    for (const id of [...this.structures.keys()]) this.dropStructure(id)
    for (const view of this.views.values()) view.dispose()
    this.views.clear()
    this.terrainMaterial.dispose()
    this.trimMaterial.dispose()
    this.waterMaterial.dispose()
    this.markMaterial.dispose()
    for (const material of this.surfaceMaterials.values()) material.dispose()
    this.sky.dispose()
    if (this.atlasImage) releaseTexture(this.atlasImage)
    for (const image of [...spriteImages(this.sprites), ...Object.values(this.textures)]) releaseTexture(image)
  }
}
