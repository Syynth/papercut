/**
 * A sample map.
 *
 * "Defaults look decent" is one of the guiding principles, and an empty flat
 * plane on first run tests nothing. This builds a small landscape that
 * exercises every part of the prototype at once — height, cliffs, ramps,
 * water, painted overrides, tint, and a mix of objects with one, two and four
 * facings so the coverage readout has something to say.
 *
 * It is also the fixture the screenshot script drives, so a regression in any
 * of those shows up as a picture rather than as nothing at all.
 */

import {
  DEFAULT_MATERIALS,
  DIR_VECTORS,
  FACE_TOP,
  cellIndex,
  columnTopAt,
  MAPS_DIR,
  createMap,
  createProject,
  createSketch,
  defaultFacing,
  faceKey,
  fillColumn,
  groundHeight,
  layersOf,
  newId,
  rampShape,
  settleFaces,
  tintKey,
  topHeight,
  voxelIndex,
  type MapDoc,
  type MapObject,
  type ProjectDoc,
  type VoxelStructure,
} from '@papercut/document'

function hash(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453
  return n - Math.floor(n)
}

function place(
  doc: MapDoc,
  sprite: string,
  x: number,
  z: number,
  overrides: Partial<MapObject> = {},
): void {
  const object: MapObject = {
    id: newId(),
    name: sprite,
    sprite,
    // In the middle of the cell, where a snapped drag would put it.
    position: [x + 0.5, groundHeight(doc, x + 0.5, z + 0.5), z + 0.5],
    rotationY: Math.round((hash(x, z, 3) * 8 - 4)) * 45,
    scale: 0.85 + hash(x, z, 9) * 0.4,
    display: 'auto',
    facing: defaultFacing(),
    anchorCell: [Math.floor(x), Math.floor(z)],
    seed: Math.floor(hash(x, z, 5) * 65535),
    locked: false,
    hidden: false,
    ...overrides,
  }
  doc.objects[object.id] = object
  doc.objectOrder.push(object.id)
}

/** The project the sample map belongs to: the defaults, and the sample as its one map. */
export function createSampleProject(): ProjectDoc {
  const project = createProject('Sample Valley')
  project.maps = [`${MAPS_DIR}/sample-valley.map.json`]
  return project
}

