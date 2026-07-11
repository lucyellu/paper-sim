// Faceted-cylinder "can label": a horizontal strip of N tall panels joined by
// vertical creases. Folding every crease to the same exterior angle (360/N)
// wraps the strip into a regular N-gon prism — a smooth-looking can/tube once N
// is large. The strip's flat coords are the label's UV map (art wraps around),
// so this is really "the label" the way the user asked for it.
//
//   +--+--+--+--+ ... +--+
//   |0 |1 |2 |3 | ... |N-1|   (each | is a vertical crease; top/bottom are cuts)
//   +--+--+--+--+ ... +--+
//
// The rigid hinge engine already does everything: no curved-surface solver, the
// curve is just many small folds. Optional overlap seam flap glues the tube shut.

import type { Edge, Face, PaperDoc, Vec2, Vertex } from './document'

export interface CanDims {
  /** Number of facets around the tube. ~24 reads as a smooth cylinder. */
  facets: number
  /** Tube height (world + flat). */
  height: number
  /** Tube radius; sets the facet width so the wrap closes into a circle. */
  radius: number
  /** Add a narrow glue seam flap on the trailing edge. */
  seam?: boolean
}

export function defaultCanDims(): CanDims {
  return { facets: 24, height: 10, radius: 3, seam: true }
}

interface Builder {
  vertices: Vertex[]
  edges: Edge[]
  faces: Face[]
  vertexByKey: Map<string, number>
  edgeByKey: Map<string, number>
  nextId: number
}

function key(p: Vec2): string {
  return `${p.x.toFixed(4)},${p.y.toFixed(4)}`
}

function getVertex(b: Builder, p: Vec2): number {
  const k = key(p)
  const existing = b.vertexByKey.get(k)
  if (existing !== undefined) return existing
  const id = b.nextId++
  b.vertices.push({ id, pos: { ...p } })
  b.vertexByKey.set(k, id)
  return id
}

/** Add a rectangular panel; `creaseSides` are creases, the rest cuts. */
function addRect(
  b: Builder,
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
  creaseSides: Array<'left' | 'right' | 'top' | 'bottom'>,
): number {
  const corners: Vec2[] = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ]
  const sideNames = ['bottom', 'right', 'top', 'left'] as const
  const vids = corners.map((c) => getVertex(b, c))
  for (let i = 0; i < 4; i++) {
    const v1 = vids[i]
    const v2 = vids[(i + 1) % 4]
    const ek = v1 < v2 ? `${v1}:${v2}` : `${v2}:${v1}`
    const kind = creaseSides.includes(sideNames[i]) ? 'crease' : 'cut'
    const existing = b.edgeByKey.get(ek)
    if (existing !== undefined) {
      const e = b.edges.find((e) => e.id === existing)!
      if (kind === 'crease') e.kind = 'crease'
      continue
    }
    const id = b.nextId++
    b.edges.push({ id, v1, v2, kind })
    b.edgeByKey.set(ek, id)
  }
  const faceId = b.nextId++
  b.faces.push({ id: faceId, name, vertexIds: vids })
  return faceId
}

export function buildCan(dims: CanDims = defaultCanDims()): PaperDoc {
  const facets = Math.max(3, Math.round(dims.facets))
  const h = dims.height
  // Regular N-gon: side length so the perimeter matches a circle of `radius`.
  const w = 2 * dims.radius * Math.sin(Math.PI / facets)
  // Exterior turn per crease that folds the strip into the closed N-gon.
  const turn = 360 / facets

  const b: Builder = {
    vertices: [],
    edges: [],
    faces: [],
    vertexByKey: new Map(),
    edgeByKey: new Map(),
    nextId: 0,
  }

  let rootFaceId = -1
  for (let i = 0; i < facets; i++) {
    // Left edge of panel i (i>0) is the crease shared with panel i-1.
    const fid = addRect(b, `panel ${i}`, i * w, 0, w, h, i > 0 ? ['left'] : [])
    if (i === 0) rootFaceId = fid
  }

  // Optional glue seam: a thin flap off the last panel's right edge.
  if (dims.seam) {
    const gx = facets * w
    addRect(b, 'seam flap', gx, 0, Math.min(w * 0.6, 1.2), h, ['left'])
    const v1 = getVertex(b, { x: gx, y: 0 })
    const v2 = getVertex(b, { x: gx, y: h })
    const ek = v1 < v2 ? `${v1}:${v2}` : `${v2}:${v1}`
    const seamEdge = b.edgeByKey.get(ek)
    if (seamEdge !== undefined) b.edges.find((e) => e.id === seamEdge)!.kind = 'crease'
  }

  // Every vertical crease between panels turns by the same exterior angle.
  const targetAngles: Record<number, number> = {}
  for (const e of b.edges) {
    if (e.kind !== 'crease') continue
    const a = b.vertices.find((v) => v.id === e.v1)!.pos
    const c = b.vertices.find((v) => v.id === e.v2)!.pos
    // Vertical creases only (panel-to-panel). The seam flap crease also wraps.
    if (Math.abs(a.x - c.x) < 1e-6) targetAngles[e.id] = turn
  }

  return { vertices: b.vertices, edges: b.edges, faces: b.faces, rootFaceId, targetAngles }
}
