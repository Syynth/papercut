/**
 * Guided tour.
 *
 * Drives the editor through a scripted session in a headless browser and
 * captures a screenshot at each step, so the tool can be reviewed without
 * running it. Where possible it clicks the real UI rather than reaching into
 * the app, so the captures show authentic interaction.
 *
 *   node scripts/tour.mjs [outputDir] [--gpu]
 *
 * Writes numbered PNGs plus tour.json, which pairs each shot with its caption
 * for downstream use. Runs against Playwright's own bundled Chromium by
 * default (`pnpm browsers` installs it); see scripts/chromium-launch.mjs for
 * the --gpu / CHROMIUM_PATH knobs.
 */
import { chromium } from 'playwright'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromiumArgs, stripGpuFlag, wantsGpu } from './chromium-launch.mjs'
import { buildWorkspacePackages } from './build-workspace.mjs'
import { meanLuminance } from './luminance.mjs'

// Thresholds below were read off a real green run against the sample map
// (`node scripts/tour.mjs`, default SwiftShader path, as CI runs it) and are
// set with headroom under that reading, not at it — the point is to catch a
// collapse, not to pin the exact pixel this scene happens to render today.
//
// A black (or near-black) frame is this project's worst rendering
// regression — see FINDINGS.md, "Bloom renders black under software GL" —
// and it can clear every other check here: no console error, no thrown
// `expect()`, a perfectly ordinary status bar. Averaged over the WHOLE
// canvas rather than a small centre crop: a fixed crop can land on one dark
// cliff face or water tile by pure camera framing (measured 36 there on a
// known-good frame, against 82 for the same frame averaged over the full
// canvas) and a floor set to survive that framing accident would no longer
// separate "renders something" from "renders nothing". The whole-canvas
// average of a real black frame is still near zero regardless of framing, so
// 30 stays well clear of both the bug and this scene's own variation.
const LUMINANCE_FLOOR = 30
// A clean run reports "5k tris" in the status bar at the opening step (the
// sample map, default camera). A mesher that silently emitted nothing, or a
// scene that failed to load, reports 0; 1000 sits well under the real count
// without pinning the exact figure this map happens to produce today.
const TRIANGLE_FLOOR = 1000

// Vite's config, `index.html` and `dist/` all live with the app now, so both
// spawns below run from there rather than from the repo root.
const APP = fileURLToPath(new URL('../apps/editor', import.meta.url))

const GPU = wantsGpu()
const OUT = stripGpuFlag()[0] ?? 'shots/tour'
mkdirSync(OUT, { recursive: true })

// The packages' `dist/` has to exist before the bundle below can be assembled;
// see scripts/build-workspace.mjs for why, and why it lives there rather than
// in each of the three scripts that need it.
buildWorkspacePackages()

console.log('Building...')
const build = spawnSync('npx', ['vite', 'build'], { cwd: APP, stdio: ['ignore', 'ignore', 'inherit'] })
if (build.status !== 0) process.exit(build.status ?? 1)

const PORT = 4900 + Math.floor(Math.random() * 90)
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: APP,
  stdio: ['ignore', 'ignore', 'inherit'],
})

for (let i = 0; i < 80; i++) {
  try {
    const response = await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(1500) })
    if (response.ok) break
  } catch {
    /* not up yet */
  }
  await sleep(250)
}

/** @type {string[]} */
const problems = []
/** @type {{ file: string, caption: string }[]} */
const steps = []
let index = 0

const browser = await chromium.launch({
  // No executablePath by default: Playwright resolves its own bundled build
  // (`npx playwright install chromium`, or `pnpm browsers`), the only build
  // guaranteed to match the Playwright version in package.json. CHROMIUM_PATH
  // stays as an override for a machine that already pins its own browser.
  executablePath: process.env.CHROMIUM_PATH,
  args: chromiumArgs(GPU),
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.addInitScript(() => window.localStorage.clear())
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(m.text())
})
page.on('pageerror', (e) => problems.push(e.message))

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' })
await sleep(5000)

