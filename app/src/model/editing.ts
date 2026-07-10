// Pure dieline-editing operations for the pattern editor. Every function
// takes a PaperDoc and returns a NEW doc (docs are immutable snapshots in the
// history), or a string error message describing why the edit is invalid.

import type { Edge, EdgeKind, Face, PaperDoc, Vec2 } from './document'

export type Anchor =
  | { kind: 'vertex'; vertexId: number }
  | { kind: 'edge'; edgeId: number; t: number }

export type EditResult = { doc: PaperDoc } | { error: string }

function nextId(doc: PaperDoc): number {
  let max = -1
  for (const v of doc.vertices) max = Math.max(max, v.id)
  for (const e of doc.edges) max = Math.max(max, e.id)
  for (const f of doc.faces) max = Math.max(max, f.id)
  return max + 1
}

function cloneDoc(doc: PaperDoc): PaperDoc {
  return {
    vertices: doc.vertices.map((v) => ({ id: v.id, pos: { ...v.pos } })),
    edges: doc.edges.map((e) => ({ ...e })),
    faces: doc.faces.map((f) => ({ ...f, vertexIds: [...f.vertexIds] })),
    rootFaceId: doc.rootFaceId,
    targetAngles: doc.targetAngles ? { ...doc.targetAngles } : undefined,
  }
}

function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

/**
 * Split an edge at parameter t (0..1 from v1). Mutates the given (cloned)
 * doc in place; returns the new vertex id. Faces containing the edge get the
 * vertex inserted into their loops.
 */
function splitEdgeInPlace(doc: PaperDoc, edgeId: number, t: number): number {
  const e = doc.edges.find((e) => e.id === edgeId)!
  const p1 = doc.vertices.find((v) => v.id === e.v1)!.pos
  const p2 = doc.vertices.find((v) => v.id === e.v2)!.pos
  let id = nextId(doc)
  const newVertexId = id++
  doc.vertices.push({ id: newVertexId, pos: lerp(p1, p2, t) })
  const e1: Edge = { id: id++, v1: e.v1, v2: newVertexId, kind: e.kind }
  const e2: Edge = { id: id++, v1: newVertexId, v2: e.v2, kind: e.kind }
  doc.edges = doc.edges.filter((x) => x.id !== edgeId)
  doc.edges.push(e1, e2)
  if (doc.targetAngles && doc.targetAngles[edgeId] !== undefined) {
    // A split hinge keeps its authored target on both halves.
    doc.targetAngles[e1.id] = doc.targetAngles[edgeId]
    doc.targetAngles[e2.id] = doc.targetAngles[edgeId]
    delete doc.targetAngles[edgeId]
  }
  for (const f of doc.faces) {
    const n = f.vertexIds.length
    for (let i = 0; i < n; i++) {
      const a = f.vertexIds[i]
      const b = f.vertexIds[(i + 1) % n]
      if ((a === e.v1 && b === e.v2) || (a === e.v2 && b === e.v1)) {
        f.vertexIds.splice(i + 1, 0, newVertexId)
        break
      }
    }
  }
  return newVertexId
}

/** Public single-edge split (e.g. to create a snap point). */
export function splitEdge(doc: PaperDoc, edgeId: number, t: number): EditResult {
  if (!doc.edges.some((e) => e.id === edgeId)) return { error: 'edge not found' }
  const next = cloneDoc(doc)
  splitEdgeInPlace(next, edgeId, t)
  return { doc: next }
}

/**
 * Draw a segment between two anchors (vertices or points on edges) and split
 * the face they share. This is the "draw a crease/cut" tool.
 */
