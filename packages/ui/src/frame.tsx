/**
 * The frame vocabulary: the five regions of the editor and what goes in them.
 *
 * Rail, context bar, stage, inspector, status bar — the shape the 2026-09-12
 * ruling fixed (see `docs/design/select-first.html`). Every control here is
 * icon-only with its label and key in a tooltip, by the same ruling; the
 * words live in `Tip`, and a caller passes a `title` it would otherwise have
 * printed. Nothing here knows what a tool or a command is — an app hands a
 * `RailButton` its title, glyph and chord, and the registry is where those
 * came from.
 *
 * Mantine appears once, for the tooltip: positioning a floating label
 * against the viewport edge is exactly the kind of thing worth not writing.
 */

import { Slider as MantineSlider, Tooltip } from '@mantine/core'
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'

import { Icon, type IconName } from './icons'

// --- atoms -----------------------------------------------------------------------

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ui-kbd">{children}</kbd>
}

/**
 * A tooltip that carries a control's name and, when it has one, its chord.
 * `kbd` is already formatted for the platform — `formatChord`'s output — so
 * this component never learns what a chord is.
 */
export function Tip({ title, kbd, children }: { title: string; kbd?: string; children: ReactNode }) {
  const label = (
    <span className="ui-tip">
      <span>{title}</span>
      {kbd ? <Kbd>{kbd}</Kbd> : null}
    </span>
  )
  return (
    <Tooltip label={label} openDelay={220} position="bottom" withArrow={false} offset={6}>
      {children}
    </Tooltip>
  )
}

// --- the frame -----------------------------------------------------------------

/** The grid. Each slot is a region; the stage is whatever the app renders the viewport into. */
export function Frame({
  top,
  rail,
  bar,
  stage,
  inspector,
  status,
  inspectorCollapsed = false,
}: {
  top: ReactNode
  rail: ReactNode
  bar: ReactNode
  stage: ReactNode
  inspector: ReactNode
  status: ReactNode
  /** The inspector folded to its strip: the bar and the stage take its width. */
  inspectorCollapsed?: boolean
}) {
  return (
    <div className={`ui-frame ${inspectorCollapsed ? 'is-insp-collapsed' : ''}`}>
      <header className="ui-top">{top}</header>
      <nav className="ui-rail" aria-label="Tools">
        {rail}
      </nav>
      <OverflowBar>{bar}</OverflowBar>
      <main className="ui-stage">{stage}</main>
      <aside className={`ui-insp ${inspectorCollapsed ? 'is-collapsed' : ''}`}>{inspector}</aside>
      <footer className="ui-status">{status}</footer>
    </div>
  )
}

// --- top bar -------------------------------------------------------------------

/** The app's name, then whatever stands between it and the level — the project's crumb — then the level. */
export function Brand({ name, level, dirty, children }: { name: string; level: string; dirty?: boolean; children?: ReactNode }) {
  return (
    <>
      <span className="ui-top-brand">{name}</span>
      {children}
      <span className="ui-top-crumb">
        {children ? '›' : '/'} <b>{level}</b>
      </span>
      {dirty ? <span className="ui-top-dirty" title="Unsaved changes" /> : null}
    </>
  )
}

export function TopGroup({ children }: { children: ReactNode }) {
  return <span className="ui-top-group">{children}</span>
}

export function TopSep() {
  return <span className="ui-top-sep" />
}

export function TopGrow() {
  return <span className="ui-top-grow" />
}

/**
 * A top-bar action. Icon-only unless `primary` (the one accented button) or
 * `labelled` — a file picker, an export — where the word is the affordance.
 */
export function TopButton({
  icon,
  title,
  kbd,
  onClick,
  disabled,
  active,
  primary,
  labelled,
}: {
  icon: IconName
  title: string
  kbd?: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
  primary?: boolean
  labelled?: boolean
}) {
  const showLabel = primary || labelled
  const className = ['ui-btn', showLabel ? '' : 'is-icon', active ? 'is-active' : '', primary ? 'is-primary' : ''].join(' ')
  const button = (
    <button type="button" className={className} onClick={onClick} disabled={disabled} aria-label={showLabel ? undefined : title}>
      <Icon name={icon} size={showLabel ? 13 : 16} />
      {showLabel ? <span>{title}</span> : null}
      {showLabel && kbd ? <Kbd>{kbd}</Kbd> : null}
    </button>
  )
  return showLabel ? (
    button
  ) : (
    <Tip title={title} kbd={kbd}>
      {button}
    </Tip>
  )
}

