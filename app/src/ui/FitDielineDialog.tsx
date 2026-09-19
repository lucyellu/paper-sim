// "Fit the grid" dieline-image wizard. Prep: rotate / flip / crop the picture
// (baked to a new image every later step uses). Fit: pick the box archetype
// and layout, then drag the archetype's guide lines (column + row folds) onto
// the picture while its real outline is drawn over it — the check-before-you-
// print moment. Size: one real body height; presets for one Letter page and
// for a sharp (≥150 dpi) print. Build: the archetype's parametric dieline with
// the picture registered onto it through the same guides. Geometry always
// comes from the builder; the picture supplies measurements and artwork.

import { useEffect, useMemo, useRef, useState } from 'react'
import { ARCHETYPES, ARCHETYPE_IDS, COLUMN_GUIDES, type ArchetypeId } from '../model/archetypes'
import { analyzeDielineImage, type DielineImageAnalysis } from '../model/dielineImage'
import {
  artDpi,
  fitLetterHeight,
  fitParams,
  flatToImage,
  foregroundMask,
  initialFit,
  looksLikeGable,
  MIN_PRINT_DPI,
  overlayForFit,
  sharpHeight,
  sheetSize,
  type CropRect,
  type FitSession,
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
}

export interface FitDielineProps {
  /** A fresh picture to start from (Prep step)… */
  source?: { dataUrl: string; fileName: string }
  /** …or the previous fit to reopen (Fit step). */
  session?: FitSession
  onClose: () => void
}

