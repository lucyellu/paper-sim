import { useEffect, useRef, useState } from 'react'
import { edgesAxis, edgesVertexIds } from '../model/document'
import { moveVertices } from '../model/editing'
import type { MaterialSettings } from '../model/material'
import { isDeformerOp } from '../model/ops'
import { describeOp, primaryFaceId, selectedHinge, useAppStore } from '../state/store'
import { loadImage } from '../viewer/texture'
import { Section, SidePanel } from './panels'

/** Right-hand panel: selection details, object controls, material, history. */
export function DetailsPanel() {
  const s = useAppStore()
  const canUndo = s.history.cursor > 0
  const canRedo = s.history.cursor < s.history.log.length
  const nonDeformerCount = s.history.log.filter((op) => !isDeformerOp(op)).length

  return (
    <SidePanel id="right" side="right" title="Details" defaultWidth={290}>
      <Section id="details" title="Details">
        <SelectionDetails />
      </Section>

      {/* In edge mode the ring reshape is the relevant control — show it first. */}
      {s.selectMode === 'edge' && s.selectedEdges.length > 0 ? (
        <>
          <EdgeRingSection />
          <TransformSection />
        </>
      ) : (
        <>
          <TransformSection />
          <EdgeRingSection />
        </>
      )}
      <MaterialSection />

      <Section id="history" title={`History (${s.history.log.length})`} className="history">
        <div className="btn-row">
          <button disabled={!canUndo} onClick={() => s.undo()} title="Ctrl+Z">
            ⭯ Undo
          </button>
          <button disabled={!canRedo} onClick={() => s.redo()} title="Ctrl+Y">
            ⭮ Redo
          </button>
        </div>
        {s.history.log.length === 0 ? (
          <p className="hint">No recorded actions. Fold something!</p>
        ) : (
          <ul className="op-list">
            <li
              className={`op-row base ${s.history.cursor === 0 ? 'current' : ''}`}
              onClick={() => s.revertToCursor(0)}
              title="Revert to the base state (before all recorded actions)"
            >
              <span className="op-desc">— base state —</span>
            </li>
            {s.history.log.map((op, i) => {
              const applied = i < s.history.cursor
              const current = i === s.history.cursor - 1
              return (
                <li
                  key={i}
                  className={`op-row ${applied ? '' : 'redo-tail'} ${current ? 'current' : ''}`}
                  onClick={() => s.revertToCursor(i + 1)}
                  title={
                    applied
                      ? 'Revert to just after this action'
                      : 'Redo forward to just after this action'
                  }
                >
                  <span className={`op-badge ${isDeformerOp(op) ? 'deformer' : 'meta'}`}>
                    {isDeformerOp(op) ? 'D' : 'M'}
                  </span>
                  <span className="op-desc">{describeOp(s, op)}</span>
                  <button
                    className="op-delete"
                    title="Delete this action from history (state is recomputed without it)"
                    onClick={(e) => {
                      e.stopPropagation()
                      s.deleteOpAt(i)
                    }}
                  >
                    ✕
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        <div className="history-footer">
          <button
            className="subtle"
            disabled={nonDeformerCount === 0}
            title="Remove organizational actions (renames) from history, keep shape-changing ones"
            onClick={() => {
              if (confirm(`Delete ${nonDeformerCount} non-deformer action(s) (renames)?`))
                s.deleteNonDeformerOps()
            }}
          >
            Delete non-deformer ({nonDeformerCount})
          </button>
          <button
            className="subtle"
            disabled={s.history.log.length === 0}
            title="Bake the current state and clear all history (like Maya's Delete History)"
            onClick={() => {
              if (
                confirm(
                  `Delete all history? ${s.history.log.length} action(s) will be baked into the current state.`,
                )
              )
                s.deleteHistory()
            }}
          >
            🧹 Delete all (bake)
          </button>
        </div>
      </Section>
    </SidePanel>
  )
}

/**
 * A compact numeric input with a local text buffer so live gizmo updates show
 * through while typing is still possible (commits on Enter / blur).
 */
function NumberCell({
  value,
  step = 1,
  min,
  max,
  onCommit,
}: {
  value: number
  step?: number
  min?: number
  max?: number
  onCommit: (n: number) => void
}) {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => setText(null), [value])
  return (
    <input
      type="number"
      className="xform-num"
      step={step}
      min={min}
      max={max}
      value={text ?? value}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text !== null && text !== '' && Number.isFinite(Number(text))) onCommit(Number(text))
        setText(null)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}

function TransformSection() {
  const s = useAppStore()
  const t = s.transform
  const axes: Array<keyof typeof t.translate> = ['x', 'y', 'z']
  const identity =
    t.translate.x === 0 &&
    t.translate.y === 0 &&
    t.translate.z === 0 &&
    t.rotateDeg.x === 0 &&
    t.rotateDeg.y === 0 &&
    t.rotateDeg.z === 0 &&
    t.scale === 1

  return (
    <Section id="object" title="Object transform">
      <div className="xform-grid">
        <span className="xform-head" />
        <span className="xform-head">X</span>
        <span className="xform-head">Y</span>
        <span className="xform-head">Z</span>

        <span className="xform-label">Move</span>
        {axes.map((axis) => (
          <NumberCell
            key={`t-${axis}`}
            value={round(t.translate[axis])}
            step={0.5}
            onCommit={(n) => s.setTransform({ translate: { ...t.translate, [axis]: n } })}
          />
        ))}

        <span className="xform-label">Rotate</span>
        {axes.map((axis) => (
          <NumberCell
            key={`r-${axis}`}
            value={round(t.rotateDeg[axis])}
            step={15}
            onCommit={(n) => s.setTransform({ rotateDeg: { ...t.rotateDeg, [axis]: n } })}
          />
        ))}
      </div>

      <label className="xform-scale">
        <span>Scale</span>
        <NumberCell
          value={round(t.scale)}
          step={0.1}
          min={0.05}
          onCommit={(n) => s.setTransform({ scale: n > 0 ? n : 0.05 })}
        />
      </label>

      <div className="object-rows">
        {axes.map((axis) => (
          <div className="btn-row object-row" key={axis}>
            <span className="axis-label">{axis.toUpperCase()}</span>
            <button title={`Rotate ${axis.toUpperCase()} −90°`} onClick={() => s.rotateObject(axis, -90)}>
              −90°
            </button>
            <button title={`Rotate ${axis.toUpperCase()} +90°`} onClick={() => s.rotateObject(axis, 90)}>
              +90°
            </button>
          </div>
        ))}
      </div>

      <div className="btn-row">
        <button className="subtle" disabled={identity} onClick={() => s.resetTransform()}>
          Reset transform
        </button>
      </div>
      <p className="hint">
        Moves / rotates / scales the <b>whole object</b>. Press <b>W</b>/<b>E</b>/<b>R</b> for the
        gizmo in the 3D view (in Object or Face mode). For a single edge ring, switch to <b>Edge</b>
        mode (3) — then W drags the ring to resize the model.
      </p>
    </Section>
  )
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

/**
 * Edge-ring reshape: with edges selected in edge mode, nudge the ring along its
 * own axis to resize the model (e.g. shorten a carton). Drives the underlying
 * dieline vertices and refolds — the same thing the in-view drag does, but exact.
 */
function EdgeRingSection() {
  const s = useAppStore()
  // Reshape is a dieline edit, so it also works on a folded (scrubbed) pose —
  // only block it during active playback.
  const editMode = !(s.playback.mode === 'scrub' && s.playback.playing)
  if (s.selectMode !== 'edge' || s.selectedEdges.length === 0) return null

  function nudge(amount: number) {
    const st = useAppStore.getState()
    const ids = edgesVertexIds(st.doc, st.selectedEdges)
    const axis = edgesAxis(st.doc, st.selectedEdges)
    const res = moveVertices(st.doc, ids, { x: axis.x * amount, y: axis.y * amount })
    if ('doc' in res && res.doc !== st.doc) {
      st.dispatch({ type: 'setDoc', label: 'reshape edge ring', prev: st.doc, next: res.doc })
    }
  }

  return (
    <Section id="edgering" title="Edge ring">
      <div className="sel-name">{s.selectedEdges.length} edge(s) selected</div>
      <p className="hint">
        This resizes the <b>selected ring</b> (not the whole object). Move it along its axis to
        resize the model (outward grows, inward shrinks). With the <b>Move</b> tool (W) drag the
        orange arrow — or the ring itself — in the 3D view.
      </p>
      <div className="btn-row presets">
        <button disabled={!editMode} onClick={() => nudge(-1)} title="Move ring inward 1 unit">
          −1
        </button>
        <button disabled={!editMode} onClick={() => nudge(-0.5)}>
          −0.5
        </button>
        <button disabled={!editMode} onClick={() => nudge(0.5)}>
          +0.5
        </button>
        <button disabled={!editMode} onClick={() => nudge(1)} title="Move ring outward 1 unit">
          +1
        </button>
      </div>
      <MoveByField onApply={nudge} disabled={!editMode} />
    </Section>
  )
}

/** A "move by [amount] [Apply]" row that clears after applying. */
function MoveByField({ onApply, disabled }: { onApply: (n: number) => void; disabled: boolean }) {
  const [text, setText] = useState('')
  function apply() {
    const n = Number(text)
    if (text !== '' && Number.isFinite(n) && n !== 0) onApply(n)
    setText('')
  }
  return (
    <label className="xform-scale">
      <span>Move by</span>
      <input
        type="number"
        className="xform-num"
        step={0.25}
        disabled={disabled}
        value={text}
        placeholder="0"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') apply()
        }}
      />
      <button disabled={disabled} onClick={apply}>
        Apply
      </button>
    </label>
  )
}

/** Read an image file as a data URL, downscaled so textures stay light. */
async function fileToDataUrl(file: File, maxDim = 2048): Promise<string> {
  const raw = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(new Error('could not read file'))
    r.readAsDataURL(file)
  })
  const img = await loadImage(raw)
  if (Math.max(img.width, img.height) <= maxDim) return raw
  const scale = maxDim / Math.max(img.width, img.height)
  const c = document.createElement('canvas')
  c.width = Math.round(img.width * scale)
  c.height = Math.round(img.height * scale)
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
  return c.toDataURL('image/png')
}

function MaterialSection() {
  const s = useAppStore()
  const m = s.material
  const baseInput = useRef<HTMLInputElement>(null)
  const overlayInput = useRef<HTMLInputElement>(null)

  function update(patch: Partial<MaterialSettings>) {
    s.setMaterial({ ...m, ...patch })
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>, slot: 'base' | 'overlay') {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const url = await fileToDataUrl(file)
      if (slot === 'base') update({ baseKind: 'image', baseImage: url })
      else update({ overlayImage: url })
    } catch (err) {
      alert(`Could not load image: ${err instanceof Error ? err.message : err}`)
    }
  }

  return (
    <Section id="material" title="Material">
      <div className="btn-row mat-row">
        <span className="mat-label">Base</span>
        <select
          value={m.baseKind}
          onChange={(e) => {
            const kind = e.target.value as MaterialSettings['baseKind']
            if (kind === 'image' && !m.baseImage) baseInput.current?.click()
            else update({ baseKind: kind })
          }}
        >
          <option value="color">Plain color</option>
          <option value="kraft">Kraft paper</option>
          <option value="image">Custom texture</option>
        </select>
        <input
          type="color"
          value={m.baseColor}
          title="Base paper color"
          onChange={(e) => update({ baseColor: e.target.value })}
        />
      </div>
      {m.baseKind === 'image' && (
        <div className="btn-row">
          <button onClick={() => baseInput.current?.click()}>
            {m.baseImage ? 'Replace texture…' : 'Choose texture…'}
          </button>
          {m.baseImage && (
            <button
              title="Remove the base texture (back to plain color)"
              onClick={() => update({ baseKind: 'color', baseImage: undefined })}
            >
              ✕
            </button>
          )}
        </div>
      )}
      <div className="btn-row">
        <button
          title="An image stretched over the whole dieline — the flat pattern is the object's UV map"
          onClick={() => overlayInput.current?.click()}
        >
          {m.overlayImage ? 'Replace design…' : 'Add design overlay…'}
        </button>
        {m.overlayImage && (
          <button title="Remove the design overlay" onClick={() => update({ overlayImage: undefined })}>
            ✕
          </button>
        )}
      </div>
      <input
        ref={baseInput}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => onPick(e, 'base')}
      />
      <input
        ref={overlayInput}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => onPick(e, 'overlay')}
      />
      <p className="hint">
        The design overlay maps onto the dieline like a product mockup: what you see in the pattern
        editor is where it lands on the folded object. Saved with the project.
      </p>
    </Section>
  )
}

