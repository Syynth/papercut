/**
 * Import RPG Maker MZ tilesets into a papercut project.
 *
 *   node scripts/import-mz.mjs <project folder> [--mz <MZ img folder>] [--families Outside,Inside,Dungeon]
 *
 * MZ autotiles are quarter-tile blocks: the engine builds each 48 px tile
 * from four 24 px quarters, chosen by which neighbours share the terrain.
 * Our dual grid wants whole tiles centred on cell corners, tagged by the
 * four cells around the corner — and a corner tile's four quarters are
 * exactly four such quarters, one from each cell, so every one of our 16
 * tiles per terrain composes from an MZ block without drawing anything.
 *
 * A2 blocks (2×3 tiles: preview, inner corners, then the big square) and
 * the A4 wall-top rows convert with inner corners; A3 and the A4 wall rows
 * (2×2 tiles, no inner corners) use the centre where an inner corner would
 * go. A name like "Dirt (Meadow)" in MZ's notes is dirt drawn OVER meadow:
 * it becomes our pair block, tagged under=meadow / over=dirt, with the
 * outside quarters filled from the meadow block's centre. A bare name is an
 * edge set: outside quarters transparent. A1 (animated water) is skipped —
 * water is its own tool — and A5, B, C are plain tiles, copied as sheets
 * with no terrain set. Character sheets are copied to `sprites/mz/` for the
 * object round to pick up; the project does not list them yet.
 *
 * The RTP licence limits these assets to RPG Maker games (brief §non-goals);
 * this imports a licensee's own install into their own private project.
 */

import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { decode, encode } from '../apps/export-cli/node_modules/fast-png/lib/index.js'

const DEFAULT_MZ = join(process.env.HOME ?? '', 'Library/Application Support/Steam/steamapps/common/RPG Maker MZ/RPGMZ.app/Contents/Resources/newdata/img')
const TILE = 48
const Q = TILE / 2

const args = process.argv.slice(2)
const project = args.find((a) => !a.startsWith('--'))
/** @param {string} name @param {string} fallback */
const opt = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : fallback
}
if (!project) {
  console.error('usage: node scripts/import-mz.mjs <project folder> [--mz <MZ img folder>] [--families Outside,Inside,Dungeon]')
  process.exit(1)
}
const projectDir = project
const mz = opt('mz', DEFAULT_MZ)
const families = opt('families', 'Outside,Inside,Dungeon').split(',')

/** @param {string} name */
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

/**
 * @typedef {{ width: number, height: number, data: Uint8Array }} Rgba
 * @typedef {{ inner: number[][] | null, center: number[][], outer: number[][], vertical: number[][], horizontal: number[][] }} Layout
 * @typedef {{ sx: number, sy: number, layout: Layout, name: string }} Block
 */

/** An MZ tileset is a palette PNG — one index per pixel, RGBA entries — so it is widened to RGBA here. @param {string} path @returns {Promise<Rgba>} */
async function readPng(path) {
  const png = decode(new Uint8Array(await readFile(path)))
  if (png.depth !== 8) throw new Error(`${path}: expected 8-bit, got ${png.depth}`)
  const pixels = png.width * png.height
  const data = new Uint8Array(pixels * 4)
  if (png.palette) {
    for (let i = 0; i < pixels; i++) {
      const [r, g, b, a = 255] = /** @type {number[]} */ (png.palette[png.data[i]])
      data[i * 4] = r
      data[i * 4 + 1] = g
      data[i * 4 + 2] = b
      data[i * 4 + 3] = a
    }
  } else if (png.channels === 4) data.set(png.data)
  else throw new Error(`${path}: expected RGBA or a palette, got ${png.channels} channels`)
  return { width: png.width, height: png.height, data }
}

/** @param {string} path @returns {Promise<string[]>} */
async function readNames(path) {
  try {
    const text = (await readFile(path, 'utf8')).replace(/^﻿/, '')
    return text.split(/\r?\n/).map((line) => line.split('|')[0].trim()).filter(Boolean)
  } catch {
    return []
  }
}

