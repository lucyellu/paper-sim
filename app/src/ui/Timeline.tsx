import { useRef } from 'react'
import { useAppStore } from '../state/store'

export function Timeline() {
  const s = useAppStore()
  const n = s.steps.length
  const pb = s.playback
  const scrub = pb.mode === 'scrub'
  const t = pb.mode === 'scrub' ? pb.t : n
  const playing = pb.mode === 'scrub' && pb.playing
  const trackRef = useRef<HTMLDivElement>(null)

  const frac = n > 0 ? t / n : 0
  // A step is "selected" when the playhead sits exactly on its notch.
  const selStep =
    scrub && n > 0 && Math.round(t) >= 1 && Math.abs(t - Math.round(t)) < 0.02
      ? Math.round(t)
      : null

  function scrubFromPointer(clientX: number) {
    const rect = trackRef.current!.getBoundingClientRect()
    const f = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    s.setScrub(f * n)
  }

  const stepIndex = Math.min(Math.max(Math.ceil(t), 1), Math.max(n, 1))
  const label =
    n === 0
      ? 'No steps yet — record keyframes to build the folding animation'
      : selStep !== null
        ? `Step ${selStep}/${n}: ${s.steps[selStep - 1]?.name ?? ''}`
        : scrub
          ? `Previewing step ${stepIndex}/${n}: ${s.steps[stepIndex - 1]?.name ?? ''}`
          : 'Editing at the end of the sequence'

  function reEdit(k: number) {
    const removed = n - k + 1
    if (
      confirm(
        `Re-edit step ${k}? This deletes step ${k}${removed > 1 ? ` and the ${removed - 1} step(s) after it` : ''}, keeping its pose so you can adjust and press Add Keyframe to re-record.`,
      )
    )
      s.editStepInPlace(k - 1)
  }

  function continueAfter(k: number) {
    const removed = n - k
    if (removed > 0) {
      if (!confirm(`Continue after step ${k}? The ${removed} later step(s) will be deleted.`))
        return
    }
    s.editFromStep(k - 1)
  }

  return (
    <div className="timeline">
      <button
        disabled={n === 0}
        onClick={() => s.setPlaying(!playing)}
        title={playing ? 'Pause' : 'Play from the top'}
      >
        {playing ? '⏸' : '▶'}
      </button>
      <div
        className={`track ${n === 0 ? 'disabled' : ''}`}
        ref={trackRef}
        onPointerDown={(e) => {
          if (n === 0) return
          ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
          scrubFromPointer(e.clientX)
        }}
        onPointerMove={(e) => {
          if (n === 0 || e.buttons !== 1) return
          scrubFromPointer(e.clientX)
        }}
      >
        <div className="track-rail" />
        <div className="track-fill" style={{ width: `${frac * 100}%` }} />
        {s.steps.map((st, i) => {
          const reached = t >= i + 1 - 0.001
          const active = selStep === i + 1
          return (
            <button
              key={st.id}
              className={`notch ${reached ? 'reached' : ''} ${active ? 'active' : ''}`}
              style={{ left: `${((i + 1) / n) * 100}%` }}
              title={`${i + 1}. ${st.name} — click to select`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                s.setScrub(i + 1)
              }}
            >
              {i + 1}
            </button>
          )
        })}
        {n > 0 && <div className="playhead" style={{ left: `${frac * 100}%` }} />}
      </div>
      <span className="timeline-label">{label}</span>
      {selStep !== null && (
        <>
          <button
            title={`Re-edit step ${selStep} (deletes it and later steps, keeps its pose to re-record)`}
            onClick={() => reEdit(selStep)}
          >
            ✎
          </button>
          <button
            title={`Continue editing after step ${selStep} (deletes later steps)`}
            onClick={() => continueAfter(selStep)}
          >
            ⏵
          </button>
        </>
      )}
      {scrub && (
        <button onClick={() => s.enterEditMode()} title="Return to editing at the sequence end">
          Resume editing
        </button>
      )}
    </div>
  )
}
