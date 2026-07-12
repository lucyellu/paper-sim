// Flat mode: work on the flat sheet before it folds. Three tools:
//
//  • Artwork (default) — move / rotate / scale the printed DESIGN so it lines
//    up with the dieline. This is the common, intuitive task: drag the image
//    in the scene with a gizmo (or type values). Changes the print and the 3D
//    preview together (it edits the material's overlay transform).
//  • Geometry — reshape the dieline ITSELF to trace the artwork, like drawing
//    a 3D object over a reference. Pick panels, then drag / gizmo to move,
//    rotate and scale their vertices. Affects the object in every mode.
//  • UVs (advanced) — shift individual panel UV islands over the artwork.
//    Print exports warp the artwork back per face so the printout still equals
//    the 3D preview.
//
// Every finished gesture lands in history as one undoable op.

import { useEffect, useRef, useState } from 'react'
import { faceCentroid, sheetBounds, vertexById, type PaperDoc, type Vec2 } from '../model/document'
import { transformVertices } from '../model/editing'
import { identityOverlayTransform, type OverlayTransform } from '../model/material'
import { analyzeDielineImage } from '../model/dielineImage'
import {
  applyFaceUV,
  faceUVCentroid,
  identityFaceUV,
  type FaceUV,
  type UVEdits,
} from '../model/uv'
import { primaryFaceId, useAppStore } from '../state/store'
import { buildSheetCanvas, materialNeedsTexture } from '../viewer/texture'
import { NumField } from './NumField'

interface ViewBox {
  x: number
  y: number
  w: number
  h: number
}

type FlatTool = 'artwork' | 'geometry' | 'uv'
type GizmoKind = 'move' | 'moveU' | 'moveV' | 'rotate' | 'scale'

interface Gesture {
  kind: GizmoKind
  startDoc: Vec2
  /** Full UV map before the gesture (commit prev + drift-free recompute). */
  prevUV: UVEdits
  /** Dieline before the gesture (geometry tool). */
  prevDoc: PaperDoc
  /** Vertices the gesture moves (geometry tool). */
  vertexIds: number[]
  selection: number[]
  pivotUV: { u: number; v: number }
  pivotDoc: Vec2
  startAngle: number
  startDist: number
  moved: boolean
}

/** Dragging the whole artwork image (Artwork tool). */
interface ArtGesture {
  kind: GizmoKind
  startDoc: Vec2
  prevOverlay: OverlayTransform | undefined
  start: OverlayTransform
  center: Vec2
  startAngle: number
  startDist: number
  moved: boolean
}

