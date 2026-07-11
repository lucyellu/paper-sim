import { columnFaceIds, rowFaceIds, sheetBounds, vertexById } from '../model/document'
import { getDisplayAngles, selectedHinge, useAppStore } from '../state/store'

/** 2D dieline inset (bottom-left), mirroring PackCAD's pattern view. */
export function PatternInset() {
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
    <div className="inset">
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
      <div className="inset-label">2D pattern</div>
    </div>
  )
}
