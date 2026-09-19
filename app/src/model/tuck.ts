// Parametric tuck-end box (the most common printable box). Four body panels
// in a row — wide W and narrow D alternating — plus a glue flap. Each end is
// closed by a LID on one wide panel (height = depth, so it spans the box) with
// a TUCK tongue beyond it, and a DUST FLAP on each narrow panel. "straight" =
// both lids on the same wide panel; "reverse" = the bottom lid sits on the
// opposite wide panel. Target angles come from the sealed 3D pose, like gable.ts.
//
//   front-first, glue right, reverse:
//          +--------+
//          |  tuck  |
//          +--------+
//          |  lid   |
//   +------+--------+--/\--+--------+--/\--+
//   |      | front  | right|  back  | left |g|     (body)
//   +------+--------+------+--------+------+
//                   \_dust/+--------+\_dust/
//                          |  lid   |
//                          +--------+
//                          |  tuck  |
//                          +--------+

import { buildPanelTree, type Edge, type EdgeKind, type Face, type PaperDoc, type Vec2, type Vertex } from './document'
import { deriveTargetAngles, type TargetPositions } from './targets'

export interface TuckParams {
  /** Wide (front/back) panel width. */
  width: number
  /** Narrow (side) panel width. */
  depth: number
  /** Body height. */
  height: number
  /** Lid height; defaults to depth (the lid must span the box to close). */
  lid?: number
  /** Tuck tongue height (default 1.5 cm, capped by the body). */
  tuck?: number
  /** Dust flap height (default 0.6·depth; capped so opposite flaps never overlap). */
  dust?: number
  /** Glue flap width. */
  glue?: number
  style: 'straight' | 'reverse'
  /** Column order in the flat row: wide panel first (W D W D) or narrow first (D W D W). */
  order: 'front-first' | 'side-first'
  glueSide: 'right' | 'left'
  /** Which wide panel (in flat order) carries the TOP lid. Default 'first'. */
  lidOn?: 'first' | 'second'
}

export function defaultTuckParams(): TuckParams {
  return { width: 6, depth: 3, height: 9, style: 'reverse', order: 'front-first', glueSide: 'right' }
}

export interface ResolvedTuck {
  W: number
  D: number
  H: number
  LID: number
  TUCK: number
  DUST: number
  GLUE: number
  /** Column x-starts and widths in flat order. */
  colX: number[]
  colW: number[]
  names: string[]
  /** Column indices of the wide panels (flat order). */
  wide: [number, number]
  topLidCol: number
  botLidCol: number
}

export function resolveTuck(p: TuckParams): ResolvedTuck {
  const W = p.width
  const D = p.depth
  const H = p.height
  const sideFirst = p.order === 'side-first'
  const colW = sideFirst ? [D, W, D, W] : [W, D, W, D]
  const colX = [0, colW[0], colW[0] + colW[1], colW[0] + colW[1] + colW[2]]
  // Named in wrap order, so "right side" always follows "front".
  const names = sideFirst
    ? ['left side', 'front', 'right side', 'back']
    : ['front', 'right side', 'back', 'left side']
  const wide: [number, number] = sideFirst ? [1, 3] : [0, 2]
  const topLidCol = wide[p.lidOn === 'second' ? 1 : 0]
  const botLidCol = p.style === 'straight' ? topLidCol : wide[topLidCol === wide[0] ? 1 : 0]
  return {
    W,
    D,
    H,
    LID: p.lid ?? D,
    TUCK: Math.min(p.tuck ?? 1.5, H * 0.4),
    DUST: Math.min(p.dust ?? D * 0.6, W * 0.45),
    GLUE: p.glue ?? 1.2,
    colX,
    colW,
    names,
    wide,
    topLidCol,
    botLidCol,
  }
}

type P3 = [number, number, number]

interface Builder {
  vertices: Vertex[]
  edges: Edge[]
  faces: Face[]
  vertexByKey: Map<string, number>
  edgeByKey: Map<string, number>
  nextId: number
  target3: TargetPositions
}

function key(p: Vec2): string {
  return `${p.x.toFixed(4)},${p.y.toFixed(4)}`
}

function vtx(b: Builder, p: Vec2, t: P3): number {
  const k = key(p)
  const existing = b.vertexByKey.get(k)
  if (existing !== undefined) return existing
  const id = b.nextId++
  b.vertices.push({ id, pos: { ...p } })
  b.vertexByKey.set(k, id)
  b.target3.set(id, t)
  return id
}

