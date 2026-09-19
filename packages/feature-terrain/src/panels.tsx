/**
 * The terrain tool's panels, as COMPONENTS (#12): `panels.declare` takes a
 * React component rather than a descriptor, which is exactly why a feature
 * package may depend on `ui` and on nothing that knows what Mantine is. Every
 * control here is a `ui` primitive; there is not a style in the file, which
 * is the no-styles rule doing its job rather than being remembered.
 *
 * Two slots (2026-09-12 frame): the BAR is the tool's mode switch, verbs and
 * parameters in one icon-only row — mode first, because it changes what a
 * drag means, then the verb, then the stroke shape, the brush and the
 * numbers, every number a scrub field (ruling of 2026-09-13) — and the
 * INSPECTOR holds what needs more room than a row: the sculpt numbers with
 * the dial while the feel is settled, and the tint picker when tinting. The
 * Materials section is the app's: it needs the loaded terrain sets for its
 * swatches, which no feature holds.
 *
 * Panels take their state as PROPS rather than reading an actor: the tool
 * parameters live on the host's tools actor, and a feature may not import the
 * host to select from it. Whatever renders a declared panel fills the props
 * in — including `platform`, so the chords the tooltips show come from the
 * keymap rather than from a string written here.
 */

import { MAX_HEIGHT, maxHeightOf, type MaterialDef, type ReadonlyMapDoc } from '@papercut/document'
import { chordFor, panels, type OwnerId, type Platform } from '@papercut/registry'
import { BarDivider, BarLabel, BarScrub, Chip, ColorInput, Field, IconSegmented, Note, Scrub, Verb } from '@papercut/ui'

import { terrainKeys } from './keys'
import type { TerrainParams } from './verbs'

export interface TerrainPanelProps {
  readonly doc: ReadonlyMapDoc
  /** The project's material library, in priority order: the chips the bar offers. */
  readonly materials: readonly MaterialDef[]
  readonly params: TerrainParams
  /** A parameter change, as the partial the tools actor takes. */
  readonly set: (changes: Partial<TerrainParams>) => void
  /** For the chords the tooltips show; the renderer detects it, since this package compiles without a window. */
  readonly platform: Platform
}

const cssColor = (color: number): string => `#${color.toString(16).padStart(6, '0')}`

/** The tallest any of the map's volumes can stand, in half-tiles: the ceiling of a height field. */
function ceilingOf(doc: ReadonlyMapDoc): number {
  let ceiling = 0
  for (const id of doc.structureOrder) {
    const s = doc.structures[id]
    if (s?.kind === 'voxel') ceiling = Math.max(ceiling, maxHeightOf(s))
  }
  return ceiling || MAX_HEIGHT
}

function StrokeControls({ params, set, platform }: TerrainPanelProps) {
  return (
    <>
      <BarLabel>Stroke</BarLabel>
      <IconSegmented
        value={params.strokeShape}
        onChange={(strokeShape) => set({ strokeShape })}
        options={[
          { value: 'brush', icon: 'brush', title: 'Brush stroke' },
          { value: 'rect', icon: 'rect', title: 'Rectangle — press to release' },
          { value: 'fill', icon: 'fill', title: 'Flood fill the plateau under the press' },
        ]}
      />
      <IconSegmented
        value={params.brush.shape}
        onChange={(shape) => set({ brush: { ...params.brush, shape } })}
        options={[
          { value: 'square', icon: 'square', title: 'Square brush' },
          { value: 'circle', icon: 'circle', title: 'Round brush' },
        ]}
      />
      <BarScrub
        label="Size"
        title="Brush size: drag to change, click to type"
        kbd={[chordFor('terrain.brush.resize', { by: -1 }, platform), chordFor('terrain.brush.resize', { by: 1 }, platform)].filter(Boolean).join(' ')}
        value={params.brush.size}
        min={1}
        max={12}
        onChange={(size) => set({ brush: { ...params.brush, size } })}
      />
    </>
  )
}

/** The number a sculpt verb takes: half-tiles per pass for Raise and Smooth, the height Flatten sets, nothing for Ramp. */
function SculptNumber({ doc, params, set }: TerrainPanelProps) {
  if (params.sculptVerb === 'flatten') {
    return (
      <>
        <BarScrub label="Height" title="The height Flatten sets, in half-tiles: sampled where you press, or typed and pinned" unit="½" value={params.height} min={0} max={ceilingOf(doc)} onChange={(height) => set({ height, heightPinned: true })} />
        <Verb
          icon={params.heightPinned ? 'lock' : 'unlock'}
          title={params.heightPinned ? 'Height is pinned — click to sample it at each press again' : 'Height follows the press — click to pin the value'}
          active={params.heightPinned}
          onClick={() => set({ heightPinned: !params.heightPinned })}
        />
      </>
    )
  }
  if (params.sculptVerb === 'raise' || params.sculptVerb === 'smooth') {
    return <BarScrub label="Strength" title="Half-tiles per pass" unit="½" value={params.strength} min={1} max={8} onChange={(strength) => set({ strength })} />
  }
  return null
}

