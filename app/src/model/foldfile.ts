// Save/load in the FOLD format (https://github.com/edemaine/fold) with
// paperSim:* extension fields. Standard FOLD fields make files readable by
// Origami Simulator / Rabbit Ear; paperSim:history is authoritative for us.
// Plain FOLD files from other tools (no paperSim:* fields) import too, as
// long as they carry faces_vertices.

import type { Edge, Face, PaperDoc, Vertex } from './document'
import type { HistoryData, Step } from './ops'
import { replay } from './ops'

export interface ObjectRotationData {
  x: number
  y: number
  z: number
}

export interface SaveFile {
  file_spec: number
  file_creator: string
  file_classes: string[]
  frame_classes: string[]
  vertices_coords: [number, number][]
  edges_vertices: [number, number][]
  edges_assignment: string[]
  edges_foldAngle: number[]
  faces_vertices: number[][]
  'paperSim:format': number
  'paperSim:rootFace': number
  'paperSim:faceNames': string[]
  'paperSim:ids': { vertices: number[]; edges: number[]; faces: number[] }
  'paperSim:targetAngles'?: Record<number, number>
  'paperSim:steps': Step[]
  'paperSim:history': HistoryData
  'paperSim:objectRotation'?: ObjectRotationData
}

export function toFoldFile(
  doc: PaperDoc,
  angles: Record<number, number>,
  steps: Step[],
  history: HistoryData,
  objectRotation?: ObjectRotationData,
): SaveFile {
  const vIndex = new Map<number, number>()
  doc.vertices.forEach((v, i) => vIndex.set(v.id, i))
  const fIndex = new Map<number, number>()
  doc.faces.forEach((f, i) => fIndex.set(f.id, i))

  const assignment = (e: Edge): string => {
    if (e.kind === 'cut') return 'B'
    const a = angles[e.id] ?? 0
    if (a > 0.5) return 'V'
    if (a < -0.5) return 'M'
    return 'F'
  }

  return {
    file_spec: 1.1,
    file_creator: 'PaperSim v1',
    file_classes: ['singleModel'],
    frame_classes: ['creasePattern'],
    vertices_coords: doc.vertices.map((v) => [v.pos.x, v.pos.y]),
    edges_vertices: doc.edges.map((e) => [vIndex.get(e.v1)!, vIndex.get(e.v2)!]),
    edges_assignment: doc.edges.map(assignment),
    edges_foldAngle: doc.edges.map((e) => (e.kind === 'crease' ? (angles[e.id] ?? 0) : 0)),
    faces_vertices: doc.faces.map((f) => f.vertexIds.map((id) => vIndex.get(id)!)),
    'paperSim:format': 1,
    'paperSim:rootFace': doc.rootFaceId,
    'paperSim:faceNames': doc.faces.map((f) => f.name),
    'paperSim:ids': {
      vertices: doc.vertices.map((v) => v.id),
      edges: doc.edges.map((e) => e.id),
      faces: doc.faces.map((f) => f.id),
    },
    'paperSim:targetAngles': doc.targetAngles,
    'paperSim:steps': steps,
    'paperSim:history': history,
    'paperSim:objectRotation': objectRotation,
  }
}

export interface LoadedFile {
  doc: PaperDoc
  /** The dieline as of the history base (see store.baseDoc). */
  baseDoc: PaperDoc
  history: HistoryData
  angles: Record<number, number>
  steps: Step[]
  objectRotation: ObjectRotationData
}

export function fromFoldFile(json: unknown): LoadedFile {
  const f = json as Partial<SaveFile>
  if (!Array.isArray(f.vertices_coords) || !Array.isArray(f.edges_vertices)) {
    throw new Error('Not a FOLD file (vertices_coords / edges_vertices missing)')
  }
  if (!Array.isArray(f.faces_vertices) || f.faces_vertices.length === 0) {
    throw new Error(
      'This FOLD file has no faces_vertices — PaperSim needs faces to build panels.',
    )
  }
  return f['paperSim:format'] === 1 ? fromPaperSimFile(f as SaveFile) : fromForeignFold(f)
}

