import { create } from 'zustand'
import { buildCarton } from '../model/carton'
import { buildGableCarton, type GableDims } from '../model/gable'
import { buildCan, type CanDims } from '../model/can'
import { buildPanelTree, type PanelTree, type PaperDoc } from '../model/document'
import { fromFoldFile, toFoldFile } from '../model/foldfile'
import { defaultMaterial, type MaterialSettings } from '../model/material'
import { nextExportName, projectNameFromFileName } from '../model/naming'
import { templateSteps } from '../model/templates'
import { identityTransform, type Transform, type Vec3 } from '../model/transform'
import {
  applyOp,
  cloneEditable,
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
/**
 * A reference image shown behind the dieline editor for tracing an imported
 * dieline into our format. Rect is in flat/doc coords: (x, y) = top-left corner
 * (y grows up), w/h in doc units. Session-only — not saved in the .fold file.
 */
export interface Backdrop {
  image: string
  x: number
  y: number
  w: number
  h: number
  opacity: number
}
export type Template = 'tuck' | 'gable' | 'can'
/** Optional dimensions when creating a template (rectangular gable, can size). */
export type TemplateDims = GableDims | CanDims
/** Which component the pointer selects in the 3D view (Maya-style). */
export type SelectMode = 'object' | 'face' | 'edge'
/** Active manipulator (Maya Q/W/E/R): none, translate, rotate, scale. */
export type TransformTool = 'select' | 'move' | 'rotate' | 'scale'
/** Back-compat alias (old save files persisted just a rotation). */
export type ObjectRotation = Vec3

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
  /** Selected edge ids (edge select mode); the LAST one is primary. */
  selectedEdges: number[]
  /** Which component the pointer picks: whole object / face / edge. */
  selectMode: SelectMode
  /** Active transform manipulator (Q/W/E/R). */
  transformTool: TransformTool
  playback: Playback
  /** User-facing project name; drives export file names (slugified). */
  projectName: string
  theme: Theme
  viewLayout: ViewLayout
  editorMode: EditorMode
  /** Whole-object placement transform (translate + rotate + uniform scale). */
  transform: Transform
  /** Sheet look: base color / paper texture / design overlay (UV = dieline). */
  material: MaterialSettings
  /** Tracing reference behind the dieline editor (session-only). */
  backdrop: Backdrop | null

  dispatch: (op: Op, opts?: { alreadyApplied?: boolean }) => void
  setAngleTransient: (edgeId: number, deg: number) => void
  setAnglesTransient: (angles: Record<number, number>) => void
  /** Swap the doc + tree without touching history (live reshape preview). */
  setDocTransient: (doc: PaperDoc) => void
  undo: () => void
  redo: () => void
  canUndo: () => boolean
  canRedo: () => boolean
  selectFace: (id: number | null, additive?: boolean) => void
  /** Replace the selection with `ids` (last id becomes primary). */
  selectFaces: (ids: number[]) => void
  /** Select/toggle a single edge (edge mode); null clears. */
  selectEdge: (id: number | null, additive?: boolean) => void
  /** Replace the edge selection with `ids` (last id becomes primary). */
  selectEdges: (ids: number[]) => void
  setSelectMode: (mode: SelectMode) => void
  setTransformTool: (tool: TransformTool) => void
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
  setTransform: (patch: Partial<Transform>) => void
  rotateObject: (axis: keyof Vec3, deltaDeg: number) => void
  resetTransform: () => void
  setMaterial: (material: MaterialSettings) => void
  setBackdrop: (backdrop: Backdrop | null) => void
  newDocument: (template?: Template, dims?: TemplateDims) => void
  saveFile: () => void
  loadFile: (json: unknown, fileName: string) => void
}

function buildTemplate(template: Template, dims?: TemplateDims): PaperDoc {
  if (template === 'gable') return buildGableCarton(dims as GableDims | undefined)
  if (template === 'can') return buildCan(dims as CanDims | undefined)
  return buildCarton()
}