/** Draw the picture rotated / flipped, then cropped. */
function bake(img: HTMLImageElement, rotation: Rotation, flipH: boolean, crop: CropRect | null): HTMLCanvasElement {
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
  const [baked, setBaked] = useState<Baked | null>(null)
  const [archId, setArchId] = useState<ArchetypeId>(session?.archetype ?? 'tuck')
  const [paramsBy, setParamsBy] = useState<Partial<Record<ArchetypeId, unknown>>>(
    session ? { [session.archetype]: session.params } : {},
  )
  const [guidesBy, setGuidesBy] = useState<Partial<Record<ArchetypeId, ImageGuides>>>(
    session ? { [session.archetype]: session.guides } : {},
  )
  const [sizeMode, setSizeMode] = useState<SizeMode>(session ? 'manual' : 'fit')
  const [manualH, setManualH] = useState(session?.heightCm ?? 10)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const prepRef = useRef<HTMLCanvasElement>(null)
  const fitRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<
    | { kind: 'crop'; x0: number; y0: number }
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

  // ---- Sizing ---------------------------------------------------------------
  const fitH = useMemo(() => (guides ? fitLetterHeight(arch, guides, params) : 10), [arch, guides, params])
  const sharpH = guides ? Math.min(sharpHeight(guides), fitH) : 10
  const heightCm = sizeMode === 'fit' ? fitH : sizeMode === 'sharp' ? sharpH : manualH
  const fitted = useMemo(() => {
    if (!guides) return null
    const { params: p, mismatch } = fitParams(arch, guides, heightCm, params)
    const doc = arch.build(p)
    return { params: p, mismatch, doc, sheet: sheetSize(doc) }
  }, [arch, guides, heightCm, params])
  const dpi = guides ? artDpi(guides, heightCm) : 0
  // The print canvas caps the art resolution too (≈4096 px across the sheet).
  const texDpi = fitted ? (4096 / Math.max(fitted.sheet.w, fitted.sheet.h)) * 2.54 : Infinity
  const printDpi = Math.min(dpi, texDpi)

  // ---- Prep -----------------------------------------------------------------
  const rotated = useMemo(() => (srcImg ? bake(srcImg, rotation, flipH, null) : null), [srcImg, rotation, flipH])
  const prepScale = rotated ? Math.min(VIEW_W / rotated.width, VIEW_H / rotated.height) : 1

  useEffect(() => {
    const c = prepRef.current
    if (step !== 'prep' || !c || !rotated) return
    c.width = Math.round(rotated.width * prepScale)
    c.height = Math.round(rotated.height * prepScale)
    const ctx = c.getContext('2d')!
    ctx.drawImage(rotated, 0, 0, c.width, c.height)
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
  }, [step, rotated, prepScale, crop])

  function rotate(delta: 90 | -90) {
    setRotation((((rotation + delta + 360) % 360) as Rotation))
    setCrop(null)
  }

  async function makeBaked(guess: boolean) {
    if (!srcImg) return
    setBusy(true)
    try {
      const canvas = bake(srcImg, rotation, flipH, crop)
      const url = canvas.toDataURL('image/png')
      const el = await loadImage(url)
      const analysis = await analyzeDielineImage(url)
      const id = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height)
      const mask = foregroundMask({ width: id.width, height: id.height, data: id.data })
      const b: Baked = { url, w: canvas.width, h: canvas.height, el, analysis, mask }
      setBaked(b)
      if (guess) {
        // Fresh guesses for every archetype; start on the one that fits best.
        const nextParams: Partial<Record<ArchetypeId, unknown>> = {}
        const nextGuides: Partial<Record<ArchetypeId, ImageGuides>> = {}
        for (const aid of ARCHETYPE_IDS) {
          const f = initialFit(aid, ARCHETYPES[aid].defaults, analysis, b.w, b.h, mask)
          nextParams[aid] = f.params
          nextGuides[aid] = f.guides
        }
        setParamsBy(nextParams)
        setGuidesBy(nextGuides)
        setArchId(looksLikeGable(nextGuides.tuck!, mask, b.w, b.h) ? 'gable' : 'tuck')
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
  const fitScale = baked ? Math.min(VIEW_W / baked.w, VIEW_H / baked.h) : 1
  const yOrder = useMemo(() => arch.guides(params).y.sort((a, b) => b.pos - a.pos).map((q) => q.id), [arch, params])
  const yLabels = useMemo(() => Object.fromEntries(arch.guides(params).y.map((q) => [q.id, q.label])), [arch, params])

  useEffect(() => {
    const c = fitRef.current
    if (step !== 'fit' || !c || !baked || !guides || !fitted) return
    c.width = Math.round(baked.w * fitScale)
    c.height = Math.round(baked.h * fitScale)
    const s = fitScale
    const ctx = c.getContext('2d')!
    ctx.drawImage(baked.el, 0, 0, c.width, c.height)
    ctx.fillStyle = 'rgba(255,255,255,0.18)'
    ctx.fillRect(0, 0, c.width, c.height)

    // The archetype's dieline, mapped through the guides.
    const toImg = flatToImage(guides, heightCm)
    const pos = new Map(fitted.doc.vertices.map((v) => [v.id, toImg(v.pos)]))
    for (const e of fitted.doc.edges) {
      const a = pos.get(e.v1)!
      const b = pos.get(e.v2)!
      ctx.beginPath()
      ctx.moveTo(a.x * s, a.y * s)
      ctx.lineTo(b.x * s, b.y * s)
      ctx.setLineDash(e.kind === 'cut' ? [] : [5, 4])
      ctx.lineWidth = 3.5
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'
      ctx.stroke()
      ctx.lineWidth = 1.6
      ctx.strokeStyle = e.kind === 'cut' ? '#111' : '#2563eb'
      ctx.stroke()
    }
    ctx.setLineDash([])

    // Guide lines (thin, full length) with labels.
    ctx.font = '11px system-ui, sans-serif'
    for (const [id, x] of Object.entries(guides.x)) {
      ctx.strokeStyle = id === 'glue' ? 'rgba(147,51,234,0.8)' : 'rgba(234,88,12,0.8)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x * s, 0)
      ctx.lineTo(x * s, c.height)
      ctx.stroke()
      ctx.fillStyle = ctx.strokeStyle
      ctx.fillRect(x * s - 4, 0, 8, 10)
    }
    for (const [id, y] of Object.entries(guides.y)) {
      ctx.strokeStyle = 'rgba(8,145,178,0.85)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, y * s)
      ctx.lineTo(c.width, y * s)
      ctx.stroke()
      ctx.fillStyle = ctx.strokeStyle
      ctx.fillRect(0, y * s - 4, 10, 8)
      ctx.fillText(yLabels[id] ?? id, 13, y * s - 3)
    }

    // Whole-grid handles: move (circle, body center) and scale (square, body corner).
    const mv = moveHandle(guides)
    const sc = scaleHandle(guides)
    ctx.fillStyle = '#f59e0b'
    ctx.strokeStyle = '#111'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(mv.x * s, mv.y * s, 8, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.fillRect(sc.x * s - 7, sc.y * s - 7, 14, 14)
    ctx.strokeRect(sc.x * s - 7, sc.y * s - 7, 14, 14)
  }, [step, baked, guides, fitted, fitScale, heightCm, yLabels])

  function setGuides(g: ImageGuides) {
    setGuidesBy((prev) => ({ ...prev, [archId]: g }))
  }

  function toImagePx(e: React.PointerEvent<HTMLCanvasElement>, w: number, h: number) {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * w, y: ((e.clientY - r.top) / r.height) * h }
  }

  function onFitDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!baked || !guides) return
    const p = toImagePx(e, baked.w, baked.h)
    const view = e.currentTarget.getBoundingClientRect().width / baked.w
    const d = (a: { x: number; y: number }) => Math.hypot(a.x - p.x, a.y - p.y) * view
    const sc = scaleHandle(guides)
    if (d(sc) < HANDLE_HIT) {
      const anchor = { x: guides.x.c0, y: guides.y.bodyH }
      dragRef.current = { kind: 'scale', anchor, start: Math.hypot(sc.x - anchor.x, sc.y - anchor.y), guides }
    } else if (d(moveHandle(guides)) < HANDLE_HIT) {
      dragRef.current = { kind: 'move', last: p }
    } else {
      let best: { kind: 'x' | 'y'; id: string; dist: number } | null = null
      for (const [id, x] of Object.entries(guides.x)) {
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
    if (!drag || !baked || !guides) {
      if (baked && guides) e.currentTarget.style.cursor = hoverCursor(toImagePx(e, baked.w, baked.h), e)
      return
    }
    const p = toImagePx(e, baked.w, baked.h)
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
    if (!guides || !baked) return 'default'
    const view = e.currentTarget.getBoundingClientRect().width / baked.w
    const near = (a: { x: number; y: number }) => Math.hypot(a.x - p.x, a.y - p.y) * view < HANDLE_HIT
    if (near(scaleHandle(guides))) return 'nwse-resize'
    if (near(moveHandle(guides))) return 'move'
    if (Object.values(guides.x).some((x) => Math.abs(x - p.x) * view < GUIDE_HIT)) return 'col-resize'
    if (Object.values(guides.y).some((y) => Math.abs(y - p.y) * view < GUIDE_HIT)) return 'row-resize'
    return 'default'
  }

  /** Keep column guides in order (glue stays outside the body). */
  function clampX(g: ImageGuides, id: string, x: number): number {
    const gap = 2
    const order = [...COLUMN_GUIDES] as string[]
    const glueRight = arch.glueSide(params) === 'right'
    if (id === 'glue') return glueRight ? Math.max(g.x.c4 + gap, x) : Math.min(g.x.c0 - gap, x)
    const i = order.indexOf(id)
    let lo = i > 0 ? g.x[order[i - 1]] + gap : -Infinity
    let hi = i < order.length - 1 ? g.x[order[i + 1]] - gap : Infinity
    if (id === 'c4' && glueRight) hi = g.x.glue - gap
    if (id === 'c0' && !glueRight) lo = g.x.glue + gap
    return Math.min(hi, Math.max(lo, x))
  }

  /** Keep row guides in their top-to-bottom order. */
  function clampY(g: ImageGuides, id: string, y: number): number {
    const i = yOrder.indexOf(id)
    const lo = i > 0 ? g.y[yOrder[i - 1]] + 2 : -Infinity
    const hi = i < yOrder.length - 1 ? g.y[yOrder[i + 1]] - 2 : Infinity
    return Math.min(hi, Math.max(lo, y))
  }

  function setOption(key: string, value: string) {
    const next = arch.withOptions(params, { [key]: value })
    setParamsBy((prev) => ({ ...prev, [archId]: next }))
    // Glue side / panel order change which strip is which: re-guess columns.
    if (baked && guides && (key === 'glueSide' || key === 'order')) {
      const f = initialFit(archId, next, baked.analysis, baked.w, baked.h, baked.mask, true)
      setGuides({ x: f.guides.x, y: guides.y })
    }
  }

  function build() {
    if (!baked || !guides || !fitted) return
    const st = useAppStore.getState()
    st.newDocument(arch.template, fitted.params as TemplateDims)
    const doc = useAppStore.getState().doc
    useAppStore.getState().setProjectName(projectNameFromFileName(fileName))
    useAppStore.getState().setMaterial({
      ...defaultMaterial(),
      baseColor: '#ffffff',
      overlayImage: baked.url,
      overlayTransform: overlayForFit(doc, guides, heightCm, baked.w, baked.h),
    })
    useAppStore.getState().setFitSession({
      fileName,
      source: sourceUrl,
      rotation,
      flipH,
      crop,
      image: baked.url,
      imageW: baked.w,
      imageH: baked.h,
      archetype: archId,
      params: fitted.params,
      guides,
      heightCm,
    })
    onClose()
  }

  // ---- Prep pointer: drag a crop rectangle ------------------------------------
  function onPrepDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!rotated) return
    const p = toImagePx(e, rotated.width, rotated.height)
    dragRef.current = { kind: 'crop', x0: p.x, y0: p.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onPrepMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current
    if (!drag || drag.kind !== 'crop' || !rotated) return
    const p = toImagePx(e, rotated.width, rotated.height)
    const x = Math.max(0, Math.min(drag.x0, p.x))
    const y = Math.max(0, Math.min(drag.y0, p.y))
    const w = Math.min(rotated.width, Math.max(drag.x0, p.x)) - x
    const h = Math.min(rotated.height, Math.max(drag.y0, p.y)) - y
    setCrop(w > 8 && h > 8 ? { x, y, w, h } : null)
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
              <p className="photo-prompt">Drag a box around the flat dieline (skip if the picture is only the dieline).</p>
              <canvas
                ref={prepRef}
                className="photo-canvas fit-canvas"
                onPointerDown={onPrepDown}
                onPointerMove={onPrepMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              />
            </div>
            <div className="photo-right">
              <p className="hint" style={{ marginTop: 0 }}>
                Many pins show the flat dieline next to a mockup — crop to just the flat part. Rotate
                so the body panels stand upright in a row (lids above and below).
              </p>
              <div className="btn-row">
                <button onClick={() => rotate(-90)}>⟲ Rotate left</button>
                <button onClick={() => rotate(90)}>⟳ Rotate right</button>
                <button
                  onClick={() => {
                    setFlipH(!flipH)
                    setCrop(null)
                  }}
                >
                  ⇋ Flip
                </button>
                <button disabled={!crop} onClick={() => setCrop(null)}>
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
              {arch.options.map((o) => (
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
              {mismatch > 0.08 && (
                <p className="hint photo-warn" data-testid="fit-mismatch">
                  The picture’s matching panels differ by {Math.round(mismatch * 100)}% — the box uses
                  their average, so the art can shift a little at the folds.
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
  return { x: (g.x.c0 + g.x.c4) / 2, y: (g.y.bodyH + g.y.body0) / 2 }
}

/** Body bottom-right corner (whole-grid scale handle), image px. */
function scaleHandle(g: ImageGuides) {
  return { x: g.x.c4, y: g.y.body0 }
}

function mapGuides(g: ImageGuides, fx: (x: number) => number, fy: (y: number) => number): ImageGuides {
  return {
    x: Object.fromEntries(Object.entries(g.x).map(([k, v]) => [k, fx(v)])),
    y: Object.fromEntries(Object.entries(g.y).map(([k, v]) => [k, fy(v)])),
  }
}
