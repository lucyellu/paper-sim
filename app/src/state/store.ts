import { create } from 'zustand'
import { buildCarton } from '../model/carton'
import { buildPanelTree, type PanelTree, type PaperDoc } from '../model/document'
import { fromFoldFile, toFoldFile } from '../model/foldfile'
import {
  applyOp,
  cloneEditable,
  emptyEditable,
  isDeformerOp,
  newStepId,
  replay,
  revertOp,
  type HistoryData,
  type Op,
  type Step,
} from '../model/ops'

export type Playback = { mode: 'edit' } | { mode: 'scrub'; t: number; playing: boolean }
export type Theme = 'light' | 'dark'
export type ViewLayout = 'single' | 'quad'

function readPref<T extends string>(key: string, fallback: T, valid: T[]): T {
  if (typeof window === 'undefined') return fallback
  const v = window.localStorage.getItem(key) as T | null
  return v !== null && valid.includes(v) ? v : fallback
}

export interface AppState {
  doc: PaperDoc
  tree: PanelTree
  /** Working hinge angles at the edit head, degrees. */
  angles: Record<number, number>
  steps: Step[]
  history: HistoryData
  selectedFaceId: number | null
  playback: Playback
  fileName: string
  theme: Theme
  viewLayout: ViewLayout

  dispatch: (op: Op, opts?: { alreadyApplied?: boolean }) => void
  setAngleTransient: (edgeId: number, deg: number) => void
  undo: () => void
  redo: () => void
  canUndo: () => boolean
  canRedo: () => boolean
  selectFace: (id: number | null) => void
  addKeyframe: () => void
  /** Truncate steps after `index` and continue editing from that state. -1 = flat. */
  editFromStep: (index: number) => void
  /** Re-record step `index`: delete it and later steps, keeping its pose to adjust. */
  editStepInPlace: (index: number) => void
  renameStep: (stepId: string, name: string) => void
  setScrub: (t: number) => void
  setPlaying: (playing: boolean) => void
  enterEditMode: () => void
  deleteHistory: () => void
  /** Jump the undo cursor to `cursor` (detailed undo: state after op cursor-1). */
  revertToCursor: (cursor: number) => void
  /** Remove one op from the log entirely and recompute (history surgery). */
  deleteOpAt: (index: number) => void
  /** Drop all non-deformer ops (renames etc.) from the log. */
  deleteNonDeformerOps: () => void
  setTheme: (theme: Theme) => void
  setViewLayout: (layout: ViewLayout) => void
  newDocument: () => void
  saveFile: () => void
  loadFile: (json: unknown, fileName: string) => void
}

function freshDoc(): { doc: PaperDoc; tree: PanelTree } {
  const doc = buildCarton()
  return { doc, tree: buildPanelTree(doc) }
}

