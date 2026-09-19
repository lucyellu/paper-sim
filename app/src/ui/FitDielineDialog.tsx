// "Fit the grid" dieline-image wizard. Prep: rotate / flip / crop the picture
// (baked to a new image every later step uses); when the picture holds several
// drawings, each one is outlined and a click picks it. Fit: pick the box
// archetype and layout, then drag the archetype's guide lines (column + row
// folds) onto the picture while its real outline is drawn over it — the
// check-before-you-print moment. Size: one real body height; presets for one Letter page and
// for a sharp (≥150 dpi) print. Build: the archetype's parametric dieline with
// the picture registered onto it through the same guides. Geometry always
// comes from the builder; the picture supplies measurements and artwork.

import { useEffect, useMemo, useRef, useState } from 'react'
import { ARCHETYPES, ARCHETYPE_IDS, archetypeOptions, type ArchetypeId } from '../model/archetypes'
import {
  analyzeDielineImage,
  findPieces,
  isolateLargestPiece,
  type DielineImageAnalysis,
  type Piece,
} from '../model/dielineImage'
import {
  artDpi,
  faceImageMaps,
  faceRegistration,
  fitLetterHeight,
  fitPlacement,
  fitParams,
  foldedStrip,
  foregroundMask,
  guessFoldedAway,
  initialFit,
  looksLikeCross,
  looksLikeGable,
  MIN_PRINT_DPI,
  overlayFromMap,
  sharpHeight,
  sheetSize,
  withFoldedAway,
  type CropRect,
  type FitSession,
  type FoldedAway,
  type ImageGuides,
} from '../model/dielineFit'
import { defaultMaterial } from '../model/material'
import { projectNameFromFileName } from '../model/naming'
import { fitsOneLetterPage } from '../model/printFit'
import { useAppStore, type TemplateDims } from '../state/store'
import { loadImage } from '../viewer/texture'

const VIEW_W = 720
const VIEW_H = 620
const GUIDE_HIT = 7 // display px
const HANDLE_HIT = 11
const PIECE_MAX = 800 // px, piece detection resolution
const CLICK_SLOP = 4 // display px: a shorter drag is a click

type Step = 'prep' | 'fit'
type Rotation = FitSession['rotation']
type SizeMode = 'fit' | 'sharp' | 'manual'

interface Baked {
  url: string
  w: number
  h: number
  el: HTMLImageElement
  analysis: DielineImageAnalysis
  mask: Uint8Array
  pixels: Uint8ClampedArray
}

export interface FitDielineProps {
  /** A fresh picture to start from (Prep step)… */
  source?: { dataUrl: string; fileName: string }
  /** …or the previous fit to reopen (Fit step). */
  session?: FitSession
  onClose: () => void
}

/** The picture the fit step shows and the box prints: `ox` px added on the left. */
interface Art {
  src: CanvasImageSource
  w: number
  h: number
  ox: number
}

/** Median color of the drawing inside the image-px rect (the paper, on most panels). */
function paperColor(b: Baked, x0: number, y0: number, x1: number, y1: number): string {
  const ch: number[][] = [[], [], []]
  const step = Math.max(1, Math.round(Math.max(x1 - x0, y1 - y0) / 60))
  for (let y = Math.max(0, Math.round(y0)); y < Math.min(b.h, y1); y += step) {
    for (let x = Math.max(0, Math.round(x0)); x < Math.min(b.w, x1); x += step) {
      if (!b.mask[y * b.w + x]) continue
      for (let k = 0; k < 3; k++) ch[k].push(b.pixels[(y * b.w + x) * 4 + k])
    }
  }
  if (!ch[0].length) return '#ffffff'
  const med = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1]
  return `rgb(${med(ch[0])},${med(ch[1])},${med(ch[2])})`
}

/**
 * The picture with a folded-away end panel's strip painted plain paper (its
 * twin panel's color), widened to reach the copied column and glue flap.
 */
function composeArt(b: Baked, real: ImageGuides, eff: ImageGuides, folded: FoldedAway): Art {
  const strip = foldedStrip(real, folded)
  if (!strip) return { src: b.el, w: b.w, h: b.h, ox: 0 }
  const xs = Object.values(eff.x)
  const m = b.w * 0.02
  const x0 = Math.floor(Math.min(0, Math.min(...xs) - m))
  const x1 = Math.ceil(Math.max(b.w, Math.max(...xs) + m))
  const c = document.createElement('canvas')
  c.width = x1 - x0
  c.height = b.h
  const ctx = c.getContext('2d')!
  ctx.drawImage(b.el, -x0, 0)
  const twin = folded === 'last' ? [real.x.c1, real.x.c2] : [real.x.c2, real.x.c3]
  const inset = (twin[1] - twin[0]) * 0.1
  ctx.fillStyle = paperColor(b, twin[0] + inset, real.y.bodyH, twin[1] - inset, real.y.body0)
  const a = Math.max(x0, strip.x0)
  const z = Math.min(x1, strip.x1)
  ctx.fillRect(a - x0, 0, z - a, b.h)
  return { src: c, w: c.width, h: b.h, ox: -x0 }
}

