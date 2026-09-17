/**
 * The settings modal (design of 2026-09-14, after brink's): a rail of
 * sections on the frame's ground, one section at a time on a raised pane,
 * and tables where a section lists things.
 *
 * Presentation only. The app decides which sections exist and what each
 * holds; the rail's active item and the pane's title come in as props.
 */

import { Modal } from '@mantine/core'
import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react'

import { Icon, type IconName } from './icons'

export function SettingsDialog({ opened, onClose, rail, title, aside, wide = false, children }: { opened: boolean; onClose: () => void; rail: ReactNode; title: string; aside?: ReactNode; /** The section needs the window: the modal grows to it and the content loses its padding, for an editor rather than a form. */ wide?: boolean; children: ReactNode }) {
  return (
    <Modal opened={opened} onClose={onClose} size={wide ? 'calc(100vw - 48px)' : 920} centered withCloseButton={false} padding={0} classNames={{ content: `ui-settings ${wide ? 'is-wide' : ''}`, body: 'ui-settings-body' }} overlayProps={{ className: 'ui-dialog-scrim' }}>
      <div className="ui-settings-rail">{rail}</div>
      <div className="ui-settings-pane">
        <div className="ui-settings-head">
          <span className="ui-settings-title">{title}</span>
          <span className="ui-settings-aside">
            {aside}
            <button type="button" className="ui-settings-close" onClick={onClose} aria-label="Close">
              <Icon name="close" size={14} />
            </button>
          </span>
        </div>
        <div className="ui-settings-content">{children}</div>
      </div>
    </Modal>
  )
}

/** The scope switch at the top of the rail. Only one scope exists today; the other is named so the shape is the design's. */
export function SettingsScope({ scopes, active, onChange }: { scopes: ReadonlyArray<{ readonly id: string; readonly label: string; readonly disabled?: boolean }>; active: string; onChange: (id: string) => void }) {
  return (
    <div className="ui-settings-scope">
      {scopes.map((scope) => (
        <button key={scope.id} type="button" className={`ui-settings-scope-btn ${scope.id === active ? 'is-active' : ''}`} disabled={scope.disabled} onClick={() => onChange(scope.id)}>
          {scope.label}
        </button>
      ))}
    </div>
  )
}

/** The search over the rail: matches section titles and their keywords. */
export function SettingsSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="ui-settings-search">
      <Icon name="select" size={12} />
      <input type="search" value={value} placeholder="Search settings" onChange={(event) => onChange(event.currentTarget.value)} />
    </label>
  )
}

export function SettingsRailNote({ children }: { children: ReactNode }) {
  return <div className="ui-settings-rail-note">{children}</div>
}

export function SettingsRailItem({ icon, title, active, onClick }: { icon: IconName; title: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`ui-settings-item ${active ? 'is-active' : ''}`} onClick={onClick}>
      <Icon name={icon} size={13} />
      {title}
    </button>
  )
}

/** A block of the pane: a title with room for an action, a note, and the content. */
export function SettingsBlock({ title, note, action, children }: { title?: ReactNode; note?: ReactNode; action?: ReactNode; children?: ReactNode }) {
  return (
    <section className="ui-settings-block">
      {title || action ? (
        <div className="ui-settings-block-head">
          <span className="ui-settings-block-title">{title}</span>
          {action ? <span className="ui-settings-block-action">{action}</span> : null}
        </div>
      ) : null}
      {note ? <p className="ui-settings-note">{note}</p> : null}
      {children}
    </section>
  )
}

/** A grid table: `columns` are the header cells and the track widths, rows are `TableRow`s with one cell per column. */
export function Table({ columns, children }: { columns: ReadonlyArray<{ readonly title: string; readonly width: string }>; children: ReactNode }) {
  return (
    <div className="ui-table" style={{ gridTemplateColumns: columns.map((c) => c.width).join(' ') }}>
      {columns.map((column) => (
        <div key={column.title} className="ui-table-th">
          {column.title}
        </div>
      ))}
      {children}
    </div>
  )
}

