/**
 * The inspector's Texturing section (the face inspector, 2026-10-21): select one face and see what the texturing
 * system looked up for it — per material layer, each corner's four tags and what answered — so a magenta corner says
 * which arrangement nobody drew rather than only that one is missing.
 *
 * It asks the mesher itself (`probeFace`), so it reports exactly what the viewport draws: turned and mirrored art,
 * a ramp's side, a wall's seam, art borrowed from another kind of face.
 */

import { useCallback, useMemo, useState } from 'react'

import { FACE_BOTTOM, FACE_TOP, archetypeOfTag, faceLayers, materialById, materialOfTag, parseFaceKey, slotMaterial, slotOfTag, slotTile, type ArchetypeId, type MaterialDef, type MaterialLayers, type ReadonlyMapDoc, type Tag } from '@papercut/document'
import { useDocumentSelector, type Selection } from '@papercut/editor-host'
import { arrangementKey, createTerrainLook, probeFace, wantedCorners, type FaceAt, type FaceLookup, type LoadedSet } from '@papercut/geometry'
import { CornerCards, CornerDetail, DetailLine, LayerChips, Note, Row, Section, type CornerCardData, type CornerStatus, type KeyCell, type LayerChip } from '@papercut/ui'

import { tileUrl } from './preview'

type Region = Extract<Selection, { kind: 'region' }>

const SIDES = ['east', 'south', 'west', 'north']
const COMPASS = ['NW', 'NE', 'SW', 'SE']
const ART: Record<ArchetypeId, string> = { floor: 'floor art', wall: 'wall art', ramp: 'ramp art' }

const cssColor = (color: number): string => `#${color.toString(16).padStart(6, '0')}`

interface Probed {
  readonly face: FaceAt
  readonly slots: Readonly<MaterialLayers> | null
  readonly lookups: readonly FaceLookup[]
}

/** A piece of the face, once per layer: what a corner card stands for. */
const pieceId = (lookup: FaceLookup): string => `${lookup.middle === null ? 'q' : `m${lookup.middle}`}${lookup.quarter}:${lookup.address[3]}`

/** Where a piece is on its face, in words. */
function pieceLabel(face: FaceAt, lookup: FaceLookup): string {
  if (lookup.middle !== null) return `Middle ${lookup.middle + 1}`
  if (face.dir === FACE_TOP || face.dir === FACE_BOTTOM) return COMPASS[lookup.quarter]
  return `${lookup.quarter < 2 ? 'Top' : 'Foot'} · ${lookup.quarter % 2 ? 'end' : 'start'}`
}

/** What answered a piece, as a card's status and its few words. */
function verdict(lookup: FaceLookup): { status: CornerStatus; note: string } {
  if (lookup.via === 'pasted') return lookup.pasted === -1 ? { status: 'missing', note: 'pasted, missing' } : { status: 'pasted', note: 'pasted tile' }
  if (lookup.unpainted) return { status: 'missing', note: 'unpainted' }
  const answer = lookup.answer
  if (answer === null || answer.missing) return { status: 'missing', note: 'missing' }
  if (!answer.source) return { status: 'empty', note: 'nothing here' }
  if (lookup.via === 'side') return { status: 'ok', note: 'side art' }
  if (lookup.via === 'seam') return { status: 'ok', note: 'seam art' }
  if (lookup.archetype !== 'floor' && answer.source.archetype === null) return { status: 'borrowed', note: 'floor art' }
  return { status: 'ok', note: `tile ${answer.source.index}` }
}

