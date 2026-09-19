/**
 * The form primitives a panel is written in.
 *
 * Same eight names and props as before #96 — a feature's panel does not
 * change when the implementation under a `Slider` does — but the inputs are
 * Mantine's now (#12: Mantine is this package's implementation detail), sized
 * `xs` so they sit in a 300px inspector, and the layout atoms (`Field`,
 * `Panel`, `Note`) stay class-based on the vocabulary's own stylesheet.
 *
 * `Segmented` here is the TEXT one, for a value whose options are names
 * (a preset, a facing count); the icon-only switch a bar wants is
 * `IconSegmented` in `frame.tsx`.
 */

import {
  ColorInput as MantineColorInput,
  NativeSelect,
  NumberInput as MantineNumberInput,
  SegmentedControl,
  Slider as MantineSlider,
  Switch,
  TextInput as MantineTextInput,
} from '@mantine/core'
import type { ReactNode } from 'react'

export function TextInput({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder?: string }) {
  return <MantineTextInput size="xs" value={value} placeholder={placeholder} onChange={(event) => onChange(event.currentTarget.value)} />
}

/** An on/off, as a switch: reads as a setting rather than a form checkbox. */
export function Toggle({ checked, onChange, title }: { checked: boolean; onChange: (checked: boolean) => void; title?: string }) {
  return <Switch size="xs" checked={checked} title={title} onChange={(event) => onChange(event.currentTarget.checked)} />
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="ui-field">
      <span className="ui-field-label">
        {label}
        {hint ? <em title={hint}>?</em> : null}
      </span>
      <span className="ui-field-control">{children}</span>
    </label>
  )
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  title,
}: {
  value: T
  options: Array<{ value: T; label: string; title?: string }>
  onChange: (value: T) => void
  title?: string
}) {
  const data = options.map((option) => ({
    value: String(option.value),
    label: option.title ? <span title={option.title}>{option.label}</span> : option.label,
  }))
  return (
    <SegmentedControl
      title={title}
      size="xs"
      fullWidth
      value={String(value)}
      data={data}
      onChange={(next) => {
        const option = options.find((candidate) => String(candidate.value) === next)
        if (option) onChange(option.value)
      }}
    />
  )
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  onChangeEnd,
  format,
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  /** When the drag or key press is over: for a value too costly to commit on every step. */
  onChangeEnd?: (value: number) => void
  format?: (value: number) => string
}) {
  return (
    <span className="ui-slider">
      <MantineSlider size="xs" min={min} max={max} step={step} value={value} onChange={onChange} onChangeEnd={onChangeEnd} label={null} />
      <output>{format ? format(value) : value}</output>
    </span>
  )
}

export function NumberInput({
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (value: number) => void
}) {
  return (
    <MantineNumberInput
      size="xs"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(next) => {
        // Mantine hands back the raw string while a field is being typed
        // into; only a finished number is a value the document should see.
        if (typeof next === 'number' && Number.isFinite(next)) onChange(next)
      }}
    />
  )
}

export function Select<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  return (
    <NativeSelect
      size="xs"
      value={value}
      data={options.map((option) => ({ value: option.value, label: option.label }))}
      onChange={(event) => onChange(event.currentTarget.value as T)}
    />
  )
}

export function ColorInput({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const hex = `#${value.toString(16).padStart(6, '0')}`
  return (
    <MantineColorInput
      size="xs"
      format="hex"
      value={hex}
      onChange={(next) => {
        const parsed = Number.parseInt(next.replace(/^#/, ''), 16)
        if (next.length === 7 && Number.isFinite(parsed)) onChange(parsed)
      }}
    />
  )
}

export function Panel({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="ui-panel">
      <header className="ui-panel-head">
        <h2>{title}</h2>
        {aside}
      </header>
      <div className="ui-panel-body">{children}</div>
    </section>
  )
}

export function Note({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' }) {
  return <p className={`ui-note ${tone === 'warn' ? 'is-warn' : ''}`}>{children}</p>
}
