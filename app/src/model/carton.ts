// Hardcoded v0 dieline: a classic tuck-style carton, laid out flat.
// Four body panels in a row (front, right, back, left) + a glue flap,
// with top and bottom flaps on each body panel.
//
//   +--------+----+--------+----+
//   |  topF  |topR|  topB  |topL|          (top flaps)
//   +--------+----+--------+----+---+
//   | front  | rt |  back  | lt | g |      (body row)
//   +--------+----+--------+----+---+
//   |  botF  |botR|  botB  |botL|          (bottom flaps)
//   +--------+----+--------+----+

import type { Edge, Face, PaperDoc, Vec2, Vertex } from './document'

const W = 6 // front/back width
const D = 4 // side depth
const H = 12 // body height
const TOP_FB = 3.2 // top flap height on front/back
const TOP_LR = 2.2 // top flap height on sides
const BOT_FB = 3.6 // bottom flap height on front/back
const BOT_LR = 2.4 // bottom flap height on sides
const GLUE = 1.4 // glue flap width

interface Builder {
  vertices: Vertex[]
  edges: Edge[]
  faces: Face[]
  vertexByKey: Map<string, number>
  edgeByKey: Map<string, number>
  nextId: number
}

function key(p: Vec2): string {
  return `${p.x.toFixed(4)},${p.y.toFixed(4)}`
}

function getVertex(b: Builder, p: Vec2): number {
  const k = key(p)
  const existing = b.vertexByKey.get(k)
  if (existing !== undefined) return existing
  const id = b.nextId++
  b.vertices.push({ id, pos: { ...p } })
  b.vertexByKey.set(k, id)
  return id
}

/**
 * Add a rectangular panel. Corner order: counter-clockwise from bottom-left.
 * `creaseSides` marks which sides are creases; every other side is a cut.
 */
function addRect(
  b: Builder,
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
  creaseSides: Array<'left' | 'right' | 'top' | 'bottom'>,
): number {
  const corners: Vec2[] = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ]
  const sideNames = ['bottom', 'right', 'top', 'left'] as const
  const vids = corners.map((c) => getVertex(b, c))
  for (let i = 0; i < 4; i++) {
    const v1 = vids[i]
    const v2 = vids[(i + 1) % 4]
    const ek = v1 < v2 ? `${v1}:${v2}` : `${v2}:${v1}`
    const kind = creaseSides.includes(sideNames[i]) ? 'crease' : 'cut'
    const existing = b.edgeByKey.get(ek)
    if (existing !== undefined) {
      // Shared edge: crease wins if either face declares it a crease.
      const e = b.edges.find((e) => e.id === existing)!
      if (kind === 'crease') e.kind = 'crease'
      continue
    }
    const id = b.nextId++
    b.edges.push({ id, v1, v2, kind })
    b.edgeByKey.set(ek, id)
  }
  const faceId = b.nextId++
  b.faces.push({ id: faceId, name, vertexIds: vids })
  return faceId
}

export function buildCarton(): PaperDoc {
  const b: Builder = {
    vertices: [],
    edges: [],
    faces: [],
    vertexByKey: new Map(),
    edgeByKey: new Map(),
    nextId: 0,
  }

  // Body row spans y in [0, H]; columns left-to-right.
  const cols = [
    { name: 'front', x: 0, w: W, topH: TOP_FB, botH: BOT_FB },
    { name: 'right side', x: W, w: D, topH: TOP_LR, botH: BOT_LR },
    { name: 'back', x: W + D, w: W, topH: TOP_FB, botH: BOT_FB },
    { name: 'left side', x: W + D + W, w: D, topH: TOP_LR, botH: BOT_LR },
  ]

  let rootFaceId = -1
  cols.forEach((col, i) => {
    const creases: Array<'left' | 'right' | 'top' | 'bottom'> = ['top', 'bottom']
    if (i > 0) creases.push('left')
    if (i < cols.length - 1) creases.push('right')
    const fid = addRect(b, col.name, col.x, 0, col.w, H, creases)
    if (i === 0) rootFaceId = fid
    addRect(b, `${col.name} top flap`, col.x, H, col.w, col.topH, ['bottom'])
    addRect(b, `${col.name} bottom flap`, col.x, -col.botH, col.w, col.botH, ['top'])
  })

  // Glue flap hangs off the right edge of the left-side panel.
  const glueX = W + D + W + D
  addRect(b, 'glue flap', glueX, 0, GLUE, H, ['left'])
  // The left-side panel's right edge was added as a cut; promote it to crease.
  const lsRight = [getVertex(b, { x: glueX, y: 0 }), getVertex(b, { x: glueX, y: H })]
  const ek = lsRight[0] < lsRight[1] ? `${lsRight[0]}:${lsRight[1]}` : `${lsRight[1]}:${lsRight[0]}`
  const edgeId = b.edgeByKey.get(ek)
  if (edgeId !== undefined) b.edges.find((e) => e.id === edgeId)!.kind = 'crease'

  // Every crease in this carton folds to 90° in the finished box.
  const targetAngles: Record<number, number> = {}
  for (const e of b.edges) if (e.kind === 'crease') targetAngles[e.id] = 90

  return { vertices: b.vertices, edges: b.edges, faces: b.faces, rootFaceId, targetAngles }
}
