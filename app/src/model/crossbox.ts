// Parametric cross box: the cube-net layout. The front sits in the middle of
// a vertical strip — top lid and its tuck above, bottom and back below it,
// the back ending in a tab that hems inside the back wall — and the two side
// walls hang off the front's left and right edges, each with a dust flap at
// its top and bottom (tucked under the lid / above the bottom) and a flap on
// its outer edge that folds in behind the back. Target angles come from the
// sealed 3D pose, like tuck.ts.
//
//                  +--------+
//                  |  tuck  |
//                  +--------+
//                  |  lid   |
//          /dust\  +--------+  /dust\
//        +-+------+|        |+------+-+
//        |f| left || front  || right|f|
//        +-+------+|        |+------+-+
//          \dust/  +--------+  \dust/
//                  | bottom |
//                  +--------+
//                  |  back  |
//                  +--------+
//                  |  tab   |
//                  +--------+

import { buildPanelTree, type PaperDoc, type Vec2 } from './document'
import { deriveTargetAngles } from './targets'
import { addPoly, newBuilder, type P3 } from './tuck'

export interface CrossParams {
  /** Front width. */
  width: number
  /** Side width = lid / bottom depth. */
  depth: number
  /** Front / back / side height. */
  height: number
  /** Lid tuck tongue height (default 1.5 cm, capped by the body). */
  tuck?: number
  /** Back tab height (default = tuck). */
  tab?: number
  /** Side dust flap height (default 0.3 · the shorter of width / depth). */
  dust?: number
  /** Side back flap width (default 0.2 · the shorter of width / depth). */
  flap?: number
}

export function defaultCrossParams(): CrossParams {
  return { width: 6, depth: 5, height: 6 }
}

export interface ResolvedCross {
  W: number
  D: number
  H: number
  TUCK: number
  TAB: number
  DUST: number
  FLAP: number
}

export function resolveCross(p: CrossParams): ResolvedCross {
  const W = p.width
  const D = p.depth
  const H = p.height
  const TUCK = Math.min(p.tuck ?? 1.5, H * 0.4)
  return {
    W,
    D,
    H,
    TUCK,
    TAB: Math.min(p.tab ?? TUCK, H * 0.4),
    // Opposite side flaps meet in the middle at most (they come in along W).
    DUST: Math.min(p.dust ?? Math.min(W, D) * 0.3, W * 0.45),
    FLAP: Math.min(p.flap ?? Math.min(W, D) * 0.2, W * 0.45),
  }
}

/** The back tab hems inside the back, tilted this much so the fold's direction is unambiguous. */
const HEM_TILT = (2 * Math.PI) / 180