export function TerrainBar(props: TerrainPanelProps) {
  const { params, set, platform } = props
  const modeKbd = chordFor('terrain.params', { terrainMode: params.terrainMode === 'sculpt' ? 'paint' : 'sculpt' }, platform)
  const ramp = params.rampRun
  return (
    <>
      <IconSegmented
        value={params.terrainMode}
        onChange={(terrainMode) => set({ terrainMode })}
        options={[
          { value: 'sculpt', icon: 'sculpt', title: 'Sculpt', kbd: modeKbd },
          { value: 'paint', icon: 'paint', title: 'Paint', kbd: modeKbd },
        ]}
      />
      <BarDivider />
      {params.terrainMode === 'sculpt' ? (
        <>
          <IconSegmented
            value={params.sculptVerb}
            onChange={(sculptVerb) => set({ sculptVerb })}
            options={[
              { value: 'raise', icon: 'raise', title: 'Raise — ⇧ lowers' },
              { value: 'flatten', icon: 'flatten', title: 'Flatten to a height' },
              { value: 'smooth', icon: 'smooth', title: 'Smooth toward the neighbours' },
              { value: 'ramp', icon: 'ramp', title: 'Ramp — press a cliff face and drag back to set the run; click a ramp to remove it' },
              { value: 'water', icon: 'water', title: 'Water — shift removes it (interim, until the Water tool)' },
            ]}
          />
          <BarDivider />
          {params.sculptVerb === 'ramp' ? (
            <BarLabel>{ramp ? (ramp.blocked ? `No ramp here: ${ramp.blocked}` : `Run ${ramp.run} of ${ramp.needed}`) : 'Press a cliff face, drag back'}</BarLabel>
          ) : (
            <>
              <StrokeControls {...props} />
              <SculptNumber {...props} />
            </>
          )}
        </>
      ) : (
        <>
          <IconSegmented
            value={params.paintVerb}
            onChange={(paintVerb) => set({ paintVerb })}
            options={[
              { value: 'material', icon: 'material', title: 'Material — paints the active material layer of a top or a cliff band; ⇧ empties it' },
              { value: 'tint', icon: 'tint', title: 'Tint' },
              { value: 'fringe', icon: 'fences', title: 'Fringe — switch off the fringe hanging from a cliff top, or the picket at a wall\u2019s foot; ⇧ switches it back on' },
              { value: 'tiles', icon: 'tile', title: 'Tiles — paste the tiles picked in the inspector onto a top or a wall, on the active material layer; ⇧ clears them' },
            ]}
          />
          <BarDivider />
          {params.paintVerb === 'material' || params.paintVerb === 'tiles' ? <BarLabel>{`Material layer ${params.materialLayer + 1}`}</BarLabel> : null}
          {params.paintVerb === 'tiles' ? <BarDivider /> : null}
          {params.paintVerb === 'tiles' ? <BarLabel>{params.stamp ? `${params.stamp.tiles[0].length}×${params.stamp.tiles.length} tiles` : 'Pick tiles in the inspector'}</BarLabel> : null}
          {params.paintVerb === 'material'
            ? props.materials.map((material) => (
                <Chip key={material.id} title={material.name} swatch={cssColor(material.color)} active={material.id === params.material} onClick={() => set({ material: material.id })} />
              ))
            : null}
          {params.paintVerb === 'tiles' ? null : (
            <>
              <BarDivider />
              <StrokeControls {...props} />
            </>
          )}
        </>
      )}
    </>
  )
}

/** The sculpt numbers with room to read, plus the stroke's dial while the feel is settled (tentative ruling of 2026-09-12). */
export function TerrainSculptPanel({ doc, params, set }: TerrainPanelProps) {
  return (
    <>
      <Scrub label="Size" value={params.brush.size} min={1} max={12} onChange={(size) => set({ brush: { ...params.brush, size } })} />
      {params.sculptVerb === 'flatten' ? (
        <Scrub label="Height" unit="½" value={params.height} min={0} max={ceilingOf(doc)} onChange={(height) => set({ height, heightPinned: true })} />
      ) : params.sculptVerb === 'ramp' ? null : (
        <Scrub label="Strength" unit="½" value={params.strength} min={1} max={8} onChange={(strength) => set({ strength })} />
      )}
      <Scrub label="Dead zone" value={params.sculptDeadZone} min={0} max={0.5} step={0.05} onChange={(sculptDeadZone) => set({ sculptDeadZone })} format={(v) => v.toFixed(2)} />
      <Note>
        {params.sculptVerb === 'ramp'
          ? 'A ramp is always 45°: one tile down per cell of run. Press a cliff face and drag back onto the high side until the run meets the drop; a half ramp finishes an odd half-tile. Click a ramp to remove its run.'
          : params.sculptVerb === 'flatten'
            ? 'Height is sampled where you press; type or drag it to pin a value, and unpin to sample again.'
            : 'Strength is half-tiles per pass: 2 is one cube. ⇧ inverts Raise; ⌥ click picks a material or height up.'}
      </Note>
    </>
  )
}

export function TerrainPaintPanel({ params, set }: TerrainPanelProps) {
  if (params.paintVerb === 'tint') {
    return (
      <Field label="Tint">
        <ColorInput value={params.tint} onChange={(tint) => set({ tint })} />
      </Field>
    )
  }
  return null
}

export function declareTerrainPanels(owner: OwnerId): void {
  panels.declare(owner, { id: 'terrain.bar', title: 'Terrain', slot: 'bar', component: TerrainBar })
  panels.declare(owner, { id: 'terrain.sculpt', title: 'Sculpt', component: TerrainSculptPanel, when: terrainKeys.mode.is('sculpt') })
  panels.declare(owner, { id: 'terrain.paint', title: 'Paint', component: TerrainPaintPanel, when: terrainKeys.mode.is('paint') })
}
