// UV mode: a Blender-style UV editor over the dieline. The artwork (the sheet
// texture) is the fixed background; each panel's UV island is drawn on top and
// can be selected and translated / rotated / scaled to choose which part of
// the artwork the panel shows. Identity = islands sit exactly on the dieline
// (faint reference lines). Print exports warp the artwork back per face
// (buildPrintCanvas), so the printout always matches the 3D preview.

import { useEffect, useMemo, useRef, useState } from 'react'
import { sheetBounds, vertexById, type Vec2 } from '../model/document'
import { identityOverlayTransform, type OverlayTransform } from '../model/material'
import {
  applyFaceUV,
  faceUVCentroid,
  identityFaceUV,
  type FaceUV,
  type UVEdits,
} from '../model/uv'
import { primaryFaceId, useAppStore } from '../state/store'
import { buildSheetCanvas, materialNeedsTexture } from '../viewer/texture'

interface ViewBox {
  x: number
  y: number
  w: number
  h: number
}

export function UVEditor() {
  const s = useAppStore()
  const doc = s.doc
  const svgRef = useRef<SVGSVGElement>(null)
  const [view, setView] = useState<ViewBox>(() => fitView())
  const [artUrl, setArtUrl] = useState<string | null>(null)
  const [pan, setPan] = useState<{ px: number; py: number; view: ViewBox } | null>(null)
  const [drag, setDrag] = useState<{
    startDoc: Vec2
    start: Record<number, FaceUV>
    moved: boolean
  } | null>(null)

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

  /** A vertex's edited UV position mapped back to doc coords (for drawing). */
  function uvVertexDocPos(faceId: number, vid: number): Vec2 {
    const p = vertexById(doc, vid).pos
    const t = s.uvEdits[faceId]
    if (!t) return p
    const face = doc.faces.find((f) => f.id === faceId)!
    const c = faceUVCentroid(doc, face)
    const [u, v] = applyFaceUV(t, c, (p.x - min.x) / sw, (p.y - min.y) / sh)
    return { x: min.x + u * sw, y: min.y + v * sh }
  }

  // ---- editing actions -------------------------------------------------------

  /**
   * Numeric field edit. One panel selected = set the value directly. Several
   * panels selected = treat the selection as ONE piece: apply the delta (or
   * scale factor) relative to the primary panel's value, about the selection
   * center — so typing Scale 0.6 shrinks the whole selection together instead
   * of each island collapsing toward its own middle.
   */
  function setSelectedField(key: keyof FaceUV, value: number) {
    if (s.selection.length === 0) return
    if (s.selection.length === 1) {
      const id = s.selection[0]
      s.setUVEdits({ ...s.uvEdits, [id]: { ...editFor(id), [key]: value } })
      return
    }
    const cur = editFor(s.selection[s.selection.length - 1])[key]
    if (key === 'du' || key === 'dv') {
      const d = value - cur
      nudgeSelected(key === 'du' ? d : 0, key === 'dv' ? d : 0)
    } else if (key === 'rotationDeg') {
      rotateSelected(value - cur)
    } else {
      // Scale: factor from the primary's current value (guard near-zero).
      if (Math.abs(cur) < 1e-6 || Math.abs(value) < 1e-6) return
      const f = value / cur
      scaleSelected(key === 'scaleU' ? f : 1, key === 'scaleV' ? f : 1)
    }
  }

  /** Pivot for group rotate/scale: mean of the selected islands' UV centers. */
  function selectionPivot(): { u: number; v: number } | null {
    if (s.selection.length === 0) return null
    let pu = 0
    let pv = 0
    let n = 0
    for (const id of s.selection) {
      const face = doc.faces.find((f) => f.id === id)
      if (!face) continue
      const c = faceUVCentroid(doc, face)
      const t = editFor(id)
      pu += c.u + t.du
      pv += c.v + t.dv
      n++
    }
    return n > 0 ? { u: pu / n, v: pv / n } : null
  }

  /** Rotate all selected islands together about the selection pivot (CW+). */
  function rotateSelected(deltaDeg: number) {
    const P = selectionPivot()
    if (!P) return
    const rad = (deltaDeg * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const next: UVEdits = { ...s.uvEdits }
    for (const id of s.selection) {
      const face = doc.faces.find((f) => f.id === id)
      if (!face) continue
      const c = faceUVCentroid(doc, face)
      const t = editFor(id)
      // Island center T(c) = c + d rotates about P (clockwise, v-up frame).
      const rx = c.u + t.du - P.u
      const ry = c.v + t.dv - P.v
      next[id] = {
        ...t,
        rotationDeg: t.rotationDeg + deltaDeg,
        du: cos * rx + sin * ry + P.u - c.u,
        dv: -sin * rx + cos * ry + P.v - c.v,
      }
    }
    s.setUVEdits(next)
  }

  /** Scale all selected islands together about the selection pivot. */
  function scaleSelected(fu: number, fv: number) {
    const P = selectionPivot()
    if (!P) return
    const next: UVEdits = { ...s.uvEdits }
    for (const id of s.selection) {
      const face = doc.faces.find((f) => f.id === id)
      if (!face) continue
      const c = faceUVCentroid(doc, face)
      const t = editFor(id)
      next[id] = {
        ...t,
        scaleU: t.scaleU * fu,
        scaleV: t.scaleV * fv,
        du: fu * (c.u + t.du - P.u) + P.u - c.u,
        dv: fv * (c.v + t.dv - P.v) + P.v - c.v,
      }
    }
    s.setUVEdits(next)
  }

  function nudgeSelected(du: number, dv: number) {
    if (s.selection.length === 0) return
    const next: UVEdits = { ...s.uvEdits }
    for (const id of s.selection) {
      const t = editFor(id)
      next[id] = { ...t, du: t.du + du, dv: t.dv + dv }
    }
    s.setUVEdits(next)
  }

  function resetSelected() {
    const next: UVEdits = { ...s.uvEdits }
    for (const id of s.selection) delete next[id]
    s.setUVEdits(next)
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
  }, [s.selection, s.uvEdits, doc])

  // ---- pointer handling --------------------------------------------------------

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
    const sel = useAppStore.getState().selection
    const start: Record<number, FaceUV> = {}
    for (const id of sel) start[id] = editFor(id)
    ;(e.target as Element).setPointerCapture(e.pointerId)
    setDrag({ startDoc: toDoc(e), start, moved: false })
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
    if (drag) {
      const cur = toDoc(e)
      const du = (cur.x - drag.startDoc.x) / sw
      const dv = (cur.y - drag.startDoc.y) / sh
      const next: UVEdits = { ...useAppStore.getState().uvEdits }
      for (const [id, t] of Object.entries(drag.start)) {
        next[Number(id)] = { ...t, du: t.du + du, dv: t.dv + dv }
      }
      s.setUVEdits(next)
      if (!drag.moved && (Math.abs(du) > 1e-4 || Math.abs(dv) > 1e-4)) {
        setDrag({ ...drag, moved: true })
      }
    }
  }

  function onPointerUp() {
    setPan(null)
    setDrag(null)
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
    }),
    [dark],
  )

  const vbAttr = `${view.x} ${view.y} ${view.w} ${view.h}`
  const strokeW = view.w / 420
  const primary = primaryFaceId(s)
  const primaryFace = primary !== null ? doc.faces.find((f) => f.id === primary) : undefined
  const primaryEdit = primary !== null ? editFor(primary) : null
  const hasSel = s.selection.length > 0

  const field = (label: string, key: keyof FaceUV, step: number) => (
    <label className="tex-field">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        value={primaryEdit ? Math.round(primaryEdit[key] * 1000) / 1000 : 0}
        disabled={!hasSel}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) setSelectedField(key, v)
        }}
      />
    </label>
  )

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
          return (
            <polygon
              key={f.id}
              data-faceid={f.id}
              points={pts}
              fill={isSel ? colors.islandSelected : colors.island}
              fillOpacity={isSel ? 0.28 : 0.1}
              stroke={isSel ? colors.islandSelected : colors.island}
              strokeOpacity={isSel ? 0.95 : 0.6}
              strokeWidth={strokeW * (isSel ? 2.2 : 1.4)}
              strokeLinejoin="round"
              style={{ cursor: drag ? 'grabbing' : 'grab' }}
              onPointerDown={(ev) => onIslandPointerDown(f.id, ev)}
            >
              <title>{f.name}</title>
            </polygon>
          )
        })}
      </svg>

      {/* toolbar */}
      <div className="pe-toolbar">
        <span className="pe-title">UV editor</span>
        <button onClick={() => s.selectFaces(doc.faces.map((f) => f.id))}>Select all</button>
        <button disabled={!hasSel} onClick={resetSelected} title="Snap the selected islands back onto the dieline">
          ↺ Reset selected
        </button>
        <button
          disabled={Object.keys(s.uvEdits).length === 0}
          onClick={() => s.setUVEdits({})}
          title="Snap every island back onto the dieline"
        >
          ↺ Reset all
        </button>
        <span className="pe-sep" />
        <button onClick={() => setView(fitView())}>⤢ Fit</button>
        <button onClick={() => s.setWorkspaceMode('fold')}>✔ Done</button>
      </div>

      <p className="pe-hint">
        {s.material.overlayImage
          ? 'Drag an island to choose which part of the artwork that panel shows (Ctrl+click adds to the selection; arrows nudge). The faint lines are the dieline — prints are warped to match, so the printout still equals the 3D preview.'
          : 'No design loaded — add one in Fold mode → dieline editor → Texture tool, then shift panel UVs here. Wheel = zoom, right-drag = pan.'}
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
        <div className="tex-grid">
          {field('Offset U', 'du', 0.01)}
          {field('Offset V', 'dv', 0.01)}
          {field('Rotate°', 'rotationDeg', 5)}
          {field('Scale U', 'scaleU', 0.05)}
          {field('Scale V', 'scaleV', 0.05)}
        </div>
        <div className="btn-row">
          <button disabled={!hasSel} onClick={() => rotateSelected(-90)} title="Rotate the selection 90° counter-clockwise">
            ⟲ 90
          </button>
          <button disabled={!hasSel} onClick={() => rotateSelected(90)} title="Rotate the selection 90° clockwise">
            ⟳ 90
          </button>
          <button
            disabled={!hasSel}
            onClick={() => scaleSelected(1 / 1.1, 1 / 1.1)}
            title="Shrink the selection 10%"
          >
            −
          </button>
          <button
            disabled={!hasSel}
            onClick={() => scaleSelected(1.1, 1.1)}
            title="Grow the selection 10%"
          >
            +
          </button>
        </div>
        <p className="pe-hint">
          Offsets are fractions of the sheet. With several panels selected, fields and buttons
          move / rotate / scale the selection as one piece about its center.
        </p>
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

  function setOv(patch: Partial<OverlayTransform>) {
    s.setMaterial({ ...m, overlayTransform: { ...ov, ...patch } })
  }

  const field = (label: string, key: keyof OverlayTransform, step: number) => (
    <label className="tex-field">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        value={Math.round(ov[key] * 1000) / 1000}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) setOv({ [key]: v } as Partial<OverlayTransform>)
        }}
      />
    </label>
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
              title="Reset the design to fill the whole dieline"
              onClick={() => setOv(identityOverlayTransform())}
            >
              ⤢ Fit to dieline
            </button>
          </div>
          <p className="pe-hint">
            Moves / scales the design image itself (same as the dieline editor's Texture tool) —
            changes the print and the 3D preview together.
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