/** Add a CCW polygon face. kinds[i] is the kind of the edge pts[i] -> pts[i+1]. */
function addPoly(b: Builder, name: string, pts: Array<{ p: Vec2; t: P3 }>, kinds: EdgeKind[]): number {
  const vids = pts.map(({ p, t }) => vtx(b, p, t))
  const n = vids.length
  for (let i = 0; i < n; i++) {
    const v1 = vids[i]
    const v2 = vids[(i + 1) % n]
    const ek = v1 < v2 ? `${v1}:${v2}` : `${v2}:${v1}`
    const existing = b.edgeByKey.get(ek)
    if (existing !== undefined) {
      // Shared edge: crease wins if either face declares it a crease.
      if (kinds[i] === 'crease') b.edges.find((e) => e.id === existing)!.kind = 'crease'
      continue
    }
    const id = b.nextId++
    b.edges.push({ id, v1, v2, kind: kinds[i] })
    b.edgeByKey.set(ek, id)
  }
  const faceId = b.nextId++
  b.faces.push({ id: faceId, name, vertexIds: vids })
  return faceId
}

// Wall directions around the footprint, in wrap order, and the outward normal
// of a wall running along d: n = d × up = (−d.z, 0, d.x).
const DIRS: P3[] = [
  [1, 0, 0],
  [0, 0, -1],
  [-1, 0, 0],
  [0, 0, 1],
]
const normalOf = (d: P3): P3 => [-d[2], 0, d[0]]

