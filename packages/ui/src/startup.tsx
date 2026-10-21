/**
 * The startup screen (design of 2026-09-14, `docs/design/project-flow`):
 * the mark and the name, two doors, the recent projects, and whether to
 * reopen the last one on launch. Mirrors brink's, in this vocabulary.
 *
 * Presentation only: the app hands in what the doors and the rows do, and
 * the mark and the name above them. The mark is the brand's (`brand/`), an
 * image the app owns; the name is text, or the brand's wordmark.
 */

import type { ReactNode } from 'react'

export function StartupScreen({ mark, name, tagline, children }: { mark: ReactNode; name: ReactNode; tagline: string; children: ReactNode }) {
  return (
    <div className="ui-startup">
      <div className="ui-startup-column">
        <div className="ui-startup-lockup">
          <div className="ui-startup-mark">{mark}</div>
          <div className="ui-startup-name">{name}</div>
          <div className="ui-startup-tagline">{tagline}</div>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Doors({ children }: { children: ReactNode }) {
  return <div className="ui-doors">{children}</div>
}

/** One way in: a title, what it does, and a tint that says which kind of thing it makes. */
export function Door({ title, body, tone, onClick }: { title: string; body: string; tone: 'ok' | 'accent'; onClick: () => void }) {
  return (
    <button type="button" className="ui-door" onClick={onClick}>
      <span className="ui-door-head">
        <span className={`ui-door-dot ${tone === 'ok' ? 'is-ok' : 'is-accent'}`} />
        <span className="ui-door-title">{title}</span>
      </span>
      <span className="ui-door-body">{body}</span>
    </button>
  )
}

export function StartupSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ui-startup-section">
      <div className="ui-startup-label">{label}</div>
      {children}
    </div>
  )
}

export function RecentList({ children, empty }: { children: ReactNode; empty: string }) {
  return <div className="ui-recents">{children ?? null}{Array.isArray(children) && children.length === 0 ? <div className="ui-recents-empty">{empty}</div> : null}</div>
}

export function RecentRow({ name, path, onClick }: { name: string; path: string; onClick: () => void }) {
  return (
    <button type="button" className="ui-recent" onClick={onClick}>
      <span className="ui-recent-name">{name}</span>
      <span className="ui-recent-path">{path}</span>
    </button>
  )
}

export function Checkbox({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
  return (
    <label className="ui-checkbox">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
      <span className={`ui-checkbox-box ${checked ? 'is-on' : ''}`} />
      <span className="ui-checkbox-label">{children}</span>
    </label>
  )
}

/** A line of feedback under a form: what went wrong, in the artist's terms. */
export function ErrorLine({ children }: { children: ReactNode }) {
  return <div className="ui-error-line">{children}</div>
}