export function UVEditor() {
  const s = useAppStore()
  const doc = s.doc
  const svgRef = useRef<SVGSVGElement>(null)
  const [view, setView] = useState<ViewBox>(() => fitView())
  const [artUrl, setArtUrl] = useState<string | null>(null)
  const [pan, setPan] = useState<{ px: number; py: number; view: ViewBox } | null>(null)
  const [gesture, setGesture] = useState<Gesture | null>(null)
  const [artGesture, setArtGesture] = useState<ArtGesture | null>(null)
  const [tool, setTool] = useState<FlatTool>('artwork')
  const fieldPrev = useRef<UVEdits | null>(null)
  const geoMode = tool === 'geometry'

  const { min, max } = sheetBounds(doc)
  const sw = Math.max(max.x - min.x, 0.001)
  const sh = Math.max(max.y - min.y, 0.001)

  function fitView(): ViewBox {
    const { min, max } = sheetBounds(useAppStore.getState().doc)
    const pad = Math.max(max.x - min.x, max.y - min.y) * 0.1 + 1
    return {
      x: min.x - pad,
      y: -(max.y + pad),
      w: max.x - min.x + 2 * pad,
      h: max.y - min.y + 2 * pad,
    }
  }

  // The baked sheet texture (base + overlay) backs the UV / Geometry tools so
  // each panel shows exactly what it samples. The Artwork tool renders a LIVE
  // overlay instead (so dragging never rebuilds the 2048px canvas), so skip it.
  useEffect(() => {
    if (tool === 'artwork') return
    if (!materialNeedsTexture(s.material)) {
      setArtUrl(null)
      return
    }
    let stale = false
    void buildSheetCanvas(doc, s.material).then((canvas) => {
      if (!stale) setArtUrl(canvas.toDataURL('image/png'))
    })
    return () => {
      stale = true
    }
  }, [doc, s.material, tool])

  function editFor(id: number): FaceUV {
    return s.uvEdits[id] ?? identityFaceUV()
  }

  /** Client px -> doc coords (svg is y-flipped: svgY = -docY). */
  function toDoc(e: { clientX: number; clientY: number }): Vec2 {
    const svg = svgRef.current!
    const rect = svg.getBoundingClientRect()
    const scale = Math.min(rect.width / view.w, rect.height / view.h)
    const ox = (rect.width - view.w * scale) / 2
    const oy = (rect.height - view.h * scale) / 2
    const sx = view.x + (e.clientX - rect.left - ox) / scale
    const sy = view.y + (e.clientY - rect.top - oy) / scale
    return { x: sx, y: -sy }
  }

  function uvToDoc(u: number, v: number): Vec2 {
    return { x: min.x + u * sw, y: min.y + v * sh }
  }

  /** A vertex's edited UV position mapped back to doc coords (for drawing). */
  function uvVertexDocPos(faceId: number, vid: number): Vec2 {
    const p = vertexById(doc, vid).pos
    const t = s.uvEdits[faceId]
    if (!t) return p
    const face = doc.faces.find((f) => f.id === faceId)!
    const c = faceUVCentroid(doc, face)
    const [u, v] = applyFaceUV(t, c, (p.x - min.x) / sw, (p.y - min.y) / sh)
    return uvToDoc(u, v)
  }

  // ---- artwork placement (Artwork tool) --------------------------------------

  const overlay = s.material.overlayTransform ?? identityOverlayTransform()
  /** The overlay image rect + center in doc space, from an overlay transform. */
  function artRect(ov: OverlayTransform) {
    const w = sw * ov.scaleX
    const h = sh * ov.scaleY
    const x = min.x + ov.offsetX * sw // left edge (doc x)
    const topY = max.y - ov.offsetY * sh // top edge (doc y; offsetY runs down)
    return { x, topY, w, h, center: { x: x + w / 2, y: topY - h / 2 } }
  }

  /** Pivot for group ops: mean of the selected islands' UV centers. */
  function selectionPivot(sel: number[]): { u: number; v: number } {
    let pu = 0
    let pv = 0
    let n = 0
    for (const id of sel) {
      const face = doc.faces.find((f) => f.id === id)
      if (!face) continue
      const c = faceUVCentroid(doc, face)
      const t = editFor(id)
      pu += c.u + t.du
      pv += c.v + t.dv
      n++
    }
    return n > 0 ? { u: pu / n, v: pv / n } : { u: 0.5, v: 0.5 }
  }

  /** Geometry-mode pivot: mean of the selected panels' dieline centroids. */
  function geoPivotDoc(sel: number[]): Vec2 {
    let x = 0
    let y = 0
    let n = 0
    for (const id of sel) {
      const face = doc.faces.find((f) => f.id === id)
      if (!face) continue
      const c = faceCentroid(doc, face)
      x += c.x
      y += c.y
      n++
    }
    return n > 0 ? { x: x / n, y: y / n } : { x: 0, y: 0 }
  }

  function selectedVertexIds(sel: number[]): number[] {
    const set = new Set<number>()
    for (const id of sel) {
      const face = doc.faces.find((f) => f.id === id)
      if (face) for (const vid of face.vertexIds) set.add(vid)
    }
    return [...set]
  }

  // ---- group transforms (always computed from the gesture-start snapshot,
  // so drags never accumulate drift) ------------------------------------------

  /** Selected islands moved/rotated/scaled as ONE piece about `pivot`. */
  function groupUVFrom(
    start: UVEdits,
    sel: number[],
    pivot: { u: number; v: number },
    du: number,
    dv: number,
    rotDeg: number,
    scale: number,
  ): UVEdits {
    const rad = (rotDeg * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const next: UVEdits = { ...start }
    for (const id of sel) {
      const face = doc.faces.find((f) => f.id === id)
      if (!face) continue
      const c = faceUVCentroid(doc, face)
      const t = start[id] ?? identityFaceUV()
      const rx = c.u + t.du - pivot.u
      const ry = c.v + t.dv - pivot.v
      next[id] = {
        du: scale * (cos * rx + sin * ry) + pivot.u - c.u + du,
        dv: scale * (-sin * rx + cos * ry) + pivot.v - c.v + dv,
        rotationDeg: t.rotationDeg + rotDeg,
        scaleU: t.scaleU * scale,
        scaleV: t.scaleV * scale,
      }
    }
    return next
  }

  /** Geometry tool: the same group transform applied to dieline vertices. */
  function groupGeoFrom(
    startDoc: PaperDoc,
    ids: number[],
    pivot: Vec2,
    dx: number,
    dy: number,
    rotDeg: number,
    scale: number,
  ): PaperDoc | null {
    const rad = (rotDeg * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const res = transformVertices(startDoc, ids, (p) => {
      const rx = p.x - pivot.x
      const ry = p.y - pivot.y
      return {
        x: pivot.x + scale * (cos * rx + sin * ry) + dx,
        y: pivot.y + scale * (-sin * rx + cos * ry) + dy,
      }
    })
    return 'error' in res ? null : res.doc
  }

  // ---- commits ---------------------------------------------------------------

  const gestureLabel: Record<GizmoKind, string> = {
    move: 'move islands',
    moveU: 'move islands',
    moveV: 'move islands',
    rotate: 'rotate islands',
    scale: 'scale islands',
  }
  const artLabel: Record<GizmoKind, string> = {
    move: 'move design',
    moveU: 'move design',
    moveV: 'move design',
    rotate: 'rotate design',
    scale: 'scale design',
  }

  function commitGesture(g: Gesture) {
    if (!g.moved) return
    if (geoMode) {
      const cur = useAppStore.getState().doc
      if (cur !== g.prevDoc) {
        s.dispatch(
          { type: 'setDoc', label: `reshape ${gestureLabel[g.kind].split(' ')[0]}`, prev: g.prevDoc, next: cur },
          { alreadyApplied: true },
        )
      }
    } else {
      s.commitUVEdits(g.prevUV, gestureLabel[g.kind])
    }
  }

  /** Apply an immediate (non-drag) UV change and record one history op. */
  function applyAndCommit(next: UVEdits, label: string, coalesce = false) {
    const prev = useAppStore.getState().uvEdits
    s.setUVEdits(next)
    useAppStore.getState().commitUVEdits(prev, label, coalesce)
  }

  // ---- editing actions (UV tool) ---------------------------------------------

  /**
   * Numeric field edit (transient — the op commits on blur/Enter via
   * NumField's onDone). One panel selected = set the value directly. Several
   * = treat the selection as ONE piece: apply the delta / factor relative to
   * the primary panel, about the selection center.
   */
  function setSelectedField(key: keyof FaceUV, value: number) {
    const sel = s.selection
    if (sel.length === 0) return
    if (sel.length === 1) {
      const id = sel[0]
      s.setUVEdits({ ...s.uvEdits, [id]: { ...editFor(id), [key]: value } })
      return
    }
    const cur = editFor(sel[sel.length - 1])[key]
    const pivot = selectionPivot(sel)
    if (key === 'du' || key === 'dv') {
      const d = value - cur
      s.setUVEdits(groupUVFrom(s.uvEdits, sel, pivot, key === 'du' ? d : 0, key === 'dv' ? d : 0, 0, 1))
    } else if (key === 'rotationDeg') {
      s.setUVEdits(groupUVFrom(s.uvEdits, sel, pivot, 0, 0, value - cur, 1))
    } else {
      if (Math.abs(cur) < 1e-6) return
      const f = value / cur
      const next: UVEdits = { ...s.uvEdits }
      for (const id of sel) {
        const face = doc.faces.find((fc) => fc.id === id)
        if (!face) continue
        const c = faceUVCentroid(doc, face)
        const t = editFor(id)
        next[id] = {
          ...t,
          scaleU: key === 'scaleU' ? t.scaleU * f : t.scaleU,
          scaleV: key === 'scaleV' ? t.scaleV * f : t.scaleV,
          du: key === 'scaleU' ? f * (c.u + t.du - pivot.u) + pivot.u - c.u : t.du,
          dv: key === 'scaleV' ? f * (c.v + t.dv - pivot.v) + pivot.v - c.v : t.dv,
        }
      }
      s.setUVEdits(next)
    }
  }

  function rotateSelected(deltaDeg: number) {
    const sel = s.selection
    if (!sel.length) return
    applyAndCommit(
      groupUVFrom(s.uvEdits, sel, selectionPivot(sel), 0, 0, deltaDeg, 1),
      `rotate islands ${deltaDeg > 0 ? '+' : ''}${deltaDeg}°`,
    )
  }

  function scaleSelectedBy(factor: number) {
    const sel = s.selection
    if (!sel.length) return
    applyAndCommit(
      groupUVFrom(s.uvEdits, sel, selectionPivot(sel), 0, 0, 0, factor),
      'scale islands',
      true,
    )
  }

  function nudgeSelected(du: number, dv: number) {
    const sel = useAppStore.getState().selection
    if (!sel.length) return
    applyAndCommit(
      groupUVFrom(useAppStore.getState().uvEdits, sel, { u: 0, v: 0 }, du, dv, 0, 1),
      'nudge islands',
      true,
    )
  }

  function resetSelected() {
    const next = { ...s.uvEdits }
    for (const id of s.selection) delete next[id]
    applyAndCommit(next, 'reset islands')
  }

  function resetAll() {
    applyAndCommit({}, 'reset all islands')
  }

  function nudgeArtwork(dx: number, dy: number) {
    const prev = useAppStore.getState().material.overlayTransform
    const ov = prev ?? identityOverlayTransform()
    s.setMaterial({ ...s.material, overlayTransform: { ...ov, offsetX: ov.offsetX + dx, offsetY: ov.offsetY + dy } })
    useAppStore.getState().commitOverlay(prev, 'nudge design', true)
  }

  // Arrow keys nudge (artwork or islands); Escape clears the selection.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      if (e.key === 'Escape') {
        useAppStore.getState().selectFace(null)
        return
      }
      const step = e.shiftKey ? 0.02 : 0.005
      const moves: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, step],
        ArrowDown: [0, -step],
      }
      const m = moves[e.key]
      if (!m) return
      if (tool === 'artwork') {
        if (!useAppStore.getState().material.overlayImage) return
        e.preventDefault()
        // Screen-up should move the image up: offsetY runs downward, so invert.
        nudgeArtwork(m[0], -m[1])
      } else if (tool === 'uv' && useAppStore.getState().selection.length > 0) {
        e.preventDefault()
        nudgeSelected(m[0], m[1])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, doc])

  // ---- pointer handling ------------------------------------------------------

  function beginGesture(kind: GizmoKind, e: React.PointerEvent, sel: number[]) {
    const pivotUV = selectionPivot(sel)
    const pivotDoc = geoMode ? geoPivotDoc(sel) : uvToDoc(pivotUV.u, pivotUV.v)
    const start = toDoc(e)
    ;(e.target as Element).setPointerCapture(e.pointerId)
    setGesture({
      kind,
      startDoc: start,
      prevUV: useAppStore.getState().uvEdits,
      prevDoc: useAppStore.getState().doc,
      vertexIds: selectedVertexIds(sel),
      selection: sel,
      pivotUV,
      pivotDoc,
      startAngle: Math.atan2(start.y - pivotDoc.y, start.x - pivotDoc.x),
      startDist: Math.max(1e-6, Math.hypot(start.x - pivotDoc.x, start.y - pivotDoc.y)),
      moved: false,
    })
  }

  function beginArtGesture(kind: GizmoKind, e: React.PointerEvent) {
    const ov = useAppStore.getState().material.overlayTransform ?? identityOverlayTransform()
    const center = artRect(ov).center
    const start = toDoc(e)
    ;(e.target as Element).setPointerCapture(e.pointerId)
    setArtGesture({
      kind,
      startDoc: start,
      prevOverlay: useAppStore.getState().material.overlayTransform,
      start: ov,
      center,
      startAngle: Math.atan2(start.y - center.y, start.x - center.x),
      startDist: Math.max(1e-6, Math.hypot(start.x - center.x, start.y - center.y)),
      moved: false,
    })
  }

  function onIslandPointerDown(faceId: number, e: React.PointerEvent) {
    if (e.button !== 0 || tool === 'artwork') return
    e.stopPropagation()
    const additive = e.ctrlKey || e.metaKey
    const wasSelected = s.selection.includes(faceId)
    if (!wasSelected) {
      s.selectFace(faceId, additive)
    } else if (additive) {
      s.selectFace(faceId, true)
      return
    }
    beginGesture('move', e, useAppStore.getState().selection)
  }

  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (e.button === 1 || e.button === 2) {
      setPan({ px: e.clientX, py: e.clientY, view })
      ;(e.target as Element).setPointerCapture(e.pointerId)
      return
    }
    if (e.button !== 0) return
    // Artwork tool: dragging empty canvas moves the whole design.
    if (tool === 'artwork') {
      if (s.material.overlayImage) beginArtGesture('move', e)
      return
    }
    if (!e.ctrlKey && !e.metaKey) s.selectFace(null)
  }

  function updateArtGesture(g: ArtGesture, e: React.PointerEvent) {
    const cur = toDoc(e)
    const dx = cur.x - g.startDoc.x
    const dy = cur.y - g.startDoc.y
    const next: OverlayTransform = { ...g.start }
    if (g.kind === 'move' || g.kind === 'moveU' || g.kind === 'moveV') {
      if (g.kind !== 'moveV') next.offsetX = g.start.offsetX + dx / sw
      if (g.kind !== 'moveU') next.offsetY = g.start.offsetY - dy / sh
    } else if (g.kind === 'rotate') {
      const a = Math.atan2(cur.y - g.center.y, cur.x - g.center.x)
      let rot = ((g.startAngle - a) * 180) / Math.PI
      if (e.shiftKey) rot = Math.round(rot / 15) * 15
      next.rotationDeg = g.start.rotationDeg + rot
    } else {
      const d = Math.max(1e-6, Math.hypot(cur.x - g.center.x, cur.y - g.center.y))
      let f = Math.max(0.05, d / g.startDist)
      if (e.shiftKey) f = Math.max(0.05, Math.round(f * 10) / 10)
      const cxFrac = g.start.offsetX + g.start.scaleX / 2
      const cyFrac = g.start.offsetY + g.start.scaleY / 2
      next.scaleX = g.start.scaleX * f
      next.scaleY = g.start.scaleY * f
      next.offsetX = cxFrac - next.scaleX / 2
      next.offsetY = cyFrac - next.scaleY / 2
    }
    s.setMaterial({ ...s.material, overlayTransform: next })
    if (!g.moved && (Math.abs(dx) > 1e-4 || Math.abs(dy) > 1e-4)) setArtGesture({ ...g, moved: true })
  }

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (pan) {
      const svg = svgRef.current!
      const rect = svg.getBoundingClientRect()
      const scale = Math.min(rect.width / pan.view.w, rect.height / pan.view.h)
      setView({
        ...pan.view,
        x: pan.view.x - (e.clientX - pan.px) / scale,
        y: pan.view.y - (e.clientY - pan.py) / scale,
      })
      return
    }
    if (artGesture) {
      updateArtGesture(artGesture, e)
      return
    }
    if (!gesture) return
    const cur = toDoc(e)
    const dx = cur.x - gesture.startDoc.x
    const dy = cur.y - gesture.startDoc.y

    let du = 0
    let dv = 0
    let gx = 0
    let gy = 0
    let rot = 0
    let scale = 1
    if (gesture.kind === 'move' || gesture.kind === 'moveU' || gesture.kind === 'moveV') {
      if (gesture.kind !== 'moveV') {
        du = dx / sw
        gx = dx
      }
      if (gesture.kind !== 'moveU') {
        dv = dy / sh
        gy = dy
      }
    } else if (gesture.kind === 'rotate') {
      const a = Math.atan2(cur.y - gesture.pivotDoc.y, cur.x - gesture.pivotDoc.x)
      rot = ((gesture.startAngle - a) * 180) / Math.PI
      if (e.shiftKey) rot = Math.round(rot / 15) * 15
    } else {
      const d = Math.max(1e-6, Math.hypot(cur.x - gesture.pivotDoc.x, cur.y - gesture.pivotDoc.y))
      scale = Math.max(0.05, d / gesture.startDist)
      if (e.shiftKey) scale = Math.max(0.05, Math.round(scale * 10) / 10)
    }

    if (geoMode) {
      const next = groupGeoFrom(gesture.prevDoc, gesture.vertexIds, gesture.pivotDoc, gx, gy, rot, scale)
      if (next) s.setDocTransient(next)
    } else {
      s.setUVEdits(groupUVFrom(gesture.prevUV, gesture.selection, gesture.pivotUV, du, dv, rot, scale))
    }
    if (!gesture.moved && (Math.abs(dx) > 1e-4 || Math.abs(dy) > 1e-4)) {
      setGesture({ ...gesture, moved: true })
    }
  }

  function onPointerUp() {
    setPan(null)
    if (artGesture) {
      if (artGesture.moved) s.commitOverlay(artGesture.prevOverlay, artLabel[artGesture.kind])
      setArtGesture(null)
    }
    if (gesture) {
      commitGesture(gesture)
      setGesture(null)
    }
  }

  function onWheel(e: React.WheelEvent<SVGSVGElement>) {
    const p = toDoc(e)
    const factor = Math.pow(1.0015, e.deltaY)
    const w = Math.max(2, Math.min(400, view.w * factor))
    const scale = w / view.w
    if (scale === 1) return
    const sx = p.x
    const sy = -p.y
    setView({
      x: sx - (sx - view.x) * scale,
      y: sy - (sy - view.y) * scale,
      w,
      h: view.h * scale,
    })
  }

  // ---- rendering -------------------------------------------------------------

  const dark = s.theme === 'dark'
  const colors = {
    dieline: dark ? '#8a7f66' : '#a89173',
    island: dark ? '#7fb4e6' : '#3f77b8',
    islandSelected: '#ff9f1c',
    geo: '#2fa46a',
    art: '#c77dff',
  }

  const vbAttr = `${view.x} ${view.y} ${view.w} ${view.h}`
  const strokeW = view.w / 420
  const primary = primaryFaceId(s)
  const primaryFace = primary !== null ? doc.faces.find((f) => f.id === primary) : undefined
  const primaryEdit = primary !== null ? editFor(primary) : null
  const hasSel = s.selection.length > 0
  const accent = geoMode ? colors.geo : colors.islandSelected
  const hasOverlay = !!s.material.overlayImage
  const rect = artRect(overlay)

  const field = (label: string, key: keyof FaceUV, step: number, minVal?: number) => (
    <NumField
      label={label}
      step={step}
      min={minVal}
      value={primaryEdit ? primaryEdit[key] : key === 'scaleU' || key === 'scaleV' ? 1 : 0}
      disabled={!hasSel}
      onFocus={() => (fieldPrev.current = useAppStore.getState().uvEdits)}
      onChange={(v) => setSelectedField(key, v)}
      onDone={() => {
        if (fieldPrev.current) {
          useAppStore.getState().commitUVEdits(fieldPrev.current, `set ${label}`)
          fieldPrev.current = null
        }
      }}
    />
  )

  /** A 2D transform gizmo at `pivot` (doc coords), like fold mode's W/E/R. */
  function Gizmo({
    pivot,
    color,
    onGrab,
  }: {
    pivot: Vec2
    color: string
    onGrab: (kind: GizmoKind) => (e: React.PointerEvent) => void
  }) {
    const cx = pivot.x
    const cy = -pivot.y
    const r = view.w * 0.05
    const head = r * 0.14
    const sq = r * 0.16
    const scx = cx + r * 0.9
    const scy = cy - r * 0.9
    return (
      <g className="uv-gizmo">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={strokeW * 1.4} opacity={0.9} pointerEvents="none" />
        <circle
          data-uvgizmo="rotate"
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="transparent"
          strokeWidth={strokeW * 9}
          style={{ cursor: 'grab' }}
          onPointerDown={onGrab('rotate')}
        />
        <line x1={cx + sq} y1={cy} x2={cx + r * 0.72} y2={cy} stroke="#d94848" strokeWidth={strokeW * 2} pointerEvents="none" />
        <polygon
          points={`${cx + r * 0.72},${cy - head / 2} ${cx + r * 0.72},${cy + head / 2} ${cx + r * 0.72 + head},${cy}`}
          fill="#d94848"
          pointerEvents="none"
        />
        <line
          data-uvgizmo="u"
          x1={cx + sq}
          y1={cy}
          x2={cx + r * 0.82}
          y2={cy}
          stroke="transparent"
          strokeWidth={strokeW * 10}
          style={{ cursor: 'ew-resize' }}
          onPointerDown={onGrab('moveU')}
        />
        <line x1={cx} y1={cy - sq} x2={cx} y2={cy - r * 0.72} stroke="#3f9d4f" strokeWidth={strokeW * 2} pointerEvents="none" />
        <polygon
          points={`${cx - head / 2},${cy - r * 0.72} ${cx + head / 2},${cy - r * 0.72} ${cx},${cy - r * 0.72 - head}`}
          fill="#3f9d4f"
          pointerEvents="none"
        />
        <line
          data-uvgizmo="v"
          x1={cx}
          y1={cy - sq}
          x2={cx}
          y2={cy - r * 0.82}
          stroke="transparent"
          strokeWidth={strokeW * 10}
          style={{ cursor: 'ns-resize' }}
          onPointerDown={onGrab('moveV')}
        />
        <rect
          data-uvgizmo="move"
          x={cx - sq}
          y={cy - sq}
          width={sq * 2}
          height={sq * 2}
          fill={color}
          opacity={0.85}
          style={{ cursor: 'move' }}
          onPointerDown={onGrab('move')}
        />
        <rect
          data-uvgizmo="scale"
          x={scx - sq * 0.8}
          y={scy - sq * 0.8}
          width={sq * 1.6}
          height={sq * 1.6}
          fill="transparent"
          stroke={color}
          strokeWidth={strokeW * 1.8}
          style={{ cursor: 'nwse-resize' }}
          onPointerDown={onGrab('scale')}
        />
      </g>
    )
  }

  const selGizmoPivot = geoMode ? geoPivotDoc(s.selection) : uvToDoc(selectionPivot(s.selection).u, selectionPivot(s.selection).v)

  const toolName = tool === 'artwork' ? 'Artwork' : tool === 'geometry' ? 'Geometry' : 'UVs'

  return (
    <div className="pattern-editor uv-editor">
      <svg
        ref={svgRef}
        viewBox={vbAttr}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* background: base sheet color always */}
        <rect x={min.x} y={-max.y} width={sw} height={sh} fill={s.material.baseColor} pointerEvents="none" />
        {tool === 'artwork' ? (
          // Live overlay image (transform-driven — smooth dragging).
          hasOverlay && (
            <g transform={`rotate(${overlay.rotationDeg} ${rect.center.x} ${-rect.center.y})`} style={{ cursor: 'move' }}>
              <image
                href={s.material.overlayImage}
                x={rect.x}
                y={-rect.topY}
                width={rect.w}
                height={rect.h}
                preserveAspectRatio="none"
                opacity={0.96}
                onPointerDown={(e) => {
                  if (e.button === 0) {
                    e.stopPropagation()
                    beginArtGesture('move', e)
                  }
                }}
              />
            </g>
          )
        ) : (
          artUrl && (
            <image href={artUrl} x={min.x} y={-max.y} width={sw} height={sh} preserveAspectRatio="none" pointerEvents="none" />
          )
        )}

        {/* dieline reference (where the paper is) */}
        {doc.edges.map((e) => {
          const a = vertexById(doc, e.v1).pos
          const b = vertexById(doc, e.v2).pos
          return (
            <line
              key={e.id}
              x1={a.x}
              y1={-a.y}
              x2={b.x}
              y2={-b.y}
              stroke={colors.dieline}
              strokeOpacity={tool === 'artwork' ? 0.9 : 0.55}
              strokeWidth={strokeW * (e.kind === 'cut' ? 1.4 : 1)}
              strokeDasharray={e.kind === 'crease' ? `${strokeW * 4} ${strokeW * 3}` : undefined}
              pointerEvents="none"
            />
          )
        })}

        {/* UV islands (selectable) — hidden in the Artwork tool */}
        {tool !== 'artwork' &&
          doc.faces.map((f) => {
            const pts = f.vertexIds
              .map((vid) => {
                const p = uvVertexDocPos(f.id, vid)
                return `${p.x},${-p.y}`
              })
              .join(' ')
            const isSel = s.selection.includes(f.id)
            const stroke = isSel ? accent : colors.island
            return (
              <polygon
                key={f.id}
                data-faceid={f.id}
                points={pts}
                fill={stroke}
                fillOpacity={isSel ? 0.28 : 0.1}
                stroke={stroke}
                strokeOpacity={isSel ? 0.95 : 0.6}
                strokeWidth={strokeW * (isSel ? 2.2 : 1.4)}
                strokeLinejoin="round"
                style={{ cursor: gesture ? 'grabbing' : 'grab' }}
                onPointerDown={(ev) => onIslandPointerDown(f.id, ev)}
              >
                <title>{f.name}</title>
              </polygon>
            )
          })}

        {tool === 'artwork' && hasOverlay && (
          <Gizmo pivot={rect.center} color={colors.art} onGrab={(kind) => (e) => {
            if (e.button !== 0) return
            e.stopPropagation()
            beginArtGesture(kind, e)
          }} />
        )}
        {tool !== 'artwork' && hasSel && (
          <Gizmo pivot={selGizmoPivot} color={accent} onGrab={(kind) => (e) => {
            if (e.button !== 0) return
            e.stopPropagation()
            beginGesture(kind, e, s.selection)
          }} />
        )}
      </svg>

      {/* toolbar */}
      <div className="pe-toolbar">
        <span className="pe-title">Flat editor</span>
        <div className="pe-toolset">
          <button
            className={tool === 'artwork' ? 'active' : ''}
            onClick={() => setTool('artwork')}
            title="Move / rotate / scale the printed design to line it up with the dieline — the common task. Drag it in the scene or type values."
          >
            🖼 Artwork
          </button>
          <button
            className={tool === 'geometry' ? 'active' : ''}
            onClick={() => setTool('geometry')}
            title="Reshape the dieline itself to trace the artwork (like drawing a 3D object over a reference). Pick panels, then drag / gizmo. Changes the object in every mode."
          >
            ⛭ Geometry
          </button>
          <button
            className={tool === 'uv' ? 'active' : ''}
            onClick={() => setTool('uv')}
            title="Advanced: shift individual panel UV islands over the artwork. Prints warp to match, so the printout still equals the 3D preview."
          >
            ▦ UVs
          </button>
        </div>
        <span className="pe-sep" />
        {tool === 'uv' && (
          <>
            <button onClick={() => s.selectFaces(doc.faces.map((f) => f.id))}>Select all</button>
            <button disabled={!hasSel} onClick={resetSelected} title="Snap the selected islands back onto the dieline">
              ↺ Reset selected
            </button>
            <button
              disabled={Object.keys(s.uvEdits).length === 0}
              onClick={resetAll}
              title="Snap every island back onto the dieline"
            >
              ↺ Reset all
            </button>
            <span className="pe-sep" />
          </>
        )}
        <button onClick={() => setView(fitView())}>⤢ Fit</button>
        <button onClick={() => s.setWorkspaceMode('fold')}>✔ Done</button>
      </div>

      <p className="pe-hint">
        {tool === 'artwork'
          ? hasOverlay
            ? 'Drag the design to slide it over the dieline; the gizmo rotates / scales it (arrows nudge). Everything you do here changes the print and the 3D preview together. Ctrl+Z undoes.'
            : 'No design loaded — add one below (Artwork ▸ under the inspector) or in Fold mode → dieline editor → Texture tool. Wheel = zoom, right-drag = pan.'
          : tool === 'geometry'
            ? 'Geometry: pick panels, then drag them (or the gizmo) to move / rotate / scale their dieline vertices — the object reshapes to match the artwork. Shared edges pull their neighbours. Ctrl+Z undoes.'
            : 'UVs (advanced): drag an island or the gizmo to choose which part of the artwork each panel shows. Ctrl+click multi-selects; arrows nudge. Prints warp to match. Ctrl+Z undoes.'}
      </p>

      {/* inspector */}
      <div className="pe-inspector tex-inspector">
        <h4>Flat editor — {toolName}</h4>

        {tool === 'uv' && (
          <>
            <p className="uv-sel-label">
              {hasSel
                ? s.selection.length === 1
                  ? (primaryFace?.name ?? `panel ${primary}`)
                  : `${s.selection.length} panels selected`
                : 'Nothing selected — click a panel'}
            </p>
            <div className="tex-grid">
              {field('Offset U', 'du', 0.01)}
              {field('Offset V', 'dv', 0.01)}
              {field('Rotate°', 'rotationDeg', 5)}
              {field('Scale U', 'scaleU', 0.05, 0.01)}
              {field('Scale V', 'scaleV', 0.05, 0.01)}
            </div>
            <div className="btn-row">
              <button disabled={!hasSel} onClick={() => rotateSelected(-90)} title="Rotate the selection 90° counter-clockwise">
                ⟲ 90
              </button>
              <button disabled={!hasSel} onClick={() => rotateSelected(90)} title="Rotate the selection 90° clockwise">
                ⟳ 90
              </button>
              <button disabled={!hasSel} onClick={() => scaleSelectedBy(1 / 1.1)} title="Shrink the selection 10%">
                −
              </button>
              <button disabled={!hasSel} onClick={() => scaleSelectedBy(1.1)} title="Grow the selection 10%">
                +
              </button>
            </div>
            <p className="pe-hint">
              Offsets are fractions of the sheet. With several panels selected, fields and buttons act on the
              selection as one piece about its center. Undoable (Ctrl+Z).
            </p>
          </>
        )}

        {tool === 'geometry' && (
          <p className="pe-hint">
            Click panels in the canvas to select them (Ctrl+click adds), then drag them or the gizmo to reshape
            the dieline. Numeric UV fields live in the UVs tool. Each finished gesture is one undoable edit.
          </p>
        )}

        <ArtworkSection highlight={tool === 'artwork'} />
      </div>
    </div>
  )
}