/** A copy of `src` whose longer side is at most `max` px. */
function downscaled(src: HTMLCanvasElement, max: number): HTMLCanvasElement {
  const s = Math.min(1, max / Math.max(src.width, src.height, 1))
  const c = document.createElement('canvas')
  c.width = Math.max(2, Math.round(src.width * s))
  c.height = Math.max(2, Math.round(src.height * s))
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height)
  return c
}

const pixels = (c: HTMLCanvasElement) => c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height)

/**
 * The separate drawings in `src`, biggest first, in `src` px, and whether
 * smaller marks (a logo, a caption) lie clearly outside the biggest one.
 */
function detectPieces(src: HTMLCanvasElement): { pieces: Piece[]; stray: boolean } {
  const low = downscaled(src, PIECE_MAX)
  const k = src.width / low.width
  const pm = findPieces(pixels(low))
  const pieces = pm.pieces.map((p) => ({ ...p, x: p.x * k, y: p.y * k, w: p.w * k, h: p.h * k }))
  const main = pm.pieces[0]
  let stray = false
  if (main) {
    const mx = low.width * 0.02
    const my = low.height * 0.02
    for (let y = 0; y < pm.height && !stray; y++) {
      for (let x = 0; x < pm.width; x++) {
        if (!pm.labels[y * pm.width + x] || pm.labels[y * pm.width + x] === main.label) continue
        if (x < main.x - mx || x > main.x + main.w + mx || y < main.y - my || y > main.y + main.h + my) {
          stray = true
          break
        }
      }
    }
  }
  return { pieces, stray }
}

/** Crop around a piece with a small margin, inside the picture. */
function pieceCrop(p: Piece, w: number, h: number): CropRect {
  const m = Math.max(4, Math.max(p.w, p.h) * 0.015)
  const x = Math.max(0, Math.floor(p.x - m))
  const y = Math.max(0, Math.floor(p.y - m))
  return { x, y, w: Math.min(w, Math.ceil(p.x + p.w + m)) - x, h: Math.min(h, Math.ceil(p.y + p.h + m)) - y }
}

/**
 * Draw the picture rotated / flipped, then cropped; `isolate` then paints
 * everything but the crop's biggest drawing with the background.
 */
function bake(
  img: HTMLImageElement,
  rotation: Rotation,
  flipH: boolean,
  crop: CropRect | null,
  isolate = false,
): HTMLCanvasElement {
  const quarter = rotation === 90 || rotation === 270
  const rw = quarter ? img.height : img.width
  const rh = quarter ? img.width : img.height
  const r = document.createElement('canvas')
  r.width = rw
  r.height = rh
  const ctx = r.getContext('2d')!
  ctx.translate(rw / 2, rh / 2)
  ctx.rotate((rotation * Math.PI) / 180)
  if (flipH) ctx.scale(quarter ? 1 : -1, quarter ? -1 : 1)
  ctx.drawImage(img, -img.width / 2, -img.height / 2)
  if (!crop) return r
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(crop.w))
  c.height = Math.max(1, Math.round(crop.h))
  c.getContext('2d')!.drawImage(r, -Math.round(crop.x), -Math.round(crop.y))
  if (isolate) {
    const full = pixels(c)
    if (isolateLargestPiece(full, pixels(downscaled(c, PIECE_MAX)))) c.getContext('2d')!.putImageData(full, 0, 0)
  }
  return c
}