/** Copy the 24 px quarter at (sx, sy) quarters of `src` to (dx, dy) quarters of `dst`. @param {Rgba} src @param {number} sx @param {number} sy @param {Rgba} dst @param {number} dx @param {number} dy */
function blitQuarter(src, sx, sy, dst, dx, dy) {
  for (let y = 0; y < Q; y++) {
    const from = ((sy * Q + y) * src.width + sx * Q) * 4
    const to = ((dy * Q + y) * dst.width + dx * Q) * 4
    dst.data.set(src.data.subarray(from, from + Q * 4), to)
  }
}

/**
 * Where each kind of quarter sits inside an MZ block, in quarter units, by
 * the quarter's position within its own tile (0 NW, 1 NE, 2 SW, 3 SE).
 * `inner` is absent for a 2×2 block, which has no inner corners.
 */
/** @type {Layout} */
const LAYOUT_2x3 = {
  inner: [[2, 0], [3, 0], [2, 1], [3, 1]],
  center: [[1, 3], [2, 3], [1, 4], [2, 4]],
  outer: [[0, 2], [3, 2], [0, 5], [3, 5]],
  vertical: [[0, 3], [3, 3], [0, 4], [3, 4]],
  horizontal: [[1, 2], [2, 2], [1, 5], [2, 5]],
}
/** @type {Layout} */
const LAYOUT_2x2 = {
  inner: null,
  center: [[1, 1], [2, 1], [1, 2], [2, 2]],
  outer: [[0, 0], [3, 0], [0, 3], [3, 3]],
  vertical: [[0, 1], [3, 1], [0, 2], [3, 2]],
  horizontal: [[1, 0], [2, 0], [1, 3], [2, 3]],
}

/** The quarter of an MZ block a cell shows at position `p`, given whether its horizontal, vertical and diagonal neighbours share the terrain. @param {Layout} layout @param {number} p @param {boolean} h @param {boolean} v @param {boolean} d */
function pick(layout, p, h, v, d) {
  if (h && v) return d || !layout.inner ? layout.center[p] : layout.inner[p]
  if (v) return layout.vertical[p]
  if (h) return layout.horizontal[p]
  return layout.outer[p]
}

// Our corner order and bits: NW=1, NE=2, SW=4, SE=8 (packages/geometry/src/terrainset.ts).
// A corner tile's quarter at position T comes from the cell at T, at the cell's opposite position; its
// neighbours across the corner are the other three tags.
const QUARTERS = [
  { tile: 0, cell: 1, position: 3, h: 2, v: 4, d: 8 }, // NW quarter: cell NW's SE quarter; E is NE, S is SW, diagonal SE
  { tile: 1, cell: 2, position: 2, h: 1, v: 8, d: 4 }, // NE quarter: cell NE's SW quarter
  { tile: 2, cell: 4, position: 1, h: 8, v: 1, d: 2 }, // SW quarter: cell SW's NE quarter
  { tile: 3, cell: 8, position: 0, h: 4, v: 2, d: 1 }, // SE quarter: cell SE's NW quarter
]

/**
 * Compose the 16 dual-grid tiles for one MZ block into `dst` at block (column, row) of 4×4 tiles. `under` is the
 * block whose centre fills the outside quarters, or null for an edge set.
 */
/** @param {Rgba} src @param {number} sx @param {number} sy @param {Layout} layout @param {{ sx: number, sy: number, layout: Layout } | null} under @param {Rgba} dst @param {number} column @param {number} row */
function convertBlock(src, sx, sy, layout, under, dst, column, row) {
  for (let mask = 0; mask < 16; mask++) {
    const tx = (column + (mask & 3)) * 2
    const ty = (row + (mask >> 2)) * 2
    for (const q of QUARTERS) {
      const dx = tx + (q.tile & 1)
      const dy = ty + (q.tile >> 1)
      if (mask & q.cell) {
        const [px, py] = pick(layout, q.position, (mask & q.h) !== 0, (mask & q.v) !== 0, (mask & q.d) !== 0)
        blitQuarter(src, sx + px, sy + py, dst, dx, dy)
      } else if (under) {
        const [px, py] = under.layout.center[q.tile]
        blitQuarter(src, under.sx + px, under.sy + py, dst, dx, dy)
      }
    }
  }
}

/** The tags of tile `mask` of a template block, our `templateTags`: over at each corner whose bit is set, under elsewhere. */
/** @param {number} mask @param {string | null} under @param {string} over */
const templateTags = (mask, under, over) => [1, 2, 4, 8].map((bit) => (mask & bit ? over : under))

