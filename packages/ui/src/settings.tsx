/**
 * The settings modal (design of 2026-09-14, after brink's): a rail of
 * sections on the frame's ground, one section at a time on a raised pane,
 * and tables where a section lists things.
 *
 * ONE SIZE, whatever is open (ruling of 2026-09-17): the window inset by a
 * fixed margin. Sections differ enormously — a four-field form, a tagger over
 * a 592 × 960 sheet — and sizing the modal to each made it jump under the
 * pointer on every switch. A form section instead caps its own content at a
 * readable width inside the big pane; an editor section fills it.
 *
 * Presentation only. The app decides which sections exist and what each
 * holds; the rail's active item and the pane's title come in as props.
 */

import { Modal } from '@mantine/core'
import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react'

import { Icon, type IconName } from './icons'

export function SettingsDialog({ opened, onClose, rail, title, aside, wide = false, children }: { opened: boolean; onClose: () => void; rail: ReactNode; title: string; aside?: ReactNode; /** The section is an EDITOR rather than a form: its pane loses the padding and the width cap and fills the window. The modal itself is one size either way. */ wide?: boolean; children: ReactNode }) {
  return (
    <Modal opened={opened} onClose={onClose} size="calc(100vw - 96px)" centered withCloseButton={false} padding={0} classNames={{ content: `ui-settings ${wide ? 'is-wide' : ''}`, body: 'ui-settings-body' }} overlayProps={{ className: 'ui-dialog-scrim' }}>
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
export function TaggerItem({ name, swatch, active, dim, meta, onClick, onRename, onRecolour, onRemove, removeTitle }: { name: string; swatch: string | null; active: boolean; /** Nothing on this sheet is tagged with it yet. */ dim?: boolean; /** How many corners of this sheet carry it. */ meta?: ReactNode; onClick: () => void; onRename?: (name: string) => void; onRecolour?: (hex: string) => void; onRemove?: (() => void) | null; removeTitle?: string }) {
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
    <div className={`ui-tagger-item ${active ? 'is-active' : ''} ${dim ? 'is-dim' : ''}`}>
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
      ) : meta !== undefined ? (
        <span className="ui-tagger-meta">{meta}</span>
      ) : null}
    </div>
  )
}

// --- the image library (decisions of 2026-09-17) ---------------------------------

/**
 * The library's frame: tabs across the top, the list down the left, the
 * chosen image big in the middle, its properties as a form on the right —
 * the terrain editor's layout, with a form where the tagger has none.
 * `onDropFiles` takes files dropped anywhere on it: the one-gesture import.
 */
export function Library({ tabs, side, stage, form, stageRef, onDropFiles }: { tabs: ReactNode; side: ReactNode; stage: ReactNode; form: ReactNode; stageRef?: Ref<HTMLDivElement>; onDropFiles?: (files: File[]) => void }) {
  const [over, setOver] = useState(false)
  return (
    <div
      className={`ui-library ${over ? 'is-over' : ''}`}
      onDragOver={onDropFiles ? (event) => {
        if ([...event.dataTransfer.types].includes('Files')) {
          event.preventDefault()
          setOver(true)
        }
      } : undefined}
      onDragLeave={onDropFiles ? () => setOver(false) : undefined}
      onDrop={onDropFiles ? (event) => {
        event.preventDefault()
        setOver(false)
        const files = [...event.dataTransfer.files]
        if (files.length > 0) onDropFiles(files)
      } : undefined}
    >
      <div className="ui-library-tabs">{tabs}</div>
      <div className="ui-library-side">{side}</div>
      <div className="ui-library-stage" ref={stageRef}>
        {stage}
      </div>
      <div className="ui-library-form">{form}</div>
      {over ? <div className="ui-library-drop">Drop to import</div> : null}
    </div>
  )
}

export function LibraryTab({ title, active, soon, onClick }: { title: string; active: boolean; soon?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`ui-library-tab ${active ? 'is-active' : ''}`} onClick={onClick}>
      {title}
      {soon ? <span className="ui-library-soon">soon</span> : null}
    </button>
  )
}

/** A row of the library's list: thumbnail, name, a second line, and a status dot — or a trailing control in the dot's place. */
export function LibraryItem({ thumb, name, meta, tone, badge, active, dim, onClick, trailing }: { thumb?: string; name: string; meta: ReactNode; tone?: 'ok' | 'warn' | 'muted'; badge?: string; active?: boolean; dim?: boolean; onClick?: () => void; trailing?: ReactNode }) {
  return (
    <div className={`ui-library-item ${active ? 'is-active' : ''} ${dim ? 'is-dim' : ''}`}>
      {thumb ? <img className="ui-library-thumb" src={thumb} alt="" /> : <span className="ui-library-thumb" />}
      <button type="button" className="ui-library-item-text" onClick={onClick} disabled={!onClick}>
        <span className="ui-library-item-name">
          {name}
          {badge ? <span className="ui-library-soon">{badge}</span> : null}
        </span>
        <span className="ui-library-item-meta">{meta}</span>
      </button>
      {trailing ?? <span className={`ui-library-dot is-${tone ?? 'muted'}`} />}
    </div>
  )
}

