// Verifies the cross box (cube-net) archetype and per-panel art registration:
//  1. Geometry: buildCrossBox folds at its target angles to exactly W × H × D
//     for several proportions, with no panels passing through each other,
//     no same-kind panels stacked, and every hidden flap drawing beneath the
//     panel that covers it.
//  2. The wizard on #790 (pudding pot: a cross-net box drawn with panels that
//     disagree by ~40%): the box drawing is picked, "Cross box" is chosen
//     automatically, every guide lands within a few px of its crease, and the
//     box builds as a crossbox with the authored fold steps.
//  3. Registration: each face of the PRINT canvas shows, at its center, the
//     same color as the picture at that face's own spot — so panels the
//     picture draws at other sizes still carry their own art.
// Screenshots land in scripts/shots/.
// Usage: node scripts/verify-v16.mjs   (dev server must be running; needs the
// local-only reference/dieline/ pictures)
import { chromium } from 'playwright'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const URL = process.env.PAPERSIM_URL ?? 'http://localhost:5173/'
const REF = (name) => fileURLToPath(new globalThis.URL(`../../reference/dieline/${name}`, import.meta.url))
const SHOTS = fileURLToPath(new globalThis.URL('./shots/', import.meta.url))
const PUDDING = REF('pinterest_4081455908182790.png')
if (!existsSync(PUDDING)) {
  console.error(`test image missing: ${PUDDING}`)
  process.exit(1)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text())
})
await page.goto(URL)
await page.waitForFunction(() => 'paperSim' in window && 'paperSimViewer' in window)
await page.waitForTimeout(400)

const results = []
const check = (key, ok, info = '') => results.push({ key, ok: !!ok, info })