const stage = await page.$('.stage canvas')
if (!stage) throw new Error('".stage canvas" not found — did the editor mount?')
const box = await stage.boundingBox()
if (!box) throw new Error('".stage canvas" has no bounding box — is it hidden or zero-sized?')
const cx = box.x + box.width / 2
const cy = box.y + box.height / 2
// `shot` below is a hoisted `function` declaration, and `tsc` does not carry
// the null checks just above into it — see `probe.mjs`'s
// `boxX`/`boxY`/`boxW`/`boxH` destructuring for the same reason (an arrow
// function would keep the narrowing; a hoisted `function` does not).
const stageBox = box

/**
 * Capture a numbered screenshot with a caption.
 * @param {string} name
 * @param {string} caption
 * @param {{ settle?: number, viewportOnly?: boolean }} [options]
 */
async function shot(name, caption, { settle = 900, viewportOnly = false } = {}) {
  await sleep(settle)
  index += 1
  const file = `${String(index).padStart(2, '0')}-${name}.png`
  await page.screenshot({
    path: `${OUT}/${file}`,
    ...(viewportOnly ? { clip: stageBox } : {}),
  })
  steps.push({ file, caption })
  console.log(`  ${file}  ${caption}`)
}

/**
 * Click a button by its visible text, or — for the bar's icon-only buttons,
 * whose tooltip title is also their `aria-label` — by the start of that
 * title, scoped to a panel side.
 * @param {string} text
 * @param {string} [scope]
 */
async function clickText(text, scope = '') {
  const byText = page.locator(`${scope} button`, { hasText: new RegExp(`^${text}$`) })
  const byTitle = page.locator(`${scope} button[aria-label^="${text}"]`)
  await byText.or(byTitle).first().click()
  await sleep(400)
}

/** @param {Partial<{ yaw: number, pitch: number, distance: number }>} state */
async function camera(state) {
  await page.evaluate((s) => window.__viewport.setCameraForProbe(s), state)
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} distance
 */
async function focus(x, y, distance) {
  await page.evaluate(
    ([fx, fy, d]) => window.__viewport.focusCellForProbe(fx, fy, d),
    [x, y, distance],
  )
}

async function readout() {
  return page.evaluate(() =>
    [...document.querySelectorAll('.readout')].map((p) => p.textContent.replace(/\s+/g, ' ').trim()),
  )
}

/** The root volume's face paint, keyed by face: what a step's before and after are compared on. */
async function faceRecord() {
  return page.evaluate(() => {
    const doc = window.__host.reader.doc
    const ground = /** @type {import('@papercut/document').VoxelStructure} */ (doc.structures[doc.structureOrder[0]])
    return /** @type {Record<string, unknown>} */ (JSON.parse(JSON.stringify(ground.paint.faces)))
  })
}

async function statusBar() {
  return page.evaluate(() =>
    [...document.querySelectorAll('.status span')].map((s) => s.textContent.trim()),
  )
}

/**
 * Assert that a step actually did what its caption says.
 *
 * Every caption here is a claim about a screenshot, and a screenshot of a
 * no-op looks a lot like a screenshot of the real thing. Three captions in an
 * early run were wrong — a ramp click that landed on water, cliff painting
 * that landed on a terrain top, a coverage readout that never recomputed —
 * and all three looked plausible until the image was read closely. So each
 * step states a measurable consequence and the tour fails loudly without it.
 * @param {string} label
 * @param {() => unknown} fn
 */
async function expect(label, fn) {
  const value = await page.evaluate(fn)
  if (!value) throw new Error(`tour step failed its own check: ${label}`)
  return value
}

/** Counts the tour asserts against. */
async function counts() {
  return page.evaluate(() => {
    const doc = window.__host.reader.doc
    // The root voxel volume; the tour reads the grid as it always did.
    const ground = /** @type {import('@papercut/document').VoxelStructure} */ (doc.structures[doc.structureOrder[0]])
    // The column tops, derived the way `topHeight` derives them: the page has the raw document, not the helpers.
    const { width, height } = ground.size
    // The material the paint step brushes on; a top's material is its top face's first material layer.
    const path = window.__host.children.project.getSnapshot().context.project.materials.find((m) => m.name === 'Path')?.id ?? -1
    let ramps = 0
    let heightSum = 0
    let pathCells = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        for (let layer = ground.layers - 1; layer >= 0; layer--) {
          const i = (layer * height + y) * width + x
          const shape = ground.voxels.shape[i]
          if (shape === -1) continue
          if (shape >= 2) ramps += 1
          if (ground.paint.faces[`${x},${y},${layer},4`]?.[0] === `m:${path}`) pathCells += 1
          heightSum += layer * 2 + (shape === 1 || (shape >= 6 && shape < 10) ? 1 : 2)
          break
        }
      }
    }
    return {
      ramps,
      faces: Object.keys(ground.paint.faces).length,
      pathCells,
      tint: Object.keys(ground.paint.tint).length,
      objects: doc.objectOrder.length,
      heightSum,
    }
  })
}

