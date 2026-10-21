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
import { renderCornerBlock } from '@papercut/fixtures'
import { Action, BlockGrid, BlockPreview, CheckLine, CornerCards, CornerDetail, DetailLine, Dialog, DialogManifest, FixOption, LayerChips, NearMiss, Note, Row, Section, type CornerCardData, type CornerStatus, type KeyCell, type LayerChip } from '@papercut/ui'

import { run } from './commands'
import { requestPlacing } from './intent'
import { tileUrl } from './preview'
import { rgbaToDataUrl } from './rgba'
import { STAND_IN_SHEET, addStandIn, removeStandIn, type Session, type StandInSpec } from './session'

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
  if (answer.source.sheet === STAND_IN_SHEET) return { status: 'standin', note: 'stand-in' }
  if (lookup.archetype !== 'floor' && answer.source.archetype === null) return { status: 'borrowed', note: 'floor art' }
  return { status: 'ok', note: `tile ${answer.source.index}` }
}

export function TexturingSection({ region, materials, terrain, session }: { region: Region; materials: readonly MaterialDef[]; terrain: readonly LoadedSet[]; session: Session | null }) {
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
        <Fixes lookup={chosen} keys={chosen.keys} missingHere={onLayer.filter((l) => verdict(l).status === verdict(chosen).status && l.keys !== null)} materials={materials} terrain={terrain} look={look} cellOf={cellOf} nameOf={nameOf} wanted={wanted} session={session} />
      ) : null}
      {chosen && chosen.keys && verdict(chosen).status === 'standin' ? <ReplaceStandIn lookup={chosen} keys={chosen.keys} materials={materials} session={session} /> : null}
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
function Fixes({ lookup, keys, missingHere, materials, terrain, look, cellOf, nameOf, wanted, session }: { lookup: FaceLookup; keys: CornerKeys; missingHere: readonly FaceLookup[]; materials: readonly MaterialDef[]; terrain: readonly LoadedSet[]; look: TerrainLook; cellOf: (tag: Tag) => KeyCell; nameOf: (tag: Tag) => string; wanted: ReadonlyMap<string, number> | null; session: Session | null }) {
  const host = useHost()
  const [generating, setGenerating] = useState(false)
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
        <FixOption
          title={borrowed ? `Draw it as ${lookup.archetype} art` : 'The template'}
          primary
          actions={
            <>
              <Action title="Place block…" onClick={() => place(template)} />
              <Action title="Generate stand-in" tone="accent" disabled={session === null} onClick={() => setGenerating(true)} />
            </>
          }
        >
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
      {template && template !== 'four' && session ? <StandInDialog opened={generating} onClose={() => setGenerating(false)} spec={specFor(template, lookup)} blockName={blockName} materials={materials} terrain={terrain} fixes={cornersFixed(template, lookup.archetype, materials, wanted)} session={session} /> : null}
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

// --- stand-ins (decision "Stand-ins are replaced by hand, never outranked", 2026-10-21) ------------

/** What a stand-in for a template is asked to draw: its values, and the kind of face and slot the corner names. */
const specFor = (template: Template, lookup: FaceLookup): StandInSpec => ({ values: template.values, context: lookup.archetype === 'floor' ? null : lookup.archetype, slot: template.slot })

/** How many corners of the map a block would answer: every missing arrangement, for this kind of face, that is one of its cells. */
function cornersFixed(template: Template, archetype: ArchetypeId, materials: readonly MaterialDef[], wanted: ReadonlyMap<string, number> | null): number | null {
  if (!wanted) return null
  let total = 0
  for (const [key, n] of wanted) {
    const [kind, , ...tags] = key.split('|')
    if (kind !== archetype) continue
    const keys = tags.map((t) => (t === '' ? null : t)) as unknown as CornerKeys
    const theirs = templateFor(keys, materials)
    if (theirs && theirs !== 'four' && sameValues(theirs.values, template.values) && theirs.slot === template.slot) total += n
  }
  return total
}

/** Generate a stand-in: the block, previewed as it will be drawn, and exactly what writing it does. */
function StandInDialog({ opened, onClose, spec, blockName, materials, terrain, fixes, session }: { opened: boolean; onClose: () => void; spec: StandInSpec; blockName: string; materials: readonly MaterialDef[]; terrain: readonly LoadedSet[]; fixes: number | null; session: Session }) {
  const host = useHost()
  const [busy, setBusy] = useState(false)
  const shape = conventionOf('corner-blocks')?.blockShape(spec.values.length) ?? null
  const tile = terrain.find((l) => l.set.sheet !== STAND_IN_SHEET)?.set.tile ?? terrain[0]?.set.tile ?? 16
  const preview = useMemo(() => {
    if (!shape || !opened) return null
    const terrains = spec.values.map((id) => (id === null ? null : { id, name: '', color: materialById(materials, id)?.color ?? 0x808080 }))
    return rgbaToDataUrl(renderCornerBlock(terrains, shape.cells, shape.columns, shape.rows, tile))
  }, [shape, opened, spec, materials, tile])
  if (!shape) return null
  const already = terrain.some((l) => l.set.sheet === STAND_IN_SHEET)
  const tiles = shape.cells.filter((cell) => !(spec.values[0] !== null && spec.values.length === 2 && cell.corners.every((v) => v === cell.corners[0]))).length
  const generate = async (): Promise<void> => {
    setBusy(true)
    try {
      const tagged = await addStandIn(host, session, spec)
      run(host, 'view.set', { notice: `Drew a stand-in for ${blockName}: ${tagged} tiles on sheets/${STAND_IN_SHEET}. Paint over them, or remove the stand-in from the inspector, when real art is ready.` })
      onClose()
    } catch (error) {
      run(host, 'view.set', { notice: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      opened={opened}
      onClose={onClose}
      title="Generate a stand-in"
      description={`Draws the block for ${blockName} in the placeholder's style and tags it, so these corners stop drawing the fallback. When real art is ready, paint over these tiles, or remove the stand-in from the inspector and tag your own block.`}
      footer={
        <>
          <Action title="Cancel" onClick={onClose} />
          <Action title="Generate" tone="accent" disabled={busy} onClick={() => void generate()} />
        </>
      }
    >
      {preview ? <BlockPreview src={preview} alt={`The ${shape.columns} × ${shape.rows} block for ${blockName}`} /> : null}
      <DialogManifest
        title="Will write"
        rows={[
          { name: `sheets/${STAND_IN_SHEET}`, note: already ? `the block added below the stand-ins already there` : `a new image, ${tile} px tiles`, tone: 'accent' },
          { name: `${tiles} tiles`, note: `tagged ${blockName}${spec.context ? `, as ${spec.context} art` : ''}` },
          ...(fixes === null ? [] : [{ name: `${fixes} ${fixes === 1 ? 'corner' : 'corners'}`, note: 'on this map stop drawing the fallback', tone: 'ok' as const }]),
        ]}
      />
    </Dialog>
  )
}

/** A corner a stand-in answers: replace it by hand, by painting over its tiles or by removing it for a block of your own. */
function ReplaceStandIn({ lookup, keys, materials, session }: { lookup: FaceLookup; keys: CornerKeys; materials: readonly MaterialDef[]; session: Session | null }) {
  const host = useHost()
  const template = templateFor(keys, materials)
  if (!template || template === 'four') return null
  const spec = specFor(template, lookup)
  const remove = async (): Promise<void> => {
    if (!session) return
    const removed = await removeStandIn(host, session, spec)
    run(host, 'view.set', { notice: removed > 0 ? `Removed the stand-in: ${removed} tiles untagged on sheets/${STAND_IN_SHEET}. Its corners draw the fallback until a block of your own is tagged.` : 'No stand-in tiles spell this transition.' })
  }
  const place = (): void => {
    const [first, second, third] = template.values
    requestPlacing({ under: first === null ? null : first, over: second as number, third: third ?? null, context: spec.context, slot: spec.slot })
    run(host, 'view.set', { settings: 'materials' })
  }
  return (
    <FixOption
      title="To replace it"
      primary
      actions={
        <>
          <Action title="Remove stand-in" disabled={session === null} onClick={() => void remove()} />
          <Action title="Place block…" onClick={place} />
        </>
      }
    >
      <span>This corner is answered by a stand-in: generated, not drawn. Paint over its tiles on sheets/{STAND_IN_SHEET} and they keep their tags; or remove it and place a block of your own.</span>
    </FixOption>
  )
}
