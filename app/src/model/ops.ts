// Event-sourced history. Every authoring action is an Op that can be applied
// and reverted. The document's editable state is base snapshot + ops applied
// up to the cursor; the whole structure is JSON-serializable and persists in
// the save file, so undo/redo survives save/load (see STATE.md).

import type { PaperDoc } from './document'

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
  /**
   * The dieline at this point in history. Undefined = unchanged from the
   * document's stored dieline (only setDoc ops ever change it).
   */
  doc?: PaperDoc
}

export type Op =
  | { type: 'setAngle'; edgeId: number; prev: number; next: number }
  | {
      /** Group fold: several hinges changed as one action. */
      type: 'setAngles'
      changes: Array<{ edgeId: number; prev: number; next: number }>
    }
  | {
      /** Dieline edit (pattern editor). Full snapshots — dielines are small. */
      type: 'setDoc'
      label: string
      prev: PaperDoc
      next: PaperDoc
    }
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
    // Docs are treated as immutable snapshots; sharing the reference is fine.
    doc: s.doc,
  }
}

export function applyOp(s: EditableState, op: Op): EditableState {
  switch (op.type) {
    case 'setAngle':
      return { ...s, angles: { ...s.angles, [op.edgeId]: op.next } }
    case 'setAngles': {
      const angles = { ...s.angles }
      for (const c of op.changes) angles[c.edgeId] = c.next
      return { ...s, angles }
    }
    case 'setDoc':
      return { ...s, doc: op.next }
    case 'addStep':
      // Guard against duplicate ids: history surgery can replay an addStep
      // whose step also survives inside a truncateSteps revert.
      return {
        ...s,
        steps: [
          ...s.steps.filter((st) => st.id !== op.step.id),
          { ...op.step, angles: { ...op.step.angles } },
        ],
      }
    case 'truncateSteps':
      return { ...s, angles: { ...op.nextAngles }, steps: s.steps.slice(0, op.keepCount) }
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
    case 'setAngles': {
      const angles = { ...s.angles }
      for (const c of op.changes) angles[c.edgeId] = c.prev
      return { ...s, angles }
    }
    case 'setDoc':
      return { ...s, doc: op.prev }
    case 'addStep':
      return { ...s, steps: s.steps.filter((st) => st.id !== op.step.id) }
    case 'truncateSteps': {
      // Re-append removed steps, skipping any id that is somehow still present
      // (possible after history surgery) so step ids stay unique.
      const present = new Set(s.steps.map((st) => st.id))
      const restored = op.removed
        .filter((st) => !present.has(st.id))
        .map((st) => ({ ...st, angles: { ...st.angles } }))
      return { ...s, angles: { ...op.prevAngles }, steps: [...s.steps, ...restored] }
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
 * animation (angles, steps, dieline); non-deformer ops are organizational
 * (renames).
 */
export function isDeformerOp(op: Op): boolean {
  return op.type !== 'renameStep'
}

export function newStepId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10)
}
