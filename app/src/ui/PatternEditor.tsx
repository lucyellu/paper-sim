import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addSegment,
  moveVertex,
  nearestEdge,
  removeEdge,
  setEdgeKind,
  setTargetAngle,
  snapPoint,
  type Anchor,
  type EditResult,
} from '../model/editing'
import { sheetBounds, vertexById, type Vec2 } from '../model/document'
import { identityOverlayTransform, type OverlayTransform } from '../model/material'
import { getDisplayAngles, useAppStore } from '../state/store'

type Tool = 'select' | 'crease' | 'cut' | 'delete' | 'texture' | 'trace'

interface ViewBox {
  x: number
  y: number
  w: number
  h: number
}

interface SnapHit {
  anchor: Anchor
  pos: Vec2
}

/** Full-viewport dieline editor: draw, delete, retype and move lines. */
export function PatternEditor() {
  const s = useAppStore()
  const doc = s.doc
  const display = getDisplayAngles(s)
  const svgRef = useRef<SVGSVGElement>(null)

  const [tool, setTool] = useState<Tool>('select')
  const [view, setView] = useState<ViewBox>(() => fitView())
  const [hover, setHover] = useState<SnapHit | null>(null)
  const [start, setStart] = useState<SnapHit | null>(null)
  const [selEdge, setSelEdge] = useState<number | null>(null)
  const [dragVertex, setDragVertex] = useState<{ id: number; pos: Vec2 } | null>(null)
  const [texDrag, setTexDrag] = useState<{ startDoc: Vec2; start: OverlayTransform } | null>(null)
  const [bgDrag, setBgDrag] = useState<{ startDoc: Vec2; startX: number; startY: number } | null>(
    null,
  )
  const [pan, setPan] = useState<{ px: number; py: number; view: ViewBox } | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  function fitView(): ViewBox {
    const { min, max } = sheetBounds(useAppStore.getState().doc)
    const pad = Math.max(max.x - min.x, max.y - min.y) * 0.08 + 1
    return {
      x: min.x - pad,
      y: -(max.y + pad),
      w: max.x - min.x + 2 * pad,
      h: max.y - min.y + 2 * pad,
    }
  }

  useEffect(() => {
    if (toast === null) return
    const t = setTimeout(() => setToast(null), 3500)
    return () => clearTimeout(t)
  }, [toast])

  // Escape cancels an in-progress draw; Delete removes the selected line.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      if (e.key === 'Escape') setStart(null)
      if ((e.key === 'Delete' || e.key === 'Backspace') && selEdge !== null) {
        e.preventDefault()
        deleteEdge(selEdge)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selEdge, doc])

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

  function pxTolerance(px: number): number {
    const svg = svgRef.current
    if (!svg) return 0.3
    const rect = svg.getBoundingClientRect()
    const scale = Math.min(rect.width / view.w, rect.height / view.h)
    return px / scale
  }

  function commit(label: string, result: EditResult) {
    if (useAppStore.getState().playback.mode !== 'edit') {
      setToast('Finish playback first (Resume editing) to edit the dieline.')
      return false
    }
    if ('error' in result) {
      setToast(result.error)
      return false
    }
    if (result.doc === doc) return true
    s.dispatch({ type: 'setDoc', label, prev: doc, next: result.doc })
    return true
  }

  function deleteEdge(edgeId: number) {
    const e = doc.edges.find((x) => x.id === edgeId)
    if (!e) return
    if (commit('delete line', removeEdge(doc, edgeId))) setSelEdge(null)
  }

  // ---- pointer handling ----------------------------------------------------
  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (e.button === 1 || e.button === 2) {
      setPan({ px: e.clientX, py: e.clientY, view })
      ;(e.target as Element).setPointerCapture(e.pointerId)
      return
    }
    if (e.button !== 0) return
    const p = toDoc(e)
    const tol = pxTolerance(10)

    if (tool === 'crease' || tool === 'cut') {
      const snap = snapPoint(doc, p, tol * 1.6)
      if (!snap) return
      if (!start) {
        setStart(snap)
      } else {
        const ok = commit(
          `draw ${tool}`,
          addSegment(doc, start.anchor, snap.anchor, tool === 'crease' ? 'crease' : 'cut'),
        )
        if (ok) setStart(null)
      }
      return
    }

    if (tool === 'delete') {
      const id = nearestEdge(doc, p, tol)
      if (id !== null) deleteEdge(id)
      return
    }

    // Select tool: edges beat faces (they're smaller targets).
    const edgeId = nearestEdge(doc, p, tol * 0.7)
    if (edgeId !== null) {
      setSelEdge(edgeId)
      return
    }
    const face = faceAt(p)
    if (face !== null) {
      s.selectFace(face, e.ctrlKey || e.metaKey)
      setSelEdge(null)
    } else {
      if (!e.ctrlKey && !e.metaKey) s.selectFace(null)
      setSelEdge(null)
    }
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
    if (dragVertex) {
      setDragVertex({ id: dragVertex.id, pos: toDoc(e) })
      return
    }
    if (bgDrag && s.backdrop) {
      const cur = toDoc(e)
      s.setBackdrop({
        ...s.backdrop,
        x: bgDrag.startX + (cur.x - bgDrag.startDoc.x),
        y: bgDrag.startY + (cur.y - bgDrag.startDoc.y),
      })
      return
    }
    if (texDrag) {
      const { min, max } = sheetBounds(doc)
      const sw = Math.max(max.x - min.x, 0.001)
      const sh = Math.max(max.y - min.y, 0.001)
      const cur = toDoc(e)
      const t = texDrag.start
      // offsetX follows +x; offsetY grows downward in the sheet, so it follows -y.
      s.setMaterial({
        ...s.material,
        overlayTransform: {
          ...t,
          offsetX: t.offsetX + (cur.x - texDrag.startDoc.x) / sw,
          offsetY: t.offsetY - (cur.y - texDrag.startDoc.y) / sh,
        },
      })
      return
    }
    if (tool === 'crease' || tool === 'cut') {
      setHover(snapPoint(doc, toDoc(e), pxTolerance(16)))
    }
  }

  function onPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    if (pan) {
      setPan(null)
      return
    }
    if (dragVertex) {
      commit('move point', moveVertex(doc, dragVertex.id, dragVertex.pos))
      setDragVertex(null)
      return
    }
    if (texDrag) {
      setTexDrag(null)
      return
    }
    if (bgDrag) {
      setBgDrag(null)
      return
    }
    void e
  }

  function onWheel(e: React.WheelEvent<SVGSVGElement>) {
    const p = toDoc(e)
    const factor = Math.pow(1.0015, e.deltaY)
    const w = Math.max(2, Math.min(400, view.w * factor))
    const scale = w / view.w
    if (scale === 1) return
    // Keep the doc point under the cursor fixed.
    const sx = p.x
    const sy = -p.y
    setView({
      x: sx - (sx - view.x) * scale,
      y: sy - (sy - view.y) * scale,
      w,
      h: view.h * scale,
    })
  }

  function faceAt(p: Vec2): number | null {
    for (const f of doc.faces) {
      const poly = f.vertexIds.map((id) => vertexById(doc, id).pos)
      let inside = false
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i]
        const b = poly[j]
        if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
          inside = !inside
        }
      }
      if (inside) return f.id
    }
    return null
  }

  // ---- rendering -------------------------------------------------------------
  const dark = s.theme === 'dark'
  const colors = useMemo(
    () => ({
      face: dark ? '#453e30' : '#ece0c2',
      faceSelected: dark ? '#c98a2e' : '#f6c66d',
      cut: dark ? '#c9b791' : '#3b3327',
      flat: dark ? '#8a7f66' : '#a89173',
      vertex: dark ? '#d9c9a3' : '#7a6a4f',
    }),
    [dark],
  )

  const vbAttr = `${view.x} ${view.y} ${view.w} ${view.h}`
  const strokeW = view.w / 420
  const selected = s.selection
  const selEdgeObj = selEdge !== null ? doc.edges.find((e) => e.id === selEdge) : undefined
  const editingDisabled = s.playback.mode !== 'edit'

  return (
    <div className="pattern-editor">
      <svg
        ref={svgRef}
        viewBox={vbAttr}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* tracing backdrop (behind everything) */}
        {s.backdrop && (
          <image
            href={s.backdrop.image}
            x={s.backdrop.x}
            y={-s.backdrop.y}
            width={s.backdrop.w}
            height={s.backdrop.h}
            opacity={s.backdrop.opacity}
            preserveAspectRatio="none"
            pointerEvents={tool === 'trace' ? 'auto' : 'none'}
            style={{ cursor: tool === 'trace' ? 'move' : 'default' }}
            onPointerDown={(ev) => {
              if (tool !== 'trace' || ev.button !== 0) return
              ev.stopPropagation()
              ;(ev.target as Element).setPointerCapture(ev.pointerId)
              setBgDrag({ startDoc: toDoc(ev), startX: s.backdrop!.x, startY: s.backdrop!.y })
            }}
          />
        )}
        {/* faces */}
        {doc.faces.map((f) => {
          const pts = f.vertexIds
            .map((id) => {
              const p = vertexById(doc, id).pos
              return `${p.x},${-p.y}`
            })
            .join(' ')
          const isSel = selected.includes(f.id)
          return (
            <polygon
              key={f.id}
              points={pts}
              fill={isSel ? colors.faceSelected : colors.face}
              fillOpacity={isSel ? 0.85 : 0.65}
              stroke="none"
            />
          )
        })}
        {/* design overlay reference (the dieline is the object's UV map) */}
        {s.material.overlayImage &&
          (() => {
            const { min, max } = sheetBounds(doc)
            const sw = max.x - min.x
            const sh = max.y - min.y
            const ov = s.material.overlayTransform ?? identityOverlayTransform()
            const iw = sw * ov.scaleX
            const ih = sh * ov.scaleY
            const ix = min.x + ov.offsetX * sw
            const iy = -max.y + ov.offsetY * sh
            const cx = ix + iw / 2
            const cy = iy + ih / 2
            const editing = tool === 'texture'
            return (
              <>
                <image
                  href={s.material.overlayImage}
                  x={ix}
                  y={iy}
                  width={iw}
                  height={ih}
                  transform={`rotate(${ov.rotationDeg} ${cx} ${cy})`}
                  preserveAspectRatio="none"
                  opacity={editing ? 0.92 : 0.85}
                  pointerEvents={editing ? 'auto' : 'none'}
                  style={{ cursor: editing ? 'move' : 'default' }}
                  onPointerDown={(ev) => {
                    if (!editing || ev.button !== 0 || editingDisabled) return
                    ev.stopPropagation()
                    ;(ev.target as Element).setPointerCapture(ev.pointerId)
                    setTexDrag({ startDoc: toDoc(ev), start: ov })
                  }}
                />
                {editing && (
                  <rect
                    x={ix}
                    y={iy}
                    width={iw}
                    height={ih}
                    transform={`rotate(${ov.rotationDeg} ${cx} ${cy})`}
                    fill="none"
                    stroke="#ff9f1c"
                    strokeWidth={strokeW * 1.5}
                    strokeDasharray={`${strokeW * 4} ${strokeW * 3}`}
                    pointerEvents="none"
                  />
                )}
              </>
            )
          })()}
        {/* edges */}
        {doc.edges.map((e) => {
          const a = vertexById(doc, e.v1).pos
          const b = vertexById(doc, e.v2).pos
          const ang = display[e.id] ?? 0
          const isSel = e.id === selEdge
          const color = isSel
            ? '#ff9f1c'
            : e.kind === 'cut'
              ? colors.cut
              : ang > 1
                ? '#3b82f6'
                : ang < -1
                  ? '#ef4444'
                  : colors.flat
          return (
            <line
              key={e.id}
              x1={a.x}
              y1={-a.y}
              x2={b.x}
              y2={-b.y}
              stroke={color}
              strokeWidth={strokeW * (isSel ? 3 : e.kind === 'cut' ? 2 : 1.6)}
              strokeDasharray={e.kind === 'crease' ? `${strokeW * 5} ${strokeW * 3}` : undefined}
              strokeLinecap="round"
            />
          )
        })}
        {/* vertices (drag handles in select mode) */}
        {tool === 'select' &&
          doc.vertices.map((v) => {
            const dragging = dragVertex?.id === v.id
            const p = dragging ? dragVertex.pos : v.pos
            return (
              <circle
                key={v.id}
                cx={p.x}
                cy={-p.y}
                r={strokeW * (dragging ? 5 : 3.2)}
                fill={dragging ? '#ff9f1c' : colors.vertex}
                fillOpacity={dragging ? 0.9 : 0.55}
                style={{ cursor: 'grab' }}
                onPointerDown={(ev) => {
                  if (ev.button !== 0 || editingDisabled) return
                  ev.stopPropagation()
                  ;(ev.target as Element).setPointerCapture(ev.pointerId)
                  setDragVertex({ id: v.id, pos: v.pos })
                }}
              />
            )
          })}
        {/* draw preview */}
        {start && (
          <>
            <circle cx={start.pos.x} cy={-start.pos.y} r={strokeW * 5} fill="#ff9f1c" />
            {hover && (
              <line
                x1={start.pos.x}
                y1={-start.pos.y}
                x2={hover.pos.x}
                y2={-hover.pos.y}
                stroke="#ff9f1c"
                strokeWidth={strokeW * 2}
                strokeDasharray={`${strokeW * 4} ${strokeW * 3}`}
              />
            )}
          </>
        )}
        {(tool === 'crease' || tool === 'cut') && hover && (
          <circle
            cx={hover.pos.x}
            cy={-hover.pos.y}
            r={strokeW * 4.4}
            fill="none"
            stroke="#ff9f1c"
            strokeWidth={strokeW * 1.6}
          />
        )}
      </svg>

      {/* toolbar */}
      <div className="pe-toolbar">
        <span className="pe-title">Dieline editor</span>
        {(
          [
            ['select', '☝ Select'],
            ['crease', '⌁ Draw crease'],
            ['cut', '✂ Draw cut'],
            ['delete', '⌫ Delete line'],
            ['texture', '🖼 Texture'],
            ['trace', '📐 Trace'],
          ] as Array<[Tool, string]>
        ).map(([t, label]) => (
          <button
            key={t}
            className={tool === t ? 'active' : ''}
            onClick={() => {
              setTool(t)
              setStart(null)
              setHover(null)
            }}
          >
            {label}
          </button>
        ))}
        <span className="pe-sep" />
        <button onClick={() => setView(fitView())}>⤢ Fit</button>
        <button onClick={() => s.setEditorMode('3d')}>✔ Done</button>
      </div>

      <p className="pe-hint">
        {editingDisabled
          ? 'Finish playback first (Resume editing) to edit the dieline.'
          : tool === 'trace'
            ? 'Load a dieline image, line it up, then use Draw crease / Draw cut to trace it into our format. The backdrop is a guide only — it is not saved.'
            : tool === 'texture'
            ? 'Drag the design to move it; set size / rotation at right. The dieline is the UV map — fit your art to the panels.'
            : tool === 'select'
              ? 'Click a line to inspect it, a panel to select it, drag a point to move it. Wheel = zoom, right-drag = pan.'
              : tool === 'delete'
                ? 'Click a line between two panels to remove it (the panels merge).'
                : start
                  ? 'Click the end point (snaps to points and lines). Esc cancels.'
                  : 'Click the start point on a panel edge or corner.'}
      </p>

      {tool === 'texture' && <TextureInspector />}

      {tool === 'trace' && <BackdropInspector />}

      {/* line inspector */}
      {selEdgeObj && (
        <div className="pe-inspector">
          <h4>Line</h4>
          <div className="btn-row">
            <button
              className={selEdgeObj.kind === 'crease' ? 'active' : ''}
              disabled={editingDisabled}
              onClick={() => commit('make crease', setEdgeKind(doc, selEdgeObj.id, 'crease'))}
            >
              Crease
            </button>
            <button
              className={selEdgeObj.kind === 'cut' ? 'active' : ''}
              disabled={editingDisabled}
              onClick={() => commit('make cut', setEdgeKind(doc, selEdgeObj.id, 'cut'))}
            >
              Cut
            </button>
          </div>
          {selEdgeObj.kind === 'crease' && (
            <label className="pe-target">
              Target angle
              <input
                type="number"
                min={-179}
                max={179}
                disabled={editingDisabled}
                value={doc.targetAngles?.[selEdgeObj.id] ?? ''}
                placeholder="—"
                onChange={(ev) => {
                  const v = ev.target.value
                  commit(
                    'set target angle',
                    setTargetAngle(doc, selEdgeObj.id, v === '' ? undefined : Number(v)),
                  )
                }}
              />
              °
            </label>
          )}
          <button
            className="subtle"
            disabled={editingDisabled}
            onClick={() => deleteEdge(selEdgeObj.id)}
          >
            ⌫ Delete line
          </button>
        </div>
      )}

      {toast && <div className="pe-toast">{toast}</div>}
    </div>
  )
}

