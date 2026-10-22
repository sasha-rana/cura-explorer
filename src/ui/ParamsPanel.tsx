import type { ReactNode } from 'react'

/** Small labelled form primitives shared by the pipeline stage sections. */

export function NumField(props: {
  label: string
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  unit?: string
}) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <span className="field-input">
        <input
          type="number"
          value={props.value}
          min={props.min}
          max={props.max}
          step={props.step ?? 1}
          onChange={(e) => {
            const v = Number(e.target.value)
            if (Number.isFinite(v)) props.onChange(v)
          }}
        />
        {props.unit && <span className="field-unit">{props.unit}</span>}
      </span>
    </label>
  )
}

/** Micron-valued field displayed in millimetres; converts at the boundary. */
export function MmField(props: {
  label: string
  valueUm: number
  onChangeUm: (v: number) => void
  minMm?: number
  maxMm?: number
  stepMm?: number
}) {
  return (
    <NumField
      label={props.label}
      value={Math.round(props.valueUm / 10) / 100}
      onChange={(v) => props.onChangeUm(Math.round(v * 1000))}
      min={props.minMm}
      max={props.maxMm}
      step={props.stepMm ?? 0.1}
      unit="mm"
    />
  )
}

/** Speed field: microns/s shown as mm/s. */
export function SpeedField(props: {
  label: string
  valueUmS: number
  onChangeUmS: (v: number) => void
}) {
  return (
    <NumField
      label={props.label}
      value={Math.round(props.valueUmS / 1000)}
      onChange={(v) => props.onChangeUmS(Math.round(v * 1000))}
      min={1}
      max={500}
      step={5}
      unit="mm/s"
    />
  )
}

export function SelectField<T extends string>(props: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <span className="field-input">
        <select value={props.value} onChange={(e) => props.onChange(e.target.value as T)}>
          {props.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </span>
    </label>
  )
}

export function Toggle(props: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span>{props.label}</span>
    </label>
  )
}

export function Section(props: {
  title: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <section className={`stage${props.open ? ' open' : ''}`}>
      <button type="button" className="stage-header" onClick={props.onToggle}>
        <span className="stage-caret">{props.open ? '▾' : '▸'}</span>
        <span>{props.title}</span>
      </button>
      {props.open && <div className="stage-body">{props.children}</div>}
    </section>
  )
}