function SelectionDetails() {
  const s = useAppStore()
  const fid = primaryFaceId(s)
  const face = fid !== null ? s.doc.faces.find((f) => f.id === fid) : undefined
  if (fid === null || !face) {
    return <p className="hint">Nothing selected. Click a panel; press F to frame it.</p>
  }
  const node = s.tree.nodes.get(fid)
  const hinge = selectedHinge(s)
  const parent =
    node?.parentFaceId !== null && node?.parentFaceId !== undefined
      ? (s.doc.faces.find((f) => f.id === node.parentFaceId)?.name ?? null)
      : null
  const target = hinge !== null ? s.doc.targetAngles?.[hinge] : undefined
  return (
    <dl className="detail-list">
      <dt>Panel</dt>
      <dd>
        {face.name}
        {s.selection.length > 1 ? ` (+${s.selection.length - 1} more)` : ''}
      </dd>
      <dt>Role</dt>
      <dd>{parent === null ? 'root (fixed)' : `folds off "${parent}"`}</dd>
      {hinge !== null && (
        <>
          <dt>Fold angle</dt>
          <dd>{Math.round((s.angles[hinge] ?? 0) * 10) / 10}°</dd>
          {target !== undefined && (
            <>
              <dt>Target</dt>
              <dd>{target}° (suggested for this model)</dd>
            </>
          )}
        </>
      )}
    </dl>
  )
}