// ---- 1. Geometry ----------------------------------------------------------------
const geometry = await page.evaluate(() => {
  const P = window.paperSim
  // Interpenetration / coplanar-overlap helpers, as in verify-v13.
  const EPS = 1e-4
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const norm = (a) => {
    const l = Math.hypot(...a)
    return [a[0] / l, a[1] / l, a[2] / l]
  }
  const newell = (pts) => {
    const n = [0, 0, 0]
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]
      const q = pts[(i + 1) % pts.length]
      n[0] += (p[1] - q[1]) * (p[2] + q[2])
      n[1] += (p[2] - q[2]) * (p[0] + q[0])
      n[2] += (p[0] - q[0]) * (p[1] + q[1])
    }
    return norm(n)
  }
  const kind = (name) =>
    /dust/.test(name) ? 'dust' : /lid/.test(name) ? 'lid' : /tuck/.test(name) ? 'tuck' : /glue/.test(name) ? 'glue' : 'wall'
  // Transversal interpenetration: A ∩ plane(B) is a segment; clip it to B's
  // interior (Cyrus–Beck, with a margin) — any length left means the panels
  // pass through each other. Edge-aligned crossings are caught too.
  const crosses = (A, B) => {
    const n = newell(B)
    const d = dot(n, B[0])
    const seg = []
    for (let i = 0; i < A.length; i++) {
      const p = A[i]
      const q = A[(i + 1) % A.length]
      const dp = dot(n, p) - d
      const dq = dot(n, q) - d
      if (dp * dq >= 0 || Math.abs(dp) < EPS || Math.abs(dq) < EPS) continue
      const t = dp / (dp - dq)
      seg.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t])
    }
    if (seg.length < 2) return false
    const [P, Q] = seg
    let t0 = 0
    let t1 = 1
    for (let i = 0; i < B.length; i++) {
      const b = B[i]
      const e = sub(B[(i + 1) % B.length], b)
      const m = 1e-3 * Math.hypot(...e)
      const fP = dot(cross(e, sub(P, b)), n) - m
      const fQ = dot(cross(e, sub(Q, b)), n) - m
      if (fP < 0 && fQ < 0) return false
      if (fP < 0) t0 = Math.max(t0, fP / (fP - fQ))
      else if (fQ < 0) t1 = Math.min(t1, fP / (fP - fQ))
    }
    return (t1 - t0) * Math.hypot(...sub(Q, P)) > 1e-3
  }
  // Coplanar overlap area (Sutherland–Hodgman clip in the shared plane).
  const coplanarArea = (A, B) => {
    const nA = newell(A)
    const nB = newell(B)
    if (Math.abs(dot(nA, nB)) < 1 - 1e-6 || Math.abs(dot(nB, A[0]) - dot(nB, B[0])) > EPS) return 0
    const u = norm(sub(B[1], B[0]))
    const v = cross(nB, u)
    const to2 = (p) => [dot(sub(p, B[0]), u), dot(sub(p, B[0]), v)]
    const area = (P) => P.reduce((s, p, i) => s + (p[0] * P[(i + 1) % P.length][1] - P[(i + 1) % P.length][0] * p[1]), 0) / 2
    let subj = A.map(to2)
    let clip = B.map(to2)
    if (area(clip) < 0) clip = clip.reverse()
    for (let i = 0; i < clip.length && subj.length; i++) {
      const a = clip[i]
      const b = clip[(i + 1) % clip.length]
      const side = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
      const out = []
      for (let j = 0; j < subj.length; j++) {
        const p = subj[j]
        const q = subj[(j + 1) % subj.length]
        const sp = side(p)
        const sq = side(q)
        if (sp >= 0) out.push(p)
        if (sp * sq < 0) {
          const t = sp / (sp - sq)
          out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t])
        }
      }
      subj = out
    }
    return subj.length < 3 ? 0 : Math.abs(area(subj))
  }

  // Self-test so the checks can't pass vacuously: a square pierced by a
  // perpendicular one, and two squares stacked in the same plane.
  const sq = (f) => [[0, 0], [2, 0], [2, 2], [0, 2]].map(([a, b]) => f(a, b))
  const detector = {
    pierced: crosses(sq((a, b) => [a - 1, 1, b - 1]), sq((a, b) => [a - 1, b, 0])),
    stacked: coplanarArea(sq((a, b) => [a, b, 0]), sq((a, b) => [a + 1, b + 1, 0])) > 0.9,
    apart: !crosses(sq((a, b) => [a, b, 0]), sq((a, b) => [a + 5, b, 1])),
  }
  const kindOf = (name) =>
    /dust/.test(name) ? 'dust' : /tuck/.test(name) ? 'tuck' : /back flap/.test(name) ? 'flap' : /tab/.test(name) ? 'tab' : /lid/.test(name) ? 'lid' : 'wall'
  const hidden = (name) => ['dust', 'tuck', 'flap', 'tab'].includes(kindOf(name))
  const out = [{ key: 'detector self-test', ok: detector.pierced && detector.stacked && detector.apart }]
  let hiddenPairs = 0
  for (const [W, D, H] of [
    [6, 5, 6],
    [8, 3, 5],
    [3, 6, 9],
    [5, 5, 5],
  ]) {
    const doc = P.buildCrossBox({ width: W, depth: D, height: H })
    const tree = P.buildPanelTree(doc)
    const angles = {}
    for (const [e, a] of Object.entries(doc.targetAngles)) angles[e] = P.degToRad(a)
    const mats = P.computeFaceMatrices(doc, tree, angles)
    const pos = new Map(doc.vertices.map((v) => [v.id, v.pos]))
    const polys = doc.faces.map((f) => {
      const e = mats.get(f.id).elements
      return {
        name: f.name,
        layer: f.layer ?? 0,
        pts: f.vertexIds.map((id) => {
          const { x, y } = pos.get(id)
          return [e[0] * x + e[4] * y + e[12], e[1] * x + e[5] * y + e[13], e[2] * x + e[6] * y + e[14]]
        }),
      }
    })
    const all = polys.flatMap((p) => p.pts)
    const ext = [0, 1, 2].map((k) => Math.max(...all.map((p) => p[k])) - Math.min(...all.map((p) => p[k])))
    const problems = []
    for (let i = 0; i < polys.length; i++)
      for (let j = i + 1; j < polys.length; j++) {
        const A = polys[i]
        const B = polys[j]
        if (crosses(A.pts, B.pts) || crosses(B.pts, A.pts)) problems.push(`${A.name} ⨯ ${B.name}`)
        else if (coplanarArea(A.pts, B.pts) > 1e-3) {
          if (kindOf(A.name) === kindOf(B.name)) problems.push(`${A.name} ≡ ${B.name}`)
          if (hidden(A.name) !== hidden(B.name)) {
            hiddenPairs++
            const [h, v] = hidden(A.name) ? [A, B] : [B, A]
            if (h.layer >= v.layer) problems.push(`${h.name} draws over ${v.name}`)
          }
        }
      }
    // The box is W wide, H tall and D deep once stood on its bottom; the flat
    // sheet lies in x/y, so the folded extents are W, H (as y) and D (as z) in
    // some order — compare sorted.
    const want = [W, D, H].sort((a, b) => a - b)
    const got = [...ext].sort((a, b) => a - b)
    const angleSet = [...new Set(Object.values(doc.targetAngles).map((a) => Math.abs(a)))].sort((a, b) => a - b)
    out.push({
      key: `cross ${W}×${D}×${H}`,
      ok:
        got.every((v, k) => Math.abs(v - want[k]) < 1e-3) &&
        problems.length === 0 &&
        tree.hingeEdgeIds.length === doc.faces.length - 1 &&
        angleSet.every((a) => Math.abs(a - 90) < 0.05 || Math.abs(a - 178) < 0.05),
      info: JSON.stringify({ ext: ext.map((v) => +v.toFixed(3)), problems, angleSet }),
    })
  }
  // Per box: 4 dust flaps under the lid / over the bottom, 2 side flaps and the tuck inside the back.
  out.push({ key: 'hidden flaps checked', ok: hiddenPairs >= 4 * 7, info: String(hiddenPairs) })
  return out
})
for (const r of geometry) check(r.key, r.ok, r.info)