export const useAppStore = create<AppState>((set, get) => {
  const initial = freshDoc()
  return {
    doc: initial.doc,
    tree: initial.tree,
    angles: {},
    steps: [],
    history: { base: emptyEditable(), log: [], cursor: 0 },
    selectedFaceId: null,
    playback: { mode: 'edit' },
    fileName: 'untitled.fold',
    theme: readPref<Theme>('paperSim.theme', 'light', ['light', 'dark']),
    viewLayout: readPref<ViewLayout>('paperSim.layout', 'single', ['single', 'quad']),

    dispatch: (op, opts) => {
      const s = get()
      const next = opts?.alreadyApplied
        ? { angles: s.angles, steps: s.steps }
        : applyOp({ angles: s.angles, steps: s.steps }, op)
      set({
        angles: next.angles,
        steps: next.steps,
        history: {
          base: s.history.base,
          log: [...s.history.log.slice(0, s.history.cursor), op],
          cursor: s.history.cursor + 1,
        },
      })
    },

    setAngleTransient: (edgeId, deg) => {
      const s = get()
      if (s.playback.mode !== 'edit') return
      set({ angles: { ...s.angles, [edgeId]: deg } })
    },

    undo: () => {
      const s = get()
      if (s.history.cursor === 0) return
      const op = s.history.log[s.history.cursor - 1]
      const next = revertOp({ angles: s.angles, steps: s.steps }, op)
      set({
        angles: next.angles,
        steps: next.steps,
        history: { ...s.history, cursor: s.history.cursor - 1 },
        playback: { mode: 'edit' },
      })
    },

    redo: () => {
      const s = get()
      if (s.history.cursor >= s.history.log.length) return
      const op = s.history.log[s.history.cursor]
      const next = applyOp({ angles: s.angles, steps: s.steps }, op)
      set({
        angles: next.angles,
        steps: next.steps,
        history: { ...s.history, cursor: s.history.cursor + 1 },
        playback: { mode: 'edit' },
      })
    },

    canUndo: () => get().history.cursor > 0,
    canRedo: () => get().history.cursor < get().history.log.length,

    selectFace: (id) => set({ selectedFaceId: id }),

    addKeyframe: () => {
      const s = get()
      if (s.playback.mode !== 'edit') return
      const step: Step = {
        id: newStepId(),
        name: `Step ${s.steps.length + 1}`,
        angles: { ...s.angles },
      }
      s.dispatch({ type: 'addStep', step })
    },

    editFromStep: (index) => {
      const s = get()
      const keepCount = index + 1
      const removed = s.steps.slice(keepCount)
      const nextAngles = index >= 0 ? { ...s.steps[index].angles } : {}
      s.dispatch({
        type: 'truncateSteps',
        keepCount,
        removed,
        prevAngles: { ...s.angles },
        nextAngles,
      })
      set({ playback: { mode: 'edit' } })
    },

    editStepInPlace: (index) => {
      const s = get()
      if (index < 0 || index >= s.steps.length) return
      s.dispatch({
        type: 'truncateSteps',
        keepCount: index,
        removed: s.steps.slice(index),
        prevAngles: { ...s.angles },
        // Keep the step's pose so the user can adjust and re-record it.
        nextAngles: { ...s.steps[index].angles },
      })
      set({ playback: { mode: 'edit' } })
    },

    renameStep: (stepId, name) => {
      const s = get()
      const step = s.steps.find((st) => st.id === stepId)
      if (!step || step.name === name) return
      s.dispatch({ type: 'renameStep', stepId, prev: step.name, next: name })
    },

    setScrub: (t) => {
      const s = get()
      const n = s.steps.length
      const clamped = Math.max(0, Math.min(n, t))
      const playing = s.playback.mode === 'scrub' ? s.playback.playing : false
      set({ playback: { mode: 'scrub', t: clamped, playing } })
    },

    setPlaying: (playing) => {
      const s = get()
      if (s.steps.length === 0) return
      let t = s.playback.mode === 'scrub' ? s.playback.t : 0
      if (playing && t >= s.steps.length) t = 0
      set({ playback: { mode: 'scrub', t, playing } })
    },

    enterEditMode: () => set({ playback: { mode: 'edit' } }),

    deleteHistory: () => {
      const s = get()
      set({
        history: {
          base: cloneEditable({ angles: s.angles, steps: s.steps }),
          log: [],
          cursor: 0,
        },
      })
    },

    revertToCursor: (cursor) => {
      const s = get()
      const clamped = Math.max(0, Math.min(s.history.log.length, cursor))
      if (clamped === s.history.cursor) return
      const history = { ...s.history, cursor: clamped }
      const state = replay(history)
      set({ angles: state.angles, steps: state.steps, history, playback: { mode: 'edit' } })
    },

    deleteOpAt: (index) => {
      const s = get()
      if (index < 0 || index >= s.history.log.length) return
      const log = s.history.log.filter((_, i) => i !== index)
      const cursor = s.history.cursor > index ? s.history.cursor - 1 : s.history.cursor
      const history = { base: s.history.base, log, cursor }
      const state = replay(history)
      set({ angles: state.angles, steps: state.steps, history, playback: { mode: 'edit' } })
    },

    deleteNonDeformerOps: () => {
      const s = get()
      let cursor = s.history.cursor
      const log: Op[] = []
      s.history.log.forEach((op, i) => {
        if (isDeformerOp(op)) log.push(op)
        else if (i < s.history.cursor) cursor--
      })
      const history = { base: s.history.base, log, cursor }
      const state = replay(history)
      set({ angles: state.angles, steps: state.steps, history, playback: { mode: 'edit' } })
    },

    setTheme: (theme) => {
      window.localStorage.setItem('paperSim.theme', theme)
      set({ theme })
    },

    setViewLayout: (layout) => {
      window.localStorage.setItem('paperSim.layout', layout)
      set({ viewLayout: layout })
    },

    newDocument: () => {
      const { doc, tree } = freshDoc()
      set({
        doc,
        tree,
        angles: {},
        steps: [],
        history: { base: emptyEditable(), log: [], cursor: 0 },
        selectedFaceId: null,
        playback: { mode: 'edit' },
        fileName: 'untitled.fold',
      })
    },

    saveFile: () => {
      const s = get()
      const file = toFoldFile(s.doc, s.angles, s.steps, s.history)
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = s.fileName
      a.click()
      URL.revokeObjectURL(url)
    },

    loadFile: (json, fileName) => {
      const loaded = fromFoldFile(json)
      set({
        doc: loaded.doc,
        tree: buildPanelTree(loaded.doc),
        angles: loaded.angles,
        steps: loaded.steps,
        history: loaded.history,
        selectedFaceId: null,
        playback: { mode: 'edit' },
        fileName,
      })
    },
  }
})