export function createSampleMap(width = 36, height = 36): MapDoc {
  const doc = createMap(width, height, 'Sample Valley')
  const ground = doc.structures.ground as VoxelStructure
  // The sample paints with the project defaults (`createSampleProject`), named here so a renumbering shows up as an error.
  const material = (name: string): number => {
    const found = DEFAULT_MATERIALS.find((m) => m.name === name)
    if (!found) throw new Error(`The sample map wants a ${name} material.`)
    return found.id
  }
  const centreX = width / 2
  const centreY = height / 2

  // --- terrain -------------------------------------------------------------
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = cellIndex(ground.size, x, y)
      const dx = (x - centreX) / width
      const dy = (y - centreY) / height
      const distance = Math.hypot(dx, dy)

      // A bowl with a ridge on one side and a river valley through the middle.
      const ridge = Math.max(0, 1 - Math.abs(dx + 0.35) * 4) * 7
      const rolling = 2 + Math.sin(x * 0.31) * 1.2 + Math.cos(y * 0.27) * 1.2
      const river = Math.max(0, 1.6 - Math.abs(y - centreY - Math.sin(x * 0.22) * 3) * 0.55)

      let h = Math.round(rolling + ridge * (1 - distance) - river * 2.4)
      h = Math.max(0, Math.min(18, h))

      // Material follows height: sand low, grass mid, stone high. Grass, sand and path are cut from dirt at a cliff; stone and dirt are themselves.
      const top = h <= 1 ? material('Sand') : h >= 8 ? material('Stone') : hash(x, y, 1) > 0.88 ? material('Dirt') : material('Grass')
      fillColumn(ground, x, y, h, { material: top, sides: top === material('Stone') ? top : material('Dirt') })

      // Water pools in the river bed.
      if (h <= 1) ground.water[index] = 2
    }
  }

  // Ramps, so the character can climb in play mode rather than being walled in.
  //
  // A ramp drops exactly one full tile, so it only reads correctly where the
  // neighbour it descends toward is exactly two half-tiles lower. Rather than
  // carving a staircase and hoping, find the places the terrain already steps
  // down by one tile and turn some of those edges into ramps.
  const stepDowns: Array<[number, number, number]> = []
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const h = topHeight(ground, x, y)
      // A full ramp is a cube-tall shape: it wants a column standing on whole tiles, not a slab.
      if (h < 3 || h % 2 === 1) continue
      for (let dir = 0; dir < 4; dir++) {
        const [dx, dy] = DIR_VECTORS[dir]
        if (topHeight(ground, x + dx, y + dy) === h - 2) stepDowns.push([x, y, dir])
      }
    }
  }
  // Spread a handful around the map instead of clustering them.
  for (let i = 0; i < stepDowns.length; i += Math.max(1, Math.floor(stepDowns.length / 14))) {
    const [x, y, dir] = stepDowns[i]
    ground.voxels.shape[voxelIndex(ground, x, y, columnTopAt(ground, x, y))] = rampShape(dir)
  }
  settleFaces(ground)

  // --- paint -----------------------------------------------------------------
  // A worn path across the grass: the top face's first material layer, which
  // is what the Material brush sets, so the transition tiles around it are the dual grid's.
  const path = (x: number, y: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return
    const top = columnTopAt(ground, x, y)
    if (top >= 0) ground.paint.faces[faceKey(x, y, top, FACE_TOP)] = layersOf(material('Path'))
  }
  for (let step = 0; step < 22; step++) {
    const x = Math.round(4 + step)
    const y = Math.round(centreY + 6 + Math.sin(step * 0.4) * 2)
    path(x, y)
    if (hash(x, y, 7) > 0.6) path(x, y - 1)
  }

  // A band of stone painted onto one cliff face — the south side of the
  // voxel one below the top, where it shows.
  for (let x = 0; x < width; x++) {
    const z = Math.round(centreY - 8)
    const top = columnTopAt(ground, x, z)
    const key = faceKey(x, z, top - 1, 1)
    if (top >= 2 && ground.paint.faces[key]) ground.paint.faces[key] = layersOf(material('Stone'))
  }

  // A cool tint in the river bed, quantised per cell rather than blended.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (topHeight(ground, x, y) <= 2) {
        ground.paint.tint[tintKey(x, y)] = 0xa8c4d8
      }
    }
  }

  // --- objects -------------------------------------------------------------
  for (let i = 0; i < 26; i++) {
    const x = 2 + hash(i, 0, 11) * (width - 4)
    const z = 2 + hash(i, 1, 13) * (height - 4)
    if (groundHeight(doc, x, z) < 1.2) continue
    place(doc, hash(i, 2, 17) > 0.35 ? 'tree' : 'bush', x, z)
  }
  for (let i = 0; i < 8; i++) {
    const x = 3 + hash(i, 4, 23) * (width - 6)
    const z = 3 + hash(i, 5, 29) * (height - 6)
    place(doc, 'rock', x, z)
  }

  // Objects the coverage readout should have opinions about: a two-sided sign
  // and four-facing statues, deliberately set to flat planes.
  place(doc, 'sign', centreX - 4, centreY + 6, {
    display: 'fixed',
    facing: { ...defaultFacing(), facings: 2, back: 'image' },
  })
  place(doc, 'statue', centreX + 3, centreY - 2, {
    display: 'fixed',
    facing: { ...defaultFacing(), facings: 4, mirror: true, transition: 'flip' },
  })
  place(doc, 'statue', centreX - 7, centreY + 1, {
    display: 'fixed',
    facing: { ...defaultFacing(), facings: 1, back: 'none' },
    name: 'statue (flat, no back)',
  })
  place(doc, 'lamp', centreX + 1, centreY + 5, { display: 'extruded' })
  place(doc, 'lamp', centreX - 2, centreY + 7, { display: 'extruded' })
  place(doc, 'barrel', centreX + 5, centreY + 4)

  // Distant painted scenery, since the ridge does not reach the horizon.
  // A sketch island with a tier on it, on the meadow east of the centre: the
  // second structure kind, in the level the tour and the tests look at.
  const island = createSketch(ground.id, 'Island', { x: centreX + 4, z: centreY + 8, yaw: 0 })
  island.points = [
    { x: 0, z: 1, smooth: true },
    { x: 3, z: -1, smooth: true },
    { x: 7, z: -1, smooth: false },
    { x: 9, z: 2, smooth: true },
    { x: 8, z: 5, smooth: true },
    { x: 4, z: 6, smooth: true },
    { x: 1, z: 4, smooth: true },
  ]
  island.closed = true
  island.layers = 4
  const tier = createSketch(island.id, 'Tier', { x: 3, z: 1, yaw: 0 })
  tier.points = [
    { x: 0, z: 0, smooth: true },
    { x: 3, z: 0, smooth: true },
    { x: 4, z: 2, smooth: true },
    { x: 2, z: 3, smooth: true },
  ]
  tier.closed = true
  tier.layers = 2
  for (const sketch of [island, tier]) {
    doc.structures[sketch.id] = sketch
    doc.structureOrder.push(sketch.id)
  }

  doc.atmosphere.backdrop = [
    { sprite: 'mountains', base: -3, height: 16, radius: 80, parallax: 0.92, opacity: 1 },
  ]

  doc.camera.yaw = 35
  doc.camera.pitch = 34
  doc.camera.distance = 26

  return doc
}