export function TexturingSection({ region, materials, terrain }: { region: Region; materials: readonly MaterialDef[]; terrain: readonly LoadedSet[] }) {
  const look = useMemo(() => createTerrainLook(materials, terrain), [materials, terrain])
  const only = region.keys.length === 1 ? region.keys[0] : null

  // Selected settled and per revision: a probe meshes the face's chunk, which is not worth redoing on every brush tick.
  const probe = useCallback(
    (doc: ReadonlyMapDoc): Probed | null => {
      if (only === null) return null
      const structure = doc.structures[region.structure]
      if (!structure || structure.kind !== 'voxel') return null
      const face = parseFaceKey(only)
      return { face, slots: faceLayers(structure.paint, face.x, face.z, face.y, face.dir) ?? null, lookups: probeFace(structure, look, face) }
    },
    [only, region.structure, look],
  )
  const probed = useDocumentSelector(probe, { settled: true })
  const anyMissing = probed?.lookups.some((l) => l.answer?.missing === true) ?? false
  // How much a missing tile matters: how many corners of the whole map want it. Meshes every chunk, so only asked
  // while a face with a missing corner is selected.
  const count = useCallback(
    (doc: ReadonlyMapDoc): ReadonlyMap<string, number> | null => {
      if (!anyMissing) return null
      const structure = doc.structures[region.structure]
      return structure?.kind === 'voxel' ? wantedCorners(structure, look) : null
    },
    [anyMissing, region.structure, look],
  )
  const wanted = useDocumentSelector(count, { settled: true })

  const [layerPick, setLayerPick] = useState<number | null>(null)
  const [cardPick, setCardPick] = useState<string | null>(null)

  if (only === null) {
    return (
      <Section icon="tile" title="Texturing" summary={`${region.keys.length} faces`}>
        <Note>Select a single face to see what it looks up and what answers it.</Note>
      </Section>
    )
  }
  if (probed === null) return null
  const { face, slots, lookups } = probed
  if (lookups.length === 0) {
    return (
      <Section icon="tile" title="Texturing" summary="not drawn">
        <Note>This face is not drawn: something covers it, or there is no voxel on that side.</Note>
      </Section>
    )
  }

  const cellOf = (tag: Tag): KeyCell => {
    if (tag === null) return { color: null, title: 'nothing' }
    const id = materialOfTag(tag)
    const material = id === null ? undefined : materialById(materials, id)
    const archetype = archetypeOfTag(tag)
    const slot = slotOfTag(tag)
    return { color: material ? cssColor(material.color) : '#5a6070', title: `${material?.name ?? `material ${id}`}${archetype ? ` @${archetype}` : ''}${slot ? `:${slot}` : ''}` }
  }
  const nameOf = (tag: Tag): string => {
    const id = materialOfTag(tag)
    return (id === null ? undefined : materialById(materials, id)?.name) ?? `material ${id}`
  }

  const layers: LayerChip[] = [0, 1, 2, 3].map((layer) => {
    const slot = slots?.[layer] ?? null
    const material = slotMaterial(slot)
    const tile = slotTile(slot)
    const def = material === null ? undefined : materialById(materials, material)
    const mine = lookups.filter((l) => l.layer === layer)
    return {
      label: def ? def.name : tile ? 'Tile' : '—',
      ...(def ? { color: cssColor(def.color) } : {}),
      live: slot !== null || mine.some((l) => l.via === 'pasted' || (l.keys ?? []).some((k) => k !== null)),
      missing: mine.some((l) => verdict(l).status === 'missing'),
    }
  })
  const layer = layerPick ?? Math.max(0, layers.findIndex((l) => l.missing) >= 0 ? layers.findIndex((l) => l.missing) : layers.findIndex((l) => l.live))
  const onLayer = lookups
    .filter((l) => l.layer === layer)
    .slice()
    .sort((a, b) => (a.middle === null ? -1 : a.middle) - (b.middle === null ? -1 : b.middle) || b.address[3] - a.address[3] || a.quarter - b.quarter)
  const cards: CornerCardData[] = onLayer.map((lookup) => ({ id: pieceId(lookup), label: pieceLabel(face, lookup), cells: (lookup.keys ?? [null, null, null, null]).map(cellOf), ...verdict(lookup) }))
  const chosen = onLayer.find((l) => pieceId(l) === cardPick) ?? onLayer.find((l) => verdict(l).status === 'missing') ?? onLayer[0]

  const pieces = new Set(lookups.filter((l) => verdict(l).status === 'missing').map((l) => `${l.layer}:${pieceId(l)}`))
  const borrowing = lookups.some((l) => verdict(l).status === 'borrowed')
  const unpainted = lookups.some((l) => l.unpainted)
  const total = new Set(lookups.map((l) => `${l.layer}:${pieceId(l)}`)).size
  const summary = unpainted ? 'unpainted' : pieces.size > 0 ? `${pieces.size} of ${total} missing` : borrowing ? 'borrowing floor art' : 'answered'

  const archetype = (lookups.find((l) => l.layer === 0 && l.via !== 'pasted') ?? lookups[0]).archetype
  const where = face.dir === FACE_TOP ? (archetype === 'ramp' ? 'Ramp' : 'Top') : face.dir === FACE_BOTTOM ? 'Underside' : `Cliff · ${SIDES[face.dir]}`

  return (
    <Section icon="tile" title="Texturing" summary={summary} accent={pieces.size > 0 || unpainted}>
      <Row label="Face" value={`${where} · ${ART[archetype]}`} />
      <Row label="At" value={`x ${face.x} · z ${face.z} · y ${face.y}`} />
      <LayerChips
        layers={layers}
        active={layer}
        onPick={(picked) => {
          setLayerPick(picked)
          setCardPick(null)
        }}
      />
      <CornerCards cards={cards} active={chosen ? pieceId(chosen) : null} onPick={setCardPick} />
      {chosen ? <ChosenCorner lookup={chosen} label={pieceLabel(face, chosen)} cellOf={cellOf} nameOf={nameOf} terrain={terrain} wanted={wanted} /> : null}
    </Section>
  )
}

