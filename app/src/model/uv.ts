// Per-face UV adjustments: a minimal UV editor. Each face's texture
// coordinates can be shifted / rotated / scaled relative to its dieline
// position, so artwork that doesn't quite line up with the panels can be
// nudged into place per panel. Identity = UVs locked to the dieline flat
// coords (the default). Print exports stay truthful: buildPrintCanvas
// (viewer/texture.ts) inverse-warps the artwork per edited face so the
// printed dieline shows exactly what the 3D preview shows.

import { sheetBounds, vertexById, type Face, type PaperDoc } from './document'

/**
 * One face's UV adjustment, applied about the face's own base-UV centroid c:
 *   uv' = R(rotationDeg) · S(scaleU, scaleV) · (uv − c) + c + (du, dv)
 * Units: du/dv are fractions of the sheet bounds (same convention as
 * OverlayTransform offsets); positive rotation turns the island clockwise on
 * screen (matching the Texture tool); scale 1 = dieline size.
 */
export interface FaceUV {
  du: number
  dv: number
  rotationDeg: number
  scaleU: number
  scaleV: number
}

/** faceId -> adjustment. Faces without an entry are locked to the dieline. */
export type UVEdits = Record<number, FaceUV>

export function identityFaceUV(): FaceUV {
  return { du: 0, dv: 0, rotationDeg: 0, scaleU: 1, scaleV: 1 }
}

const EPS = 1e-6

export function isIdentityFaceUV(t: FaceUV): boolean {
  return (
    Math.abs(t.du) < EPS &&
    Math.abs(t.dv) < EPS &&
    Math.abs(t.rotationDeg) < EPS &&
    Math.abs(t.scaleU - 1) < EPS &&
    Math.abs(t.scaleV - 1) < EPS
  )
}

/** True when any face actually diverges from the dieline. */
export function hasUVEdits(edits: UVEdits | undefined): boolean {
  if (!edits) return false
  return Object.values(edits).some((t) => !isIdentityFaceUV(t))
}

/** Drop identity entries so the map (and the save file) stays lean. */
export function pruneUVEdits(edits: UVEdits): UVEdits {
  const out: UVEdits = {}
  for (const [id, t] of Object.entries(edits)) {
    if (!isIdentityFaceUV(t)) out[Number(id)] = t
  }
  return out
}

export function sanitizeUVEdits(raw: unknown): UVEdits {
  if (typeof raw !== 'object' || raw === null) return {}
  const num = (v: unknown, fb: number) => (Number.isFinite(v) ? (v as number) : fb)
  const out: UVEdits = {}
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const id = Number(key)
    if (!Number.isFinite(id) || typeof val !== 'object' || val === null) continue
    const t = val as Partial<FaceUV>
    const clean: FaceUV = {
      du: num(t.du, 0),
      dv: num(t.dv, 0),
      rotationDeg: num(t.rotationDeg, 0),
      scaleU: num(t.scaleU, 1),
      scaleV: num(t.scaleV, 1),
    }
    if (!isIdentityFaceUV(clean)) out[id] = clean
  }
  return out
}

/** A face's centroid in normalized UV space (flat coords over sheet bounds). */
export function faceUVCentroid(doc: PaperDoc, face: Face): { u: number; v: number } {
  const { min, max } = sheetBounds(doc)
  const w = Math.max(max.x - min.x, 0.001)
  const h = Math.max(max.y - min.y, 0.001)
  let u = 0
  let v = 0
  for (const vid of face.vertexIds) {
    const p = vertexById(doc, vid).pos
    u += (p.x - min.x) / w
    v += (p.y - min.y) / h
  }
  return { u: u / face.vertexIds.length, v: v / face.vertexIds.length }
}

/**
 * 2D affine map in canvas convention: x' = a·x + c·y + e, y' = b·x + d·y + f
 * (directly usable with ctx.setTransform(a, b, c, d, e, f)).
 */
export interface Affine {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

/** The FaceUV as an affine map base-UV -> edited-UV (uv space, v grows up). */
export function faceUVAffine(t: FaceUV, c: { u: number; v: number }): Affine {
  // Clockwise-on-screen rotation in a v-up frame: R = [[cos, sin], [-sin, cos]].
  const rad = (t.rotationDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const a = t.scaleU * cos
  const b = -t.scaleU * sin
  const cc = t.scaleV * sin
  const d = t.scaleV * cos
  return {
    a,
    b,
    c: cc,
    d,
    e: c.u + t.du - (a * c.u + cc * c.v),
    f: c.v + t.dv - (b * c.u + d * c.v),
  }
}

export function applyAffine(m: Affine, x: number, y: number): [number, number] {
  return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]
}

/** Compose two maps: the result applies m1 first, then m2. */
export function composeAffine(m2: Affine, m1: Affine): Affine {
  return {
    a: m2.a * m1.a + m2.c * m1.b,
    b: m2.b * m1.a + m2.d * m1.b,
    c: m2.a * m1.c + m2.c * m1.d,
    d: m2.b * m1.c + m2.d * m1.d,
    e: m2.a * m1.e + m2.c * m1.f + m2.e,
    f: m2.b * m1.e + m2.d * m1.f + m2.f,
  }
}

export function invertAffine(m: Affine): Affine {
  const det = m.a * m.d - m.b * m.c || 1e-12
  const a = m.d / det
  const b = -m.b / det
  const c = -m.c / det
  const d = m.a / det
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) }
}

/** Transform one base UV through a face's adjustment. */
export function applyFaceUV(
  t: FaceUV,
  c: { u: number; v: number },
  u: number,
  v: number,
): [number, number] {
  return applyAffine(faceUVAffine(t, c), u, v)
}
