/**
 * Carry a project's format-4 maps across to format 5: a voxel stops naming a
 * material, and every face that draws carries its own four material layers
 * instead (ruling of 2026-09-18).
 *
 *   node scripts/convert-map-faces.mjs <project folder> [--dry-run]
 *
 * A ONE-SHOT script, like `convert-project-tags.mjs` and for the same reason:
 * papercut carries no format migrations in the loader, but an existing map
 * holds real work and the old file has everything the new one needs. Each
 * converted file is backed up beside itself first.
 *
 * What it does, per voxel volume. AIR moves from the material array into the
 * shape array and the material array goes. Then every face that draws gets the
 * stack that reproduces what it drew under format 4, on its first layer:
 *
 *   - a top: its face override, else its voxel's material;
 *   - a side: its face override, else its voxel's material, either way cut
 *     through that material's `side` — the old mesher looked every side up
 *     through `side`, override or not;
 *   - an empty column's floor: material 0, as the old mesher drew it.
 *
 * Face overrides on faces that do not draw — dormant paint — are dropped, and
 * counted. Last, `side` comes off every material in the project, since each
 * face now says what it is made of itself.
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const AIR = -1
const SHAPE_BLOCK = 0
const FACE_TOP = 4
const FACE_BOTTOM = 5
/** +X east, +Z south, -X west, -Z north: the document's side order. */
const DIRS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
]

/**
 * A format-4 map, as loosely as this needs to know it.
 * @typedef {{ formatVersion?: number, structures?: Record<string, any> }} OldMap
 */

/** @param {number} material @returns {[string, null, null, null]} */
const layersOf = (material) => [`m:${material}`, null, null, null]

/**
 * Convert one map in place. `sideOf` is the project's `side` by material id,
 * read before the project loses it.
 * @param {OldMap} map
 * @param {Map<number, number>} sideOf
 * @returns {{ faces: number, overrides: number, dropped: number }}
 */
export function convertMap(map, sideOf) {
  if (map.formatVersion !== 4) throw new Error(`This map is format ${map.formatVersion}; the converter reads format 4.`)
  const side = (/** @type {number} */ material) => sideOf.get(material) ?? material
  let faces = 0
  let overrides = 0
  let dropped = 0
  for (const structure of Object.values(map.structures ?? {})) {
    if (structure.kind !== 'voxel') continue
    const { width, height } = structure.size
    const layers = structure.layers
    /** @type {number[]} */
    const material = structure.voxels.material
    /** @type {number[]} */
    const shape = structure.voxels.shape.map((/** @type {number} */ s, /** @type {number} */ i) => (material[i] === AIR ? AIR : s))
    /** @type {Record<string, number>} */
    const old = structure.paint?.faces ?? {}
    const index = (/** @type {number} */ x, /** @type {number} */ z, /** @type {number} */ y) => (y * height + z) * width + x
    const shapeAt = (/** @type {number} */ x, /** @type {number} */ z, /** @type {number} */ y) =>
      x < 0 || z < 0 || x >= width || z >= height || y < 0 || y >= layers ? AIR : shape[index(x, z, y)]

    /** @type {Record<string, [string, null, null, null]>} */
    const next = {}
    const paint = (/** @type {string} */ key, /** @type {number} */ drawn) => {
      next[key] = layersOf(drawn)
      faces += 1
    }
    for (let z = 0; z < height; z++) {
      for (let x = 0; x < width; x++) {
        let top = -1
        for (let y = layers - 1; y >= 0; y--) {
          if (shapeAt(x, z, y) !== AIR) {
            top = y
            break
          }
        }
        if (top < 0) paint(`${x},${z},-1,${FACE_TOP}`, 0)
        for (let y = 0; y < layers; y++) {
          if (shapeAt(x, z, y) === AIR) continue
          const own = material[index(x, z, y)]
          const override = (/** @type {number} */ dir) => old[`${x},${z},${y},${dir}`]
          DIRS.forEach(([dx, dz], dir) => {
            if (shapeAt(x + dx, z + dz, y) !== SHAPE_BLOCK) paint(`${x},${z},${y},${dir}`, side(override(dir) ?? own))
          })
          if (shapeAt(x, z, y + 1) === AIR) paint(`${x},${z},${y},${FACE_TOP}`, override(FACE_TOP) ?? own)
          if (y > 0 && shapeAt(x, z, y - 1) === AIR) paint(`${x},${z},${y},${FACE_BOTTOM}`, override(FACE_BOTTOM) ?? own)
        }
      }
    }
    for (const key of Object.keys(old)) {
      overrides += 1
      if (!(key in next)) dropped += 1
    }
    structure.voxels = { shape }
    structure.paint = { faces: next, tint: structure.paint?.tint ?? {} }
  }
  map.formatVersion = 5
  return { faces, overrides, dropped }
}

/**
 * The project's `side` by material id, and the project without it.
 * @param {{ materials?: any[] }} project
 * @returns {Map<number, number>}
 */
export function takeSides(project) {
  /** @type {Map<number, number>} */
  const sides = new Map()
  for (const m of project.materials ?? []) {
    if (typeof m.side === 'number') sides.set(m.id, m.side)
    delete m.side
  }
  return sides
}

function main() {
  const [folder, flag] = process.argv.slice(2)
  if (!folder) {
    console.error('usage: node scripts/convert-map-faces.mjs <project folder> [--dry-run]')
    process.exit(2)
  }
  const dryRun = flag === '--dry-run'
  const projectPath = join(folder, 'papercut.json')
  const project = JSON.parse(readFileSync(projectPath, 'utf8'))
  const sides = takeSides(project)
  console.log(`${sides.size} materials cut their sides from another: ${[...sides].map(([m, s]) => `${m}→${s}`).join(', ') || 'none'}`)
  for (const path of project.maps ?? []) {
    const file = join(folder, path)
    const map = JSON.parse(readFileSync(file, 'utf8'))
    if (map.formatVersion !== 4) {
      console.log(`${path}: format ${map.formatVersion}, left alone`)
      continue
    }
    const { faces, overrides, dropped } = convertMap(map, sides)
    console.log(`${path}: ${faces} faces painted; ${overrides} face overrides carried, ${dropped} of them dormant and dropped`)
    if (dryRun) continue
    copyFileSync(file, `${file}.v4.bak`)
    writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`)
  }
  if (dryRun) return
  copyFileSync(projectPath, `${projectPath}.sides.bak`)
  writeFileSync(projectPath, `${JSON.stringify(project, null, 2)}\n`)
  console.log('written; the originals are beside them as .v4.bak and .sides.bak')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