/** The average colour of a block's centre, as `#rrggbb`. @param {Rgba} src @param {number} sx @param {number} sy @param {Layout} layout */
function centreColour(src, sx, sy, layout) {
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (const [px, py] of layout.center) {
    for (let y = 0; y < Q; y++) {
      for (let x = 0; x < Q; x++) {
        const i = (((sy + py) * Q + y) * src.width + (sx + px) * Q + x) * 4
        if (src.data[i + 3] < 128) continue
        r += src.data[i]
        g += src.data[i + 1]
        b += src.data[i + 2]
        n++
      }
    }
  }
  if (n === 0) return '#808080'
  return `#${[r, g, b].map((c) => Math.round(c / n).toString(16).padStart(2, '0')).join('')}`
}

/** The blocks of a sheet: their origin in quarters, layout and name, for A2 (rows of 2×3), A3 (rows of 2×2) and A4 (alternating). */
/** @param {string} kind @param {number} width @param {number} height @param {string[]} names @returns {Block[]} */
function blocksOf(kind, width, height, names) {
  const perRow = width / (2 * TILE)
  /** @type {Block[]} */
  const blocks = []
  let y = 0
  let rowIndex = 0
  while (y < height) {
    const tall = kind === 'A2' || (kind === 'A4' && rowIndex % 2 === 0)
    const layout = tall ? LAYOUT_2x3 : LAYOUT_2x2
    const rowHeight = tall ? 3 * TILE : 2 * TILE
    for (let c = 0; c < perRow; c++) {
      const index = blocks.length
      const name = names[index] ?? `${kind} ${index + 1}`
      // A4 pairs each wall with the top it is capped by: two terrains, so a material can take one for its top faces
      // and the other for its sides.
      blocks.push({ sx: c * 4, sy: y / Q, layout, name: kind === 'A4' && tall ? `${name} (top)` : name })
    }
    y += rowHeight
    rowIndex++
  }
  return blocks
}

/**
 * "Dirt (Meadow)" → dirt over meadow, when a "Meadow" block is in the sheet; otherwise the parenthesis is a style —
 * "Wall I (Stone)" — and the whole name is the terrain's.
 */
/** @param {string} name @param {Set<string>} bases @returns {{ over: string, under: string | null }} */
function parseName(name, bases) {
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(name)
  if (m && bases.has(m[2].trim())) return { over: m[1].trim(), under: m[2].trim() }
  return { over: name.trim(), under: null }
}