// ---- 2. Wizard on the pudding pot --------------------------------------------------
await page.locator('.menu-label', { hasText: 'File' }).click()
const [chooser] = await Promise.all([
  page.waitForEvent('filechooser'),
  page.locator('.menu-item', { hasText: 'Import dieline image' }).click(),
])
await chooser.setFiles(PUDDING)
await page.waitForFunction(() => document.querySelector('canvas.prep-canvas')?.width > 10, null, { timeout: 20000 })
await page.waitForTimeout(400)
await page.locator('.fit-modal button.primary', { hasText: 'Next' }).click()
await page.waitForFunction(() => document.querySelector('canvas.fit-canvas')?.dataset.guides, null, { timeout: 20000 })
await page.waitForTimeout(400)
const fit = await page.evaluate(() => {
  const c = document.querySelector('canvas.fit-canvas')
  return { arch: document.querySelector('[data-arch].active')?.dataset.arch, g: JSON.parse(c.dataset.guides) }
})
check('pudding: cross box picked', fit.arch === 'cross', fit.arch)
// Creases measured on the picture (1536 × 1024), shifted into the picked
// drawing's crop: its origin is the box's top-left minus the crop margin.
const expected = {
  x: { sideL: 92, c0: 365, c1: 645, sideR: 912 },
  y: { lid: 92, bodyH: 290, body0: 553, bottom: 778, back: 935, sideTop: 349, sideBot: 551 },
}
const originX = 365 - fit.g.x.c0
const originY = 290 - fit.g.y.bodyH
const off = []
for (const axis of ['x', 'y'])
  for (const [id, want] of Object.entries(expected[axis])) {
    const got = fit.g[axis][id] + (axis === 'x' ? originX : originY)
    if (Math.abs(got - want) > 8) off.push(`${id} ${Math.round(got)} vs ${want}`)
  }
check('pudding: guides on the creases (±8 px)', off.length === 0, off.join(', '))
await page.screenshot({ path: SHOTS + 'v16-pudding-fit.png' })