export function buildTuckBox(params: TuckParams = defaultTuckParams()): PaperDoc {
  const r = resolveTuck(params)
  const { H, LID, TUCK, DUST, GLUE, colX, colW, names } = r
  const total = colX[3] + colW[3]

  // Sealed pose: column 0 starts at the footprint corner (−c0/2, ·, c1/2) and
  // the strip wraps around it; a glue flap continues onto the wall it meets.
  const start: P3 = [-colW[0] / 2, 0, colW[1] / 2]
  const corners: P3[] = [start]
  for (let i = 0; i < 4; i++) {
    const c = corners[i]
    corners.push([c[0] + DIRS[i][0] * colW[i], 0, c[2] + DIRS[i][2] * colW[i]])
  }
  const colOf = (u: number) => (u < colX[1] ? 0 : u < colX[2] ? 1 : u < colX[3] ? 2 : 3)
  const wall = (u: number, y: number): P3 => {
    if (u > total) return [start[0] + DIRS[0][0] * (u - total), y, start[2] + DIRS[0][2] * (u - total)]
    if (u < 0) return [start[0] + DIRS[3][0] * u, y, start[2] + DIRS[3][2] * u]
    const i = colOf(Math.min(u, total - 1e-9))
    const s = u - colX[i]
    return [corners[i][0] + DIRS[i][0] * s, y, corners[i][2] + DIRS[i][2] * s]
  }
  /** Flap pose: folded flat inward over the end at height `y0`, `v` in from the wall. */
  const inward = (i: number, u: number, y0: number, v: number): P3 => {
    const w = wall(u, y0)
    const n = normalOf(DIRS[i])
    return [w[0] - n[0] * v, y0, w[2] - n[2] * v]
  }
  /** Tuck pose: past the lid, hanging `w` down (top) / up (bottom) inside the far wall. */
  const tucked = (i: number, u: number, y0: number, w: number, dir: 1 | -1): P3 => {
    const t = inward(i, u, y0, LID)
    return [t[0], y0 + dir * w, t[2]]
  }

  const b: Builder = {
    vertices: [],
    edges: [],
    faces: [],
    vertexByKey: new Map(),
    edgeByKey: new Map(),
    nextId: 0,
    target3: new Map(),
  }
  const glueCol = params.glueSide === 'right' ? 3 : 0
  let rootFaceId = -1

  for (let i = 0; i < 4; i++) {
    const x0 = colX[i]
    const cw = colW[i]
    const x1 = x0 + cw
    const narrow = !r.wide.includes(i)
    const hasTop = narrow || i === r.topLidCol
    const hasBot = narrow || i === r.botLidCol
    const leftKind: EdgeKind = i > 0 || glueCol === 0 ? 'crease' : 'cut'
    const rightKind: EdgeKind = i < 3 || glueCol === 3 ? 'crease' : 'cut'
    const fid = addPoly(
      b,
      names[i],
      [
        { p: { x: x0, y: 0 }, t: wall(x0, 0) },
        { p: { x: x1, y: 0 }, t: wall(x1, 0) },
        { p: { x: x1, y: H }, t: wall(x1, H) },
        { p: { x: x0, y: H }, t: wall(x0, H) },
      ],
      [hasBot ? 'crease' : 'cut', rightKind, hasTop ? 'crease' : 'cut', leftKind],
    )
    if (names[i] === 'front') rootFaceId = fid

    if (narrow) {
      // Dust flaps, tapered on both sides so they clear the lid's corners.
      const ta = Math.min(DUST * 0.35, cw * 0.2)
      addPoly(
        b,
        `${names[i]} top dust flap`,
        [
          { p: { x: x0, y: H }, t: wall(x0, H) },
          { p: { x: x1, y: H }, t: wall(x1, H) },
          { p: { x: x1 - ta, y: H + DUST }, t: inward(i, x1 - ta, H, DUST) },
          { p: { x: x0 + ta, y: H + DUST }, t: inward(i, x0 + ta, H, DUST) },
        ],
        ['crease', 'cut', 'cut', 'cut'],
      )
      addPoly(
        b,
        `${names[i]} bottom dust flap`,
        [
          { p: { x: x0 + ta, y: -DUST }, t: inward(i, x0 + ta, 0, DUST) },
          { p: { x: x1 - ta, y: -DUST }, t: inward(i, x1 - ta, 0, DUST) },
          { p: { x: x1, y: 0 }, t: wall(x1, 0) },
          { p: { x: x0, y: 0 }, t: wall(x0, 0) },
        ],
        ['cut', 'cut', 'crease', 'cut'],
      )
      continue
    }

    // Tuck tongue corners are chamfered so it slides in past the dust flaps.
    const c = Math.min(TUCK * 0.45, cw * 0.2)
    if (i === r.topLidCol) {
      const y1 = H + LID
      addPoly(
        b,
        `${names[i]} top lid`,
        [
          { p: { x: x0, y: H }, t: wall(x0, H) },
          { p: { x: x1, y: H }, t: wall(x1, H) },
          { p: { x: x1, y: y1 }, t: inward(i, x1, H, LID) },
          { p: { x: x0, y: y1 }, t: inward(i, x0, H, LID) },
        ],
        ['crease', 'cut', 'crease', 'cut'],
      )
      const tk = (x: number, w: number) => ({ p: { x, y: y1 + w }, t: tucked(i, x, H, w, -1) })
      addPoly(
        b,
        `${names[i]} top tuck`,
        [tk(x0, 0), tk(x1, 0), tk(x1, TUCK - c), tk(x1 - c, TUCK), tk(x0 + c, TUCK), tk(x0, TUCK - c)],
        ['crease', 'cut', 'cut', 'cut', 'cut', 'cut'],
      )
    }
    if (i === r.botLidCol) {
      const y1 = -LID
      addPoly(
        b,
        `${names[i]} bottom lid`,
        [
          { p: { x: x0, y: y1 }, t: inward(i, x0, 0, LID) },
          { p: { x: x1, y: y1 }, t: inward(i, x1, 0, LID) },
          { p: { x: x1, y: 0 }, t: wall(x1, 0) },
          { p: { x: x0, y: 0 }, t: wall(x0, 0) },
        ],
        ['crease', 'cut', 'crease', 'cut'],
      )
      const tk = (x: number, w: number) => ({ p: { x, y: y1 - w }, t: tucked(i, x, 0, w, 1) })
      addPoly(
        b,
        `${names[i]} bottom tuck`,
        [tk(x0 + c, TUCK), tk(x1 - c, TUCK), tk(x1, TUCK - c), tk(x1, 0), tk(x0, 0), tk(x0, TUCK - c)],
        ['cut', 'cut', 'cut', 'crease', 'cut', 'cut'],
      )
    }
  }

  // Glue flap, tapered top and bottom, on the chosen outer edge.
  const gt = Math.min(GLUE, H * 0.15)
  const g = (x: number, y: number) => ({ p: { x, y }, t: wall(x, y) })
  if (params.glueSide === 'right') {
    addPoly(b, 'glue flap', [g(total, 0), g(total + GLUE, gt), g(total + GLUE, H - gt), g(total, H)], [
      'cut',
      'cut',
      'cut',
      'crease',
    ])
  } else {
    addPoly(b, 'glue flap', [g(0, 0), g(0, H), g(-GLUE, H - gt), g(-GLUE, gt)], ['crease', 'cut', 'cut', 'cut'])
  }

  // Hidden flaps lie flat against the panels that cover them — dust flaps
  // under the lids, tucks and the glue flap inside the walls — so they draw
  // beneath them wherever the two coincide.
  for (const f of b.faces) f.layer = /dust|tuck|glue/.test(f.name) ? 0 : /lid/.test(f.name) ? 2 : 1

  const doc: PaperDoc = { vertices: b.vertices, edges: b.edges, faces: b.faces, rootFaceId }
  doc.targetAngles = deriveTargetAngles(doc, buildPanelTree(doc), b.target3)
  return doc
}