console.log('\nCapturing tour...\n')

// ---------------------------------------------------------------- 1. opening
await shot('opening', 'First run opens the sample map, not an empty plane.')

// Structural signals a machine can judge reliably, per #56/#60: no pixel
// baselines yet (SwiftShader-vs-Metal and run-to-run GL noise would make
// tolerance tuning a treadmill), so CI asserts on things a rendering
// collapse actually breaks instead — a black frame, a mesh that produced no
// triangles. Checked at the very first frame: it is the earliest point a
// silent renderer failure could already be hiding behind a green console.
const openingLuma = await meanLuminance(page, box)
if (openingLuma < LUMINANCE_FLOOR) {
  throw new Error(
    `opening frame is too dark to be a real render: luma=${openingLuma.toFixed(1)}, floor=${LUMINANCE_FLOOR}`,
  )
}

// "Xk tris" in the fifth status-bar span — see App.tsx's <footer className="status">.
const openingTris = Number((await statusBar())[4].match(/([\d.]+)k tris/)?.[1]) * 1000
if (!(openingTris >= TRIANGLE_FLOOR)) {
  throw new Error(`mesh produced too few triangles to be real geometry: tris=${openingTris}, floor=${TRIANGLE_FLOOR}`)
}

// ---------------------------------------------------------------- 2. sculpt
await clickText('Terrain', '.left')
await page.keyboard.press(']')
await page.keyboard.press(']')
await page.keyboard.press(']')
await page.keyboard.press(']')
await clickText('Circle', '.left')
await page.mouse.move(cx - 60, cy + 40)
await shot('brush-preview', 'Brush preview: a round 5-cell brush, drawn on the terrain surface it will affect.')

const beforeSculpt = await counts()
await page.mouse.down()
for (let i = 0; i < 10; i++) {
  await page.mouse.move(cx - 60 + i * 14, cy + 40 - i * 6)
  await sleep(40)
}
await page.mouse.up()
const raised = (await counts()).heightSum - beforeSculpt.heightSum
await expect('raise changed the terrain', () => window.__host.reader.canUndo())
await shot(
  'sculpt-raise',
  `Dragging with Raise — ${raised} half-tiles of terrain moved. The whole stroke is one undo entry, not ten.`,
)

await page.keyboard.press('Control+z')
await expect(
  'one undo reverted the whole stroke',
  () => !window.__host.reader.canUndo() && window.__host.reader.canRedo(),
)
await shot('sculpt-undo', 'One Ctrl+Z takes the entire stroke back — the whole drag was a single entry.')

// ---------------------------------------------------------------- 3. ramps
// Aim squarely at a cliff face. "Ramp faces: click a cliff" means clicking
// anything else is a no-op — an earlier run clicked water and captured two
// identical screenshots captioned as a before and after.
async function faceCamera(distance = 10, pitch = 10) {
  const face = await page.evaluate(() => {
    const doc = window.__host.reader.doc
    // The root voxel volume; the tour reads the grid as it always did.
    const ground = /** @type {import('@papercut/document').VoxelStructure} */ (doc.structures[doc.structureOrder[0]])
    const { width, height } = ground.size
    /** @param {number} x @param {number} y */
    const columnTop = (x, y) => {
      for (let layer = ground.layers - 1; layer >= 0; layer--) {
        const i = (layer * height + y) * width + x
        const shape = ground.voxels.shape[i]
        if (shape === -1) continue
        return layer * 2 + (shape === 1 || (shape >= 6 && shape < 10) ? 1 : 2)
      }
      return 0
    }
    let best = { x: 0, y: 0, drop: -1, top: 0, bottom: 0 }
    for (let y = 2; y < ground.size.height - 2; y++) {
      for (let x = 2; x < ground.size.width - 2; x++) {
        const top = columnTop(x, y)
        const bottom = columnTop(x, y + 1)
        if (top - bottom > best.drop) best = { x, y, drop: top - bottom, top, bottom }
      }
    }
    return best
  })
  await page.evaluate(
    ([x, y, z, d]) => window.__viewport.setTargetForProbe(x, y, z, d),
    [face.x + 0.5, ((face.top + face.bottom) / 2) * 0.5, face.y + 1, distance],
  )
  await camera({ pitch, yaw: 0 })
  return face
}