/** @param {string} family @param {string} kind @param {string} outDir */
async function convertSheet(family, kind, outDir) {
  const file = `${family}_${kind}.png`
  const source = join(mz, 'tilesets', file)
  let src
  try {
    src = await readPng(source)
  } catch {
    return null
  }
  const names = await readNames(join(mz, 'tilesets', `${family}_${kind}.txt`))
  const blocks = blocksOf(kind, src.width, src.height, names)
  const perRow = src.width / (2 * TILE)
  const rows = Math.ceil(blocks.length / perRow)
  const dst = { width: perRow * 4 * TILE, height: rows * 4 * TILE, data: new Uint8Array(perRow * 4 * TILE * rows * 4 * TILE * 4) }

  // Terrains: every base name, and every name that only appears as an under-terrain. Ids are slugs; a clash gets a number.
  /** @type {{ id: string, name: string, color: string }[]} */
  const terrains = []
  /** @type {Map<string, string>} */
  const ids = new Map()
  /** @param {string} name */
  const idFor = (name) => {
    const known = ids.get(name)
    if (known) return known
    let id = slug(name) || 'terrain'
    let n = 2
    while ([...ids.values()].includes(id)) id = `${slug(name)}-${n++}`
    ids.set(name, id)
    return id
  }
  // The bare names first: a parenthesis is a pair only against one of these.
  const bases = new Set(blocks.map((b) => b.name).filter((n) => !/\(/.test(n)))
  /** @type {Map<string, Block>} */
  const byName = new Map()
  blocks.forEach((block) => {
    const { over, under } = parseName(block.name, bases)
    if (under === null) byName.set(over, block)
  })
  for (const block of blocks) {
    const { over, under } = parseName(block.name, bases)
    for (const name of [over, under]) {
      if (name === null || terrains.some((t) => t.name === name)) continue
      const own = byName.get(name)
      terrains.push({ id: idFor(name), name, color: own ? centreColour(src, own.sx, own.sy, own.layout) : centreColour(src, block.sx, block.sy, block.layout) })
    }
  }

  /** @type {Record<number, (string | null)[]>} */
  const tiles = {}
  blocks.forEach((block, index) => {
    const column = (index % perRow) * 4
    const row = Math.floor(index / perRow) * 4
    const { over, under } = parseName(block.name, bases)
    const underBlock = under === null ? null : (byName.get(under) ?? null)
    convertBlock(src, block.sx, block.sy, block.layout, underBlock ? { sx: underBlock.sx, sy: underBlock.sy, layout: underBlock.layout } : null, dst, column, row)
    for (let mask = 0; mask < 16; mask++) {
      const tileIndex = (row + (mask >> 2)) * (perRow * 4) + column + (mask & 3)
      tiles[tileIndex] = templateTags(mask, underBlock && under !== null ? idFor(under) : null, idFor(over))
    }
  })

  const outName = `${family}_${kind}.png`
  await writeFile(join(outDir, outName), encode({ width: dst.width, height: dst.height, data: dst.data, channels: 4 }))
  const pairs = blocks.filter((b) => parseName(b.name, bases).under !== null).length
  // The terrain set travels in the project file now (ruling of 2026-09-17), as part of the image's entry.
  return { path: `sheets/mz/${outName}`, name: `${family} ${kind}`, terrain: { terrains, tiles }, terrains: terrains.length, blocks: blocks.length, pairs }
}

/** @param {string} family @param {string} kind @param {string} outDir */
async function copySheet(family, kind, outDir) {
  const file = `${family}_${kind}.png`
  try {
    await copyFile(join(mz, 'tilesets', file), join(outDir, file))
  } catch {
    return null
  }
  return { path: `sheets/mz/${file}`, name: `${family} ${kind}`, terrain: { terrains: [], tiles: {} } }
}

async function main() {
  const sheetsDir = join(projectDir, 'sheets', 'mz')
  const spritesDir = join(projectDir, 'sprites', 'mz')
  await mkdir(sheetsDir, { recursive: true })
  await mkdir(spritesDir, { recursive: true })

  /** @type {{ path: string, name: string, terrain: { terrains: {id: string, name: string, color: string}[], tiles: Record<number, (string|null)[]> } }[]} */
  const entries = []
  /** @type {string[]} */
  const notes = []
  for (const family of families) {
    for (const kind of ['A2', 'A3', 'A4']) {
      const converted = await convertSheet(family, kind, sheetsDir)
      if (!converted) continue
      entries.push({ path: converted.path, name: converted.name, terrain: converted.terrain })
      notes.push(`${family}_${kind}: ${converted.blocks} blocks → ${converted.terrains} terrains, ${converted.pairs} pairs`)
    }
    for (const kind of ['A5', 'B', 'C', 'D', 'E']) {
      const copied = await copySheet(family, kind, sheetsDir)
      if (copied) entries.push(copied)
    }
  }
  let sprites = 0
  for (const file of await readdir(join(mz, 'characters'))) {
    if (!file.endsWith('.png')) continue
    await copyFile(join(mz, 'characters', file), join(spritesDir, file))
    sprites++
  }

  // The project: 48 px, and its sheet list replaced by the imported ones; the materials are left to a second pass.
  const projectFile = join(projectDir, 'papercut.json')
  const doc = JSON.parse(await readFile(projectFile, 'utf8'))
  doc.resolution = { ...doc.resolution, texelDensity: TILE }
  const kept = doc.images.filter((/** @type {{ path: string }} */ s) => !s.path.startsWith('sheets/mz/') && basename(s.path) !== 'ground.png')
  const grid = { tile: TILE, margin: { x: 0, y: 0 }, spacing: { x: 0, y: 0 } }
  doc.images = [...kept, ...entries.map((e) => ({ path: e.path, name: e.name, kind: 'tileset', hash: null, grid, terrain: e.terrain }))]
  await writeFile(projectFile, JSON.stringify(doc, null, 2))

  console.log(notes.join('\n'))
  console.log(`${entries.length} images listed, ${sprites} character sheets copied to sprites/mz/, project at ${TILE} px`)
}

await main()