/** A group heading inside the list. */
export function LibraryGroup({ children }: { children: ReactNode }) {
  return <div className="ui-library-group">{children}</div>
}

/** A read-only line of a property form: a label and a value that is derived, never typed. */
export function Derived({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ui-derived">
      <span className="ui-derived-label">{label}</span>
      <span className="ui-derived-value">{children}</span>
    </div>
  )
}

/**
 * An X Y pair with a link: one field while linked, two when split (decision of 2026-09-17). Stored per axis
 * always; the link is the view. `unit` is the suffix.
 */
export function PairInput({ label, value, onChange, unit = 'px', min = 0 }: { label: string; value: { x: number; y: number }; onChange: (value: { x: number; y: number }) => void; unit?: string; min?: number }) {
  const [linked, setLinked] = useState(value.x === value.y)
  const number = (v: number, set: (n: number) => void) => (
    <input
      type="number"
      className="ui-pair-field"
      min={min}
      value={v}
      onChange={(event) => {
        const n = Number(event.currentTarget.value)
        if (Number.isInteger(n) && n >= min) set(n)
      }}
    />
  )
  return (
    <div className="ui-field">
      <div className="ui-field-label ui-pair-label">
        <span>{label}</span>
        <button type="button" className={`ui-pair-link ${linked ? '' : 'is-split'}`} title={linked ? 'Split into X and Y' : 'Link X and Y'} onClick={() => setLinked((l) => !l)} aria-label={linked ? 'Split into X and Y' : 'Link X and Y'}>
          <Icon name={linked ? 'link' : 'unlink'} size={12} />
        </button>
      </div>
      <div className="ui-pair">
        {linked ? (
          number(value.x, (n) => onChange({ x: n, y: n }))
        ) : (
          <>
            <span className="ui-pair-axis">X</span>
            {number(value.x, (n) => onChange({ ...value, x: n }))}
            <span className="ui-pair-axis">Y</span>
            {number(value.y, (n) => onChange({ ...value, y: n }))}
          </>
        )}
        <span className="ui-pair-unit">{unit}</span>
      </div>
    </div>
  )
}

export interface PickerOption {
  readonly value: string
  readonly name: string
  /** The second line, and what typing also matches. */
  readonly meta: string
  readonly thumb?: string
}

/**
 * A rich typeahead over assets (decision of 2026-09-17): type to filter names and details, a thumbnail and a
 * second line per row, ↑ ↓ ⏎ ⎋, the current value shown as such a row. `footer` says what is not listed and why.
 */
export function AssetPicker({ value, options, onChange, footer, placeholder = 'Type to find…' }: { value: string; options: readonly PickerOption[]; onChange: (value: string) => void; footer?: ReactNode; placeholder?: string }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const current = options.find((o) => o.value === value)
  const q = query.trim().toLowerCase()
  const shown = q ? options.filter((o) => o.name.toLowerCase().includes(q) || o.value.toLowerCase().includes(q) || o.meta.toLowerCase().includes(q)) : options
  const choose = (option: PickerOption): void => {
    onChange(option.value)
    setOpen(false)
    setQuery('')
  }
  useEffect(() => {
    if (open) input.current?.focus()
  }, [open])
  useEffect(() => setCursor(0), [q])
  return (
    <div className="ui-picker" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
    }}>
      {open ? (
        <input
          ref={input}
          className="ui-picker-input"
          value={query}
          placeholder={current?.name ?? placeholder}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'ArrowDown') setCursor((c) => Math.min(shown.length - 1, c + 1))
            else if (event.key === 'ArrowUp') setCursor((c) => Math.max(0, c - 1))
            else if (event.key === 'Enter' && shown[cursor]) choose(shown[cursor])
            else if (event.key === 'Escape') setOpen(false)
            else return
            event.preventDefault()
          }}
        />
      ) : (
        <button type="button" className="ui-picker-current" onClick={() => setOpen(true)}>
          {current?.thumb ? <img className="ui-library-thumb is-small" src={current.thumb} alt="" /> : null}
          <span className="ui-picker-name">{current?.name ?? placeholder}</span>
          <span className="ui-picker-caret">▾</span>
        </button>
      )}
      {open ? (
        <div className="ui-picker-menu" role="listbox">
          {shown.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`ui-picker-row ${index === cursor ? 'is-cursor' : ''} ${option.value === value ? 'is-active' : ''}`}
              onMouseEnter={() => setCursor(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option)}
            >
              {option.thumb ? <img className="ui-library-thumb" src={option.thumb} alt="" /> : <span className="ui-library-thumb" />}
              <span className="ui-picker-row-text">
                <span className="ui-picker-row-name">{option.name}</span>
                <span className="ui-picker-row-meta">{option.meta}</span>
              </span>
            </button>
          ))}
          {shown.length === 0 ? <div className="ui-picker-empty">Nothing matches.</div> : null}
          {footer ? <div className="ui-picker-footer">{footer}</div> : null}
        </div>
      ) : null}
    </div>
  )
}

