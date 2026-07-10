import { create } from 'zustand'
import { buildCarton } from '../model/carton'
import { buildGableCarton } from '../model/gable'
import { buildPanelTree, type PanelTree, type PaperDoc } from '../model/document'
import { fromFoldFile, toFoldFile } from '../model/foldfile'
import { nextExportName, projectNameFromFileName } from '../model/naming'
import {
  applyOp,
  cloneEditable,
  emptyEditable,
  isDeformerOp,
  newStepId,
  replay,
  revertOp,
  type EditableState,
  type HistoryData,
  type Op,
  type Step,
} from '../model/ops'

export type Playback = { mode: 'edit' } | { mode: 'scrub'; t: number; playing: boolean }
export type Theme = 'light' | 'dark'
export type ViewLayout = 'single' | 'quad'
export type EditorMode = '3d' | 'pattern'
export type Template = 'tuck' | 'gable'
export interface ObjectRotation {
  x: number
  y: number
  z: number
}

function readPref<T extends string>(key: string, fallback: T, valid: T[]): T {
  if (typeof window === 'undefined') return fallback
  const v = window.localStorage.getItem(key) as T | null
  return v !== null && valid.includes(v) ? v : fallback
}

export interface AppState {
  doc: PaperDoc
  tree: PanelTree
  /** The dieline as of the history base (setDoc ops replay from here). */
  baseDoc: PaperDoc
  /** Working hinge angles at the edit head, degrees. */
  angles: Record<number, number>
  steps: Step[]
  history: HistoryData
  /** Selected face ids; the LAST one is the primary selection. */
  selection: number[]
  playback: Playback
  /** User-facing project name; drives export file names (slugified). */
  projectName: string
  theme: Theme
  viewLayout: ViewLayout
  editorMode: EditorMode
  /** Whole-object orientation in the 3D view, degrees (XYZ euler). */
  objectRotation: ObjectRotation

  dispatch: (op: Op, opts?: { alreadyApplied?: boolean }) => void
  setAngleTransient: (edgeId: number, deg: number) => void
  setAnglesTransient: (angles: Record<number, number>) => void
  undo: () => void
  redo: () => void
  canUndo: () => boolean
  canRedo: () => boolean
  selectFace: (id: number | null, additive?: boolean) => void
  addKeyframe: () => void
  /** Truncate steps after `index` and continue editing from that state. -1 = flat. */
  editFromStep: (index: number) => void
  /** Re-record step `index`: delete it and later steps, keeping its pose to adjust. */
  editStepInPlace: (index: number) => void
  renameStep: (stepId: string, name: string) => void
  setProjectName: (name: string) => void
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
  setEditorMode: (mode: EditorMode) => void
  setObjectRotation: (rot: ObjectRotation) => void
  rotateObject: (axis: keyof ObjectRotation, deltaDeg: number) => void
  newDocument: (template?: Template) => void
  saveFile: () => void
  loadFile: (json: unknown, fileName: string) => void
}

function buildTemplate(template: Template): PaperDoc {
  return template === 'gable' ? buildGableCarton() : buildCarton()
}

