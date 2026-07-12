// UV mode: a Blender-style UV editor over the dieline. The artwork (the sheet
// texture) is the fixed background; each panel's UV island is drawn on top and
// can be selected and translated / rotated / scaled — by dragging islands, by
// the in-scene gizmo, or numerically — to choose which part of the artwork the
// panel shows. Identity = islands sit exactly on the dieline (faint reference
// lines). Print exports warp the artwork back per face (buildPrintCanvas), so
// the printout always matches the 3D preview.
//
// Geometry mode flips what gets edited: dragging islands / the gizmo moves the
// selected panels' dieline vertices instead of their UVs, reshaping the actual
// object to match the artwork (useful when stretching the art would mangle
// text). Every finished gesture lands in history as one undoable op.

import { useEffect, useMemo, useRef, useState } from 'react'
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

type GizmoKind = 'move' | 'moveU' | 'moveV' | 'rotate' | 'scale'

interface Gesture {
  kind: GizmoKind
  startDoc: Vec2
  /** Full UV map before the gesture (commit prev + drift-free recompute). */
  prevUV: UVEdits
  /** Dieline before the gesture (geometry mode). */
  prevDoc: PaperDoc
  /** Vertices the gesture moves (geometry mode). */
  vertexIds: number[]
  selection: number[]
  pivotUV: { u: number; v: number }
  pivotDoc: Vec2
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
  const [geoMode, setGeoMode] = useState(false)
  const fieldPrev = useRef<UVEdits | null>(null)

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

  // The artwork background = the sheet texture (what the UVs sample from).
  useEffect(() => {
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
  }, [doc, s.material])

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
      // Island center orbits the pivot (clockwise-positive, v-up frame).
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

  /** Geometry mode: the same group transform applied to dieline vertices. */
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

  function commitGesture(g: Gesture) {
    if (!g.moved) return
    if (geoMode) {
      const cur = useAppStore.getState().doc
      if (cur !== g.prevDoc) {
        s.dispatch(
          { type: 'setDoc', label: `UV geometry ${gestureLabel[g.kind].split(' ')[0]}`, prev: g.prevDoc, next: cur },
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

  // ---- editing actions -------------------------------------------------------

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
      // Per-axis group scale: contract island centers along that axis only.
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

  // Arrow keys nudge the selected islands; Escape clears the selection.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      if (e.key === 'Escape') {
        useAppStore.getState().selectFace(null)
        return
      }
      if (geoMode) return
      const step = e.shiftKey ? 0.02 : 0.005
      const moves: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, step],
        ArrowDown: [0, -step],
      }
      const m = moves[e.key]
      if (m && useAppStore.getState().selection.length > 0) {
        e.preventDefault()
        nudgeSelected(m[0], m[1])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geoMode, doc])

  // ---- pointer handling --------------------------------------------------------

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

