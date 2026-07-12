// Core document model: a flat sheet as a planar graph of vertices, edges
// (cuts or creases), and faces (rigid panels). Folding state is one angle per
// crease that participates in the panel tree.

export interface Vec2 {
  x: number
  y: number
}

export type EdgeKind = 'cut' | 'crease'

export interface Vertex {
  id: number
  pos: Vec2
}

export interface Edge {
  id: number
  v1: number
  v2: number
  kind: EdgeKind
}

export interface Face {
  id: number
  name: string
  /** Vertex ids, counter-clockwise in flat coordinates. */
  vertexIds: number[]
}

export interface PaperDoc {
  vertices: Vertex[]
  edges: Edge[]
  faces: Face[]
  rootFaceId: number
  /**
   * Authored fold targets, degrees, keyed by hinge edge id: the pose this
   * dieline is meant to fold into (drives the "suggested angle" UI).
   */
  targetAngles?: Record<number, number>
}

/** One node of the panel tree: how a face hangs off its parent. */
export interface TreeNode {
  faceId: number
  parentFaceId: number | null
  /** Crease edge connecting to the parent (null for root). */
  hingeEdgeId: number | null
  /**
   * Hinge axis endpoints in flat coords, oriented so the child face lies to
   * the LEFT of a->b. With that orientation a positive fold angle rotates the
   * child toward +z (a valley fold seen from +z).
   */
  axisA: Vec2 | null
  axisB: Vec2 | null
  children: number[]
}

export interface PanelTree {
  /** faceId -> node */
  nodes: Map<number, TreeNode>
  /** BFS order starting at the root, parents always before children. */
  order: number[]
  /** Crease edge ids that act as hinges (tree edges). */
  hingeEdgeIds: number[]
}

export function vertexById(doc: PaperDoc, id: number): Vertex {
  const v = doc.vertices.find((v) => v.id === id)
  if (!v) throw new Error(`vertex ${id} not found`)
  return v
}

export function faceById(doc: PaperDoc, id: number): Face {
  const f = doc.faces.find((f) => f.id === id)
  if (!f) throw new Error(`face ${id} not found`)
  return f
}

export function edgeById(doc: PaperDoc, id: number): Edge {
  const e = doc.edges.find((e) => e.id === id)
  if (!e) throw new Error(`edge ${id} not found`)
  return e
}