/** Scale / place the underlying artwork itself (the material's overlay). */
function ArtworkSection({ highlight }: { highlight: boolean }) {
  const s = useAppStore()
  const m = s.material
  const ov = m.overlayTransform ?? identityOverlayTransform()
  const prevOv = useRef<OverlayTransform | undefined>(undefined)
  const [fitting, setFitting] = useState(false)

  function setOv(patch: Partial<OverlayTransform>) {
    s.setMaterial({ ...m, overlayTransform: { ...ov, ...patch } })
  }

  function fillSheet() {
    const prev = m.overlayTransform
    s.setMaterial({ ...m, overlayTransform: identityOverlayTransform() })
    useAppStore.getState().commitOverlay(prev, 'fill sheet')
  }

  async function autoFit() {
    if (!m.overlayImage || fitting) return
    setFitting(true)
    const prev = m.overlayTransform
    try {
      const analysis = await analyzeDielineImage(m.overlayImage)
      const st = useAppStore.getState()
      st.setMaterial({ ...st.material, overlayTransform: analysis.overlay })
      useAppStore.getState().commitOverlay(prev, 'auto-fit artwork')
    } catch {
      // Undecodable image: leave the placement alone.
    } finally {
      setFitting(false)
    }
  }

  const field = (label: string, key: keyof OverlayTransform, step: number) => (
    <NumField
      label={label}
      step={step}
      value={ov[key]}
      onFocus={() => (prevOv.current = useAppStore.getState().material.overlayTransform)}
      onChange={(v) => setOv({ [key]: v } as Partial<OverlayTransform>)}
      onDone={() => {
        useAppStore.getState().commitOverlay(prevOv.current, `set ${label.toLowerCase()}`)
        prevOv.current = undefined
      }}
    />
  )

  return (
    <>
      <h4 className={`uv-art-head${highlight ? ' uv-art-head--on' : ''}`}>Artwork</h4>
      {m.overlayImage ? (
        <>
          <div className="tex-grid">
            {field('Offset X', 'offsetX', 0.02)}
            {field('Offset Y', 'offsetY', 0.02)}
            {field('Scale X', 'scaleX', 0.05)}
            {field('Scale Y', 'scaleY', 0.05)}
            {field('Rotate°', 'rotationDeg', 5)}
          </div>
          <div className="btn-row">
            <button
              onClick={autoFit}
              disabled={fitting}
              title="Detect the artwork's content box (trim background margins) and stretch it onto the sheet"
            >
              {fitting ? '…' : '◱ Auto-fit'}
            </button>
            <button title="Stretch the whole image over the whole sheet" onClick={fillSheet}>
              ⤢ Fill sheet
            </button>
          </div>
          <p className="pe-hint">
            Moves / scales the design image itself — changes the print and the 3D preview together.
            {highlight ? ' The in-scene gizmo drives these same values.' : ''} Undoable.
          </p>
        </>
      ) : (
        <p className="pe-hint">
          No design image — add one in Fold mode → dieline editor → Texture tool.
        </p>
      )}
    </>
  )
}
