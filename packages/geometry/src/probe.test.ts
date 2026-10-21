import { describe, expect, it } from 'vitest'

import { DEFAULT_MATERIALS, FACE_TOP, PLACEHOLDER_SHEET, createMap, fillColumn, tagOf, type MapDoc, type RgbaImage, type VoxelStructure } from '@papercut/document'

import { type LoadedSet } from './atlas'
import { createTerrainLook } from './look'
import { arrangementKey, probeFace, wantedCorners } from './terrain'
import { createTerrainSet, stampTemplate } from './terrainset'

const ground = (doc: MapDoc): VoxelStructure => doc.structures.ground as VoxelStructure

const TILE = 4

function solid(width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) data.set([0, 255, 0, 255], i)
  return { width, height, data }
}

/** Each default material's edge set on a block of its own, and no pairs: grass against nothing resolves, grass against dirt does not. */
function edgesOnly(): LoadedSet {
  let set = createTerrainSet(PLACEHOLDER_SHEET, TILE, 16, 8)
  DEFAULT_MATERIALS.forEach((material, i) => {
    set = stampTemplate(set, (i % 4) * 4, Math.floor(i / 4) * 4, null, tagOf(material.id))
  })
  return { set, image: solid(16 * TILE, 8 * TILE) }
}

const look = () => createTerrainLook(DEFAULT_MATERIALS, [edgesOnly()])
const GRASS = tagOf(0)
const DIRT = tagOf(1)

describe('probing a face (the face inspector, 2026-10-21)', () => {
  it('records every quarter of a top on its painted layer, answered from the sheet that drew it', () => {
    // A grass pillar two voxels tall: its top is grass against the drop all round, which the edge set draws.
    const doc = createMap(8, 8)
    fillColumn(ground(doc), 3, 3, 4)
    const lookups = probeFace(ground(doc), look(), { x: 3, z: 3, y: 1, dir: FACE_TOP }).filter((l) => l.layer === 0)
    expect(lookups.map((l) => l.quarter).sort()).toEqual([0, 1, 2, 3])
    for (const lookup of lookups) {
      expect(lookup.via).toBe('corner')
      expect(lookup.archetype).toBe('floor')
      expect(lookup.answer?.missing).toBe(false)
      expect(lookup.answer?.source?.sheet).toBe(PLACEHOLDER_SHEET)
    }
    // The north-west quarter is the corner with the pillar to its south-east and the drop everywhere else.
    expect(lookups.find((l) => l.quarter === 0)?.keys).toEqual([null, null, null, GRASS])
  })

  it('records a corner nobody drew as missing, and counts it once per corner of the map', () => {
    // Grass beside dirt at one height: the two corners they share are a pair the edge sets do not draw.
    const doc = createMap(8, 8)
    fillColumn(ground(doc), 3, 3, 4)
    fillColumn(ground(doc), 4, 3, 4, { material: 1 })
    const terrain = look()
    const lookups = probeFace(ground(doc), terrain, { x: 3, z: 3, y: 1, dir: FACE_TOP }).filter((l) => l.layer === 0)
    const missing = lookups.filter((l) => l.answer?.missing)
    expect(missing.map((l) => l.quarter).sort()).toEqual([1, 3])
    const northEast = missing.find((l) => l.quarter === 1)
    expect(northEast?.keys).toEqual([null, null, GRASS, DIRT])
    // The grid corner at the pillar's north-east, two voxels up.
    expect(northEast?.point).toEqual([4, 2, 3])

    // Both columns' tops ask for that corner; it is one corner of the map.
    const wanted = wantedCorners(ground(doc), terrain)
    expect(wanted.get(arrangementKey(northEast!))).toBe(1)
    expect([...wanted.values()].every((n) => n >= 1)).toBe(true)
  })

  it('records a wall face as both of its half-tile bands, as wall art', () => {
    // The ground is a voxel deep, so the pillar's wall stands at its upper voxel, layer 1. A course is four quarters,
    // two in each of its half-tile bands.
    const doc = createMap(8, 8)
    fillColumn(ground(doc), 3, 3, 4)
    const lookups = probeFace(ground(doc), look(), { x: 3, z: 3, y: 1, dir: 0 }).filter((l) => l.layer === 0)
    expect(lookups.map((l) => l.quarter).sort()).toEqual([0, 1, 2, 3])
    expect(lookups.every((l) => l.archetype === 'wall')).toBe(true)
    expect(new Set(lookups.map((l) => l.address[3])).size).toBe(2)
  })

  it('records nothing for a face that is not drawn', () => {
    const doc = createMap(8, 8)
    fillColumn(ground(doc), 3, 3, 4)
    // The pillar's lower voxel has no top face of its own: the upper one covers it.
    expect(probeFace(ground(doc), look(), { x: 3, z: 3, y: 0, dir: FACE_TOP })).toEqual([])
  })
})
