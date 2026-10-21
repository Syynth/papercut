/**
 * The pieces of the inspector's Texturing section (the face inspector, 2026-10-21): a corner's four tags as a 2×2
 * key, the face's corners as cards, its material layers as chips, and the chosen corner spelled out.
 *
 * Presentation only: the app says what each corner looked up and what answered.
 */

import type { ReactNode } from 'react'

/** One of a corner's four tags, as a colour, or `null` for nothing (the drop at a plateau's edge, an empty layer). */
export interface KeyCell {
  readonly color: string | null
  /** What the tag is, for the tooltip. */
  readonly title: string
}

/** A corner's four tags, north-west, north-east, south-west, south-east, as the 2×2 the dual grid looks up. */
export function CornerKey({ cells, size = 34 }: { cells: readonly KeyCell[]; size?: number }) {
  return (
    <span className="ui-key" style={{ width: size, height: size }} role="img" aria-label={cells.map((c) => c.title).join(', ')}>
      {cells.map((cell, i) => (
        <span key={i} className={cell.color === null ? 'ui-key-cell is-none' : 'ui-key-cell'} style={cell.color === null ? undefined : { background: cell.color }} title={cell.title} />
      ))}
    </span>
  )
}

export type CornerStatus = 'ok' | 'missing' | 'borrowed' | 'pasted' | 'empty'

export interface CornerCardData {
  readonly id: string
  /** Where on the face: NW, Top · end, Middle … */
  readonly label: string
  readonly cells: readonly KeyCell[]
  readonly status: CornerStatus
  /** What answered, in a few words: `tile 52`, `missing`, `floor art`. */
  readonly note: string
}

/** A face's corners, two across: pick one to spell it out below. */
export function CornerCards({ cards, active, onPick }: { cards: readonly CornerCardData[]; active: string | null; onPick: (id: string) => void }) {
  return (
    <div className="ui-corners">
      {cards.map((card) => (
        <button key={card.id} type="button" className={`ui-corner${card.id === active ? ' is-active' : ''}`} onClick={() => onPick(card.id)} aria-pressed={card.id === active}>
          <CornerKey cells={card.cells} />
          <span className="ui-corner-text">
            <span className="ui-corner-name">{card.label}</span>
            <span className={`ui-corner-note is-${card.status}`}>{card.note}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

export interface LayerChip {
  readonly label: string
  readonly color?: string
  /** Whether anything on this layer reaches the face: its own slot, or a neighbour's material auto-tiling onto it. */
  readonly live: boolean
  /** Whether a corner on this layer has no tile. */
  readonly missing: boolean
}

/** The face's four material layers, bottom first; the one whose corners are shown is active. */
export function LayerChips({ layers, active, onPick }: { layers: readonly LayerChip[]; active: number; onPick: (layer: number) => void }) {
  return (
    <div className="ui-layer-chips">
      {layers.map((layer, i) => (
        <button key={i} type="button" className={`ui-layer-chip${i === active ? ' is-active' : ''}${layer.live ? '' : ' is-dead'}${layer.missing ? ' is-missing' : ''}`} onClick={() => onPick(i)} aria-pressed={i === active} disabled={!layer.live} title={`Layer ${i + 1}`}>
          {layer.color ? <span className="ui-key-cell ui-layer-swatch" style={{ background: layer.color }} /> : null}
          <span>{layer.label}</span>
        </button>
      ))}
    </div>
  )
}

/** The chosen corner spelled out: its key large, what it wants, and what answered or did not. */
export function CornerDetail({ cells, title, tags, thumb, children }: { cells: readonly KeyCell[]; title: string; tags: string; thumb?: string; children: ReactNode }) {
  return (
    <div className="ui-corner-detail">
      <div className="ui-corner-detail-head">
        <CornerKey cells={cells} size={44} />
        <span className="ui-corner-detail-text">
          <span className="ui-corner-detail-title">{title}</span>
          <span className="ui-corner-detail-tags">{tags}</span>
        </span>
        {thumb ? <img className="ui-corner-thumb" src={thumb} alt="The tile that answered" /> : null}
      </div>
      {children}
    </div>
  )
}

/** A line under a corner's detail, in a tone. */
export function DetailLine({ tone = 'muted', children }: { tone?: 'muted' | 'warn' | 'ok' | 'accent'; children: ReactNode }) {
  return <span className={`ui-detail-line is-${tone}`}>{children}</span>
}