/** The chosen piece spelled out: what it wants, and what answered it or that nothing did. */
function ChosenCorner({ lookup, label, cellOf, nameOf, terrain, wanted }: { lookup: FaceLookup; label: string; cellOf: (tag: Tag) => KeyCell; nameOf: (tag: Tag) => string; terrain: readonly LoadedSet[]; wanted: ReadonlyMap<string, number> | null }) {
  const keys = lookup.keys ?? [null, null, null, null]
  if (lookup.via === 'pasted') {
    return (
      <CornerDetail cells={keys.map(cellOf)} title={`${label} is a pasted tile`} tags={`layer ${lookup.layer + 1}`}>
        <DetailLine tone={lookup.pasted === -1 ? 'warn' : 'muted'}>{lookup.pasted === -1 ? 'Its image did not load, or the tile is off its grid, so it draws the fallback.' : 'A tile pasted whole on this layer: nothing auto-tiles here.'}</DetailLine>
      </CornerDetail>
    )
  }
  const named = [...new Set(keys.filter((k): k is string => k !== null).map(nameOf))]
  const combo = [...named, ...(keys.includes(null) ? ['edge'] : [])].join(' · ') || 'nothing'
  const tags = `[ ${keys.map((k) => k ?? '—').join(' , ')} ] ${lookup.archetype}${lookup.direction === null ? '' : ` · ${SIDES[lookup.direction]}`}`
  const answer = lookup.answer
  const source = answer?.source
  const loaded = source ? terrain.find((l) => l.set.sheet === source.sheet) : undefined
  const thumb = loaded && source ? tileUrl(loaded, source.index) : undefined
  const { status } = verdict(lookup)
  const count = status === 'missing' && wanted ? wanted.get(arrangementKey(lookup)) : undefined
  return (
    <CornerDetail cells={keys.map(cellOf)} title={`${label} wants ${combo}`} tags={tags} thumb={thumb}>
      {lookup.unpainted ? <DetailLine tone="warn">Nobody painted this face, so its first layer draws the fallback whatever answers.</DetailLine> : null}
      {status === 'missing' && !lookup.unpainted ? (
        <DetailLine tone="warn">
          No tile answers, so it draws the fallback.
          {count === undefined ? '' : ` Wanted at ${count} ${count === 1 ? 'corner' : 'corners'} on this map.`}
        </DetailLine>
      ) : null}
      {status === 'empty' ? <DetailLine>Nothing is on this layer at this corner.</DetailLine> : null}
      {source && status !== 'missing' ? (
        <DetailLine tone={status === 'borrowed' ? 'accent' : 'ok'}>
          Tile {source.index} of {source.sheet}
          {lookup.via === 'side' ? ', the ramp’s side art' : lookup.via === 'seam' ? ', the wall’s seam art' : ''}
          {answer?.orient ? ', turned to fit' : ''}.
        </DetailLine>
      ) : null}
      {status === 'borrowed' ? <DetailLine tone="accent">It is art tagged for any face: nothing is tagged as {lookup.archetype} art for this corner, so the floor’s tile stands in.</DetailLine> : null}
    </CornerDetail>
  )
}
