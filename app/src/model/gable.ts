// Gable-top milk carton dieline (square base). The top of each side panel is
// a gusset: two diagonal creases meeting at a peak split it into three
// triangles — the center triangle folds INWARD to form the spout, the outer
// triangles ride up with the roof panels, and the rib above pinches shut to
// seal. Target angles are derived from the sealed 3D pose (see targets.ts).
//
//   +------+--/\--+------+--/\--+
//   | rib  | /  \ | rib  | /  \ |        (seal rib; side ribs split + pinch)
//   +------+/-··-\+------+/-··-\+
//   | roof | gusset| roof | gusset|      (·· = diagonal creases to peak)
//   +------+------+------+------+---+
//   |front | right| back | left  | g |   (body)
//   +------+------+------+------+---+
//   | flap | flap | flap | flap |        (bottom flaps)
//   +------+------+------+------+

import { buildPanelTree, type Edge, type EdgeKind, type Face, type PaperDoc, type Vec2, type Vertex } from './document'
import { deriveTargetAngles, type TargetPositions } from './targets'

/**
 * Gable-carton dimensions. width = front/back panel width, depth = side panel
 * width; a rectangular gable is rigid because the roof ridge runs along the
 * width and the gussets fold in over the depth (edge lengths are preserved for
 * any width — only the depth couples to the gable height, which must exceed
 * depth/2 for the roof to reach the ridge).
 */
export interface GableDims {
  width: number
  depth: number
  height: number
  /** Roof/gusset flat height; must be > depth/2. Default = 0.75·depth. */
  gable?: number
  /** Seal-rib height. */
  rib?: number
  /** Bottom flap height, front/back. */
  botFB?: number
  /** Bottom flap height, sides. */
  botLR?: number
  /** Glue flap width. */
  glue?: number
}

export function defaultGableDims(): GableDims {
  return { width: 4, depth: 4, height: 10 }
}

type P3 = [number, number, number]

interface Dims {
  W: number
  D: number
  H: number
  G: number
  R: number
  BOT_FB: number
  BOT_LR: number
  GLUE: number
  SIN: number
  COS: number
  PEAK: number
}

function resolveDims(d: GableDims): Dims {
  const W = d.width
  const D = d.depth
  const H = d.height
  const G = d.gable ?? D * 0.75
  const SIN = D / (2 * G) // roof tilt: top edges travel D/2 inward to the ridge
  const COS = Math.sqrt(Math.max(0, 1 - SIN * SIN))
  return {
    W,
    D,
    H,
    G,
    R: d.rib ?? 0.9,
    BOT_FB: d.botFB ?? 2.2,
    BOT_LR: d.botLR ?? 1.8,
    GLUE: d.glue ?? 1.2,
    SIN,
    COS,
    PEAK: G * COS,
  }
}

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

