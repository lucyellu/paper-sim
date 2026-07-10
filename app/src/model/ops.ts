// Event-sourced history. Every authoring action is an Op that can be applied
// and reverted. The document's editable state is base snapshot + ops applied
// up to the cursor; the whole structure is JSON-serializable and persists in
// the save file, so undo/redo survives save/load (see STATE.md).

export interface Step {
  id: string
  name: string
  /** Full snapshot of hinge angles (degrees) at the end of this step. */
  angles: Record<number, number>
}

/** The slice of state that ops act on. */
export interface EditableState {
  /** Working angles at the edit head, degrees, keyed by hinge edge id. */
  angles: Record<number, number>
  steps: Step[]
}

export type Op =
  | { type: 'setAngle'; edgeId: number; prev: number; next: number }
  | { type: 'addStep'; step: Step }
  | {
      type: 'truncateSteps'
      keepCount: number
      removed: Step[]
      prevAngles: Record<number, number>
      nextAngles: Record<number, number>
    }
  | { type: 'renameStep'; stepId: string; prev: string; next: string }

export interface HistoryData {
  base: EditableState
  log: Op[]
  /** Number of ops currently applied (undo moves it back, redo forward). */
  cursor: number
}

export function cloneEditable(s: EditableState): EditableState {
  return {
    angles: { ...s.angles },
    steps: s.steps.map((st) => ({ ...st, angles: { ...st.angles } })),
  }
}

export function applyOp(s: EditableState, op: Op): EditableState {
  switch (op.type) {
    case 'setAngle':
      return { ...s, angles: { ...s.angles, [op.edgeId]: op.next } }
    case 'addStep':
      return { ...s, steps: [...s.steps, { ...op.step, angles: { ...op.step.angles } }] }
    case 'truncateSteps':
      return { angles: { ...op.nextAngles }, steps: s.steps.slice(0, op.keepCount) }
    case 'renameStep':
      return {
        ...s,
        steps: s.steps.map((st) => (st.id === op.stepId ? { ...st, name: op.next } : st)),
      }
  }
}

export function revertOp(s: EditableState, op: Op): EditableState {
  switch (op.type) {
    case 'setAngle':
      return { ...s, angles: { ...s.angles, [op.edgeId]: op.prev } }
    case 'addStep':
      return { ...s, steps: s.steps.slice(0, -1) }
    case 'truncateSteps':
      return {
        angles: { ...op.prevAngles },
        steps: [...s.steps, ...op.removed.map((st) => ({ ...st, angles: { ...st.angles } }))],
      }
    case 'renameStep':
      return {
        ...s,
        steps: s.steps.map((st) => (st.id === op.stepId ? { ...st, name: op.prev } : st)),
      }
  }
}

/** Rebuild editable state by replaying ops up to the cursor. */
export function replay(h: HistoryData): EditableState {
  let s = cloneEditable(h.base)
  for (let i = 0; i < h.cursor; i++) s = applyOp(s, h.log[i])
  return s
}

export function emptyEditable(): EditableState {
  return { angles: {}, steps: [] }
}

/**
 * Maya distinction, adapted: "deformer" ops change the folded shape or the
 * animation (angles, steps); non-deformer ops are organizational (renames).
 */
export function isDeformerOp(op: Op): boolean {
  return op.type !== 'renameStep'
}

export function newStepId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10)
}
