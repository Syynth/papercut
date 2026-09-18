/**
 * Carry a format-2 project across to format 3: tags that named a TERRAIN
 * become tags that name a MATERIAL (ruling of 2026-09-17).
 *
 *   node scripts/convert-project-tags.mjs <path to papercut.json> [--dry-run]
 *
 * A ONE-SHOT script, deliberately not a migration in the loader. The ruling
 * is that papercut carries no format migrations, and it should not: nobody is
 * shipping games on it yet and a migration path is a thing to maintain
 * forever. But an existing project holds real tagging work, and the old file
 * has everything needed to convert it, because each material said which
 * terrain it drew with. So the conversion exists exactly once, here, run by
 * hand, and the loader stays strict and refuses anything that is not format 3.
 *
 * What it does. Every `<sheet>/<terrain>` a material claimed through `top` or
 * `side` maps to that material's id. A terrain NO material claimed becomes a
 * new material, because under the new model there is nothing else it could be
 * and dropping its tags would throw the art away. Then every corner tag is
 * rewritten, `top` is deleted, `side` becomes a material id, a layout's
 * terrain list becomes a material list, and `unauthored` goes.
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const sheetName = (path) => String(path).slice(String(path).lastIndexOf('/') + 1)
const keyOf = (sheet, terrain) => `${sheet}/${terrain}`

/**
 * The conversion itself, over a parsed project, mutating it in place and
 * reporting what it did. Pure of the filesystem so a test can exercise the
 * mapping rules without a project folder.
 */
export function convert(project) {
  const materials = project.materials ?? []
  let nextId = materials.reduce((max, m) => Math.max(max, (m.id ?? 0) + 1), 0)

  /** `<sheet>/<terrain>` -> material id. `top` wins over `side`, because it is what the material IS. */
  const claim = new Map()
  for (const m of materials) if (m.top) claim.set(keyOf(m.top.sheet, m.top.terrain), m.id)
  for (const m of materials) if (m.side && !claim.has(keyOf(m.side.sheet, m.side.terrain))) claim.set(keyOf(m.side.sheet, m.side.terrain), m.id)

  // A terrain nothing claimed still has art, so it becomes a material rather than losing its tags.
  const invented = []
  for (const image of project.images ?? []) {
    const sheet = sheetName(image.path)
    for (const t of image.terrain?.terrains ?? []) {
      const key = keyOf(sheet, t.id)
      if (claim.has(key)) continue
      const colour = Number.parseInt(String(t.color ?? '#808080').replace(/^#/, ''), 16)
      const material = { id: nextId++, name: t.name || t.id, color: Number.isFinite(colour) ? colour : 0x808080, archetype: 'floor' }
      materials.push(material)
      claim.set(key, material.id)
      invented.push(`${material.name} (${key})`)
    }
  }

  let rewritten = 0
  let orphaned = 0
  for (const image of project.images ?? []) {
    const sheet = sheetName(image.path)
    const tiles = image.terrain?.tiles ?? {}
    for (const [index, tags] of Object.entries(tiles)) {
      tiles[index] = tags.map((tag) => {
        if (tag === null) return null
        const id = claim.get(keyOf(sheet, tag))
        if (id === undefined) {
          orphaned += 1
          return null
        }
        rewritten += 1
        return String(id)
      })
    }
    image.terrain = { tiles }
    if (image.layout) {
      image.layout.materials = (image.layout.terrains ?? []).map((t) => claim.get(keyOf(sheet, t)) ?? 0)
      delete image.layout.terrains
      delete image.layout.unauthored
    }
  }

  for (const m of materials) {
    const side = m.side ? claim.get(keyOf(m.side.sheet, m.side.terrain)) : undefined
    delete m.top
    // A side that resolves to the material itself said nothing, so it goes rather than being written out.
    if (side === undefined || side === m.id) delete m.side
    else m.side = side
  }

  project.materials = materials
  project.formatVersion = 3
  return { rewritten, orphaned, invented }
}

function main() {
  const [, , file, ...flags] = process.argv
  const dryRun = flags.includes('--dry-run')
  if (!file) {
    console.error('usage: node scripts/convert-project-tags.mjs <path to papercut.json> [--dry-run]')
    process.exitCode = 1
    return
  }
  const project = JSON.parse(readFileSync(file, 'utf8'))
  if (project.formatVersion === 3) {
    console.error(`${file} is already format 3; nothing to convert.`)
    process.exitCode = 1
    return
  }
  if (project.formatVersion !== 2) {
    console.error(`${file} is format ${String(project.formatVersion)}; this converts format 2.`)
    process.exitCode = 1
    return
  }
  const { rewritten, orphaned, invented } = convert(project)
  console.log(`${file}`)
  console.log(`  ${rewritten} corner tags rewritten across ${(project.images ?? []).length} images`)
  if (invented.length) console.log(`  ${invented.length} materials invented for unclaimed terrains: ${invented.join(', ')}`)
  if (orphaned) console.log(`  ${orphaned} tags named a terrain the file never defined; they are now nothing`)
  if (dryRun) {
    console.log('  --dry-run: nothing written')
    return
  }
  copyFileSync(file, `${file}.format2.bak`)
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`)
  console.log(`  written; the format-2 file is kept at ${file}.format2.bak`)
}

// Guarded so the test can import `convert` without the CLI running against a file that is not there.
if (process.argv[1] === fileURLToPath(import.meta.url)) main()