// --- the Materials section (decisions of 2026-09-19) ------------------------------

/**
 * How much of a subject is drawn: a 4 × 4 grid of cells with the number beside it. Cell k is arrangement mask k, laid
 * out as the classic mask block (column k mod 4, row k div 4): `on` where a tile answers it, `off` where it is owed
 * and missing, `na` where it is not owed.
 */
export function CoverageMark({ cells, drawn, owed, large = false }: { cells: ReadonlyArray<'on' | 'off' | 'na'>; drawn: number; owed: number; large?: boolean }) {
  return (
    <span className="ui-coverage" title={`${drawn} of ${owed} arrangements drawn`}>
      <span className={`ui-coverage-grid ${large ? 'is-large' : ''}`} aria-hidden="true">
        {cells.map((cell, k) => (
          <i key={k} className={`is-${cell}`} />
        ))}
      </span>
      <span className={`ui-coverage-count is-${drawn === owed ? 'ok' : drawn === 0 ? 'muted' : 'warn'}`}>
        {drawn}/{owed}
      </span>
    </span>
  )
}

/** The kinds of face a material has art for, as three icons: lit for art of its own, half-lit where art for any face draws there, dim for none. */
export function FaceMarks({ faces }: { faces: ReadonlyArray<{ readonly id: string; readonly title: string; readonly icon: IconName; readonly art: 'own' | 'any' | 'none' }> }) {
  return (
    <span className="ui-faces">
      {faces.map((face) => (
        <span key={face.id} className={`is-${face.art}`} title={`${face.title}: ${face.art === 'own' ? 'has art drawn for it' : face.art === 'any' ? 'draws with art tagged for any face' : 'no art'}`}>
          <Icon name={face.icon} size={11} />
        </span>
      ))}
    </span>
  )
}

/** A material in the section's list: swatch, name, what `marks` says about it, and its coverage at the right. */
export function MaterialRow({ name, swatch, active, marks, trailing, onClick }: { name: string; swatch: string; active: boolean; marks?: ReactNode; trailing?: ReactNode; onClick: () => void }) {
  return (
    <div className={`ui-material-row ${active ? 'is-active' : ''}`}>
      <span className="ui-tagger-swatch" style={{ background: swatch, cursor: 'default' }} />
      <button type="button" className="ui-material-row-name" onClick={onClick}>
        <span>{name}</span>
        {marks}
      </button>
      {trailing}
    </div>
  )
}

/** One of a material's subjects, under it in the list: on its own, or meeting another. The lit one is what every view shows. */
export function SubjectRow({ label, prefix, note, swatch, active, trailing, onClick }: { label: string; prefix?: string; note?: string; swatch?: string; active: boolean; trailing?: ReactNode; onClick: () => void }) {
  return (
    <div className={`ui-subject-row ${active ? 'is-active' : ''}`}>
      {swatch ? <span className="ui-tagger-swatch" style={{ background: swatch, cursor: 'default' }} /> : <span />}
      <button type="button" className="ui-material-row-name" onClick={onClick}>
        <span>
          {prefix ? <span className="ui-subject-prefix">{prefix} </span> : null}
          {label}
        </span>
        {note ? <span className="ui-subject-note">{note}</span> : null}
      </button>
      {trailing}
    </div>
  )
}

/**
 * A stage with controls floating on it (decision of 2026-09-19): the content scrolls underneath, the floats stay
 * where they are. `foot` is the one line of small print along the bottom.
 */
export function FloatStage({ children, floats, foot, scrollRef }: { children: ReactNode; floats?: ReactNode; foot?: ReactNode; scrollRef?: Ref<HTMLDivElement> }) {
  return (
    <div className="ui-float-stage">
      <div className="ui-float-stage-scroll" ref={scrollRef}>
        {children}
      </div>
      {floats}
      {foot ? <div className="ui-tagger-foot">{foot}</div> : null}
    </div>
  )
}

/** A control floating on a stage, in one of its top corners. */
export function StageFloat({ corner, children }: { corner: 'left' | 'right'; children: ReactNode }) {
  return <div className={`ui-stage-float is-${corner}`}>{children}</div>
}