/** A labelled button that opens the file picker; the input rides inside it. */
/** A file picker as a button. `multiple` lets several files be picked together, delivered to `onFiles`; `onFile` gets the first either way. */
export function FileButton({ icon, title, accept, onFile, onFiles, multiple = false }: { icon: IconName; title: string; accept: string; onFile?: (file: File) => void; onFiles?: (files: File[]) => void; multiple?: boolean }) {
  return (
    <label className="ui-btn is-file">
      <Icon name={icon} size={13} />
      <span>{title}</span>
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          if (files.length > 0) {
            onFiles?.(files)
            onFile?.(files[0])
          }
          event.target.value = ''
        }}
      />
    </label>
  )
}

// --- rail ----------------------------------------------------------------------

export function RailButton({
  icon,
  title,
  kbd,
  active,
  planned,
  onClick,
}: {
  icon: IconName
  title: string
  kbd?: string
  active?: boolean
  /** Declared in the design but not built: drawn dimmer, with a dot, and still clickable. */
  planned?: boolean
  onClick: () => void
}) {
  const className = ['ui-rail-btn', active ? 'is-active' : '', planned ? 'is-planned' : ''].join(' ')
  return (
    <Tip title={planned ? `${title} (planned)` : title} kbd={kbd}>
      <button type="button" className={className} onClick={onClick} aria-pressed={active} aria-label={title}>
        <Icon name={icon} />
      </button>
    </Tip>
  )
}

export function RailGap() {
  return <span className="ui-rail-gap" />
}

export function RailRule() {
  return <hr className="ui-rail-rule" />
}

// --- context bar ---------------------------------------------------------------

export function BarLabel({ children }: { children: ReactNode }) {
  return <span className="ui-bar-label">{children}</span>
}

export function BarGroup({ children }: { children: ReactNode }) {
  return <span className="ui-bar-group">{children}</span>
}

export function BarDivider() {
  return <span className="ui-bar-divider" />
}

export function BarValue({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="ui-bar-value" title={title}>
      {children}
    </span>
  )
}

/** A verb: one icon button in the bar. `active` is for a verb that is a selected mode of its own. */
export function Verb({
  icon,
  title,
  kbd,
  active,
  disabled,
  onClick,
}: {
  icon: IconName
  title: string
  kbd?: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <Tip title={title} kbd={kbd}>
      {/* A verb given `active` is a TOGGLE, and looks like one whether on or off: a well, as a segmented control's buttons have, lit the same way when on. One that only acts stays bare. */}
      <button type="button" className={`ui-verb ${active !== undefined ? 'is-toggle' : ''} ${active ? 'is-active' : ''}`} onClick={onClick} disabled={disabled} aria-pressed={active} aria-label={title}>
        <Icon name={icon} size={17} />
      </button>
    </Tip>
  )
}

/** A parameter in the bar: a short slider with its value beside it, the name and chord in the tooltip. */
export function BarSlider({
  title,
  kbd,
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
}: {
  title: string
  kbd?: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  format?: (value: number) => string
}) {
  return (
    <Tip title={title} kbd={kbd}>
      <span className="ui-bar-group">
        <span className="ui-bar-slider">
          <MantineSlider size="xs" min={min} max={max} step={step} value={value} onChange={onChange} label={null} />
        </span>
        <BarValue>{format ? format(value) : value}</BarValue>
      </span>
    </Tip>
  )
}

export interface IconOption<T> {
  readonly value: T
  readonly icon: IconName
  readonly title: string
  readonly kbd?: string
}

/** A mode switch: one of N, icon-only, the active one underlined in the accent. */
export function IconSegmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T
  options: ReadonlyArray<IconOption<T>>
  onChange: (value: T) => void
}) {
  return (
    <span className="ui-seg" role="radiogroup">
      {options.map((option) => (
        <Tip key={String(option.value)} title={option.title} kbd={option.kbd}>
          <button
            type="button"
            role="radio"
            aria-checked={option.value === value}
            aria-label={option.title}
            className={`ui-seg-btn ${option.value === value ? 'is-active' : ''}`}
            onClick={() => onChange(option.value)}
          >
            <Icon name={option.icon} size={16} />
          </button>
        </Tip>
      ))}
    </span>
  )
}