/**
 * Find a screen pixel that is actually over a cliff face.
 *
 * Aiming the camera at a face is not the same as knowing where it landed on
 * screen, and a click that misses produces a screenshot of nothing happening.
 * So ask the editor: hover a spiral of candidate points and read the status
 * bar, which reports the picked surface. Searching outward from the centre
 * usually settles in a handful of probes.
 * @param {string} kind
 * @param {number} [radius]
 * @param {number} [step]
 */
async function findSurfacePixel(kind, radius = 200, step = 25) {
  const candidates = []
  for (let dy = -radius; dy <= radius; dy += step) {
    for (let dx = -radius; dx <= radius; dx += step) {
      candidates.push({ dx, dy, d: Math.hypot(dx, dy) })
    }
  }
  candidates.sort((a, b) => a.d - b.d)

  for (const { dx, dy } of candidates) {
    await page.mouse.move(cx + dx, cy + dy)
    await sleep(70)
    const label = (await statusBar())[0]
    if (label.startsWith(kind)) return { x: cx + dx, y: cy + dy, label }
  }
  return null
}

/**
 * @param {number} [radius]
 * @param {number} [step]
 */
const findCliffPixel = (radius, step) => findSurfacePixel('cliff', radius, step)
/**
 * Terrain top with no object in front of it: picking reports objects as no surface.
 * @param {number} [radius]
 * @param {number} [step]
 */
const findTopPixel = (radius, step) => findSurfacePixel('top', radius, step)

await clickText('Ramp', '.left')
for (let i = 0; i < 6; i++) await page.keyboard.press('[')
const rampFace = await faceCamera(11, 12)
const beforeRamps = (await counts()).ramps

const rampPixel = await findCliffPixel()
if (!rampPixel) throw new Error('no cliff face visible to put a ramp on')
await shot(
  'ramp-before',
  `The Ramp verb, hovering a cliff face. Picking resolves to a surface and a cell on it, not just a point in space — the status bar names it: "${rampPixel.label}".`,
  { settle: 1200 },
)

await page.mouse.move(rampPixel.x, rampPixel.y)
await page.mouse.down()
await page.mouse.up()
const afterRamps = (await counts()).ramps
if (afterRamps <= beforeRamps) {
  throw new Error('ramp click did not create a ramp — it missed the cliff face')
}
await shot(
  'ramp-after',
  'Clicking the cliff face turns that edge into a ramp. No direction had to be chosen — picking already resolved which side was clicked.',
)

// Same ramp from above, where the slope actually reads.
await page.evaluate(
  ([x, y, z, d]) => window.__viewport.setTargetForProbe(x, y, z, d),
  [rampFace.x + 0.5, ((rampFace.top + rampFace.bottom) / 2) * 0.5, rampFace.y + 1, 15],
)
await camera({ pitch: 38, yaw: 20 })
await shot(
  'ramp-above',
  'The same ramp from above. It drops exactly one tile, so it only reads correctly where the neighbour is one tile lower — the main limitation of the tool as it stands.',
  { settle: 1500 },
)

// ---------------------------------------------------------------- 4. paint
await focus(18, 18, 22)
await camera({ pitch: 36, yaw: 35 })
await page.keyboard.press('Tab')
await shot('paint-verbs', 'Tab switches to Paint. There is no tile palette: the Material brush sets what a surface IS, and the terrain set draws it.')