function defaultProjectName(template: Template): string {
  if (template === 'gable') return 'milk carton'
  if (template === 'can') return 'can'
  return 'box'
}

export const useAppStore = create<AppState>((set, get) => {
  const initialDoc = buildTemplate('tuck')
  const initialSteps = templateSteps('tuck', initialDoc)

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
    steps: initialSteps,
    history: {
      base: { angles: {}, steps: initialSteps.map((st) => ({ ...st, angles: { ...st.angles } })) },
      log: [],
      cursor: 0,
    },
    selection: [],
    selectedEdges: [],
    selectMode: 'face',
    transformTool: 'select',
    playback: { mode: 'edit' },
    projectName: 'box',
    theme: readPref<Theme>('paperSim.theme', 'light', ['light', 'dark']),
    viewLayout: readPref<ViewLayout>('paperSim.layout', 'single', ['single', 'quad']),
    editorMode: '3d',
    transform: identityTransform(),
    material: defaultMaterial(),
    backdrop: null,

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

    setDocTransient: (doc) => {
      const s = get()
      set({
        doc,
        tree: buildPanelTree(doc),
        selection: s.selection.filter((id) => doc.faces.some((f) => f.id === id)),
        selectedEdges: s.selectedEdges.filter((id) => doc.edges.some((e) => e.id === id)),
      })
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

    selectFaces: (ids) => {
      const s = get()
      set({ selection: ids.filter((id) => s.doc.faces.some((f) => f.id === id)) })
    },

    selectEdge: (id, additive) => {
      const s = get()
      if (id === null) {
        set({ selectedEdges: [] })
        return
      }
      if (!additive) {
        set({ selectedEdges: [id] })
        return
      }
      const without = s.selectedEdges.filter((e) => e !== id)
      set({
        selectedEdges:
          without.length === s.selectedEdges.length ? [...s.selectedEdges, id] : without,
      })
    },

    selectEdges: (ids) => {
      const s = get()
      set({ selectedEdges: ids.filter((id) => s.doc.edges.some((e) => e.id === id)) })
    },

    setSelectMode: (mode) => set({ selectMode: mode }),
    setTransformTool: (tool) => set({ transformTool: tool }),

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

    setTransform: (patch) => {
      const s = get()
      set({ transform: { ...s.transform, ...patch } })
    },

    rotateObject: (axis, deltaDeg) => {
      const s = get()
      const rotateDeg = { ...s.transform.rotateDeg }
      rotateDeg[axis] = (((rotateDeg[axis] + deltaDeg) % 360) + 360) % 360
      set({ transform: { ...s.transform, rotateDeg } })
    },

    resetTransform: () => set({ transform: identityTransform() }),

    setMaterial: (material) => set({ material }),
    setBackdrop: (backdrop) => set({ backdrop }),

    newDocument: (template = 'tuck', dims) => {
      const doc = buildTemplate(template, dims)
      // Templates ship with authored fold steps (baked into the history base,
      // not undoable): load the carton, press play, watch it fold.
      const steps = templateSteps(template, doc)
      set({
        doc,
        tree: buildPanelTree(doc),
        baseDoc: doc,
        angles: {},
        steps,
        history: {
          base: { angles: {}, steps: steps.map((st) => ({ ...st, angles: { ...st.angles } })) },
          log: [],
          cursor: 0,
        },
        selection: [],
        selectedEdges: [],
        playback: { mode: 'edit' },
        projectName: defaultProjectName(template),
        transform: identityTransform(),
        material: defaultMaterial(),
        backdrop: null,
        editorMode: '3d',
      })
    },

    saveFile: () => {
      const s = get()
      const file = toFoldFile(
        s.doc,
        s.angles,
        s.steps,
        s.history,
        s.transform,
        s.projectName,
        s.material,
      )
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
        selectedEdges: [],
        playback: { mode: 'edit' },
        projectName: loaded.projectName ?? projectNameFromFileName(fileName),
        transform: loaded.transform,
        material: loaded.material,
        backdrop: null,
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