/** `drag` makes the row a drag source and target: `onDrop` gets the row dragged onto this one, by whatever key the caller passes as `drag`. */
export function TableRow({ cells, active, muted, onClick, drag, onDrop, dropping }: { cells: readonly ReactNode[]; active?: boolean; muted?: boolean; onClick?: () => void; drag?: string; onDrop?: (dragged: string) => void; dropping?: boolean }) {
  const draggable = drag !== undefined
  return (
    <>
      {cells.map((cell, index) => (
        <div
          key={index}
          className={`ui-table-td ${active ? 'is-active' : ''} ${muted ? 'is-muted' : ''} ${onClick ? 'is-link' : ''} ${draggable ? 'is-draggable' : ''} ${dropping ? 'is-dropping' : ''}`}
          onClick={onClick}
          draggable={draggable}
          onDragStart={draggable ? (event) => event.dataTransfer.setData('text/plain', drag) : undefined}
          onDragOver={onDrop ? (event) => event.preventDefault() : undefined}
          onDrop={onDrop ? (event) => {
            event.preventDefault()
            onDrop(event.dataTransfer.getData('text/plain'))
          } : undefined}
        >
          {cell}
        </div>
      ))}
    </>
  )
}

export function Swatch({ color, image }: { color?: string; image?: string }) {
  return <span className="ui-swatch" style={image ? { background: `url(${image}) center / cover` } : { background: color }} />
}

export function Status({ tone, children }: { tone: 'ok' | 'warn' | 'accent' | 'muted'; children: ReactNode }) {
  return <span className={`ui-status-text is-${tone}`}>{children}</span>
}

/** A grid of fields, two or three across, for a selected thing's details. */
export function FieldGrid({ columns = 2, children }: { columns?: 2 | 3; children: ReactNode }) {
  return (
    <div className="ui-field-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {children}
    </div>
  )
}

/** A sheet's pixels, shown at a whole multiple so a 16 px tile reads at desk distance. */
export function SheetPreview({ src, width, height, scale = 2, alt }: { src: string; width: number; height: number; scale?: number; alt: string }) {
  return (
    <div className="ui-sheet-preview">
      <img src={src} alt={alt} width={width * scale} height={height * scale} style={{ imageRendering: 'pixelated' }} />
    </div>
  )
}

/**
 * The terrain editor's frame (decision of 2026-09-14, after Tiled's; the
 * pass of 2026-09-17): the tools across the top, the terrain list down the
 * side, the sheet filling the rest, one line of small print over it.
 * `stageRef` is the sheet's box, for whoever fits or zooms the sheet to it.
 */
export function Tagger({ tools, side, stage, foot, stageRef }: { tools: ReactNode; side: ReactNode; stage: ReactNode; foot?: ReactNode; stageRef?: Ref<HTMLDivElement> }) {
  return (
    <div className="ui-tagger">
      <div className="ui-tagger-tools">{tools}</div>
      <div className="ui-tagger-side">{side}</div>
      <div className="ui-tagger-stage" ref={stageRef}>
        {stage}
        {foot ? <div className="ui-tagger-foot">{foot}</div> : null}
      </div>
    </div>
  )
}

/**
 * A terrain in the tagger's list: its swatch, its name, and on the chosen
 * one a remove mark. Double-click the name to rename it in place; click the
 * swatch to recolour it. `swatch` is `null` for the entry that tags nothing.
 */
export function TaggerItem({ name, swatch, active, onClick, onRename, onRecolour, onRemove, removeTitle }: { name: string; swatch: string | null; active: boolean; onClick: () => void; onRename?: (name: string) => void; onRecolour?: (hex: string) => void; onRemove?: (() => void) | null; removeTitle?: string }) {
  const [editing, setEditing] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (editing !== null) input.current?.select()
  }, [editing])
  const commit = (): void => {
    const next = editing?.trim() ?? ''
    setEditing(null)
    if (next && next !== name) onRename?.(next)
  }
  return (
    <div className={`ui-tagger-item ${active ? 'is-active' : ''}`}>
      {swatch === null ? (
        <span className="ui-tagger-swatch is-none" />
      ) : onRecolour ? (
        <label className="ui-tagger-swatch" style={{ background: swatch }} title="Recolour">
          <input type="color" value={swatch} onChange={(event) => onRecolour(event.currentTarget.value)} />
        </label>
      ) : (
        <span className="ui-tagger-swatch" style={{ background: swatch }} />
      )}
      {editing === null ? (
        <button type="button" className="ui-tagger-name" onClick={onClick} onDoubleClick={onRename ? () => setEditing(name) : undefined} title={onRename ? 'Double-click to rename' : undefined}>
          {name}
        </button>
      ) : (
        <input
          ref={input}
          className="ui-tagger-rename"
          value={editing}
          onChange={(event) => setEditing(event.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') setEditing(null)
            event.stopPropagation()
          }}
        />
      )}
      {active && onRemove !== undefined ? (
        <button type="button" className="ui-tagger-remove" disabled={onRemove === null} title={removeTitle} onClick={onRemove ?? undefined} aria-label="Remove terrain">
          <Icon name="close" size={11} />
        </button>
      ) : null}
    </div>
  )
}
