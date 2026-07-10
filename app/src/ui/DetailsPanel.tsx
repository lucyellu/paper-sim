import { isDeformerOp } from '../model/ops'
import { describeOp, primaryFaceId, selectedHinge, useAppStore } from '../state/store'

/** Right-hand panel: selection details + full action history (Maya-style). */
export function DetailsPanel() {
  const s = useAppStore()
  const canUndo = s.history.cursor > 0
  const canRedo = s.history.cursor < s.history.log.length
  const nonDeformerCount = s.history.log.filter((op) => !isDeformerOp(op)).length

  return (
    <div className="details">
      <section>
        <h3>Details</h3>
        <SelectionDetails />
      </section>

      <section className="history">
        <h3>History ({s.history.log.length})</h3>
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
      </section>
    </div>
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