/**
 * A library entry in the bar: a material, a sprite, a style. Shows a glyph
 * when the entry names one, a swatch when it has a colour, and otherwise a
 * two-letter monogram, so an entry the icon set has never heard of still
 * gets a chip rather than a blank.
 */
export function Chip({
  title,
  icon,
  swatch,
  active,
  onClick,
}: {
  title: string
  icon?: IconName
  swatch?: string
  active?: boolean
  onClick: () => void
}) {
  return (
    <Tip title={title}>
      <button type="button" className={`ui-chip ${active ? 'is-active' : ''}`} onClick={onClick} aria-pressed={active} aria-label={title}>
        {icon ? (
          <Icon name={icon} size={16} />
        ) : swatch ? (
          <span className="ui-chip-swatch" style={{ background: swatch }} />
        ) : (
          <span className="ui-chip-mono">{monogram(title)}</span>
        )}
      </button>
    </Tip>
  )
}

function monogram(title: string): string {
  const words = title.trim().split(/[\s_-]+/).filter(Boolean)
  const letters = words.length >= 2 ? words[0][0] + words[1][0] : title.slice(0, 2)
  return letters.toUpperCase()
}

// --- inspector -----------------------------------------------------------------

/**
 * The context bar, with a "more" menu for what does not fit (the owner, 2026-09-21). The bar lays its controls out on
 * one line and lets the rest wrap out of sight; the button at its end opens a panel holding exactly those. Nothing is
 * measured but where each control landed, so a bar's contents need to know nothing about it.
 */