/** Angles to render right now: working angles, or step interpolation while scrubbing. */
export function getDisplayAngles(s: AppState): Record<number, number> {
  if (s.playback.mode === 'edit' || s.steps.length === 0) return s.angles
  const t = s.playback.t
  const n = s.steps.length
  const i = Math.min(Math.floor(t), n - 1)
  const from = i === 0 ? {} : s.steps[i - 1].angles
  const to = s.steps[i].angles
  const f = smoothstep(Math.max(0, Math.min(1, t - i)))
  const out: Record<number, number> = {}
  const keys = new Set([...Object.keys(from), ...Object.keys(to)])
  for (const k of keys) {
    const a = from[Number(k)] ?? 0
    const b = to[Number(k)] ?? 0
    out[Number(k)] = a + (b - a) * f
  }
  return out
}

function smoothstep(x: number): number {
  return x * x * (3 - 2 * x)
}

/** The hinge edge id controlled by the selected face (null for root/none). */
export function selectedHinge(s: AppState): number | null {
  if (s.selectedFaceId === null) return null
  return s.tree.nodes.get(s.selectedFaceId)?.hingeEdgeId ?? null
}

/** The panel a hinge folds (the child face of the tree edge). */
export function hingePanelName(s: AppState, edgeId: number): string {
  for (const node of s.tree.nodes.values()) {
    if (node.hingeEdgeId === edgeId) {
      return s.doc.faces.find((f) => f.id === node.faceId)?.name ?? `panel ${node.faceId}`
    }
  }
  return `crease ${edgeId}`
}

/** Human-readable one-liner for a history op. */
export function describeOp(s: AppState, op: Op): string {
  switch (op.type) {
    case 'setAngle':
      return `Fold "${hingePanelName(s, op.edgeId)}" ${Math.round(op.prev)}° → ${Math.round(op.next)}°`
    case 'addStep':
      return `Add keyframe "${op.step.name}"`
    case 'truncateSteps':
      return op.removed.length === 0
        ? 'Revert working pose'
        : `Delete ${op.removed.length} step(s) after step ${op.keepCount}`
    case 'renameStep':
      return `Rename step "${op.prev}" → "${op.next}"`
  }
}
