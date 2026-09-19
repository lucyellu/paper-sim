import { useRef, useState } from 'react'
import { columnFaceIds, rowFaceIds, sheetBounds, vertexById } from '../model/document'
import { getDisplayAngles, selectedHinge, useAppStore } from '../state/store'
import { readPref, writePref } from './panels'

const PREF_KEY = 'paperSim.panel.patternInset'
const MIN_W = 140
const MAX_W = 900
const DEFAULT_W = 220

/**
 * 2D dieline inset (bottom-left), mirroring PackCAD's pattern view. Drag its
 * right edge to resize; click the label to collapse it to a pill.
 */
export function PatternInset() {
  const [saved] = useState(() => readPref(PREF_KEY, { width: DEFAULT_W, collapsed: false }))
  const [width, setWidth] = useState(
    Math.max(MIN_W, Math.min(MAX_W, saved.width ?? DEFAULT_W)),
  )
  const [collapsed, setCollapsed] = useState(saved.collapsed ?? false)
  const rootRef = useRef<HTMLDivElement>(null)

  function onGripDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    const grip = e.currentTarget
    grip.setPointerCapture(e.pointerId)
    const onMove = (ev: PointerEvent) => {
      const root = rootRef.current!
      const rect = root.getBoundingClientRect()
      // Don't let it grow past the viewport area it floats over.
      const room = (root.offsetParent?.clientWidth ?? window.innerWidth) - 24
      const w = Math.min(ev.clientX - rect.left, room)
      setWidth(Math.max(MIN_W, Math.min(MAX_W, Math.round(w))))
    }
    const onUp = () => {
      grip.removeEventListener('pointermove', onMove)
      grip.removeEventListener('pointerup', onUp)
      setWidth((w) => {
        writePref(PREF_KEY, { width: w, collapsed: false })
        return w
      })
    }
    grip.addEventListener('pointermove', onMove)
    grip.addEventListener('pointerup', onUp)
  }

  function toggle() {
    setCollapsed(!collapsed)
    writePref(PREF_KEY, { width, collapsed: !collapsed })
  }

  if (collapsed) {
    return (
      <div className="inset collapsed">
        <button className="inset-label inset-head" title="Expand 2D pattern" onClick={toggle}>
          <span className="chev">▸</span> 2D pattern
        </button>
      </div>
    )
  }

  return <PatternInsetBody rootRef={rootRef} width={width} onGripDown={onGripDown} onToggle={toggle} />
}

function PatternInsetBody({
  rootRef,
  width,
  onGripDown,
  onToggle,
}: {
  rootRef: React.RefObject<HTMLDivElement>
  width: number
  onGripDown: (e: React.PointerEvent<HTMLDivElement>) => void
  onToggle: () => void
}) {
  const s = useAppStore()
  const { doc, selection } = s
  const display = getDisplayAngles(s)
  const hinge = selectedHinge(s)

  const { min, max } = sheetBounds(doc)
  const pad = 1
  const viewBox = `${min.x - pad} ${-(max.y + pad)} ${max.x - min.x + 2 * pad} ${max.y - min.y + 2 * pad}`

  const dark = s.theme === 'dark'
  const colors = {
    face: dark ? '#4c4433' : '#e9d9b4',
    faceSelected: dark ? '#c98a2e' : '#f6c66d',
    stroke: dark ? '#a08650' : '#8a6d3b',
    flat: dark ? '#7a705a' : '#b3a284',
  }

  return (
    <div ref={rootRef} className="inset" style={{ width }}>
      <div className="inset-grip" onPointerDown={onGripDown} title="Drag to resize" />
      <svg viewBox={viewBox} style={{ width: '100%', display: 'block' }}>
        {doc.faces.map((f) => {
          const pts = f.vertexIds
            .map((id) => {
              const p = vertexById(doc, id).pos
              return `${p.x},${-p.y}`
            })
            .join(' ')
          const selected = selection.includes(f.id)
          return (
            <polygon
              key={f.id}
              points={pts}
              fill={selected ? colors.faceSelected : colors.face}
              stroke={colors.stroke}
              strokeWidth={0.12}
              style={{ cursor: 'pointer' }}
              onClick={(e) => {
                if (e.detail >= 3) {
                  // Triple-click: the whole object (this face stays primary).
                  s.selectFaces([
                    ...doc.faces.map((x) => x.id).filter((id) => id !== f.id),
                    f.id,
                  ])
                } else if (e.detail === 2) {
                  // Double-click: the row (Shift = column), Maya-style.
                  const band = e.shiftKey ? columnFaceIds(doc, f.id) : rowFaceIds(doc, f.id)
                  s.selectFaces([...band.filter((id) => id !== f.id), f.id])
                } else {
                  s.selectFace(f.id, e.ctrlKey || e.metaKey)
                }
              }}
            />
          )
        })}
        {doc.edges
          .filter((e) => e.kind === 'crease')
          .map((e) => {
            const a = vertexById(doc, e.v1).pos
            const b = vertexById(doc, e.v2).pos
            const ang = display[e.id] ?? 0
            const color =
              e.id === hinge
                ? '#ff9f1c'
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
                strokeWidth={e.id === hinge ? 0.22 : 0.14}
                strokeDasharray={ang > 1 || ang < -1 ? '0.5 0.3' : undefined}
              />
            )
          })}
      </svg>
      <button className="inset-label inset-head" title="Collapse 2D pattern" onClick={onToggle}>
        <span className="chev open">▸</span> 2D pattern
      </button>
    </div>
  )
}