export function addSegment(
  doc: PaperDoc,
  a: Anchor,
  b: Anchor,
  kind: EdgeKind,
  targetAngle?: number,
): EditResult {
  const next = cloneDoc(doc)

  // Materialize anchors into vertex ids. If both anchors sit on the SAME
  // edge, the first split invalidates the second anchor's edge id — remap it.
  let va: number
  let vb: number
  if (a.kind === 'vertex') {
    va = a.vertexId
  } else {
    va = splitEdgeInPlace(next, a.edgeId, a.t)
  }
  if (b.kind === 'vertex') {
    vb = b.vertexId
  } else if (a.kind === 'edge' && b.edgeId === a.edgeId) {
    return { error: 'both points are on the same edge — nothing to split' }
  } else {
    vb = splitEdgeInPlace(next, b.edgeId, b.t)
  }
  if (va === vb) return { error: 'start and end are the same point' }

  const pa = next.vertices.find((v) => v.id === va)!.pos
  const pb = next.vertices.find((v) => v.id === vb)!.pos
  const mid = lerp(pa, pb, 0.5)

  // Find the face whose boundary contains both vertices with the segment
  // interior inside it.
  let face: Face | null = null
  let ia = -1
  let ib = -1
  for (const f of next.faces) {
    const i1 = f.vertexIds.indexOf(va)
    const i2 = f.vertexIds.indexOf(vb)
    if (i1 < 0 || i2 < 0) continue
    const n = f.vertexIds.length
    if ((i1 + 1) % n === i2 || (i2 + 1) % n === i1) {
      return { error: 'an edge already exists between these points' }
    }
    const poly = f.vertexIds.map((vid) => next.vertices.find((v) => v.id === vid)!.pos)
    if (!pointInPolygon(mid, poly)) continue
    face = f
    ia = i1
    ib = i2
    break
  }
  if (!face) {
    return { error: 'both points must lie on the boundary of the same panel' }
  }

  let id = nextId(next)
  next.edges.push({ id: id++, v1: va, v2: vb, kind })
  if (kind === 'crease' && targetAngle !== undefined) {
    next.targetAngles = next.targetAngles ?? {}
    next.targetAngles[id - 1] = targetAngle
  }

  // Split the loop into two chains: va..vb and vb..va (inclusive ends).
  const loop = face.vertexIds
  const n = loop.length
  const chain = (from: number, to: number): number[] => {
    const out: number[] = []
    for (let i = from; ; i = (i + 1) % n) {
      out.push(loop[i])
      if (i === to) break
    }
    return out
  }
  const loopA = chain(ia, ib) // keeps the original face id/name
  const loopB = chain(ib, ia)
  face.vertexIds = loopA
  next.faces.push({ id: id++, name: `${face.name} ✂`, vertexIds: loopB })

  return { doc: next }
}

/**
 * Delete an edge. A crease shared by two faces merges them back into one
 * panel; anything else is structural (boundary) and can't be deleted.
 */
export function removeEdge(doc: PaperDoc, edgeId: number): EditResult {
  const e = doc.edges.find((x) => x.id === edgeId)
  if (!e) return { error: 'edge not found' }

  const containing = doc.faces.filter((f) => {
    const n = f.vertexIds.length
    for (let i = 0; i < n; i++) {
      const a = f.vertexIds[i]
      const b = f.vertexIds[(i + 1) % n]
      if ((a === e.v1 && b === e.v2) || (a === e.v2 && b === e.v1)) return true
    }
    return false
  })
  if (containing.length !== 2) {
    return { error: 'only lines between two panels can be deleted (this is a boundary)' }
  }

  const next = cloneDoc(doc)
  const [fa, fb] = containing.map((f) => next.faces.find((x) => x.id === f.id)!)

  // Orient: fa traverses va -> vb; fb traverses vb -> va (consistent winding).
  const findDirected = (f: Face, v1: number, v2: number): number => {
    const n = f.vertexIds.length
    for (let i = 0; i < n; i++) {
      if (f.vertexIds[i] === v1 && f.vertexIds[(i + 1) % n] === v2) return i
    }
    return -1
  }
  let first = fa
  let second = fb
  let i = findDirected(fa, e.v1, e.v2)
  let va = e.v1
  let vb = e.v2
  if (i < 0) {
    i = findDirected(fa, e.v2, e.v1)
    va = e.v2
    vb = e.v1
  }
  if (i < 0) return { error: 'inconsistent face winding' }
  const j = findDirected(second, vb, va)
  if (j < 0) return { error: 'inconsistent face winding' }

  // first: [... va, vb ...] rotated to start at vb; second rotated to start
  // at va. Merged = first-rotated + second-rotated minus the joint vertices.
  const rot = (f: Face, start: number): number[] => [
    ...f.vertexIds.slice(start),
    ...f.vertexIds.slice(0, start),
  ]
  const la = rot(first, (i + 1) % first.vertexIds.length) // [vb ... va]
  const lb = rot(second, (j + 1) % second.vertexIds.length) // [va ... vb]
  const merged = [...la, ...lb.slice(1, -1)]

  first.vertexIds = merged
  next.faces = next.faces.filter((f) => f.id !== second.id)
  next.edges = next.edges.filter((x) => x.id !== edgeId)
  if (next.targetAngles) delete next.targetAngles[edgeId]
  if (next.rootFaceId === second.id) next.rootFaceId = first.id

  // Drop orphaned vertices (no edge references them).
  const used = new Set<number>()
  for (const edge of next.edges) {
    used.add(edge.v1)
    used.add(edge.v2)
  }
  next.vertices = next.vertices.filter((v) => used.has(v.id))
  for (const f of next.faces) f.vertexIds = f.vertexIds.filter((vid) => used.has(vid))

  return { doc: next }
}

