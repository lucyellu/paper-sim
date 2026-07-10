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
