// Save/load in the FOLD format (https://github.com/edemaine/fold) with
// paperSim:* extension fields. Standard FOLD fields make files readable by
// Origami Simulator / Rabbit Ear; paperSim:history is authoritative for us.

import type { Edge, Face, PaperDoc, Vertex } from './document'
import type { HistoryData, Step } from './ops'
import { replay } from './ops'

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
}

export function toFoldFile(
  doc: PaperDoc,
  angles: Record<number, number>,
  steps: Step[],
  history: HistoryData,
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
    file_creator: 'PaperSim v0',
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
  }
}

export interface LoadedFile {
  doc: PaperDoc
  history: HistoryData
  angles: Record<number, number>
  steps: Step[]
}

export function fromFoldFile(json: unknown): LoadedFile {
  const f = json as SaveFile
  if (f['paperSim:format'] !== 1) {
    throw new Error('Not a PaperSim file (paperSim:format missing or unsupported)')
  }
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
  return { doc, history, angles: state.angles, steps: state.steps }
}