/** UV-editor panel: place/size/rotate the design overlay to fit the dieline. */
function TextureInspector() {
  const s = useAppStore()
  const m = s.material
  const ov = m.overlayTransform ?? identityOverlayTransform()
  const fileRef = useRef<HTMLInputElement>(null)

  function setOv(patch: Partial<OverlayTransform>) {
    s.setMaterial({ ...m, overlayTransform: { ...ov, ...patch } })
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const url = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result as string)
      r.onerror = () => reject(new Error('read failed'))
      r.readAsDataURL(file)
    }).catch(() => null)
    if (url) s.setMaterial({ ...m, overlayImage: url })
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
    <div className="pe-inspector tex-inspector">
      <h4>Texture / UV</h4>
      <div className="btn-row">
        <button onClick={() => fileRef.current?.click()}>
          {m.overlayImage ? 'Replace design…' : 'Add design…'}
        </button>
        {m.overlayImage && (
          <button
            title="Remove the design overlay"
            onClick={() => s.setMaterial({ ...m, overlayImage: undefined })}
          >
            ✕
          </button>
        )}
      </div>
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
          <p className="pe-hint" style={{ position: 'static' }}>
            Drag the image in the canvas to move it. Fit = fill the dieline (default).
          </p>
        </>
      ) : (
        <p className="pe-hint" style={{ position: 'static' }}>
          Add a design image, then drag/size it to fit the dieline panels.
        </p>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={onPick}
      />
    </div>
  )
}