export function FitDielineDialog({ source, session, onClose }: FitDielineProps) {
  const fileName = session?.fileName ?? source?.fileName ?? 'dieline'
  const sourceUrl = session?.source ?? source?.dataUrl ?? ''
  const [step, setStep] = useState<Step>(session ? 'fit' : 'prep')
  const [srcImg, setSrcImg] = useState<HTMLImageElement | null>(null)
  const [rotation, setRotation] = useState<Rotation>(session?.rotation ?? 0)
  const [flipH, setFlipH] = useState(session?.flipH ?? false)
  const [crop, setCrop] = useState<CropRect | null>(session?.crop ?? null)
  const [isolate, setIsolate] = useState(session?.isolate ?? false)
  const [baked, setBaked] = useState<Baked | null>(null)
  const [archId, setArchId] = useState<ArchetypeId>(session?.archetype ?? 'tuck')
  const [paramsBy, setParamsBy] = useState<Partial<Record<ArchetypeId, unknown>>>(
    session ? { [session.archetype]: session.params } : {},
  )
  const [guidesBy, setGuidesBy] = useState<Partial<Record<ArchetypeId, ImageGuides>>>(
    session ? { [session.archetype]: session.guides } : {},
  )
  const [folded, setFolded] = useState<FoldedAway>(session?.folded ?? 'none')
  const [sizeMode, setSizeMode] = useState<SizeMode>(session ? 'manual' : 'fit')
  const [manualH, setManualH] = useState(session?.heightCm ?? 10)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const prepRef = useRef<HTMLCanvasElement>(null)
  const fitRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<
    | { kind: 'crop'; x0: number; y0: number; sx: number; sy: number; moved: boolean }
    | { kind: 'x' | 'y'; id: string }
    | { kind: 'move'; last: { x: number; y: number } }
    | { kind: 'scale'; anchor: { x: number; y: number }; start: number; guides: ImageGuides }
    | null
  >(null)

  useEffect(() => {
    loadImage(sourceUrl)
      .then(setSrcImg)
      .catch(() => setError('Could not decode this image.'))
  }, [sourceUrl])

  // Reopening a session: re-bake silently so the Fit step has its image.
  useEffect(() => {
    if (session && srcImg && !baked) void makeBaked(false)
  }, [srcImg])

  const arch = ARCHETYPES[archId]
  const params = paramsBy[archId] ?? arch.defaults
  const guides = guidesBy[archId] ?? null
  const hasColumns = guides?.x.c4 !== undefined
  // The guides the box is fitted with: as dragged, plus a folded-away end
  // panel's column copied from its twin.
  const eff = useMemo(
    () => (guides ? withFoldedAway(guides, hasColumns ? folded : 'none', arch.glueSide(params)) : null),
    [guides, folded, hasColumns, arch, params],
  )
  const art = useMemo(
    () => (baked && guides && eff ? composeArt(baked, guides, eff, hasColumns ? folded : 'none') : null),
    [baked, guides, eff, folded, hasColumns],
  )

  // ---- Sizing ---------------------------------------------------------------
  const fitH = useMemo(() => (eff ? fitLetterHeight(arch, eff, params) : 10), [arch, eff, params])
  const sharpH = eff ? Math.min(sharpHeight(eff), fitH) : 10
  const heightCm = sizeMode === 'fit' ? fitH : sizeMode === 'sharp' ? sharpH : manualH
  const fitted = useMemo(() => {
    if (!eff) return null
    const { params: p, mismatch } = fitParams(arch, eff, heightCm, params)
    const doc = arch.build(p)
    return { params: p, mismatch, doc, sheet: sheetSize(doc), maps: faceImageMaps(arch, p, doc, eff) }
  }, [arch, eff, heightCm, params])
  const dpi = eff ? artDpi(eff, heightCm) : 0
  // The print canvas caps the art resolution too (≈4096 px across the sheet).
  const texDpi = fitted ? (4096 / Math.max(fitted.sheet.w, fitted.sheet.h)) * 2.54 : Infinity
  const printDpi = Math.min(dpi, texDpi)

  // ---- Prep -----------------------------------------------------------------
  const rotated = useMemo(() => (srcImg ? bake(srcImg, rotation, flipH, null) : null), [srcImg, rotation, flipH])
  const prepScale = rotated ? Math.min(VIEW_W / rotated.width, VIEW_H / rotated.height) : 1
  const detected = useMemo(() => (rotated ? detectPieces(rotated) : { pieces: [], stray: false }), [rotated])
  const pieces = detected.pieces
  const picked =
    isolate && crop && rotated ? pieces.findIndex((p) => sameRect(crop, pieceCrop(p, rotated.width, rotated.height))) : -1

  // Several drawings: start on the biggest (usually the dieline); a click picks
  // another. One drawing with small marks outside it (a logo, a caption): pick
  // it too, so the marks are painted out and don't stretch the guides.
  useEffect(() => {
    if (session || !rotated || !(pieces.length >= 2 || (pieces.length === 1 && detected.stray))) return
    pickPiece(pieces[0])
  }, [detected])

  function pickPiece(p: Piece) {
    if (!rotated) return
    setCrop(pieceCrop(p, rotated.width, rotated.height))
    setIsolate(true)
  }

  useEffect(() => {
    const c = prepRef.current
    if (step !== 'prep' || !c || !rotated) return
    c.width = Math.round(rotated.width * prepScale)
    c.height = Math.round(rotated.height * prepScale)
    const ctx = c.getContext('2d')!
    ctx.drawImage(rotated, 0, 0, c.width, c.height)
    if (pieces.length > 1) {
      ctx.font = 'bold 12px system-ui, sans-serif'
      pieces.forEach((p, i) => {
        const [x, y, w, h] = [p.x, p.y, p.w, p.h].map((v) => v * prepScale)
        ctx.setLineDash([4, 3])
        ctx.lineWidth = 1.5
        ctx.strokeStyle = 'rgba(8,145,178,0.9)'
        ctx.strokeRect(x, y, w, h)
        ctx.setLineDash([])
        ctx.fillStyle = 'rgba(8,145,178,0.95)'
        ctx.fillRect(x, y, 20, 17)
        ctx.fillStyle = '#fff'
        ctx.fillText(String(i + 1), x + (i < 9 ? 6 : 2), y + 13)
      })
    }
    if (crop) {
      const [x, y, w, h] = [crop.x, crop.y, crop.w, crop.h].map((v) => v * prepScale)
      ctx.fillStyle = 'rgba(0,0,0,0.45)'
      ctx.fillRect(0, 0, c.width, y)
      ctx.fillRect(0, y + h, c.width, c.height - y - h)
      ctx.fillRect(0, y, x, h)
      ctx.fillRect(x + w, y, c.width - x - w, h)
      ctx.strokeStyle = '#f59e0b'
      ctx.lineWidth = 2
      ctx.setLineDash([6, 4])
      ctx.strokeRect(x, y, w, h)
      ctx.setLineDash([])
    }
  }, [step, rotated, prepScale, crop, pieces])

  function rotate(delta: 90 | -90) {
    setRotation((((rotation + delta + 360) % 360) as Rotation))
    clearCrop()
  }

  function clearCrop() {
    setCrop(null)
    setIsolate(false)
  }

  async function makeBaked(guess: boolean) {
    if (!srcImg) return
    setBusy(true)
    try {
      const canvas = bake(srcImg, rotation, flipH, crop, isolate && !!crop)
      const url = canvas.toDataURL('image/png')
      const el = await loadImage(url)
      const analysis = await analyzeDielineImage(url)
      const id = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height)
      const mask = foregroundMask({ width: id.width, height: id.height, data: id.data })
      const b: Baked = { url, w: canvas.width, h: canvas.height, el, analysis, mask, pixels: id.data }
      setBaked(b)
      // Dev-only handle for scripted checks (scripts/verify*.mjs).
      if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).paperSimFitBaked = b
      if (guess) {
        // Fresh guesses for every archetype; start on the one that fits best.
        const nextParams: Partial<Record<ArchetypeId, unknown>> = {}
        const nextGuides: Partial<Record<ArchetypeId, ImageGuides>> = {}
        for (const aid of ARCHETYPE_IDS) {
          const f = initialFit(aid, ARCHETYPES[aid].defaults, analysis, b.w, b.h, mask, false, id.data)
          nextParams[aid] = f.params
          nextGuides[aid] = f.guides
        }
        setParamsBy(nextParams)
        setGuidesBy(nextGuides)
        const pick = looksLikeCross(mask, b.w, b.h)
          ? 'cross'
          : looksLikeGable(nextGuides.tuck!, mask, b.w, b.h)
            ? 'gable'
            : 'tuck'
        setArchId(pick)
        setFolded(pick === 'cross' ? 'none' : guessFoldedAway(nextGuides.tuck!, mask, b.w, b.h))
        setSizeMode('fit')
      }
      setStep('fit')
    } catch (err) {
      setError(`Could not prepare the image (${err instanceof Error ? err.message : err}).`)
    } finally {
      setBusy(false)
    }
  }

  // ---- Fit canvas -------------------------------------------------------------
  const fitScale = art ? Math.min(VIEW_W / art.w, VIEW_H / art.h) : 1
  const ox = art?.ox ?? 0
  /** Guides the user can drag (a folded-away panel's copied ones can't be). */
  const draggable = (id: string) => !eff || !guides || eff.x[id] === guides.x[id]
  // Guides that keep their order while dragged: every x-guide in one chain
  // (left to right); y-guides top to bottom within each of the archetype's groups.
  const chains = useMemo(() => {
    const gs = arch.guides(params)
    const flatY = Object.fromEntries(gs.y.map((q) => [q.id, q.pos]))
    const groups = arch.yGroups ?? [gs.y.map((q) => q.id)]
    return {
      x: [...gs.x].sort((a, b) => a.pos - b.pos).map((q) => q.id),
      y: groups.map((ids) => [...ids].sort((a, b) => flatY[b] - flatY[a])),
    }
  }, [arch, params])
  const yLabels = useMemo(() => Object.fromEntries(arch.guides(params).y.map((q) => [q.id, q.label])), [arch, params])

  useEffect(() => {
    const c = fitRef.current
    if (step !== 'fit' || !c || !baked || !guides || !eff || !art || !fitted) return
    c.width = Math.round(art.w * fitScale)
    c.height = Math.round(art.h * fitScale)
    const s = fitScale
    const ctx = c.getContext('2d')!
    ctx.drawImage(art.src, 0, 0, c.width, c.height)
    ctx.fillStyle = 'rgba(255,255,255,0.18)'
    ctx.fillRect(0, 0, c.width, c.height)

    // The archetype's dieline: each face drawn where its art comes from.
    const pos = new Map(fitted.doc.vertices.map((v) => [v.id, v.pos]))
    const kindOf = new Map(fitted.doc.edges.map((e) => [Math.min(e.v1, e.v2) + ':' + Math.max(e.v1, e.v2), e.kind]))
    for (const face of fitted.doc.faces) {
      const m = fitted.maps.get(face.id)!
      const pts = face.vertexIds.map((id) => ({ x: m.ax * pos.get(id)!.x + m.bx + ox, y: m.ay * pos.get(id)!.y + m.by }))
      face.vertexIds.forEach((v1, i) => {
        const v2 = face.vertexIds[(i + 1) % face.vertexIds.length]
        const kind = kindOf.get(Math.min(v1, v2) + ':' + Math.max(v1, v2))
        const a = pts[i]
        const b = pts[(i + 1) % pts.length]
        ctx.beginPath()
        ctx.moveTo(a.x * s, a.y * s)
        ctx.lineTo(b.x * s, b.y * s)
        ctx.setLineDash(kind === 'cut' ? [] : [5, 4])
        ctx.lineWidth = 3.5
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'
        ctx.stroke()
        ctx.lineWidth = 1.6
        ctx.strokeStyle = kind === 'cut' ? '#111' : '#2563eb'
        ctx.stroke()
      })
    }
    ctx.setLineDash([])

    // Guide lines (thin, full length) with labels.
    ctx.font = '11px system-ui, sans-serif'
    for (const [id, gx] of Object.entries(eff.x)) {
      const x = gx + ox
      const fixed = !draggable(id)
      ctx.strokeStyle = fixed ? 'rgba(120,113,108,0.7)' : id === 'glue' ? 'rgba(147,51,234,0.8)' : 'rgba(234,88,12,0.8)'
      ctx.lineWidth = 1
      ctx.setLineDash(fixed ? [3, 3] : [])
      ctx.beginPath()
      ctx.moveTo(x * s, 0)
      ctx.lineTo(x * s, c.height)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = ctx.strokeStyle
      if (!fixed) ctx.fillRect(x * s - 4, 0, 8, 10)
    }
    for (const [id, y] of Object.entries(guides.y)) {
      ctx.strokeStyle = 'rgba(8,145,178,0.85)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, y * s)
      ctx.lineTo(c.width, y * s)
      ctx.stroke()
      ctx.fillStyle = ctx.strokeStyle
      const right = chains.y.findIndex((g) => g.includes(id)) > 0
      const label = yLabels[id] ?? id
      ctx.fillRect(right ? c.width - 10 : 0, y * s - 4, 10, 8)
      ctx.fillText(label, right ? c.width - 13 - ctx.measureText(label).width : 13, y * s - 3)
    }

    // Whole-grid handles: move (circle, body center) and scale (square, body corner).
    const mv = moveHandle(eff)
    const sc = scaleHandle(eff)
    ctx.fillStyle = '#f59e0b'
    ctx.strokeStyle = '#111'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc((mv.x + ox) * s, mv.y * s, 8, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.fillRect((sc.x + ox) * s - 7, sc.y * s - 7, 14, 14)
    ctx.strokeRect((sc.x + ox) * s - 7, sc.y * s - 7, 14, 14)
  }, [step, baked, guides, eff, art, ox, fitted, fitScale, heightCm, yLabels, chains])

  function setGuides(g: ImageGuides) {
    setGuidesBy((prev) => ({ ...prev, [archId]: g }))
  }

  function toImagePx(e: React.PointerEvent<HTMLCanvasElement>, w: number, h: number) {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * w, y: ((e.clientY - r.top) / r.height) * h }
  }

  /** Fit canvas pointer → picture px (the view may be widened on the left by `ox`). */
  function toFitPx(e: React.PointerEvent<HTMLCanvasElement>, a: Art) {
    const p = toImagePx(e, a.w, a.h)
    return { x: p.x - a.ox, y: p.y }
  }

  function onFitDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!baked || !guides || !eff || !art) return
    const p = toFitPx(e, art)
    const view = e.currentTarget.getBoundingClientRect().width / art.w
    const d = (a: { x: number; y: number }) => Math.hypot(a.x - p.x, a.y - p.y) * view
    const sc = scaleHandle(eff)
    if (d(sc) < HANDLE_HIT) {
      const anchor = { x: eff.x.c0, y: guides.y.bodyH }
      dragRef.current = { kind: 'scale', anchor, start: Math.hypot(sc.x - anchor.x, sc.y - anchor.y), guides }
    } else if (d(moveHandle(eff)) < HANDLE_HIT) {
      dragRef.current = { kind: 'move', last: p }
    } else {
      let best: { kind: 'x' | 'y'; id: string; dist: number } | null = null
      for (const [id, x] of Object.entries(guides.x)) {
        if (!draggable(id)) continue
        const dist = Math.abs(x - p.x) * view
        if (dist < GUIDE_HIT && (!best || dist < best.dist)) best = { kind: 'x', id, dist }
      }
      for (const [id, y] of Object.entries(guides.y)) {
        const dist = Math.abs(y - p.y) * view
        if (dist < GUIDE_HIT && (!best || dist < best.dist)) best = { kind: 'y', id, dist }
      }
      if (!best) return
      dragRef.current = { kind: best.kind, id: best.id }
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onFitMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current
    if (!drag || !baked || !guides || !art) {
      if (baked && guides && art) e.currentTarget.style.cursor = hoverCursor(toFitPx(e, art), e)
      return
    }
    const p = toFitPx(e, art)
    if (drag.kind === 'x') setGuides({ ...guides, x: { ...guides.x, [drag.id]: clampX(guides, drag.id, p.x) } })
    else if (drag.kind === 'y') setGuides({ ...guides, y: { ...guides.y, [drag.id]: clampY(guides, drag.id, p.y) } })
    else if (drag.kind === 'move') {
      const dx = p.x - drag.last.x
      const dy = p.y - drag.last.y
      drag.last = p
      setGuides(mapGuides(guides, (x) => x + dx, (y) => y + dy))
    } else if (drag.kind === 'scale') {
      const f = Math.max(0.05, Math.hypot(p.x - drag.anchor.x, p.y - drag.anchor.y) / Math.max(1, drag.start))
      const { anchor } = drag
      setGuides(mapGuides(drag.guides, (x) => anchor.x + (x - anchor.x) * f, (y) => anchor.y + (y - anchor.y) * f))
    }
  }

  function hoverCursor(p: { x: number; y: number }, e: React.PointerEvent<HTMLCanvasElement>): string {
    if (!guides || !eff || !art) return 'default'
    const view = e.currentTarget.getBoundingClientRect().width / art.w
    const near = (a: { x: number; y: number }) => Math.hypot(a.x - p.x, a.y - p.y) * view < HANDLE_HIT
    if (near(scaleHandle(eff))) return 'nwse-resize'
    if (near(moveHandle(eff))) return 'move'
    if (Object.entries(guides.x).some(([id, x]) => draggable(id) && Math.abs(x - p.x) * view < GUIDE_HIT)) return 'col-resize'
    if (Object.values(guides.y).some((y) => Math.abs(y - p.y) * view < GUIDE_HIT)) return 'row-resize'
    return 'default'
  }

  /** Keep a dragged guide between its neighbours in its chain. */
  function clampIn(chain: string[], pos: Record<string, number>, id: string, v: number, dir: 1 | -1): number {
    const i = chain.indexOf(id)
    if (i < 0) return v
    const gap = 2
    const prev = i > 0 ? pos[chain[i - 1]] : undefined
    const next = i < chain.length - 1 ? pos[chain[i + 1]] : undefined
    let lo = -Infinity
    let hi = Infinity
    if (prev !== undefined) (dir > 0 ? (lo = prev + gap) : (hi = prev - gap))
    if (next !== undefined) (dir > 0 ? (hi = next - gap) : (lo = next + gap))
    return Math.min(hi, Math.max(lo, v))
  }

  function clampX(g: ImageGuides, id: string, x: number): number {
    return clampIn(chains.x, g.x, id, x, 1)
  }

  /** Rows run top to bottom in the image (flat y descending). */
  function clampY(g: ImageGuides, id: string, y: number): number {
    const chain = chains.y.find((c) => c.includes(id))
    return chain ? clampIn(chain, g.y, id, y, 1) : y
  }

  function setOption(key: string, value: string) {
    const next = arch.withOptions(params, { [key]: value })
    setParamsBy((prev) => ({ ...prev, [archId]: next }))
    // The glue side changes which strip is which: re-guess columns. (The lid
    // panel doesn't: the columns are already on the picture's folds.)
    if (baked && guides && key === 'glueSide') {
      const f = initialFit(archId, next, baked.analysis, baked.w, baked.h, baked.mask, true, baked.pixels)
      setGuides({ x: f.guides.x, y: guides.y })
    }
  }

  function build() {
    if (!baked || !guides || !eff || !art || !fitted) return
    const st = useAppStore.getState()
    st.newDocument(arch.template, fitted.params as TemplateDims)
    const doc = useAppStore.getState().doc
    useAppStore.getState().setProjectName(projectNameFromFileName(fileName))
    // Each panel shows its own part of the picture, even where the picture's
    // panels disagree with the box's (averaged) sizes. The art is the picture
    // as shown (a folded-away panel painted plain), so guides shift by `ox`.
    const g = mapGuides(eff, (x) => x + ox, (y) => y)
    const maps = faceImageMaps(arch, fitted.params, doc, g)
    const place = fitPlacement(doc, maps, g, heightCm)
    useAppStore.getState().setMaterial({
      ...defaultMaterial(),
      baseColor: '#ffffff',
      overlayImage: art.src instanceof HTMLCanvasElement ? art.src.toDataURL('image/png') : baked.url,
      overlayTransform: overlayFromMap(doc, place, art.w, art.h),
    })
    useAppStore.getState().setUVEdits(faceRegistration(doc, maps, place))
    useAppStore.getState().setFitSession({
      fileName,
      source: sourceUrl,
      rotation,
      flipH,
      crop,
      isolate: isolate && !!crop,
      image: baked.url,
      imageW: baked.w,
      imageH: baked.h,
      archetype: archId,
      params: fitted.params,
      guides,
      heightCm,
      folded: hasColumns ? folded : 'none',
    })
    onClose()
  }

  // ---- Prep pointer: click a drawing, or drag a crop rectangle ----------------
  function onPrepDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!rotated) return
    const p = toImagePx(e, rotated.width, rotated.height)
    dragRef.current = { kind: 'crop', x0: p.x, y0: p.y, sx: e.clientX, sy: e.clientY, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onPrepMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current
    if (!drag || drag.kind !== 'crop' || !rotated) {
      if (rotated && !drag) {
        e.currentTarget.style.cursor = pieceAt(toImagePx(e, rotated.width, rotated.height)) ? 'pointer' : 'crosshair'
      }
      return
    }
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < CLICK_SLOP) return
    drag.moved = true
    setIsolate(false)
    const p = toImagePx(e, rotated.width, rotated.height)
    const x = Math.max(0, Math.min(drag.x0, p.x))
    const y = Math.max(0, Math.min(drag.y0, p.y))
    const w = Math.min(rotated.width, Math.max(drag.x0, p.x)) - x
    const h = Math.min(rotated.height, Math.max(drag.y0, p.y)) - y
    setCrop(w > 8 && h > 8 ? { x, y, w, h } : null)
  }

  function onPrepUp(e: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag || drag.kind !== 'crop' || drag.moved || !rotated) return
    const hit = pieceAt(toImagePx(e, rotated.width, rotated.height))
    if (hit) pickPiece(hit)
  }

  /** The smallest drawing whose box holds `p` (one can sit in another's notch). */
  function pieceAt(p: { x: number; y: number }): Piece | null {
    if (pieces.length < 2) return null
    const inside = pieces.filter((q) => p.x >= q.x && p.x <= q.x + q.w && p.y >= q.y && p.y <= q.y + q.h)
    return inside.sort((a, b) => a.w * a.h - b.w * b.h)[0] ?? null
  }

  const endDrag = () => {
    dragRef.current = null
  }

  const mismatch = fitted?.mismatch ?? 0
  const fitsPage = fitted ? fitsOneLetterPage(fitted.sheet.w, fitted.sheet.h) : true
  const box = fitted?.params as { width: number; depth: number; height: number } | undefined

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal photo-modal fit-modal">
        <h2>Import dieline image — {step === 'prep' ? '1. Prep' : '2. Fit the grid'}</h2>
        {step === 'prep' ? (
          <div className="photo-layout">
            <div className="photo-left">
              <p className="photo-prompt">
                {pieces.length > 1
                  ? `This picture has ${pieces.length} separate drawings — click the one to fold, or drag your own box.`
                  : 'Drag a box around the flat dieline (skip if the picture is only the dieline).'}
              </p>
              <canvas
                ref={prepRef}
                className="photo-canvas fit-canvas prep-canvas"
                data-img-w={rotated?.width}
                data-pieces={JSON.stringify(pieces.map((p) => [p.x, p.y, p.w, p.h].map(Math.round)))}
                data-picked={picked}
                onPointerDown={onPrepDown}
                onPointerMove={onPrepMove}
                onPointerUp={onPrepUp}
                onPointerCancel={endDrag}
              />
            </div>
            <div className="photo-right">
              <p className="hint" style={{ marginTop: 0 }}>
                Many pins show the flat dieline next to a mockup, color variants or other parts —
                pick or crop just the one to fold. A picked drawing is cleaned up: labels and crop
                marks around it are painted out. Rotate so the body panels stand upright in a row
                (lids above and below).
              </p>
              {picked >= 0 && (
                <p className="hint" data-testid="picked-piece">
                  {pieces.length > 1
                    ? `Using drawing ${picked + 1} of ${pieces.length}.`
                    : 'Using the dieline; the small marks outside it are painted out. “Whole image” keeps them.'}
                </p>
              )}
              <div className="btn-row">
                <button onClick={() => rotate(-90)}>⟲ Rotate left</button>
                <button onClick={() => rotate(90)}>⟳ Rotate right</button>
                <button
                  onClick={() => {
                    setFlipH(!flipH)
                    clearCrop()
                  }}
                >
                  ⇋ Flip
                </button>
                <button disabled={!crop} onClick={clearCrop}>
                  Whole image
                </button>
              </div>
              {error && <p className="hint photo-warn">{error}</p>}
              <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
                <button onClick={onClose}>Cancel</button>
                <button className="primary" disabled={!srcImg || busy} onClick={() => void makeBaked(true)}>
                  {busy ? 'Measuring…' : 'Next: fit →'}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="photo-layout">
            <div className="photo-left">
              <p className="photo-prompt">
                Drag the orange column lines and teal row lines onto the picture’s folds. ● moves the
                whole grid, ■ scales it.
              </p>
              <canvas
                ref={fitRef}
                className="photo-canvas fit-canvas"
                data-img-w={baked?.w}
                data-img-h={baked?.h}
                data-guides={guides ? JSON.stringify(guides) : undefined}
                data-view-ox={ox}
                data-view-w={art?.w}
                onPointerDown={onFitDown}
                onPointerMove={onFitMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              />
            </div>
            <div className="photo-right">
              <div className="photo-field fit-field">
                <span>Box</span>
                <div className="seg">
                  {ARCHETYPE_IDS.map((id) => (
                    <button key={id} data-arch={id} className={archId === id ? 'active' : ''} onClick={() => setArchId(id)}>
                      {ARCHETYPES[id].label}
                    </button>
                  ))}
                </div>
              </div>
              {archetypeOptions(arch, params).map((o) => (
                <div key={o.key} className="photo-field fit-field">
                  <span>{o.label}</span>
                  <div className="seg">
                    {o.choices.map((c) => (
                      <button
                        key={c.value}
                        data-opt={`${o.key}=${c.value}`}
                        className={arch.optionsOf(params)[o.key] === c.value ? 'active' : ''}
                        onClick={() => setOption(o.key, c.value)}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {hasColumns && (
                <div className="photo-field fit-field">
                  <span>Drawn flat</span>
                  <div className="seg">
                    {(
                      [
                        ['none', 'All 4 panels'],
                        ['last', 'Panel 4 folded away'],
                        ['first', 'Panel 1 folded away'],
                      ] as const
                    ).map(([v, label]) => (
                      <button
                        key={v}
                        data-folded={v}
                        className={folded === v ? 'active' : ''}
                        title={
                          v === 'none'
                            ? undefined
                            : 'The picture shows this panel folded back (a mockup view): it gets its twin panel’s size and prints plain.'
                        }
                        onClick={() => setFolded(v)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {mismatch > 0.08 && (
                <p className="hint photo-warn" data-testid="fit-mismatch">
                  The picture’s matching panels differ by {Math.round(mismatch * 100)}% — the box uses
                  their average, and each panel’s art is stretched to fill its panel.
                </p>
              )}
              <div className="import-dims fit-dims">
                <label className="import-dim import-dim-primary">
                  <span>Body height (cm)</span>
                  <input
                    type="number"
                    step={0.1}
                    min={1}
                    data-testid="fit-height"
                    value={Math.round(heightCm * 10) / 10}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      if (!Number.isFinite(v) || v <= 0) return
                      setManualH(v)
                      setSizeMode('manual')
                    }}
                  />
                </label>
              </div>
              <div className="btn-row">
                <button className={sizeMode === 'fit' ? 'active' : ''} onClick={() => setSizeMode('fit')}>
                  Fit one Letter page
                </button>
                <button
                  className={sizeMode === 'sharp' ? 'active' : ''}
                  onClick={() => setSizeMode('sharp')}
                  title={`Largest size where the art still prints at ${MIN_PRINT_DPI} dpi or more`}
                >
                  Sharpest print
                </button>
              </div>
              {fitted && box && (
                <p className="hint" data-testid="fit-summary">
                  Box {box.width.toFixed(1)} × {box.depth.toFixed(1)} × {box.height.toFixed(1)} cm · sheet{' '}
                  {fitted.sheet.w.toFixed(1)} × {fitted.sheet.h.toFixed(1)} cm —{' '}
                  {fitsPage ? 'one Letter page.' : <b className="photo-warn">tiles across pages.</b>}
                  <br />
                  Print resolution ≈ <b className={printDpi < MIN_PRINT_DPI ? 'photo-warn' : ''}>{Math.round(printDpi)} dpi</b>
                  {printDpi < MIN_PRINT_DPI && (
                    <span className="photo-warn">
                      {' '}
                      — below {MIN_PRINT_DPI}, the print will look soft. Try “Sharpest print” or a
                      bigger picture.
                    </span>
                  )}
                </p>
              )}
              <p className="hint">
                Decorative cuts in the picture (rounded tucks, thumb notches) become straight edges:
                cut along the printed lines, not the picture’s.
              </p>
              {error && <p className="hint photo-warn">{error}</p>}
              <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                {!session && <button onClick={() => setStep('prep')}>← Back</button>}
                <button onClick={onClose}>Cancel</button>
                <button className="primary" disabled={!fitted} onClick={build}>
                  Build box
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** Center of the body (whole-grid move handle), image px. */
function moveHandle(g: ImageGuides) {
  return { x: (g.x.c0 + bodyRight(g)) / 2, y: (g.y.bodyH + g.y.body0) / 2 }
}

/** Body bottom-right corner (whole-grid scale handle), image px. */
function scaleHandle(g: ImageGuides) {
  return { x: bodyRight(g), y: g.y.body0 }
}

/** Right edge of the body: the last column line (tuck / gable) or the front's (cross). */
function bodyRight(g: ImageGuides): number {
  return g.x.c4 ?? g.x.c1
}

function sameRect(a: CropRect, b: CropRect): boolean {
  return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.w - b.w) < 1 && Math.abs(a.h - b.h) < 1
}

function mapGuides(g: ImageGuides, fx: (x: number) => number, fy: (y: number) => number): ImageGuides {
  return {
    x: Object.fromEntries(Object.entries(g.x).map(([k, v]) => [k, fx(v)])),
    y: Object.fromEntries(Object.entries(g.y).map(([k, v]) => [k, fy(v)])),
  }
}