function fromPaperSimFile(f: SaveFile): LoadedFile {
  const ids = f['paperSim:ids']
  const names = f['paperSim:faceNames'] ?? []

  const vertices: Vertex[] = f.vertices_coords.map((c, i) => ({
    id: ids.vertices[i],
    pos: { x: c[0], y: c[1] },
  }))
  const edges: Edge[] = f.edges_vertices.map((ev, i) => ({
    id: ids.edges[i],
    v1: ids.vertices[ev[0]],
    v2: ids.vertices[ev[1]],
    kind: f.edges_assignment[i] === 'B' ? 'cut' : 'crease',
  }))
  const faces: Face[] = f.faces_vertices.map((fv, i) => ({
    id: ids.faces[i],
    name: names[i] ?? `panel ${i}`,
    vertexIds: fv.map((vi) => ids.vertices[vi]),
  }))
  const doc: PaperDoc = {
    vertices,
    edges,
    faces,
    rootFaceId: f['paperSim:rootFace'],
    targetAngles: f['paperSim:targetAngles'],
  }

  const history = f['paperSim:history']
  const state = replay(history)
  // The stored FOLD fields describe the doc at the history cursor; the base
  // doc (before op 0) is the first setDoc op's `prev`, or the same doc if the
  // dieline was never edited.
  const firstSetDoc = history.log.find((op) => op.type === 'setDoc')
  const baseDoc = firstSetDoc && firstSetDoc.type === 'setDoc' ? firstSetDoc.prev : doc
  return {
    doc: state.doc ?? doc,
    baseDoc,
    history,
    angles: state.angles,
    steps: state.steps,
    objectRotation: f['paperSim:objectRotation'] ?? { x: 0, y: 0, z: 0 },
  }
}

/** Import a FOLD file made by another tool (Origami Simulator, Rabbit Ear…). */
function fromForeignFold(f: Partial<SaveFile>): LoadedFile {
  const vertices: Vertex[] = f.vertices_coords!.map((c, i) => ({
    id: i,
    // Some tools write 3D coords; keep x/y (flat crease patterns).
    pos: { x: c[0], y: c[1] },
  }))
  const nV = vertices.length
  const assignment = f.edges_assignment ?? []
  const edges: Edge[] = f.edges_vertices!.map((ev, i) => ({
    id: nV + i,
    v1: ev[0],
    v2: ev[1],
    // 'B' = boundary/cut; M/V/F/U all fold-capable -> crease.
    kind: (assignment[i] ?? 'U') === 'B' ? 'cut' : 'crease',
  }))
  const nE = edges.length
  const faces: Face[] = f.faces_vertices!.map((fv, i) => ({
    id: nV + nE + i,
    name: `panel ${i + 1}`,
    vertexIds: fv,
  }))

  // Root: the largest face (stable anchor for the panel tree).
  let rootFaceId = faces[0].id
  let best = -Infinity
  for (const face of faces) {
    let area = 0
    const pts = face.vertexIds.map((vi) => vertices[vi].pos)
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]
      const q = pts[(i + 1) % pts.length]
      area += p.x * q.y - q.x * p.y
    }
    if (Math.abs(area) > best) {
      best = Math.abs(area)
      rootFaceId = face.id
    }
  }

  // Authored fold angles (if present) become target angles.
  const targetAngles: Record<number, number> = {}
  const foldAngles = f.edges_foldAngle ?? []
  edges.forEach((e, i) => {
    const a = foldAngles[i]
    if (e.kind === 'crease' && typeof a === 'number' && a !== 0) {
      targetAngles[e.id] = Math.max(-179, Math.min(179, a))
    }
  })

  const doc: PaperDoc = {
    vertices,
    edges,
    faces,
    rootFaceId,
    targetAngles: Object.keys(targetAngles).length > 0 ? targetAngles : undefined,
  }
  return {
    doc,
    baseDoc: doc,
    history: { base: { angles: {}, steps: [] }, log: [], cursor: 0 },
    angles: {},
    steps: [],
    objectRotation: { x: 0, y: 0, z: 0 },
  }
}
