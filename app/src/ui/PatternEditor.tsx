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
import { getDisplayAngles, useAppStore } from '../state/store'

type Tool = 'select' | 'crease' | 'cut' | 'delete'

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
            return (
              <image
                href={s.material.overlayImage}
                x={min.x}
                y={-max.y}
                width={max.x - min.x}
                height={max.y - min.y}
                preserveAspectRatio="none"
                opacity={0.85}
                pointerEvents="none"
              />
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
          : tool === 'select'
            ? 'Click a line to inspect it, a panel to select it, drag a point to move it. Wheel = zoom, right-drag = pan.'
            : tool === 'delete'
              ? 'Click a line between two panels to remove it (the panels merge).'
              : start
                ? 'Click the end point (snaps to points and lines). Esc cancels.'
                : 'Click the start point on a panel edge or corner.'}
      </p>

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
