/**
 * Map file in, `.glb` out.
 *
 * This is the whole app: it owns no export logic of its own and deliberately
 * cannot acquire any. Everything that decides what lands in the file lives
 * behind `@papercut/runtime/export`, so what the CLI writes and what the
 * editor's export button writes are the same bytes — which is the property
 * that makes a headless export worth having.
 */

import { readFile, writeFile } from 'node:fs/promises'

import { createProject, deserialize, sheetName } from '@papercut/document'
import { generatePlaceholderTerrainSet } from '@papercut/fixtures'
import { openProject } from '@papercut/project'
import { exportGltf } from '@papercut/runtime/export'

import { loadBakedAssets } from './baked-assets'
import { encodePngPure } from './encode-png'
import { installNodeFileReader } from './node-file-reader'
import { fastPngCodec, findProjectFolder, nodeFs } from './project-fs'

export interface ExportMapOptions {
  /** Merge static geometry per chunk for fewer draw calls, losing identity. */
  merge: boolean
}

export interface ExportMapResult {
  /** The document's own name, so a caller can report what it exported. */
  name: string
  bytes: number
  /** The project folder the map was exported under, or `null` for the default project. */
  project: string | null
  /** What the project's images had to say while loading, one line each. */
  warnings: string[]
}

export async function exportMapFile(
  inputPath: string,
  outputPath: string,
  options: ExportMapOptions,
): Promise<ExportMapResult> {
  installNodeFileReader()

  // `deserialize` is the same loader the editor uses, migrations and all, so a
  // map the editor can open is a map the CLI can export — and one it cannot is
  // rejected here with `LoadError` rather than half-exported.
  const doc = deserialize(await readFile(inputPath, 'utf8'))

  // The pre-baked stand-in for `generateSprites`: this app has no canvas to
  // draw them live with, which is the whole point (#48). The terrain set
  // needs none, so it is drawn here the way the editor draws it. A future
  // flag for an artist's own sheet would decode it through the same
  // `fast-png`, into the same `RgbaImage` shape, right here.
  const { sprites } = await loadBakedAssets()
  // The map's project, found by walking up to its `papercut.json`: its materials, its resolution and its images.
  // Without one the map exports under the default project, which is what a map made before there were projects
  // paints with. The generated placeholder stands in for the placeholder sheet when the project lists it and the
  // folder does not supply it; a project that does not list it has materials of its own under the placeholder's ids.
  const folder = await findProjectFolder(inputPath)
  const opened = folder === null ? { project: createProject(), sets: [], warnings: [], unlisted: [] } : await openProject(nodeFs, folder, fastPngCodec)
  const { project } = opened
  const generated = generatePlaceholderTerrainSet(project.resolution.texelDensity)
  const usable = opened.sets.filter((s) => s.set.tile === project.resolution.texelDensity)
  const listed = project.images.some((i) => sheetName(i.path) === sheetName(generated.set.sheet))
  const terrain = [...(listed && !usable.some((s) => s.set.sheet === sheetName(generated.set.sheet)) ? [generated] : []), ...usable]

  const bytes = new Uint8Array(await exportGltf(doc, { merge: options.merge, terrain, materials: project.materials, resolution: project.resolution, sprites, textures: {}, encodePng: encodePngPure }))
  await writeFile(outputPath, bytes)

  return { name: doc.name, bytes: bytes.byteLength, project: folder, warnings: opened.warnings }
}