/** Add a polygon face. kinds[i] is the kind of the edge pts[i] -> pts[i+1]. */
function addPoly(
  b: Builder,
  name: string,
  pts: Array<{ p: Vec2; t: P3 }>,
  kinds: EdgeKind[],
): number {
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

/**
 * Sealed-pose position of a point on the body walls / glue flap. `u` is the
 * flat x (perimeter coordinate), `y` the world height. The flat strip wraps
 * around the rectangular footprint front -> right -> back -> left -> (glue on
 * the front plane). Widths: front/back = W, sides = D.
 */
function wallPos(dm: Dims, u: number, y: number): P3 {
  const { W, D } = dm
  const hw = W / 2
  const hd = D / 2
  if (u <= W) return [u - hw, y, hd] // front: x -hw..hw, z=+hd
  if (u <= W + D) return [hw, y, hd - (u - W)] // right: x=hw, z hd..-hd
  if (u <= 2 * W + D) return [hw - (u - (W + D)), y, -hd] // back: x hw..-hw, z=-hd
  if (u <= 2 * W + 2 * D) return [-hw, y, -hd + (u - (2 * W + D))] // left: x=-hw, z -hd..hd
  return [-hw + (u - (2 * W + 2 * D)), y, hd] // glue onto front plane
}

/** Outward wall normal for body column i (0=front, 1=right, 2=back, 3=left). */
const WALL_NORMAL: P3[] = [
  [0, 0, 1],
  [1, 0, 0],
  [0, 0, -1],
  [-1, 0, 0],
]

export function buildGableCarton(dims: GableDims = defaultGableDims()): PaperDoc {
  const dm = resolveDims(dims)
  const { W, D, H, G, R, BOT_FB, BOT_LR, GLUE, SIN, COS, PEAK } = dm
  const wall = (u: number, y: number): P3 => wallPos(dm, u, y)

  const b: Builder = {
    vertices: [],
    edges: [],
    faces: [],
    vertexByKey: new Map(),
    edgeByKey: new Map(),
    nextId: 0,
    target3: new Map(),
  }
  const names = ['front', 'right side', 'back', 'left side']
  // Column flat x-starts and widths: front(W) right(D) back(W) left(D).
  const colX = [0, W, W + D, 2 * W + D]
  const colW = [W, D, W, D]
  let rootFaceId = -1

  for (let i = 0; i < 4; i++) {
    const x0 = colX[i]
    const cw = colW[i]
    const bot = i % 2 === 0 ? BOT_FB : BOT_LR
    const [nx, , nz] = WALL_NORMAL[i]

    // Body panel: corners BL, BR, TR, TL; sides bottom, right, top, left.
    const fid = addPoly(
      b,
      names[i],
      [
        { p: { x: x0, y: 0 }, t: wall(x0, 0) },
        { p: { x: x0 + cw, y: 0 }, t: wall(x0 + cw, 0) },
        { p: { x: x0 + cw, y: H }, t: wall(x0 + cw, H) },
        { p: { x: x0, y: H }, t: wall(x0, H) },
      ],
      ['crease', 'crease', 'crease', i > 0 ? 'crease' : 'cut'],
    )
    if (i === 0) rootFaceId = fid

    // Bottom flap: folds flat onto the ground plane (target y = 0, pulled
    // inward along the wall normal — flat y is negative below the fold).
    const flapT = (u: number, v: number): P3 => {
      const w = wall(u, 0)
      return [w[0] + nx * v, 0, w[2] + nz * v]
    }
    addPoly(
      b,
      `${names[i]} bottom flap`,
      [
        { p: { x: x0, y: -bot }, t: flapT(x0, -bot) },
        { p: { x: x0 + cw, y: -bot }, t: flapT(x0 + cw, -bot) },
        { p: { x: x0 + cw, y: 0 }, t: wall(x0 + cw, 0) },
        { p: { x: x0, y: 0 }, t: wall(x0, 0) },
      ],
      ['cut', 'cut', 'crease', 'cut'],
    )

    if (i % 2 === 0) {
      // Front/back roof (width W): tilts inward so its top edge lands on the
      // ridge (z = 0), the rib stands vertical there.
      const roofT = (u: number, w: number): P3 => {
        const base = wall(u, 0)
        return [base[0], H + w * COS, base[2] - nz * w * SIN]
      }
      const ribT = (u: number, r: number): P3 => [wall(u, 0)[0], H + PEAK + r, 0]
      addPoly(
        b,
        `${names[i]} roof`,
        [
          { p: { x: x0, y: H }, t: wall(x0, H) },
          { p: { x: x0 + cw, y: H }, t: wall(x0 + cw, H) },
          { p: { x: x0 + cw, y: H + G }, t: roofT(x0 + cw, G) },
          { p: { x: x0, y: H + G }, t: roofT(x0, G) },
        ],
        ['crease', 'cut', 'crease', 'cut'],
      )
      addPoly(
        b,
        `${names[i]} rib`,
        [
          { p: { x: x0, y: H + G }, t: ribT(x0, 0) },
          { p: { x: x0 + cw, y: H + G }, t: ribT(x0 + cw, 0) },
          { p: { x: x0 + cw, y: H + G + R }, t: ribT(x0 + cw, R) },
          { p: { x: x0, y: H + G + R }, t: ribT(x0, R) },
        ],
        ['crease', 'cut', 'cut', 'cut'],
      )
    } else {
      // Sides (depth D): gusset (three triangles) + rib halves that pinch shut.
      // The gusset folds in over the depth; corners land on the ridge END at
      // x = nx·W/2, the apex pulls inward by D/2 to x = nx·(W−D)/2.
      const side = names[i]
      const apexT: P3 = [(nx * (W - D)) / 2, H + PEAK, 0]
      const cornerT: P3 = [(nx * W) / 2, H + PEAK, 0]
      // Rib halves double over onto the corner→apex→corner path (x only).
      const xAt = (u: number): number => {
        const a = u - x0 // 0..D across the gusset
        return a <= D / 2 ? nx * (W / 2 - a) : nx * (W / 2 - D + a)
      }
      const ribT = (u: number, r: number): P3 => [xAt(u), H + PEAK + r, 0]

      const bl = { p: { x: x0, y: H }, t: wall(x0, H) }
      const br = { p: { x: x0 + cw, y: H }, t: wall(x0 + cw, H) }
      const apex = { p: { x: x0 + cw / 2, y: H + G }, t: apexT }
      const tl = { p: { x: x0, y: H + G }, t: cornerT }
      const tr = { p: { x: x0 + cw, y: H + G }, t: cornerT }

      addPoly(b, `${side} gusset`, [bl, br, apex], ['crease', 'crease', 'crease'])
      addPoly(b, `${side} gusset left`, [bl, apex, tl], ['crease', 'crease', 'cut'])
      addPoly(b, `${side} gusset right`, [br, tr, apex], ['cut', 'crease', 'crease'])

      const ribPt = (x: number, r: number) => ({
        p: { x, y: H + G + r },
        t: ribT(x, r) as P3,
      })
      addPoly(
        b,
        `${side} rib a`,
        [
          { ...tl, t: cornerT },
          { ...apex, t: apexT },
          ribPt(x0 + cw / 2, R),
          ribPt(x0, R),
        ],
        ['crease', 'crease', 'cut', 'cut'],
      )
      addPoly(
        b,
        `${side} rib b`,
        [
          { ...apex, t: apexT },
          { ...tr, t: cornerT },
          ribPt(x0 + cw, R),
          ribPt(x0 + cw / 2, R),
        ],
        ['crease', 'cut', 'cut', 'crease'],
      )
    }
  }

  // Glue flap off the left side's right edge, wrapping onto the front plane.
  const gx = 2 * W + 2 * D
  addPoly(
    b,
    'glue flap',
    [
      { p: { x: gx, y: 0 }, t: wall(gx, 0) },
      { p: { x: gx + GLUE, y: 0 }, t: wall(gx + GLUE, 0) },
      { p: { x: gx + GLUE, y: H }, t: wall(gx + GLUE, H) },
      { p: { x: gx, y: H }, t: wall(gx, H) },
    ],
    ['cut', 'cut', 'cut', 'crease'],
  )
  // The left side's right edge was added as a cut; promote it to a crease.
  const v1 = b.vertexByKey.get(key({ x: gx, y: 0 }))!
  const v2 = b.vertexByKey.get(key({ x: gx, y: H }))!
  const ek = v1 < v2 ? `${v1}:${v2}` : `${v2}:${v1}`
  const glueEdge = b.edgeByKey.get(ek)
  if (glueEdge !== undefined) b.edges.find((e) => e.id === glueEdge)!.kind = 'crease'

  const doc: PaperDoc = {
    vertices: b.vertices,
    edges: b.edges,
    faces: b.faces,
    rootFaceId,
  }
  doc.targetAngles = deriveTargetAngles(doc, buildPanelTree(doc), b.target3)
  return doc
}