function OverflowBar({ children }: { children: ReactNode }) {
  const row = useRef<HTMLDivElement>(null)
  const more = useRef<HTMLDivElement>(null)
  /** How many of the row's controls are on its first line: the rest are in the menu. */
  const [shown, setShown] = useState<number | null>(null)
  const [open, setOpen] = useState(false)

  useLayoutEffect(() => {
    const element = row.current
    if (!element) return
    const measure = (): void => {
      const items = [...element.children] as HTMLElement[]
      const first = items[0]?.offsetTop ?? 0
      const fit = items.findIndex((item) => item.offsetTop > first + 4)
      setShown(fit === -1 ? null : fit)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    const mutations = new MutationObserver(measure)
    mutations.observe(element, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      mutations.disconnect()
    }
  }, [])

  // The menu holds the same controls again, the ones already on the bar hidden: by position, since the two are the same list.
  useLayoutEffect(() => {
    const items = more.current ? ([...more.current.children] as HTMLElement[]) : []
    // By `display`, not the `hidden` attribute, which loses to a control's own display rule.
    items.forEach((item, index) => {
      item.style.display = shown !== null && index < shown ? 'none' : ''
    })
  })

  useEffect(() => {
    if (shown === null) setOpen(false)
  }, [shown])
  useEffect(() => {
    if (!open) return
    const close = (event: Event): void => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !(event.target instanceof Node && more.current?.parentElement?.contains(event.target))) setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', close)
    }
  }, [open])

  return (
    <div className="ui-bar">
      <div className="ui-bar-row" ref={row}>
        {children}
      </div>
      {shown !== null ? (
        <div className="ui-bar-more-anchor">
          <button type="button" className={`ui-btn is-icon ${open ? 'is-active' : ''}`} title="More: the controls that do not fit on the bar" aria-label="More controls" aria-expanded={open} onClick={() => setOpen(!open)}>
            <Icon name="more" />
          </button>
          {open ? (
            <div className="ui-bar-more" ref={more}>
              {children}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** What the inspector's pieces need to know about the panel they are in: whether it is folded, and how to open it on a section. */
interface InspectorPanelState {
  collapsed: boolean
  setCollapsed(collapsed: boolean): void
  /** The section to open and bring into view once the panel has unfolded; its title. */
  wanted: string | null
  want(title: string | null): void
}

const InspectorPanelContext = createContext<InspectorPanelState>({ collapsed: false, setCollapsed: () => undefined, wanted: null, want: () => undefined })

/**
 * The inspector, able to fold to a thin strip (the owner, 2026-09-21). Folded, its head is the button that unfolds it
 * and each `Section` is its icon; a click on one unfolds the panel onto that section. The sections stay mounted either
 * way, so what was open is open again.
 */
export function InspectorPanel({ collapsed, onCollapsedChange, children }: { collapsed: boolean; onCollapsedChange: (collapsed: boolean) => void; children: ReactNode }) {
  const [wanted, want] = useState<string | null>(null)
  return <InspectorPanelContext.Provider value={{ collapsed, setCollapsed: onCollapsedChange, wanted, want }}>{children}</InspectorPanelContext.Provider>
}

export function InspectorHead({ children }: { children: ReactNode }) {
  const panel = useContext(InspectorPanelContext)
  if (panel.collapsed) {
    return (
      <div className="ui-insp-head is-collapsed">
        <button type="button" className="ui-btn is-icon" title="Show the inspector" aria-label="Show the inspector" onClick={() => panel.setCollapsed(false)}>
          <Icon name="chevronLeft" />
        </button>
      </div>
    )
  }
  return (
    <div className="ui-insp-head">
      <span>{children}</span>
      <button type="button" className="ui-btn is-icon ui-insp-fold" title="Fold the inspector to a strip" aria-label="Fold the inspector" onClick={() => panel.setCollapsed(true)}>
        <Icon name="chevronRight" />
      </button>
    </div>
  )
}

/**
 * One collapsible section of the inspector. `summary` is the glance at the
 * right of the header — "10 voxels", "Layer 2" — accented when it names
 * something selected. Open state is the section's own by default: what the
 * artist folded stays folded across re-renders, and a caller sets only
 * `defaultOpen`. A caller that needs to open a group of sections from
 * elsewhere — the Level gear on the rail — passes `open` and `onToggle`.
 */
export function Section({
  title,
  summary,
  accent,
  defaultOpen = true,
  open: controlled,
  onToggle,
  icon,
  children,
}: {
  title: string
  /** Its glyph on the folded inspector's strip; without one the strip shows the title's first letter. */
  icon?: IconName
  summary?: ReactNode
  accent?: boolean
  defaultOpen?: boolean
  open?: boolean
  onToggle?: (open: boolean) => void
  children: ReactNode
}) {
  const [own, setOwn] = useState(defaultOpen)
  const open = controlled ?? own
  const panel = useContext(InspectorPanelContext)
  const element = useRef<HTMLDetailsElement>(null)
  // Asked for from the strip: once the panel has unfolded, open and come into view.
  const wanted = !panel.collapsed && panel.wanted === title
  useEffect(() => {
    if (!wanted) return
    setOwn(true)
    onToggle?.(true)
    element.current?.scrollIntoView({ block: 'start' })
    panel.want(null)
  }, [wanted, onToggle, panel])
  if (panel.collapsed) {
    const glance = typeof summary === 'string' || typeof summary === 'number' ? `${title}: ${summary}` : title
    return (
      <button
        type="button"
        className={`ui-btn is-icon ui-insp-strip ${accent ? 'is-accent' : ''}`}
        title={glance}
        aria-label={glance}
        onClick={() => {
          panel.want(title)
          panel.setCollapsed(false)
        }}
      >
        {icon ? <Icon name={icon} /> : <span className="ui-insp-initial">{title.slice(0, 1)}</span>}
      </button>
    )
  }
  return (
    <details
      ref={element}
      className="ui-sec"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open
        if (next === open) return
        setOwn(next)
        onToggle?.(next)
      }}
    >
      <summary>
        {title}
        {summary !== undefined ? <span className={`ui-sec-sum ${accent ? 'is-accent' : ''}`}>{summary}</span> : null}
      </summary>
      <div className="ui-sec-body">{children}</div>
    </details>
  )
}

/** A label on the left and a value or a control on the right. */
export function Row({ label, value, muted, children }: { label: ReactNode; value?: ReactNode; muted?: boolean; children?: ReactNode }) {
  return (
    <div className="ui-row">
      <span>{label}</span>
      {children !== undefined ? (
        <span className="ui-row-control">{children}</span>
      ) : (
        <span className={`ui-row-value ${muted ? 'is-muted' : ''}`}>{value}</span>
      )}
    </div>
  )
}

export function Actions({ children }: { children: ReactNode }) {
  return <div className="ui-actions">{children}</div>
}

export function Action({
  title,
  kbd,
  tone = 'default',
  disabled,
  onClick,
}: {
  title: string
  kbd?: string
  tone?: 'default' | 'accent' | 'danger'
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button type="button" className={`ui-action ${tone === 'accent' ? 'is-accent' : tone === 'danger' ? 'is-danger' : ''}`} onClick={onClick} disabled={disabled}>
      {title}
      {kbd ? <Kbd>{kbd}</Kbd> : null}
    </button>
  )
}

export function List({ children }: { children: ReactNode }) {
  return <div className="ui-list">{children}</div>
}

/** A row in a list: a dot or swatch, a name, and a glance at the right. */
export function Item({
  name,
  meta,
  swatch,
  active,
  onClick,
  trailing,
}: {
  name: ReactNode
  meta?: ReactNode
  swatch?: string
  active?: boolean
  onClick?: () => void
  /** Small controls at the right edge — a hide toggle, a lock — rendered outside the button so a click on them does not also select. */
  trailing?: ReactNode
}) {
  return (
    <div className={`ui-item ${active ? 'is-active' : ''} ${trailing ? 'has-trailing' : ''}`}>
      <span className="ui-item-dot" style={swatch ? { background: swatch } : undefined} />
      {onClick ? (
        <button type="button" className="ui-item-name ui-item-link" onClick={onClick}>
          {name}
        </button>
      ) : (
        <span className="ui-item-name">{name}</span>
      )}
      <span className="ui-item-meta">{meta}</span>
      {trailing ? <span className="ui-row-control">{trailing}</span> : null}
    </div>
  )
}

// --- status bar ----------------------------------------------------------------

export function StatusHints({ children }: { children: ReactNode }) {
  return <div className="ui-status-hints">{children}</div>
}

export function StatusRight({ children }: { children: ReactNode }) {
  return <div className="ui-status-right">{children}</div>
}

/** One hint: a chord and what it does. */
export function Hint({ kbd, children }: { kbd?: string; children: ReactNode }) {
  return (
    <span className="ui-hint">
      {kbd ? <Kbd>{kbd}</Kbd> : null}
      {children}
    </span>
  )
}

// --- viewport overlays ---------------------------------------------------------

export function Overlay({ at, children }: { at: 'top-left' | 'top-center' | 'bottom-left' | 'bottom-center' | 'bottom-right' | 'right'; children: ReactNode }) {
  return <div className={`ui-overlay is-${at}`}>{children}</div>
}

export function Pill({ warn, children }: { warn?: boolean; children: ReactNode }) {
  return <span className={`ui-pill ${warn ? 'is-warn' : ''}`}>{children}</span>
}

// --- material layers -------------------------------------------------------------

/** One row of the Material Layers widget. */
export interface MaterialLayerRow {
  /** What the open map holds on this layer, in words: "Grass · Sand", or "empty". */
  readonly summary: string
  /** The first material's swatch, or `null` for an empty layer. */
  readonly swatch: string | null
  readonly visible: boolean
}

/**
 * The Material Layers widget (rulings of 2026-09-18): a compact control in a
 * corner of the stage, shown while painting terrain. Its bar is always there:
 * one target per layer, bottom first, so switching the layer painting goes to
 * is one click, the active one lit and a hidden one dimmed, each with a bar of
 * the swatch of what it mostly holds. The layers icon opens it, adding a row
 * per layer, topmost first, with what the map holds on it and an eye that
 * hides it from the view without changing anything saved. Layers are numbered
 * from 1 on screen; `active` and the callbacks count from 0.
 */
export function MaterialLayers({
  rows,
  active,
  open,
  onOpen,
  onSelect,
  onToggle,
}: {
  rows: readonly MaterialLayerRow[]
  active: number
  open: boolean
  onOpen: (open: boolean) => void
  onSelect: (layer: number) => void
  onToggle: (layer: number) => void
}) {
  const describe = (layer: number): string => {
    const row = rows[layer]
    return `Material layer ${layer + 1} · ${row.summary}${row.visible ? '' : ' · hidden'}${layer === active ? ' · painting here' : ''}`
  }
  return (
    <div className={`ui-mlayers ${open ? 'is-open' : ''}`}>
      {open ? (
        <div className="ui-mlayers-rows">
          {rows
            .map((row, layer) => ({ row, layer }))
            .reverse()
            .map(({ row, layer }) => (
              <div key={layer} className={`ui-mlayers-row ${layer === active ? 'is-active' : ''} ${row.visible ? '' : 'is-hidden'}`}>
                <button type="button" className="ui-mlayers-eye" aria-label={`${row.visible ? 'Hide' : 'Show'} material layer ${layer + 1}`} aria-pressed={!row.visible} onClick={() => onToggle(layer)}>
                  <Icon name={row.visible ? 'eye' : 'eyeOff'} size={14} />
                </button>
                <button type="button" className="ui-mlayers-pick" aria-pressed={layer === active} title={describe(layer)} onClick={() => onSelect(layer)}>
                  <span className="ui-mlayers-n ui-num">{layer + 1}</span>
                  {row.swatch ? <span className="ui-mlayers-swatch" style={{ background: row.swatch }} /> : null}
                  <span className="ui-mlayers-summary">{row.summary}</span>
                </button>
              </div>
            ))}
        </div>
      ) : null}
      <div className="ui-mlayers-bar">
        <button type="button" className="ui-mlayers-toggle" aria-expanded={open} title={open ? 'Material layers — close' : 'Material layers — show each layer, and hide some from the view'} onClick={() => onOpen(!open)}>
          <Icon name="layers" size={15} />
        </button>
        {rows.map((row, layer) => (
          <button
            key={layer}
            type="button"
            className={`ui-mlayers-target ${layer === active ? 'is-active' : ''} ${row.visible ? '' : 'is-hidden'}`}
            aria-pressed={layer === active}
            aria-label={describe(layer)}
            title={describe(layer)}
            onClick={() => onSelect(layer)}
          >
            <span className="ui-num">{layer + 1}</span>
            <span className="ui-mlayers-target-swatch" style={{ background: row.swatch ?? 'transparent' }} />
          </button>
        ))}
      </div>
    </div>
  )
}

// --- layer view ----------------------------------------------------------------

/**
 * The layer view's control: a slicer's layer slider on the stage's right
 * edge (`docs/design/select-first.html`). Two handles, `lo` and `hi`, in the
 * document's height unit; dragging either moves it, alt-dragging moves both
 * to scrub one band, double-clicking resets to the whole range. Dim until
 * narrowed, so it disappears until wanted.
 */
export function LayerRange({
  max,
  lo,
  hi,
  onChange,
  title = 'Z layers',
}: {
  max: number
  lo: number
  hi: number
  onChange: (range: { lo: number; hi: number }) => void
  title?: string
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const narrow = lo > 0 || hi < max
  const y = (layer: number) => `${100 - (layer / max) * 100}%`
  const tick = Math.max(1, Math.round(max / 8 / 5) * 5)
  const labels: number[] = []
  for (let layer = 0; layer <= max; layer += tick) labels.push(layer)

  const grab = (which: 'lo' | 'hi') => (event: PointerEvent<HTMLElement>) => {
    const track = trackRef.current
    if (!track) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const both = event.altKey
    const start = { lo, hi }
    const rect = track.getBoundingClientRect()
    const toLayer = (clientY: number) => Math.max(0, Math.min(max, Math.round(((rect.bottom - clientY) / rect.height) * max)))
    const startLayer = toLayer(event.clientY)
    const move = (moveEvent: globalThis.PointerEvent) => {
      const layer = toLayer(moveEvent.clientY)
      if (both) {
        const span = start.hi - start.lo
        const nextLo = Math.max(0, Math.min(max - span, start.lo + layer - startLayer))
        onChange({ lo: nextLo, hi: nextLo + span })
      } else if (which === 'hi') onChange({ lo, hi: Math.max(lo, layer) })
      else onChange({ lo: Math.min(hi, layer), hi })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className={`ui-layers ${narrow ? 'is-narrow' : ''}`} title={`${title} — drag a handle; ⌥ drag moves both; double-click resets`} onDoubleClick={() => onChange({ lo: 0, hi: max })}>
      <div className="ui-layers-track" ref={trackRef} />
      <div className="ui-layers-range" style={{ top: y(hi), height: `${((hi - lo) / max) * 100}%` }} />
      {labels.map((layer) => (
        <div key={layer} className="ui-layers-tick" style={{ top: y(layer) }}>
          <i>{layer}</i>
        </div>
      ))}
      <button type="button" className="ui-layers-handle" data-layer={hi} style={{ top: y(hi) }} onPointerDown={grab('hi')} aria-label={`Top of the Z layer view: ${hi}`} />
      <button type="button" className="ui-layers-handle" data-layer={lo} style={{ top: y(lo) }} onPointerDown={grab('lo')} aria-label={`Bottom of the Z layer view: ${lo}`} />
      <span className="ui-layers-cap">{title.toUpperCase()}</span>
    </div>
  )
}
