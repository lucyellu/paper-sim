import { useEffect, useRef, useState } from 'react'
import { faceById } from '../model/document'
import { selectedHinge, useAppStore } from '../state/store'

export function Sidebar() {
  const s = useAppStore()
  const editMode = s.playback.mode === 'edit'
  const fileInput = useRef<HTMLInputElement>(null)

  const hinge = selectedHinge(s)
  const selectedFace = s.selectedFaceId !== null ? faceById(s.doc, s.selectedFaceId) : null

  async function onLoadFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const json = JSON.parse(await file.text())
      s.loadFile(json, file.name)
    } catch (err) {
      alert(`Could not load file: ${err instanceof Error ? err.message : err}`)
    }
  }

  return (
    <div className="sidebar">
      <div className="brand">
        <span className="brand-title">Paper Sim</span>
        <span className="brand-sub">v0 — fold the carton</span>
      </div>

      <section>
        <h3>File</h3>
        <div className="btn-row">
          <button
            onClick={() => {
              if (confirm('Start a new document? Unsaved work will be lost.')) s.newDocument()
            }}
          >
            New
          </button>
          <button onClick={() => s.saveFile()}>Save</button>
          <button onClick={() => fileInput.current?.click()}>Load</button>
          <input
            ref={fileInput}
            type="file"
            accept=".fold,application/json"
            style={{ display: 'none' }}
            onChange={onLoadFile}
          />
        </div>
        <div className="file-name">{s.fileName}</div>
      </section>

      <section>
        <h3>Selection</h3>
        {selectedFace === null ? (
          <p className="hint">
            Click a panel in the 3D view or the 2D pattern. Press <b>F</b> to frame the selection
            (or reset the view when nothing is selected).
          </p>
        ) : (
          <>
            <div className="sel-name">{selectedFace.name}</div>
            {hinge === null ? (
              <p className="hint">This is the root panel — it has no fold of its own.</p>
            ) : (
              <AngleControl edgeId={hinge} disabled={!editMode} />
            )}
          </>
        )}
      </section>

      <StepsPanel />
    </div>
  )
}

function AngleControl({ edgeId, disabled }: { edgeId: number; disabled: boolean }) {
  const s = useAppStore()
  const value = s.angles[edgeId] ?? 0
  const dragStart = useRef<number | null>(null)
  const [text, setText] = useState<string | null>(null)

  useEffect(() => setText(null), [edgeId, value])

  function commit(next: number) {
    const prev = useAppStore.getState().angles[edgeId] ?? 0
    const clamped = Math.max(-179, Math.min(179, next))
    if (clamped === prev) return
    s.dispatch({ type: 'setAngle', edgeId, prev, next: clamped })
  }

  // Preset buttons, ranked by closeness to this model's authored target angle
  // (rank 0 = the suggested fold; drives the highlight strength).
  const target = s.doc.targetAngles?.[edgeId]
  const presets = [-90, 0, 90, 179]
  if (target !== undefined && !presets.includes(Math.round(target))) {
    presets.push(Math.round(target))
    presets.sort((a, b) => a - b)
  }
  const rankOf = new Map<number, number>()
  if (target !== undefined) {
    ;[...presets]
      .sort((a, b) => Math.abs(a - target) - Math.abs(b - target))
      .forEach((p, rank) => rankOf.set(p, rank))
  }

  return (
    <div className="angle-control">
      <label>Fold angle</label>
      <div className="btn-row">
        <input
          type="range"
          min={-179}
          max={179}
          step={1}
          disabled={disabled}
          value={value}
          onPointerDown={() => (dragStart.current = useAppStore.getState().angles[edgeId] ?? 0)}
          onChange={(e) => s.setAngleTransient(edgeId, Number(e.target.value))}
          onPointerUp={() => {
            const start = dragStart.current
            dragStart.current = null
            const now = useAppStore.getState().angles[edgeId] ?? 0
            if (start !== null && start !== now) {
              s.dispatch(
                { type: 'setAngle', edgeId, prev: start, next: now },
                { alreadyApplied: true },
              )
            }
          }}
        />
        <input
          type="number"
          className="angle-num"
          min={-179}
          max={179}
          disabled={disabled}
          value={text ?? Math.round(value * 10) / 10}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            if (text !== null && text !== '') commit(Number(text))
            setText(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
        />
        <span className="unit">°</span>
      </div>
      <div className="btn-row presets">
        {presets.map((deg) => {
          const rank = rankOf.get(deg)
          return (
            <button
              key={deg}
              className={rank !== undefined ? `suggest-${Math.min(rank, 3)}` : ''}
              disabled={disabled}
              title={rank === 0 ? 'Suggested — this model folds to this angle' : undefined}
              onClick={() => commit(deg)}
            >
              {deg}°
            </button>
          )
        })}
      </div>
      <p className="hint">
        Drag the orange ring in 3D — it snaps near these angles (Alt = free, Shift = 15° grid).
      </p>
    </div>
  )
}

function StepsPanel() {
  const s = useAppStore()
  const editMode = s.playback.mode === 'edit'
  const n = s.steps.length

  function reEdit(i: number) {
    const removed = n - i
    if (
      confirm(
        `Re-edit step ${i + 1}? This deletes step ${i + 1}${removed > 1 ? ` and the ${removed - 1} step(s) after it` : ''}, keeping its pose so you can adjust and re-record.`,
      )
    )
      s.editStepInPlace(i)
  }

  function continueAfter(i: number) {
    const removed = n - (i + 1)
    if (removed > 0) {
      if (!confirm(`Continue after step ${i + 1}? The ${removed} later step(s) will be deleted.`))
        return
    }
    s.editFromStep(i)
  }

  return (
    <section className="steps">
      <h3>Fold steps</h3>
      {n === 0 && (
        <p className="hint">
          Fold some panels, then press <b>Add Keyframe</b> to record a step. Steps play back in
          order and become the exported instructions.
        </p>
      )}
      <ol className="step-list">
        {s.steps.map((st, i) => (
          <li key={st.id}>
            <button
              className="step-num"
              title="Preview this step (also click its notch on the timeline)"
              onClick={() => s.setScrub(i + 1)}
            >
              {i + 1}
            </button>
            <input
              className="step-name"
              defaultValue={st.name}
              key={`${st.id}:${st.name}`}
              onBlur={(e) => s.renameStep(st.id, e.target.value.trim() || st.name)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
            />
            <button title="Re-edit this step (deletes it + later steps, keeps pose)" onClick={() => reEdit(i)}>
              ✎
            </button>
            <button title="Continue after this step (deletes later steps)" onClick={() => continueAfter(i)}>
              ⏵
            </button>
          </li>
        ))}
      </ol>
      <button className="primary" disabled={!editMode} onClick={() => s.addKeyframe()}>
        ＋ Add Keyframe
      </button>
      {n > 0 && (
        <button
          className="subtle"
          onClick={() => {
            if (confirm('Restart from flat? All steps will be deleted.')) s.editFromStep(-1)
          }}
        >
          ↺ Restart from flat
        </button>
      )}
    </section>
  )
}