/** Load + place a reference dieline image to trace over (session-only). */
function BackdropInspector() {
  const s = useAppStore()
  const bg = s.backdrop
  const fileRef = useRef<HTMLInputElement>(null)

  /** Fit a w:h rect inside the sheet bounds, centered. */
  function fitRect(aspect: number) {
    const { min, max } = sheetBounds(s.doc)
    const sw = Math.max(max.x - min.x, 0.001)
    const sh = Math.max(max.y - min.y, 0.001)
    let w = sw
    let h = w / aspect
    if (h > sh) {
      h = sh
      w = h * aspect
    }
    return { x: min.x + (sw - w) / 2, y: max.y - (sh - h) / 2, w, h }
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const url = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result as string)
      r.onerror = () => reject(new Error('read failed'))
      r.readAsDataURL(file)
    }).catch(() => null)
    if (!url) return
    const img = new Image()
    img.onload = () => {
      const aspect = img.naturalWidth / Math.max(1, img.naturalHeight)
      const r = fitRect(aspect)
      s.setBackdrop({ image: url, ...r, opacity: 0.5 })
    }
    img.src = url
  }

  function scale(f: number) {
    if (!bg) return
    const cx = bg.x + bg.w / 2
    const cy = bg.y - bg.h / 2
    const w = bg.w * f
    const h = bg.h * f
    s.setBackdrop({ ...bg, w, h, x: cx - w / 2, y: cy + h / 2 })
  }

  function refit() {
    if (!bg) return
    const r = fitRect(bg.w / Math.max(0.001, bg.h))
    s.setBackdrop({ ...bg, ...r })
  }

  return (
    <div className="pe-inspector tex-inspector">
      <h4>Trace backdrop</h4>
      <div className="btn-row">
        <button onClick={() => fileRef.current?.click()}>
          {bg ? 'Replace image…' : 'Load image…'}
        </button>
        {bg && (
          <button title="Remove the tracing backdrop" onClick={() => s.setBackdrop(null)}>
            ✕
          </button>
        )}
      </div>
      {bg ? (
        <>
          <div className="btn-row">
            <button title="Shrink" onClick={() => scale(1 / 1.1)}>
              − smaller
            </button>
            <button title="Grow" onClick={() => scale(1.1)}>
              + bigger
            </button>
            <button title="Fit to the sheet bounds" onClick={refit}>
              ⤢ Fit
            </button>
          </div>
          <label className="tex-field" style={{ display: 'block' }}>
            <span>Opacity</span>
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={bg.opacity}
              onChange={(e) => s.setBackdrop({ ...bg, opacity: Number(e.target.value) })}
            />
          </label>
          <p className="pe-hint" style={{ position: 'static' }}>
            Drag the image to line it up, then trace with Draw crease / Draw cut. Not saved in the
            file.
          </p>
        </>
      ) : (
        <p className="pe-hint" style={{ position: 'static' }}>
          Load one of your saved dieline images, scale/drag it onto the sheet, then draw over it.
        </p>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={onPick}
      />
    </div>
  )
}
