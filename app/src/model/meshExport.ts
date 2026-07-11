// Bake the folded (or flat) paper model into a plain 3D mesh for export.
// Each panel becomes a single-sided n-gon polygon: we take its flat polygon,
// push it through the fold forward-kinematics + the sheet->world (y-up)
// rotation the viewer uses, then recenter the whole thing on the origin and
// rest it on the ground (matching the viewport's auto-centering pivot). The
// object's viewport placement (user translate/rotate/scale) is intentionally
// NOT baked, so exports always land centered and upright in Maya/Blender/Roblox.

import * as THREE from 'three'
import { sheetBounds, vertexById, type PaperDoc, type PanelTree } from './document'
import { computeFaceMatrices, degToRad } from './fold'

export type MeshPose = 'folded' | 'flat'

export interface BakedMesh {
  /** Per polygon-vertex positions, flat [x,y,z, ...] (control points). */
  positions: number[]
  /** Per polygon-vertex UVs, flat [u,v, ...] (normalized flat coords). */
  uvs: number[]
  /** Per polygon-vertex normals, flat [x,y,z, ...]. */
  normals: number[]
  /** Each panel as a list of control-point indices (an n-gon). */
  polygons: number[][]
  /** Fan-triangulated indices, flat [a,b,c, ...] (for GLB / triangle formats). */
  triangles: number[]
}

function radAngles(deg: Record<number, number>): Record<number, number> {
  const out: Record<number, number> = {}
  for (const k of Object.keys(deg)) out[Number(k)] = degToRad(deg[Number(k)])
  return out
}

/** Newell's method: a stable polygon normal even for slightly non-planar faces. */
function polygonNormal(pts: THREE.Vector3[]): THREE.Vector3 {
  const n = new THREE.Vector3()
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    n.x += (a.y - b.y) * (a.z + b.z)
    n.y += (a.z - b.z) * (a.x + b.x)
    n.z += (a.x - b.x) * (a.y + b.y)
  }
  if (n.lengthSq() === 0) return new THREE.Vector3(0, 1, 0)
  return n.normalize()
}

export function bakeMesh(
  doc: PaperDoc,
  tree: PanelTree,
  angles: Record<number, number>,
  pose: MeshPose,
): BakedMesh {
  const poseAngles = pose === 'flat' ? {} : angles
  const matrices = computeFaceMatrices(doc, tree, radAngles(poseAngles))
  const sheetToWorld = new THREE.Matrix4().makeRotationX(-Math.PI / 2)
  const { min, max } = sheetBounds(doc)
  const bw = Math.max(max.x - min.x, 0.001)
  const bh = Math.max(max.y - min.y, 0.001)

  // First pass: world points per face + collect bounds for recentering.
  const faces: { pts: THREE.Vector3[]; uv: Array<[number, number]> }[] = []
  const bb = new THREE.Box3()
  bb.makeEmpty()
  for (const face of doc.faces) {
    const m = matrices.get(face.id)
    if (!m) continue
    const mat = new THREE.Matrix4().multiplyMatrices(sheetToWorld, m)
    const pts: THREE.Vector3[] = []
    const uv: Array<[number, number]> = []
    for (const vid of face.vertexIds) {
      const v = vertexById(doc, vid)
      const p = new THREE.Vector3(v.pos.x, v.pos.y, 0).applyMatrix4(mat)
      pts.push(p)
      bb.expandByPoint(p)
      uv.push([(v.pos.x - min.x) / bw, (v.pos.y - min.y) / bh])
    }
    faces.push({ pts, uv })
  }

  const cx = (bb.min.x + bb.max.x) / 2
  const cz = (bb.min.z + bb.max.z) / 2
  const my = bb.min.y

  const positions: number[] = []
  const uvs: number[] = []
  const normals: number[] = []
  const polygons: number[][] = []
  const triangles: number[] = []
  let idx = 0
  for (const f of faces) {
    const n = polygonNormal(f.pts)
    const ring: number[] = []
    for (let i = 0; i < f.pts.length; i++) {
      const p = f.pts[i]
      positions.push(p.x - cx, p.y - my, p.z - cz)
      uvs.push(f.uv[i][0], f.uv[i][1])
      normals.push(n.x, n.y, n.z)
      ring.push(idx++)
    }
    polygons.push(ring)
    // Fan triangulation for triangle-only formats.
    for (let i = 1; i < ring.length - 1; i++) {
      triangles.push(ring[0], ring[i], ring[i + 1])
    }
  }
  return { positions, uvs, normals, polygons, triangles }
}