export function buildCrossBox(params: CrossParams = defaultCrossParams()): PaperDoc {
  const { W, D, H, TUCK, TAB, DUST, FLAP } = resolveCross(params)
  // Sealed pose: front at z = D/2 (printed side out, +z), box centered on x.
  // Every pose below is written in box coords (x ∈ [0, W], z ∈ [−D, 0]) and
  // shifted by `at`.
  const at = (x: number, y: number, z: number): P3 => [x - W / 2, y, z + D / 2]
  const b = newBuilder()
  const pt = (x: number, y: number, t: P3) => ({ p: { x, y } as Vec2, t })

  // Center strip.
  const front = addPoly(
    b,
    'front',
    [pt(0, 0, at(0, 0, 0)), pt(W, 0, at(W, 0, 0)), pt(W, H, at(W, H, 0)), pt(0, H, at(0, H, 0))],
    ['crease', 'crease', 'crease', 'crease'],
  )
  const lid = (x: number, y: number) => pt(x, y, at(x, H, -(y - H)))
  addPoly(b, 'top lid', [lid(0, H), lid(W, H), lid(W, H + D), lid(0, H + D)], ['crease', 'cut', 'crease', 'cut'])
  // Tuck: past the lid, hanging down inside the back. Corners chamfered.
  const c = Math.min(TUCK * 0.45, W * 0.2)
  const tk = (x: number, s: number) => pt(x, H + D + s, at(x, H - s, -D))
  addPoly(
    b,
    'top tuck',
    [tk(0, 0), tk(W, 0), tk(W, TUCK - c), tk(W - c, TUCK), tk(c, TUCK), tk(0, TUCK - c)],
    ['crease', 'cut', 'cut', 'cut', 'cut', 'cut'],
  )
  const bot = (x: number, y: number) => pt(x, y, at(x, 0, y))
  addPoly(b, 'bottom', [bot(0, -D), bot(W, -D), bot(W, 0), bot(0, 0)], ['crease', 'cut', 'crease', 'cut'])
  const back = (x: number, y: number) => pt(x, y, at(x, -D - y, -D))
  addPoly(b, 'back', [back(0, -D - H), back(W, -D - H), back(W, -D), back(0, -D)], ['crease', 'cut', 'crease', 'cut'])
  const tb = (x: number, s: number) =>
    pt(x, -D - H - s, at(x, H - s * Math.cos(HEM_TILT), -D + s * Math.sin(HEM_TILT)))
  const ct = Math.min(TAB * 0.45, W * 0.2)
  addPoly(
    b,
    'back tab',
    [tb(ct, TAB), tb(W - ct, TAB), tb(W, TAB - ct), tb(W, 0), tb(0, 0), tb(0, TAB - ct)],
    ['cut', 'cut', 'cut', 'crease', 'cut', 'cut'],
  )

  // Side walls: `side(x)` maps a flat x on this side to the distance back from
  // the front (0 at the front edge, D at the back edge); `wallX` is the side's
  // box x and `inward` the direction into the box.
  const ta = Math.min(DUST * 0.6, D * 0.2)
  const gt = Math.min(FLAP, H * 0.15)
  for (const s of ['left', 'right'] as const) {
    const left = s === 'left'
    const wallX = left ? 0 : W
    const inward = left ? 1 : -1
    const depthOf = (x: number) => (left ? -x : x - W)
    const edge = left ? -D : W + D // flat x of the side's back edge
    const near = left ? 0 : W // flat x of the side's front edge
    const wallPt = (x: number, y: number) => pt(x, y, at(wallX, y, -depthOf(x)))
    // Each polygon is CCW in flat coords; the left side runs right-to-left.
    const [xa, xb] = left ? [edge, near] : [near, edge]
    addPoly(
      b,
      `${s} side`,
      [wallPt(xa, 0), wallPt(xb, 0), wallPt(xb, H), wallPt(xa, H)],
      ['crease', 'crease', 'crease', 'crease'],
    )
    // Dust flaps fold in flat: `v` in from the side wall.
    const dustTop = (x: number, v: number) => pt(x, H + v, at(wallX + inward * v, H, -depthOf(x)))
    const dustBot = (x: number, v: number) => pt(x, -v, at(wallX + inward * v, 0, -depthOf(x)))
    const [ia, ib] = left ? [xa + ta, xb - ta] : [xa + ta, xb - ta]
    addPoly(
      b,
      `${s} side top dust flap`,
      [dustTop(xa, 0), dustTop(xb, 0), dustTop(ib, DUST), dustTop(ia, DUST)],
      ['crease', 'cut', 'cut', 'cut'],
    )
    addPoly(
      b,
      `${s} side bottom dust flap`,
      [dustBot(ia, DUST), dustBot(ib, DUST), dustBot(xb, 0), dustBot(xa, 0)],
      ['cut', 'cut', 'crease', 'cut'],
    )
    // Back flap: past the back edge, folded in against the inside of the back.
    const fl = (x: number, y: number) => pt(x, y, at(wallX + inward * Math.abs(x - edge), y, -D))
    const far = left ? edge - FLAP : edge + FLAP
    addPoly(
      b,
      `${s} side back flap`,
      left
        ? [fl(far, gt), fl(edge, 0), fl(edge, H), fl(far, H - gt)]
        : [fl(edge, 0), fl(far, gt), fl(far, H - gt), fl(edge, H)],
      left ? ['cut', 'crease', 'cut', 'cut'] : ['cut', 'cut', 'cut', 'crease'],
    )
  }

  // Hidden flaps lie flat against the panels covering them; the lid and the
  // bottom cover the dust flaps.
  for (const f of b.faces) f.layer = /dust|tuck|flap|tab/.test(f.name) ? 0 : /lid|^bottom$/.test(f.name) ? 2 : 1

  const doc: PaperDoc = { vertices: b.vertices, edges: b.edges, faces: b.faces, rootFaceId: front }
  doc.targetAngles = deriveTargetAngles(doc, buildPanelTree(doc), b.target3)
  return doc
}
