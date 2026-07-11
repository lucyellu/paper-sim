import { useEffect, useRef, useState } from 'react'
import { selectedHinge, selectedHinges, useAppStore } from '../state/store'
import { Section, SidePanel } from './panels'

export function Sidebar() {
  const s = useAppStore()
  const editMode = s.playback.mode === 'edit'

  const hinge = selectedHinge(s)
  const hinges = selectedHinges(s)
  const selectedFaces = s.selection
    .map((id) => s.doc.faces.find((f) => f.id === id))
    .filter((f): f is NonNullable<typeof f> => f !== undefined)

  return (
    <SidePanel id="left" side="left" title="Paper Sim" defaultWidth={270}>
      <div className="brand">
        <span className="brand-title">Paper Sim</span>
        <span className="brand-sub">v1 — fold anything flat</span>
      </div>

      <Section id="project" title="Project">
        <label className="project-name-row">
          <span>Name</span>
          <input
            type="text"
            className="project-name"
            key={s.projectName}
            defaultValue={s.projectName}
            title="Project name — exports are named projectname_dieline_001 etc."
            onBlur={(e) => s.setProjectName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
          />
        </label>
        <p className="hint">File &amp; Export live in the top menu bar.</p>
      </Section>

      <Section id="selection" title="Selection">
        {selectedFaces.length === 0 ? (
          <p className="hint">
            Click a panel to select it (Ctrl+click adds panels). <b>Double-click</b> selects its
            whole row, <b>Shift+double-click</b> its column, <b>triple-click</b> the entire object.
            Press <b>F</b> to frame.
          </p>
        ) : selectedFaces.length === 1 ? (
          <>
            <div className="sel-name">{selectedFaces[0].name}</div>
            {hinge === null ? (
              <p className="hint">This is the root panel — it has no fold of its own.</p>
            ) : (
              <AngleControl edgeId={hinge} disabled={!editMode} />
            )}
          </>
        ) : (
          <>
            <div className="sel-name">
              {selectedFaces.length} panels: {selectedFaces.map((f) => f.name).join(', ')}
            </div>
            {hinges.length === 0 ? (
              <p className="hint">None of these panels has a fold.</p>
            ) : (
              <GroupAngleControl hinges={hinges} disabled={!editMode} />
            )}
          </>
        )}
      </Section>

      <StepsSection />
    </SidePanel>
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

/** One control folding several hinges together (e.g. a gable-top spout). */
function GroupAngleControl({ hinges, disabled }: { hinges: number[]; disabled: boolean }) {
  const s = useAppStore()
  const targets = hinges.map((h) => s.doc.targetAngles?.[h])
  const haveTargets = hinges.filter((_, i) => targets[i] !== undefined && targets[i] !== 0)
  const dragStart = useRef<Record<number, number> | null>(null)

  // Progress toward targets: mean of angle/target across hinges with targets.
  const fractions = haveTargets.map((h) => {
    const t = s.doc.targetAngles![h]
    return ((s.angles[h] ?? 0) / t) * 100
  })
  const percent =
    fractions.length > 0
      ? Math.round(fractions.reduce((a, b) => a + b, 0) / fractions.length)
      : 0

  function anglesAt(f: number): Record<number, number> {
    const out: Record<number, number> = {}
    for (const h of haveTargets) {
      const t = s.doc.targetAngles![h]
      out[h] = Math.max(-179, Math.min(179, (t * f) / 100))
    }
    return out
  }

  function commitTo(map: Record<number, number>) {
    const cur = useAppStore.getState().angles
    const changes = Object.keys(map)
      .map(Number)
      .map((h) => ({ edgeId: h, prev: cur[h] ?? 0, next: map[h] }))
      .filter((c) => c.prev !== c.next)
    if (changes.length > 0) s.dispatch({ type: 'setAngles', changes })
  }

  return (
    <div className="angle-control">
      <label>Fold together{haveTargets.length < hinges.length ? ' (creases with targets)' : ''}</label>
      {haveTargets.length === 0 ? (
        <p className="hint">
          These creases have no target angles — drag the gizmo ring instead (all selected creases
          fold with it), or set targets in the dieline editor.
        </p>
      ) : (
        <>
          <div className="btn-row">
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              disabled={disabled}
              value={Math.max(0, Math.min(100, percent))}
              onPointerDown={() => {
                const cur = useAppStore.getState().angles
                const snapshot: Record<number, number> = {}
                for (const h of haveTargets) snapshot[h] = cur[h] ?? 0
                dragStart.current = snapshot
              }}
              onChange={(e) => s.setAnglesTransient(anglesAt(Number(e.target.value)))}
              onPointerUp={() => {
                const start = dragStart.current
                dragStart.current = null
                if (!start) return
                const cur = useAppStore.getState().angles
                const changes = haveTargets
                  .map((h) => ({ edgeId: h, prev: start[h], next: cur[h] ?? 0 }))
                  .filter((c) => c.prev !== c.next)
                if (changes.length > 0) {
                  s.dispatch({ type: 'setAngles', changes }, { alreadyApplied: true })
                }
              }}
            />
            <span className="unit">{percent}%</span>
          </div>
          <div className="btn-row presets">
            <button disabled={disabled} onClick={() => commitTo(anglesAt(0))}>
              Flat
            </button>
            <button disabled={disabled} onClick={() => commitTo(anglesAt(50))}>
              Half
            </button>
            <button
              disabled={disabled}
              className="suggest-0"
              title="Fold every selected crease to its target angle"
              onClick={() => commitTo(anglesAt(100))}
            >
              To target
            </button>
          </div>
          <p className="hint">
            0–100% folds every selected crease toward its own target. The gizmo ring drives the
            group too.
          </p>
        </>
      )}
    </div>
  )
}


function StepsSection() {
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
    <Section id="steps" title={`Fold steps${n > 0 ? ` (${n})` : ''}`} className="steps">
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
    </Section>
  )
}