export const useAppStore = create<AppState>((set, get) => {
  const initialDoc = buildTemplate('tuck')

  /** Editable slice of the current state (what ops act on). */
  function editable(): EditableState {
    const s = get()
    return { angles: s.angles, steps: s.steps, doc: s.doc }
  }

  /** Turn an op-result EditableState into a store update (handles doc edits). */
  function fromEditable(next: EditableState, fallbackDoc?: PaperDoc) {
    const s = get()
    const doc = next.doc ?? fallbackDoc ?? s.doc
    if (doc === s.doc) return { angles: next.angles, steps: next.steps }
    return {
      angles: next.angles,
      steps: next.steps,
      doc,
      tree: buildPanelTree(doc),
      selection: s.selection.filter((id) => doc.faces.some((f) => f.id === id)),
    }
  }

  return {
    doc: initialDoc,
    tree: buildPanelTree(initialDoc),
    baseDoc: initialDoc,
    angles: {},
    steps: [],
    history: { base: emptyEditable(), log: [], cursor: 0 },
    selection: [],
    playback: { mode: 'edit' },
    projectName: 'box',
    theme: readPref<Theme>('paperSim.theme', 'light', ['light', 'dark']),
    viewLayout: readPref<ViewLayout>('paperSim.layout', 'single', ['single', 'quad']),
    editorMode: '3d',
    objectRotation: { x: 0, y: 0, z: 0 },

    dispatch: (op, opts) => {
      const s = get()
      const next = opts?.alreadyApplied ? editable() : applyOp(editable(), op)
      set({
        ...fromEditable(next),
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

    setAnglesTransient: (angles) => {
      const s = get()
      if (s.playback.mode !== 'edit') return
      set({ angles: { ...s.angles, ...angles } })
    },

    undo: () => {
      const s = get()
      if (s.history.cursor === 0) return
      const op = s.history.log[s.history.cursor - 1]
      const next = revertOp(editable(), op)
      set({
        ...fromEditable(next),
        history: { ...s.history, cursor: s.history.cursor - 1 },
        playback: { mode: 'edit' },
      })
    },

    redo: () => {
      const s = get()
      if (s.history.cursor >= s.history.log.length) return
      const op = s.history.log[s.history.cursor]
      const next = applyOp(editable(), op)
      set({
        ...fromEditable(next),
        history: { ...s.history, cursor: s.history.cursor + 1 },
        playback: { mode: 'edit' },
      })
    },

    canUndo: () => get().history.cursor > 0,
    canRedo: () => get().history.cursor < get().history.log.length,

    selectFace: (id, additive) => {
      const s = get()
      if (id === null) {
        set({ selection: [] })
        return
      }
      if (!additive) {
        set({ selection: [id] })
        return
      }
      // Additive: toggle membership; newly added becomes primary (last).
      const without = s.selection.filter((f) => f !== id)
      set({ selection: without.length === s.selection.length ? [...s.selection, id] : without })
    },

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

    setProjectName: (name) => {
      const trimmed = name.trim()
      if (trimmed) set({ projectName: trimmed })
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
        baseDoc: s.doc,
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
      set({ ...fromEditable(state, s.baseDoc), history, playback: { mode: 'edit' } })
    },

    deleteOpAt: (index) => {
      const s = get()
      if (index < 0 || index >= s.history.log.length) return
      const log = s.history.log.filter((_, i) => i !== index)
      const cursor = s.history.cursor > index ? s.history.cursor - 1 : s.history.cursor
      const history = { base: s.history.base, log, cursor }
      const state = replay(history)
      set({ ...fromEditable(state, s.baseDoc), history, playback: { mode: 'edit' } })
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
      set({ ...fromEditable(state, s.baseDoc), history, playback: { mode: 'edit' } })
    },

    setTheme: (theme) => {
      window.localStorage.setItem('paperSim.theme', theme)
      set({ theme })
    },

    setViewLayout: (layout) => {
      window.localStorage.setItem('paperSim.layout', layout)
      set({ viewLayout: layout })
    },

    setEditorMode: (mode) => set({ editorMode: mode }),

    setObjectRotation: (rot) => set({ objectRotation: rot }),

    rotateObject: (axis, deltaDeg) => {
      const s = get()
      const next = { ...s.objectRotation }
      next[axis] = ((next[axis] + deltaDeg) % 360 + 360) % 360
      set({ objectRotation: next })
    },

    newDocument: (template = 'tuck') => {
      const doc = buildTemplate(template)
      set({
        doc,
        tree: buildPanelTree(doc),
        baseDoc: doc,
        angles: {},
        steps: [],
        history: { base: emptyEditable(), log: [], cursor: 0 },
        selection: [],
        playback: { mode: 'edit' },
        projectName: template === 'gable' ? 'milk carton' : 'box',
        objectRotation: { x: 0, y: 0, z: 0 },
        editorMode: '3d',
      })
    },

    saveFile: () => {
      const s = get()
      const file = toFoldFile(s.doc, s.angles, s.steps, s.history, s.objectRotation, s.projectName)
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = nextExportName(s.projectName, '', 'fold')
      a.click()
      URL.revokeObjectURL(url)
    },

    loadFile: (json, fileName) => {
      const loaded = fromFoldFile(json)
      set({
        doc: loaded.doc,
        tree: buildPanelTree(loaded.doc),
        baseDoc: loaded.baseDoc,
        angles: loaded.angles,
        steps: loaded.steps,
        history: loaded.history,
        selection: [],
        playback: { mode: 'edit' },
        projectName: loaded.projectName ?? projectNameFromFileName(fileName),
        objectRotation: loaded.objectRotation,
        editorMode: '3d',
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

/** Primary selected face (the last one selected), or null. */
export function primaryFaceId(s: AppState): number | null {
  return s.selection.length > 0 ? s.selection[s.selection.length - 1] : null
}

/** The hinge edge id controlled by the primary selection (null for root/none). */
export function selectedHinge(s: AppState): number | null {
  const fid = primaryFaceId(s)
  if (fid === null) return null
  return s.tree.nodes.get(fid)?.hingeEdgeId ?? null
}

/** All hinge edge ids across the selection, primary last, deduplicated. */
export function selectedHinges(s: AppState): number[] {
  const out: number[] = []
  for (const fid of s.selection) {
    const h = s.tree.nodes.get(fid)?.hingeEdgeId
    if (h !== null && h !== undefined && !out.includes(h)) out.push(h)
  }
  return out
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
    case 'setAngles':
      return `Fold ${op.changes.length} creases together`
    case 'setDoc':
      return `Dieline: ${op.label}`
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