await page.locator('.fit-modal button.primary', { hasText: 'Build' }).click()
await page.waitForTimeout(1200)
const built = await page.evaluate(() => {
  const st = window.paperSim.store.getState()
  return {
    faces: st.doc.faces.map((f) => f.name),
    steps: st.steps.map((s) => s.name),
    uv: Object.keys(st.uvEdits).length,
    session: st.fitSession?.archetype,
  }
})
check(
  'pudding: builds a crossbox',
  built.faces.includes('left side back flap') && built.faces.includes('back tab') && built.session === 'cross',
  JSON.stringify(built.faces),
)
check('pudding: fold steps', built.steps.length === 5 && built.steps[0] === 'Fold the sides back', built.steps.join(' / '))
check('pudding: panels registered per face', built.uv >= 8, `${built.uv} faces edited`)

// ---- 3. Registration: print canvas vs picture, face by face --------------------------
const reg = await page.evaluate(async () => {
  const P = window.paperSim
  const st = P.store.getState()
  const doc = st.doc
  const baked = window.paperSimFitBaked
  const g = st.fitSession.guides
  const fitMod = await import('/src/model/dielineFit.ts')
  const arch = (await import('/src/model/archetypes.ts')).ARCHETYPES.cross
  const maps = fitMod.faceImageMaps(arch, st.fitSession.params, doc, g)
  const print = await P.buildPrintCanvas(doc, st.material, st.uvEdits)
  const pctx = print.getContext('2d')
  const { min, max } = P.sheetBounds(doc)
  const img = document.createElement('canvas')
  img.width = baked.w
  img.height = baked.h
  img.getContext('2d').drawImage(baked.el, 0, 0)
  const ictx = img.getContext('2d')
  const avg = (ctx, x, y) => {
    const d = ctx.getImageData(Math.round(x) - 2, Math.round(y) - 2, 5, 5).data
    const c = [0, 0, 0]
    for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) c[k] += d[i + k] / 25
    return c
  }
  const rows = []
  for (const f of doc.faces) {
    // Five interior points (the vertex centroid and halfway to four spread-out
    // vertices); the median difference, so one sample on a sharp art edge
    // (a 1-px resampling offset) can't decide it.
    const pts = f.vertexIds.map((id) => doc.vertices.find((v) => v.id === id).pos)
    const cx = pts.reduce((s2, p) => s2 + p.x, 0) / pts.length
    const cy = pts.reduce((s2, p) => s2 + p.y, 0) / pts.length
    const probes = [{ x: cx, y: cy }]
    for (let i = 0; i < 4; i++) {
      const v = pts[Math.floor((i * pts.length) / 4)]
      probes.push({ x: (cx + v.x) / 2, y: (cy + v.y) / 2 })
    }
    const m = maps.get(f.id)
    const diffs = probes.map(({ x, y }) => {
      const a = avg(pctx, ((x - min.x) / (max.x - min.x)) * print.width, (1 - (y - min.y) / (max.y - min.y)) * print.height)
      const b = avg(ictx, m.ax * x + m.bx, m.ay * y + m.by)
      return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])
    })
    diffs.sort((p, q) => p - q)
    rows.push({ face: f.name, diffs: diffs.map(Math.round), diff: Math.round(diffs[2]) })
  }
  const url = print.toDataURL('image/png')
  return { rows, url }
})
const bad = reg.rows.filter((r) => r.diff > 36)
check('registration: every printed face shows its own art', bad.length === 0, JSON.stringify(bad))
const { writeFileSync } = await import('node:fs')
writeFileSync(SHOTS + 'v16-pudding-print.png', Buffer.from(reg.url.split(',')[1], 'base64'))

// Folded, stood up on its bottom.
await page.evaluate(() => {
  const st = window.paperSim.store.getState()
  st.setAnglesTransient({ ...st.doc.targetAngles })
  window.paperSim.store.getState().rotateObject('x', 90)
})
await page.waitForTimeout(700)
await page.screenshot({ path: SHOTS + 'v16-pudding-folded.png' })

await browser.close()
let ok = true
for (const r of results) {
  if (!r.ok) ok = false
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.key}${r.info && !r.ok ? '  ' + r.info : ''}`)
}
if (pageErrors.length) {
  ok = false
  console.log('page errors:', pageErrors)
}
console.log(ok ? 'ALL OK' : 'FAILURES')
process.exit(ok ? 0 : 1)
