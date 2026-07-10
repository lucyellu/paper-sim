// Forward-kinematics folding: each panel's transform is its parent's
// transform composed with a rotation about the shared crease line. All math
// happens in the "flat frame" (sheet in the xy-plane, +z = fold up); the
// viewer rotates the whole model into y-up world space.

import * as THREE from 'three'
import type { PanelTree, PaperDoc } from './document'

export type AngleMap = Record<number, number> // hinge edge id -> radians

/** Compute a flat-frame matrix for every face. */
export function computeFaceMatrices(
  doc: PaperDoc,
  tree: PanelTree,
  angles: AngleMap,
): Map<number, THREE.Matrix4> {
  const matrices = new Map<number, THREE.Matrix4>()
  const rot = new THREE.Matrix4()
  const toOrigin = new THREE.Matrix4()
  const fromOrigin = new THREE.Matrix4()
  const axis = new THREE.Vector3()

  for (const fid of tree.order) {
    const node = tree.nodes.get(fid)!
    if (node.parentFaceId === null) {
      matrices.set(fid, new THREE.Matrix4())
      continue
    }
    const parent = matrices.get(node.parentFaceId)!
    const a = node.axisA!
    const bp = node.axisB!
    const theta = angles[node.hingeEdgeId!] ?? 0
    axis.set(bp.x - a.x, bp.y - a.y, 0).normalize()
    rot.makeRotationAxis(axis, theta)
    toOrigin.makeTranslation(-a.x, -a.y, 0)
    fromOrigin.makeTranslation(a.x, a.y, 0)
    // local = T(a) * R * T(-a); world = parent * local
    const m = new THREE.Matrix4()
      .multiply(parent)
      .multiply(fromOrigin)
      .multiply(rot)
      .multiply(toOrigin)
    matrices.set(fid, m)
  }
  return matrices
}

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180
}

export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI
}