/** Change a line's type (cut <-> crease). */
export function setEdgeKind(doc: PaperDoc, edgeId: number, kind: EdgeKind): EditResult {
  const e = doc.edges.find((x) => x.id === edgeId)
  if (!e) return { error: 'edge not found' }
  if (e.kind === kind) return { doc }
  const next = cloneDoc(doc)
  next.edges.find((x) => x.id === edgeId)!.kind = kind
  if (kind === 'cut' && next.targetAngles) delete next.targetAngles[edgeId]
  return { doc: next }
}

/** Move a vertex (drag in the editor). */
export function moveVertex(doc: PaperDoc, vertexId: number, pos: Vec2): EditResult {
  const v = doc.vertices.find((x) => x.id === vertexId)
  if (!v) return { error: 'vertex not found' }
  const next = cloneDoc(doc)
  next.vertices.find((x) => x.id === vertexId)!.pos = { ...pos }
  return { doc: next }
}

/** Set/clear the authored target angle of a crease. */
export function setTargetAngle(
  doc: PaperDoc,
  edgeId: number,
  angle: number | undefined,
): EditResult {
  const next = cloneDoc(doc)
  next.targetAngles = next.targetAngles ?? {}
  if (angle === undefined) delete next.targetAngles[edgeId]
  else next.targetAngles[edgeId] = Math.max(-179, Math.min(179, angle))
  return { doc: next }
}

/** Nearest edge to a point within `tolerance` (for click-selecting lines). */
export function nearestEdge(doc: PaperDoc, p: Vec2, tolerance: number): number | null {
  let best: { id: number; d: number } | null = null
  for (const e of doc.edges) {
    const a = doc.vertices.find((v) => v.id === e.v1)!.pos
    const b = doc.vertices.find((v) => v.id === e.v2)!.pos
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    if (len2 === 0) continue
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
    const q = lerp(a, b, t)
    const d = Math.hypot(q.x - p.x, q.y - p.y)
    if (d <= tolerance && (!best || d < best.d)) best = { id: e.id, d }
  }
  return best?.id ?? null
}

/** Snap a point to the dieline: a vertex if close, else a point on an edge. */
export function snapPoint(
  doc: PaperDoc,
  p: Vec2,
  tolerance: number,
): { anchor: Anchor; pos: Vec2 } | null {
  let bestV: { id: number; pos: Vec2; d: number } | null = null
  for (const v of doc.vertices) {
    const d = Math.hypot(v.pos.x - p.x, v.pos.y - p.y)
    if (d <= tolerance && (!bestV || d < bestV.d)) bestV = { id: v.id, pos: v.pos, d }
  }
  if (bestV) return { anchor: { kind: 'vertex', vertexId: bestV.id }, pos: bestV.pos }

  let bestE: { id: number; t: number; pos: Vec2; d: number } | null = null
  for (const e of doc.edges) {
    const a = doc.vertices.find((v) => v.id === e.v1)!.pos
    const b = doc.vertices.find((v) => v.id === e.v2)!.pos
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    if (len2 === 0) continue
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
    t = Math.max(0.02, Math.min(0.98, t))
    const q = lerp(a, b, t)
    const d = Math.hypot(q.x - p.x, q.y - p.y)
    if (d <= tolerance && (!bestE || d < bestE.d)) bestE = { id: e.id, t, pos: q, d }
  }
  if (bestE) {
    return { anchor: { kind: 'edge', edgeId: bestE.id, t: bestE.t }, pos: bestE.pos }
  }
  return null
}
