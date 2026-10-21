/**
 * The inspector's Texturing section (the face inspector, 2026-10-21): select one face and see what the texturing
 * system looked up for it — per material layer, each corner's four tags and what answered — so a magenta corner says
 * which arrangement nobody drew rather than only that one is missing.
 *
 * It asks the mesher itself (`probeFace`), so it reports exactly what the viewport draws: turned and mirrored art,
 * a ramp's side, a wall's seam, art borrowed from another kind of face.
 */

import { useCallback, useMemo, useState } from 'react'

import { FACE_BOTTOM, FACE_TOP, archetypeOfTag, faceLayers, materialById, materialOfTag, parseFaceKey, slotMaterial, slotOfTag, slotTile, tagOf, type ArchetypeId, type MaterialDef, type MaterialLayers, type ReadonlyMapDoc, type Tag } from '@papercut/document'
import { useDocumentSelector, useHost, type Selection } from '@papercut/editor-host'
import { arrangementKey, conventionOf, createTerrainLook, probeFace, wantedCorners, type CornerKeys, type FaceAt, type FaceLookup, type LoadedSet, type TerrainLook } from '@papercut/geometry'
import { Action, BlockGrid, CheckLine, CornerCards, CornerDetail, DetailLine, FixOption, LayerChips, NearMiss, Note, Row, Section, type CornerCardData, type CornerStatus, type KeyCell, type LayerChip } from '@papercut/ui'

import { run } from './commands'
import { requestPlacing } from './intent'
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
  // Counted over the layers that hold anything here: an empty layer's corners are nothing, not something to draw.
  const total = new Set(lookups.filter((l) => layers[l.layer].live).map((l) => `${l.layer}:${pieceId(l)}`)).size
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
      {chosen && chosen.keys && (verdict(chosen).status === 'missing' || verdict(chosen).status === 'borrowed') && !chosen.unpainted ? (
        <Fixes lookup={chosen} keys={chosen.keys} missingHere={onLayer.filter((l) => verdict(l).status === verdict(chosen).status && l.keys !== null)} materials={materials} terrain={terrain} look={look} cellOf={cellOf} nameOf={nameOf} />
      ) : null}
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

// --- what would fill it -------------------------------------------------------------

/** The block of the corner-blocks layout that would draw an arrangement: its values, its cells, and the cell for it. */
export interface Template {
  /** Material ids, `null` for nothing, in the block's order: nothing first, then by the project's priority. */
  readonly values: readonly (number | null)[]
  readonly columns: number
  /** Each cell's four corners, as indexes into `values`. */
  readonly cells: readonly (readonly number[])[]
  readonly slot: string | null
}

const orderOf = (materials: readonly MaterialDef[], id: number): number => materials.findIndex((m) => m.id === id)

/** The distinct materials an arrangement names, by priority. */
function materialsIn(keys: CornerKeys, materials: readonly MaterialDef[]): number[] {
  const ids = new Set<number>()
  for (const key of keys) {
    const id = materialOfTag(key)
    if (id !== null) ids.add(id)
  }
  return [...ids].sort((a, b) => orderOf(materials, a) - orderOf(materials, b))
}

/** The block for an arrangement; `four` where four things meet, which no block draws; `null` where corners name different slots. */
export function templateFor(keys: CornerKeys, materials: readonly MaterialDef[]): Template | 'four' | null {
  const slots = new Set(keys.filter((k) => k !== null).map((k) => slotOfTag(k)))
  if (slots.size > 1) return null
  const values = [...(keys.includes(null) ? [null] : []), ...materialsIn(keys, materials)]
  if (values.length > 3) return 'four'
  if (values.length < 2) return null
  const shape = conventionOf('corner-blocks')?.blockShape(values.length)
  if (!shape) return null
  return { values, columns: shape.columns, cells: shape.cells.map((c) => [...c.corners]), slot: [...slots][0] ?? null }
}

/** Which cell of a block an arrangement is, or -1. */
export function cellOfArrangement(template: Template, keys: CornerKeys): number {
  const index = keys.map((k) => template.values.indexOf(k === null ? null : materialOfTag(k)))
  return template.cells.findIndex((corners) => corners.every((v, i) => v === index[i]))
}

const sameValues = (a: readonly (number | null)[], b: readonly (number | null)[]): boolean => a.length === b.length && a.every((v, i) => v === b[i])

/** The same corner as `keys` with another material in a tag's place: what a layer would hold if the corner were split across layers. */
const retag = (key: Tag, material: number): Tag => (key === null ? null : tagOf(material, slotOfTag(key), archetypeOfTag(key) ?? null))

/** Drawn tiles that match three of an arrangement's four corners, by material and slot, for this kind of face or any. */
function nearMisses(keys: CornerKeys, archetype: ArchetypeId, terrain: readonly LoadedSet[]): { loaded: LoadedSet; index: number; tags: CornerKeys }[] {
  const same = (a: Tag, b: Tag): boolean => a === b || (a !== null && b !== null && materialOfTag(a) === materialOfTag(b) && slotOfTag(a) === slotOfTag(b))
  const out: { loaded: LoadedSet; index: number; tags: CornerKeys }[] = []
  for (const loaded of terrain) {
    for (const [index, tags] of loaded.set.tiles) {
      const named = tags.map((t) => archetypeOfTag(t)).find((a) => a)
      if (named && named !== archetype) continue
      if (tags.filter((t, i) => same(t, keys[i])).length === 3) out.push({ loaded, index, tags })
      if (out.length === 3) return out
    }
  }
  return out
}