// The Material verb, with the path material, brushed onto the ground. The
// material is chosen through the same command the inspector's picker sends,
// and looked up by id rather than assumed to sit at a fixed index.
await clickText('Material', '.left')
await page.evaluate(() => {
  const path = window.__host.children.project.getSnapshot().context.project.materials.find((m) => m.name === 'Path')?.id ?? -1
  if (path < 0) throw new Error('the sample map has no "path" material to paint with')
  return window.__host.dispatch('terrain.params', { material: path })
})
await page.keyboard.press('[')
await page.keyboard.press('[')
const beforePaint = await counts()
await page.mouse.move(cx - 40, cy + 20)
await page.mouse.down()
for (let i = 0; i < 9; i++) {
  await page.mouse.move(cx - 40 + i * 16, cy + 20 + Math.sin(i / 2) * 14)
  await sleep(40)
}
await page.mouse.up()
const afterPaint = await counts()
const pathPainted = afterPaint.pathCells - beforePaint.pathCells
if (pathPainted <= 0) {
  throw new Error(`material painting did not set any top voxel to path: ${beforePaint.pathCells} path cells before, ${afterPaint.pathCells} after`)
}
await shot(
  'paint-material',
  `Painting the path material over the terrain — ${pathPainted} more cells now have path as their top voxel's material. Nothing is stamped on top: the terrain set's transitions are what draw the edge.`,
)

// ---------------------------------------------------------------- 5. tint
await clickText('Tint', '.left')
await page.mouse.move(cx + 30, cy - 20)
await page.mouse.down()
for (let i = 0; i < 7; i++) {
  await page.mouse.move(cx + 30 + i * 15, cy - 20 + i * 8)
  await sleep(40)
}
await page.mouse.up()
await expect('tint painting landed', () => Object.keys(/** @type {import('@papercut/document').VoxelStructure} */ (window.__host.reader.doc.structures[window.__host.reader.doc.structureOrder[0]]).paint.tint).length > 0)
await shot(
  'paint-tint',
  'The tint brush, quantised per cell — deliberately not smooth splatting, which looks mushy next to pixel art.',
)

// ------------------------------------------- 6. a face's paint moves with the surface
const cliff = await faceCamera(9, 8)
await clickText('Material', '.left')
await shot(
  'cliff-before',
  `A cliff face seen head on, ${cliff.drop} half-tiles tall, with the Material brush selected.`,
  { settle: 1600 },
)

// Paint bands of that face through the UI: on a side band the Material brush
// sets that face's first material layer. Find the face first, then walk up and
// down from it, checking the status bar still reports a cliff before each
// click so no stroke lands on a terrain top by accident.
const facesBefore = await faceRecord()
const cliffPixel = await findCliffPixel()
if (!cliffPixel) throw new Error('no cliff face visible to paint')
for (const dy of [-30, -10, 0, 10, 30]) {
  await page.mouse.move(cliffPixel.x, cliffPixel.y + dy)
  await sleep(120)
  const label = (await statusBar())[0]
  if (!label.startsWith('cliff')) continue
  await page.mouse.down()
  await page.mouse.up()
  await sleep(200)
}

const facesPainted = await faceRecord()
const painted = Object.keys(facesPainted).filter((key) => JSON.stringify(facesPainted[key]) !== JSON.stringify(facesBefore[key]))
if (painted.length === 0) {
  throw new Error('cliff painting did not land on any cliff face — captions would be wrong')
}
await shot(
  'cliff-painted',
  `Cliff bands painted one at a time — ${painted.length} faces. Each is keyed by voxel and side, never by a triangle, and holds four material layers rather than a tile.`,
)

// Now sculpt the cliff away.
// Through the command, not through a private write path: `terrain.flatten` is
// what the sculpt tool's own stroke ends up calling, so this step drives the
// editor rather than its insides.
await page.evaluate(
  (c) => window.__host.dispatch('terrain.flatten', { structure: window.__host.reader.doc.structureOrder[0], cells: [[c.x, c.y]], height: c.bottom }),
  cliff,
)
const facesLowered = await faceRecord()
const gone = painted.filter((key) => !(key in facesLowered))
if (gone.length === 0) {
  throw new Error('expected lowering the cliff to take the paint off the faces it removed')
}
const unpaintedLine = (await statusBar())[2]
await shot(
  'cliff-lowered',
  `Sculpting the cliff down. ${gone.length} painted faces went with the geometry: no paint is kept for faces that do not exist. The faces the edit uncovered took their neighbours' layers — "${unpaintedLine}".`,
)

await page.evaluate(() => window.__host.dispatch('undo'))
const facesRestored = await faceRecord()
if (!painted.every((key) => JSON.stringify(facesRestored[key]) === JSON.stringify(facesPainted[key]))) {
  throw new Error('undo did not bring the painted faces back as they were')
}
await shot(
  'cliff-restored',
  'Undo brings the cliff back with every painted face as it was: the sculpt recorded the paint it removed.',
)