export function faceCentroid(doc: PaperDoc, face: Face): Vec2 {
  let x = 0
  let y = 0
  for (const vid of face.vertexIds) {
    const p = vertexById(doc, vid).pos
    x += p.x
    y += p.y
  }
  return { x: x / face.vertexIds.length, y: y / face.vertexIds.length }
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`
}

/**
 * Derive the panel tree by BFS from the root face across crease edges.
 * Crease edges shared by two faces become hinges; creases that would close a
 * cycle are ignored (dielines are trees; cycles are out of scope for v0).
 */
export function buildPanelTree(doc: PaperDoc): PanelTree {
  // Map each undirected vertex pair to its edge.
  const edgeByPair = new Map<string, Edge>()
  for (const e of doc.edges) edgeByPair.set(edgeKey(e.v1, e.v2), e)

  // For each crease edge, find the faces that share it.
  const facesByEdge = new Map<number, number[]>()
  for (const f of doc.faces) {
    const n = f.vertexIds.length
    for (let i = 0; i < n; i++) {
      const a = f.vertexIds[i]
      const b = f.vertexIds[(i + 1) % n]
      const e = edgeByPair.get(edgeKey(a, b))
      if (!e || e.kind !== 'crease') continue
      const list = facesByEdge.get(e.id) ?? []
      list.push(f.id)
      facesByEdge.set(e.id, list)
    }
  }

  const nodes = new Map<number, TreeNode>()
  const order: number[] = []
  const hingeEdgeIds: number[] = []

  nodes.set(doc.rootFaceId, {
    faceId: doc.rootFaceId,
    parentFaceId: null,
    hingeEdgeId: null,
    axisA: null,
    axisB: null,
    children: [],
  })
  const queue = [doc.rootFaceId]
  while (queue.length > 0) {
    const fid = queue.shift()!
    order.push(fid)
    for (const [edgeId, faceIds] of facesByEdge) {
      if (!faceIds.includes(fid)) continue
      const other = faceIds.find((id) => id !== fid)
      if (other === undefined || nodes.has(other)) continue
      const e = edgeById(doc, edgeId)
      let a = vertexById(doc, e.v1).pos
      let b = vertexById(doc, e.v2).pos
      // Orient a->b so the child face is on the left (cross(b-a, c-a) > 0).
      const c = faceCentroid(doc, faceById(doc, other))
      const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
      if (cross < 0) [a, b] = [b, a]
      nodes.set(other, {
        faceId: other,
        parentFaceId: fid,
        hingeEdgeId: edgeId,
        axisA: a,
        axisB: b,
        children: [],
      })
      nodes.get(fid)!.children.push(other)
      hingeEdgeIds.push(edgeId)
      queue.push(other)
    }
  }

  return { nodes, order, hingeEdgeIds }
}

function faceBBox(doc: PaperDoc, face: Face): { min: Vec2; max: Vec2 } {
  const min = { x: Infinity, y: Infinity }
  const max = { x: -Infinity, y: -Infinity }
  for (const vid of face.vertexIds) {
    const p = vertexById(doc, vid).pos
    min.x = Math.min(min.x, p.x)
    min.y = Math.min(min.y, p.y)
    max.x = Math.max(max.x, p.x)
    max.y = Math.max(max.y, p.y)
  }
  return { min, max }
}

function bandFaceIds(doc: PaperDoc, faceId: number, axis: 'x' | 'y'): number[] {
  const seed = doc.faces.find((f) => f.id === faceId)
  if (!seed) return []
  const sb = faceBBox(doc, seed)
  const lo = axis === 'y' ? sb.min.y : sb.min.x
  const hi = axis === 'y' ? sb.max.y : sb.max.x
  return doc.faces
    .filter((f) => {
      const b = faceBBox(doc, f)
      const flo = axis === 'y' ? b.min.y : b.min.x
      const fhi = axis === 'y' ? b.max.y : b.max.x
      const overlap = Math.min(hi, fhi) - Math.max(lo, flo)
      // Same band if the intervals overlap by at least a third of the
      // narrower one (tolerates slightly staggered panels).
      return overlap > Math.min(hi - lo, fhi - flo) * 0.34
    })
    .map((f) => f.id)
}

/** Faces in the same horizontal row as `faceId` (Maya-style loop select). */
export function rowFaceIds(doc: PaperDoc, faceId: number): number[] {
  return bandFaceIds(doc, faceId, 'y')
}

/** Faces in the same vertical column as `faceId`. */
export function columnFaceIds(doc: PaperDoc, faceId: number): number[] {
  return bandFaceIds(doc, faceId, 'x')
}

function edgeDir(doc: PaperDoc, e: Edge): Vec2 {
  const a = vertexById(doc, e.v1).pos
  const b = vertexById(doc, e.v2).pos
  const d = { x: b.x - a.x, y: b.y - a.y }
  const l = Math.hypot(d.x, d.y) || 1
  return { x: d.x / l, y: d.y / l }
}

function edgeMid(doc: PaperDoc, e: Edge): Vec2 {
  const a = vertexById(doc, e.v1).pos
  const b = vertexById(doc, e.v2).pos
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/**
 * The edge "ring" containing `edgeId`: edges (near-)parallel to it that share
 * its perpendicular flat-coordinate band. For a box/carton this is the loop of
 * top (or bottom) wall edges — the set you'd drag to change height. Includes
 * the seed edge. First-cut heuristic: tuned for axis-aligned box/carton rings.
 */
export function edgeRing(doc: PaperDoc, edgeId: number): number[] {
  const seed = doc.edges.find((e) => e.id === edgeId)
  if (!seed) return []
  const dir = edgeDir(doc, seed)
  const perp = { x: -dir.y, y: dir.x }
  const seedLen = Math.hypot(
    vertexById(doc, seed.v2).pos.x - vertexById(doc, seed.v1).pos.x,
    vertexById(doc, seed.v2).pos.y - vertexById(doc, seed.v1).pos.y,
  )
  const mid = edgeMid(doc, seed)
  const seedPerp = mid.x * perp.x + mid.y * perp.y
  const band = Math.max(0.5, seedLen * 0.25)
  const out: number[] = []
  for (const e of doc.edges) {
    const d = edgeDir(doc, e)
    // Parallel (either orientation): small |cross|.
    if (Math.abs(d.x * dir.y - d.y * dir.x) > 0.1) continue
    const m = edgeMid(doc, e)
    if (Math.abs(m.x * perp.x + m.y * perp.y - seedPerp) > band) continue
    out.push(e.id)
  }
  return out
}

/** Unique vertex ids used by a set of edges. */
export function edgesVertexIds(doc: PaperDoc, edgeIds: number[]): number[] {
  const set = new Set<number>()
  for (const id of edgeIds) {
    const e = doc.edges.find((x) => x.id === id)
    if (e) {
      set.add(e.v1)
      set.add(e.v2)
    }
  }
  return [...set]
}

/**
 * Vertices moved by an edge-ring reshape: the ring's own vertices PLUS every
 * vertex beyond the ring line along the reshape axis. The whole region past
 * the ring translates rigidly, so panels beyond it (e.g. a carton's gable
 * top) keep their exact shape and their derived fold targets stay valid —
 * only the band behind the ring stretches. Moving just the ring's own
 * vertices would shear the panels beyond it and the fold no longer closes.
 */
export function ringRegionVertexIds(doc: PaperDoc, edgeIds: number[]): number[] {
  const ringIds = new Set(edgesVertexIds(doc, edgeIds))
  if (ringIds.size === 0) return []
  const axis = edgesAxis(doc, edgeIds)
  const proj = (v: Vertex) => v.pos.x * axis.x + v.pos.y * axis.y
  // Ring line coordinate = the innermost axis-projection among ring vertices.
  let ringCoord = Infinity
  let min = Infinity
  let max = -Infinity
  for (const v of doc.vertices) {
    const p = proj(v)
    if (ringIds.has(v.id)) ringCoord = Math.min(ringCoord, p)
    if (p < min) min = p
    if (p > max) max = p
  }
  const eps = Math.max(1e-6, (max - min) * 1e-4)
  return doc.vertices.filter((v) => ringIds.has(v.id) || proj(v) >= ringCoord - eps).map((v) => v.id)
}

/**
 * Unit flat-space axis perpendicular to a set of (roughly parallel) edges —
 * the direction the ring moves to grow/shrink the model along it. Oriented to
 * point away from the sheet centre (so "positive" is outward).
 */
export function edgesAxis(doc: PaperDoc, edgeIds: number[]): Vec2 {
  const first = doc.edges.find((x) => x.id === edgeIds[0])
  if (!first) return { x: 0, y: 1 }
  const dir = edgeDir(doc, first)
  let perp = { x: -dir.y, y: dir.x }
  const c = sheetCentroid(doc)
  const m = edgeMid(doc, first)
  if ((m.x - c.x) * perp.x + (m.y - c.y) * perp.y < 0) perp = { x: -perp.x, y: -perp.y }
  return perp
}

function sheetCentroid(doc: PaperDoc): Vec2 {
  let x = 0
  let y = 0
  for (const v of doc.vertices) {
    x += v.pos.x
    y += v.pos.y
  }
  const n = doc.vertices.length || 1
  return { x: x / n, y: y / n }
}

/** Bounding box of the flat sheet. */
export function sheetBounds(doc: PaperDoc): { min: Vec2; max: Vec2 } {
  const min = { x: Infinity, y: Infinity }
  const max = { x: -Infinity, y: -Infinity }
  for (const v of doc.vertices) {
    min.x = Math.min(min.x, v.pos.x)
    min.y = Math.min(min.y, v.pos.y)
    max.x = Math.max(max.x, v.pos.x)
    max.y = Math.max(max.y, v.pos.y)
  }
  return { min, max }
}
