import { useState } from 'react'

/**
 * A numeric input that doesn't fight the keyboard: while focused it shows
 * exactly what was typed (so clearing "1" to type "0.6" works — a controlled
 * number input would snap back on the intermediate ""/"0"), pushing every
 * valid value live via onChange; blur/Enter drops the draft back to the
 * canonical value and fires onDone (the commit-one-history-op hook).
 */
export function NumField({
  label,
  value,
  step,
  min,
  disabled,
  onChange,
  onFocus,
  onDone,
}: {
  label: string
  value: number
  step: number
  /** Ignore typed values below this (e.g. 0.01 keeps scales positive). */
  min?: number
  disabled?: boolean
  onChange: (v: number) => void
  onFocus?: () => void
  onDone?: () => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <label className="tex-field">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        disabled={disabled}
        value={draft ?? String(Math.round(value * 1000) / 1000)}
        onFocus={onFocus}
        onChange={(e) => {
          setDraft(e.target.value)
          const v = Number(e.target.value)
          if (e.target.value !== '' && Number.isFinite(v) && (min === undefined || v >= min)) {
            onChange(v)
          }
        }}
        onBlur={() => {
          setDraft(null)
          onDone?.()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
    </label>
  )
}