// ---------------------------------------------------------------- 7. objects
await focus(18, 18, 20)
await camera({ pitch: 34, yaw: 35 })
await page.keyboard.press('2')
await shot('objects-tool', 'The Objects tool. Sprite picker on the left, properties on the right.')

const beforeObjects = (await counts()).objects
// Clicking an existing object selects it rather than placing a new one, so
// find bare terrain first.
const placePixel = await findTopPixel()
if (!placePixel) throw new Error('no bare terrain visible to place an object on')
await page.mouse.click(placePixel.x, placePixel.y)
const afterObjects = (await counts()).objects
if (afterObjects <= beforeObjects) throw new Error('object placement did not add an object')
await shot(
  'object-placed',
  'Placing drops the object onto the surface under the cursor and anchors it to that cell, so later sculpting carries it rather than burying it.',
)

// Show the facing/flip configuration on a four-facing object.
await expect('a four-facing statue exists to inspect', () => {
  const { reader } = window.__host
  const id = reader.doc.objectOrder.find((i) => reader.doc.objects[i].sprite === 'statue')
  if (!id) return false
  return window.__host.dispatch('selection.set', { id }).ok
})
await shot('facing-config', 'Facing and flip: 1/2/4/8 directional images, mirroring, back side, transition and hinge.')

// ---------------------------------------------------------------- 8. camera
await page.keyboard.press('3')
await shot('camera-free', 'The Camera tab. Yaw range is free 360°, and the coverage readout prices that.')

const freeCoverage = await readout()

await camera({ yaw: 140, pitch: 62 })
await shot(
  'camera-envelope',
  'Free orbit is always available while editing, but the viewport tints and warns when the view leaves the game’s envelope.',
)

await camera({ yaw: 35, pitch: 34 })
await clickText('Narrow', '.right')
const narrowCoverage = await readout()
if (narrowCoverage.join() === freeCoverage.join()) {
  throw new Error('coverage readout did not change with the bounds — it is stale')
}
await shot(
  'camera-narrow',
  'The same map with a narrow yaw range. Half the cliff faces become invisible from every permitted angle, so they never need painting — but the flat planes still read wrong, because narrowing the camera cannot fix an object that faces the wrong way.',
)

await clickText('Free', '.right')
await sleep(600)

// ---------------------------------------------------------------- 9. atmosphere
await page.locator('.right .tabs button', { hasText: 'atmosphere' }).click()
await sleep(500)
await focus(18, 18, 20)
await camera({ pitch: 30, yaw: 35 })
await shot('atmosphere', 'Atmosphere presets move fog, sky, lighting and post-processing together.')

await page.selectOption('.right select', 'Night festival')
await shot('atmosphere-night', 'Night festival: the lamp props carry their own point lights, so they light the ground.')

await page.selectOption('.right select', 'Misty dusk')
await shot('atmosphere-dusk', 'Misty dusk. Backdrop cards give distant scenery without anyone modelling a mountain.')

await page.selectOption('.right select', 'Clear noon')
await sleep(600)

// ---------------------------------------------------------------- 10. play mode
await page.keyboard.press('p')
await sleep(1500)
await page.keyboard.down('w')
await sleep(1200)
await page.keyboard.up('w')
await shot('play-mode', 'Play mode: WASD walks the map using the same runtime code the viewport renders through.', {
  settle: 700,
})
await page.keyboard.press('p')
await sleep(600)

// ---------------------------------------------------------------- 11. outliner
await page.locator('.right .tabs button', { hasText: 'outliner' }).click()
await shot('outliner', 'The outliner, with per-object hide and lock.')

writeFileSync(
  `${OUT}/tour.json`,
  JSON.stringify({ steps, freeCoverage, narrowCoverage }, null, 2),
)

console.log('\nCoverage, free rotation:')
for (const line of freeCoverage) console.log('  ' + line)
console.log('\nCoverage, narrow bounds:')
for (const line of narrowCoverage) console.log('  ' + line)

await browser.close()
server.kill()

if (problems.length > 0) {
  console.error('\nConsole errors:')
  for (const p of [...new Set(problems)]) console.error('  ' + p)
  process.exit(1)
}
console.log(`\n${steps.length} screenshots in ${OUT}/`)