  function onIslandPointerDown(faceId: number, e: React.PointerEvent) {
    if (e.button !== 0) return
    e.stopPropagation()
    const additive = e.ctrlKey || e.metaKey
    const wasSelected = s.selection.includes(faceId)
    if (!wasSelected) {
      s.selectFace(faceId, additive)
    } else if (additive) {
      // Ctrl+click on a selected island deselects it — no drag.
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
    // Clicked empty space: clear the selection.
    if (!e.ctrlKey && !e.metaKey) s.selectFace(null)
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

  // ---- rendering ---------------------------------------------------------------

  const dark = s.theme === 'dark'
  const colors = useMemo(
    () => ({
      dieline: dark ? '#8a7f66' : '#a89173',
      island: dark ? '#7fb4e6' : '#3f77b8',
      islandSelected: '#ff9f1c',
      geo: '#2fa46a',
    }),
    [dark],
  )

  const vbAttr = `${view.x} ${view.y} ${view.w} ${view.h}`
  const strokeW = view.w / 420
  const primary = primaryFaceId(s)
  const primaryFace = primary !== null ? doc.faces.find((f) => f.id === primary) : undefined
  const primaryEdit = primary !== null ? editFor(primary) : null
  const hasSel = s.selection.length > 0
  const accent = geoMode ? colors.geo : colors.islandSelected

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

  /** The in-scene gizmo at the selection pivot (like fold mode's W/E/R). */
  function Gizmo() {
    const sel = s.selection
    const pivot = geoMode
      ? geoPivotDoc(sel)
      : (() => {
          const p = selectionPivot(sel)
          return uvToDoc(p.u, p.v)
        })()
    const cx = pivot.x
    const cy = -pivot.y
    const r = view.w * 0.05
    const head = r * 0.14
    const sq = r * 0.16
    const scx = cx + r * 0.9
    const scy = cy - r * 0.9
    const grab = (kind: GizmoKind) => (e: React.PointerEvent) => {
      if (e.button !== 0) return
      e.stopPropagation()
      beginGesture(kind, e, sel)
    }
    return (
      <g className="uv-gizmo">
        {/* rotate ring */}
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={accent} strokeWidth={strokeW * 1.4} opacity={0.9} pointerEvents="none" />
        <circle
          data-uvgizmo="rotate"
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="transparent"
          strokeWidth={strokeW * 9}
          style={{ cursor: 'grab' }}
          onPointerDown={grab('rotate')}
        />
        {/* U axis */}
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
          onPointerDown={grab('moveU')}
        />
        {/* V axis (up on screen) */}
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
          onPointerDown={grab('moveV')}
        />
        {/* free move (center) */}
        <rect
          data-uvgizmo="move"
          x={cx - sq}
          y={cy - sq}
          width={sq * 2}
          height={sq * 2}
          fill={accent}
          opacity={0.85}
          style={{ cursor: 'move' }}
          onPointerDown={grab('move')}
        />
        {/* uniform scale (outside the ring, NE) */}
        <rect
          data-uvgizmo="scale"
          x={scx - sq * 0.8}
          y={scy - sq * 0.8}
          width={sq * 1.6}
          height={sq * 1.6}
          fill="transparent"
          stroke={accent}
          strokeWidth={strokeW * 1.8}
          style={{ cursor: 'nwse-resize' }}
          onPointerDown={grab('scale')}
        />
      </g>
    )
  }

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
        {/* artwork background (the texture the UVs sample from) */}
        {artUrl ? (
          <image
            href={artUrl}
            x={min.x}
            y={-max.y}
            width={sw}
            height={sh}
            preserveAspectRatio="none"
            pointerEvents="none"
          />
        ) : (
          <rect
            x={min.x}
            y={-max.y}
            width={sw}
            height={sh}
            fill={s.material.baseColor}
            pointerEvents="none"
          />
        )}
        {/* dieline reference (where the paper is; faint) */}
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
              strokeOpacity={0.55}
              strokeWidth={strokeW * (e.kind === 'cut' ? 1.4 : 1)}
              strokeDasharray={e.kind === 'crease' ? `${strokeW * 4} ${strokeW * 3}` : undefined}
              pointerEvents="none"
            />
          )
        })}
        {/* UV islands (selectable, draggable) */}
        {doc.faces.map((f) => {
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
        {hasSel && <Gizmo />}
      </svg>

      {/* toolbar */}
      <div className="pe-toolbar">
        <span className="pe-title">UV editor</span>
        <button
          className={geoMode ? 'active' : ''}
          onClick={() => setGeoMode(!geoMode)}
          title="Edit the dieline itself: dragging islands / the gizmo moves, rotates and scales the selected panels' geometry (the object reshapes to match the artwork instead of the artwork stretching). Undoable; refolds live."
        >
          ⛭ Geometry
        </button>
        <span className="pe-sep" />
        <button onClick={() => s.selectFaces(doc.faces.map((f) => f.id))}>Select all</button>
        <button
          disabled={!hasSel}
          onClick={resetSelected}
          title="Snap the selected islands back onto the dieline"
        >
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
        <button onClick={() => setView(fitView())}>⤢ Fit</button>
        <button onClick={() => s.setWorkspaceMode('fold')}>✔ Done</button>
      </div>

      <p className="pe-hint">
        {geoMode
          ? 'Geometry mode: dragging islands (or the gizmo) moves the selected panels’ dieline vertices — the object reshapes to match the artwork. Shared edges pull their neighbours. Ctrl+Z undoes.'
          : s.material.overlayImage
            ? 'Drag an island (or use the gizmo) to choose which part of the artwork each panel shows. Ctrl+click adds to the selection; arrows nudge; Ctrl+Z undoes. Prints are warped to match, so the printout still equals the 3D preview.'
            : 'No design loaded — add one below (Artwork) or in Fold mode → dieline editor → Texture tool. Wheel = zoom, right-drag = pan.'}
      </p>

      {/* transform inspector */}
      <div className="pe-inspector tex-inspector">
        <h4>UV transform</h4>
        <p className="uv-sel-label">
          {hasSel
            ? s.selection.length === 1
              ? (primaryFace?.name ?? `panel ${primary}`)
              : `${s.selection.length} panels selected`
            : 'Nothing selected'}
        </p>
        {geoMode ? (
          <p className="pe-hint">
            Geometry mode — drag islands or the gizmo to reshape the dieline itself. Numeric UV
            fields apply in UV mode (toggle ⛭ Geometry off).
          </p>
        ) : (
          <>
            <div className="tex-grid">
              {field('Offset U', 'du', 0.01)}
              {field('Offset V', 'dv', 0.01)}
              {field('Rotate°', 'rotationDeg', 5)}
              {field('Scale U', 'scaleU', 0.05, 0.01)}
              {field('Scale V', 'scaleV', 0.05, 0.01)}
            </div>
            <div className="btn-row">
              <button
                disabled={!hasSel}
                onClick={() => rotateSelected(-90)}
                title="Rotate the selection 90° counter-clockwise"
              >
                ⟲ 90
              </button>
              <button
                disabled={!hasSel}
                onClick={() => rotateSelected(90)}
                title="Rotate the selection 90° clockwise"
              >
                ⟳ 90
              </button>
              <button
                disabled={!hasSel}
                onClick={() => scaleSelectedBy(1 / 1.1)}
                title="Shrink the selection 10%"
              >
                −
              </button>
              <button
                disabled={!hasSel}
                onClick={() => scaleSelectedBy(1.1)}
                title="Grow the selection 10%"
              >
                +
              </button>
            </div>
            <p className="pe-hint">
              Offsets are fractions of the sheet. With several panels selected, fields and buttons
              move / rotate / scale the selection as one piece about its center. Every change is
              undoable (Ctrl+Z).
            </p>
          </>
        )}
        <ArtworkSection />
      </div>
    </div>
  )
}

/** Scale / place the underlying artwork itself (the material's overlay). */
function ArtworkSection() {
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

  /** Detect the artwork's content box (trim margins) and map it onto the sheet. */
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
      <h4 className="uv-art-head">Artwork</h4>
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
            Moves / scales the design image itself (same as the Texture tool) — changes the print
            and the 3D preview together. Undoable.
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
