// Derive per-hinge target fold angles from a known 3D "goal pose": given a
// target position for every dieline vertex (each face placed rigidly), the
// dihedral angle across each hinge — measured with the same axis/sign
// convention as the FK in fold.ts — is the angle that reproduces the pose.

import * as THREE from 'three'
import { edgeById, faceById, vertexById, type PanelTree, type PaperDoc } from './document'

export type TargetPositions = Map<number, [number, number, number]>

export function deriveTargetAngles(
  doc: PaperDoc,
  tree: PanelTree,
  target3: TargetPositions,
): Record<number, number> {
  const out: Record<number, number> = {}
  const pos = (vid: number) => {
    const t = target3.get(vid)
    if (!t) throw new Error(`no target position for vertex ${vid}`)
    return new THREE.Vector3(t[0], t[1], t[2])
  }
  // Newell's method over the target-positioned polygon; the flat winding is
  // CCW (+z normal), so the target normal is the face's rotated +z side.
  const normal = (faceId: number) => {
    const f = faceById(doc, faceId)
    const pts = f.vertexIds.map(pos)
    const n = new THREE.Vector3()
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]
      const q = pts[(i + 1) % pts.length]
      n.x += (p.y - q.y) * (p.z + q.z)
      n.y += (p.z - q.z) * (p.x + q.x)
      n.z += (p.x - q.x) * (p.y + q.y)
    }
    return n.normalize()
  }
  for (const node of tree.nodes.values()) {
    if (node.hingeEdgeId === null) continue
    const e = edgeById(doc, node.hingeEdgeId)
    // Orient the edge's vertices to match the node's axisA -> axisB direction.
    const p1 = vertexById(doc, e.v1).pos
    const sameDir =
      Math.abs(p1.x - node.axisA!.x) < 1e-6 && Math.abs(p1.y - node.axisA!.y) < 1e-6
    const [va, vb] = sameDir ? [e.v1, e.v2] : [e.v2, e.v1]
    const u = pos(vb).sub(pos(va)).normalize()
    const np = normal(node.parentFaceId!)
    const nc = normal(node.faceId)
    const rad = Math.atan2(u.dot(new THREE.Vector3().crossVectors(np, nc)), np.dot(nc))
    const deg = (rad * 180) / Math.PI
    // The UI clamps fold angles to ±179.
    out[node.hingeEdgeId] = Math.max(-179, Math.min(179, Math.round(deg * 10) / 10))
  }
  return out
}
