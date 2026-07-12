// Rectangular sleeve: an open-ended band that slips over a real product (a
// juice box, a milk carton…) the way a phone case wraps a phone — the
// "expression layer" of the product vision. Four panels joined by vertical
// 90° creases (W·D·W·D) plus a glue seam; no top or bottom. Print true-scale,
// fold, glue (or laminate), slide it over the real thing.
//
//   +----+--+----+--+-+
//   | W  |D | W  |D |g|   (| = vertical crease folding 90°; top/bottom cuts)
//   +----+--+----+--+-+

import type { Edge, Face, PaperDoc, Vec2, Vertex } from './document'

export interface SleeveDims {
  /** Front/back panel width — the product's width plus slip clearance. */
  width: number
  /** Side panel width — the product's depth plus slip clearance. */
  depth: number
  /** Band height (usually shorter than the product so the top shows). */
  height: number
  /** Add a narrow glue seam flap on the trailing edge. */
  seam?: boolean
}

/** Fits a 200 ml juice box (≈5.2 × 4.0 cm footprint) with slip clearance. */
export function defaultSleeveDims(): SleeveDims {
  return { width: 5.5, depth: 4.3, height: 7, seam: true }
}

export function buildSleeve(dims: SleeveDims = defaultSleeveDims()): PaperDoc {
  const { width, depth, height } = dims
  const vertices: Vertex[] = []
  const edges: Edge[] = []
  const faces: Face[] = []
  const vertexByKey = new Map<string, number>()
  const edgeByKey = new Map<string, number>()
  let nextId = 0

  const getVertex = (p: Vec2): number => {
    const k = `${p.x.toFixed(4)},${p.y.toFixed(4)}`
    const existing = vertexByKey.get(k)
    if (existing !== undefined) return existing
    const id = nextId++
    vertices.push({ id, pos: { ...p } })
    vertexByKey.set(k, id)
    return id
  }

  const addPanel = (name: string, x: number, w: number, creaseLeft: boolean): number => {
    const corners: Vec2[] = [
      { x, y: 0 },
      { x: x + w, y: 0 },
      { x: x + w, y: height },
      { x, y: height },
    ]
    const vids = corners.map(getVertex)
    for (let i = 0; i < 4; i++) {
      const v1 = vids[i]
      const v2 = vids[(i + 1) % 4]
      const ek = v1 < v2 ? `${v1}:${v2}` : `${v2}:${v1}`
      const kind = i === 3 && creaseLeft ? 'crease' : 'cut'
      const existing = edgeByKey.get(ek)
      if (existing !== undefined) {
        if (kind === 'crease') edges.find((e) => e.id === existing)!.kind = 'crease'
        continue
      }
      const id = nextId++
      edges.push({ id, v1, v2, kind })
      edgeByKey.set(ek, id)
    }
    const faceId = nextId++
    faces.push({ id: faceId, name, vertexIds: vids })
    return faceId
  }

  const names = ['front panel', 'side panel', 'back panel', 'side panel 2']
  const widths = [width, depth, width, depth]
  let x = 0
  let rootFaceId = -1
  for (let i = 0; i < 4; i++) {
    const fid = addPanel(names[i], x, widths[i], i > 0)
    if (i === 0) rootFaceId = fid
    x += widths[i]
  }
  if (dims.seam ?? true) addPanel('seam flap', x, Math.min(depth * 0.35, 1.2), true)

  // A rectangular tube: every vertical crease turns the band by 90°.
  const targetAngles: Record<number, number> = {}
  for (const e of edges) {
    if (e.kind !== 'crease') continue
    const a = vertices.find((v) => v.id === e.v1)!.pos
    const b = vertices.find((v) => v.id === e.v2)!.pos
    if (Math.abs(a.x - b.x) < 1e-6) targetAngles[e.id] = 90
  }

  return { vertices, edges, faces, rootFaceId, targetAngles }
}