/**
 * The ways to fill a corner nobody drew (or one a wall borrows floor art for), best first: the template block that
 * draws it and Place block…, set to it; splitting it across layers, when each layer's part is drawn already; and the
 * drawn tiles that come closest.
 */
function Fixes({ lookup, keys, missingHere, materials, terrain, look, cellOf, nameOf }: { lookup: FaceLookup; keys: CornerKeys; missingHere: readonly FaceLookup[]; materials: readonly MaterialDef[]; terrain: readonly LoadedSet[]; look: TerrainLook; cellOf: (tag: Tag) => KeyCell; nameOf: (tag: Tag) => string }) {
  const host = useHost()
  const template = templateFor(keys, materials)
  const ids = materialsIn(keys, materials)
  const name = (id: number): string => nameOf(tagOf(id))
  const borrowed = verdict(lookup).status === 'borrowed'

  const place = (block: Template): void => {
    const [first, second, third] = block.values
    const spelled = first === null ? { under: null, over: second as number, third: third ?? null } : { under: first, over: second as number, third: third ?? null }
    requestPlacing({ ...spelled, context: lookup.archetype === 'floor' ? null : lookup.archetype, slot: block.slot })
    run(host, 'view.set', { settings: 'materials' })
  }

  // Every corner of this face that the same block would draw, lit together.
  const lit = new Set<number>()
  if (template && template !== 'four') {
    for (const other of missingHere) {
      if (!other.keys) continue
      const theirs = templateFor(other.keys, materials)
      if (theirs && theirs !== 'four' && sameValues(theirs.values, template.values)) lit.add(cellOfArrangement(template, other.keys))
    }
    lit.add(cellOfArrangement(template, keys))
    lit.delete(-1)
  }
  const blockName = template && template !== 'four' ? [...template.values.map((v) => (v === null ? 'the edge' : name(v)))].join(', ').replace(/, ([^,]*)$/, ' and $1') : ''

  // Split across layers: the lowest material under all of it, each other material alone on a layer of its own above.
  const layers =
    ids.length >= 2
      ? [
          { label: `Layer 1: ${name(ids[0])}${keys.includes(null) ? ' · edge' : ''}`, keys: keys.map((k) => retag(k, ids[0])) as unknown as CornerKeys },
          ...ids.slice(1).map((id, i) => ({ label: `Layer ${i + 2}: ${name(id)} · edge`, keys: keys.map((k) => (k !== null && materialOfTag(k) === id ? k : null)) as unknown as CornerKeys })),
        ].map((plan) => ({ ...plan, drawn: look.atlas.slotTile(plan.keys, lookup.archetype, lookup.direction) !== null }))
      : []

  const near = borrowed ? [] : nearMisses(keys, lookup.archetype, terrain)

  return (
    <>
      {template === 'four' ? (
        <FixOption title="No block draws this" primary>
          <span>Four things meet at this corner, and the corner-blocks layout stops at three. Split it across layers instead.</span>
        </FixOption>
      ) : template ? (
        <FixOption title={borrowed ? `Draw it as ${lookup.archetype} art` : 'The template'} primary actions={<Action title="Place block…" tone="accent" onClick={() => place(template)} />}>
          <BlockGrid columns={template.columns} cells={template.cells.map((corners) => corners.map((v) => cellOf(template.values[v] === null ? null : tagOf(template.values[v]))))} lit={lit} />
          <span>
            The {template.values.length === 2 ? 'pair' : 'triple'} block for {blockName}
            {lookup.archetype === 'floor' ? '' : `, tagged as ${lookup.archetype} art`}. Lit: the {lit.size === 1 ? 'cell this corner needs' : `${lit.size} cells this face needs`}.
          </span>
        </FixOption>
      ) : null}
      {layers.length > 0 && !borrowed ? (
        <FixOption title="Or layer it">
          <span>Paint {name(ids[0])} under it on one layer and {ids.slice(1).map(name).join(' and ')} on {ids.length > 2 ? 'layers' : 'a layer'} above, so each layer wants only its own edge.</span>
          {layers.map((plan) => (
            <CheckLine key={plan.label} ok={plan.drawn}>
              {plan.label}
              {plan.drawn ? ', drawn' : ', not drawn either'}
            </CheckLine>
          ))}
        </FixOption>
      ) : null}
      {near.length > 0 ? (
        <FixOption title="Near misses">
          <span>Drawn tiles that match three of the four corners.</span>
          {near.map((n) => (
            <NearMiss key={`${n.loaded.set.sheet}:${n.index}`} cells={n.tags.map(cellOf)} label={`${n.loaded.set.sheet}, tile ${n.index}`} thumb={tileUrl(n.loaded, n.index)} />
          ))}
        </FixOption>
      ) : null}
    </>
  )
}
