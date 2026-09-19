// "Carton from photo" wizard: the user clicks 8 corners on ONE carton in a
// 3/4-view picture (body "Y" + ridge ends), each visible face is unwarped
// onto its flat panel of the parametric gable dieline (model/photoUnwarp.ts),
// and a true-scale carton is built with that artwork. Geometry always comes
// from the gable builder — only the artwork comes from the photo.

import { useEffect, useMemo, useRef, useState } from 'react'
import { sheetBounds } from '../model/document'
import { buildGableCarton, type GableDims } from '../model/gable'
import { defaultMaterial } from '../model/material'
import { projectNameFromFileName } from '../model/naming'
import {
  bodyFaces,
  cartonDims,
  composeCartonArt,
  defaultApex,
  fitLetterDims,
  fitsLetter,
  photoFaces,
  photoProportions,
  POINT_PROMPTS,
  REQUIRED_POINTS,
  sheetSizeCm,
  widerFace,
  type FrontSide,
  type Pt,
  type RGBAImage,
} from '../model/photoUnwarp'
import { useAppStore } from '../state/store'
import { loadImage } from '../viewer/texture'

const MAX_VIEW_W = 700
const MAX_VIEW_H = 600
const HIT_RADIUS = 11 // display px
const HANDLE_CORE = 8 // inside this, a numbered handle beats the apex ring
const RING_RADIUS = 13
const APEX = REQUIRED_POINTS // drag index for the optional 9th (apex) handle

export interface PhotoCartonProps {
  dataUrl: string
  fileName: string
  onClose: () => void
}

export function PhotoCartonDialog({ dataUrl, fileName, onClose }: PhotoCartonProps) {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const srcRef = useRef<RGBAImage | null>(null)
  // All points are stored in IMAGE pixel coords; the view scale is only for drawing.
  const [points, setPoints] = useState<Pt[]>([])
  const [apexOverride, setApexOverride] = useState<Pt | null>(null)
  const [frontOverride, setFrontOverride] = useState<FrontSide | null>(null)
  const [manualDims, setManualDims] = useState<GableDims | null>(null)
  const [error, setError] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    loadImage(dataUrl)
      .then((el) => {
        if (cancelled) return
        const c = document.createElement('canvas')
        c.width = el.width
        c.height = el.height
        const ctx = c.getContext('2d')!
        ctx.drawImage(el, 0, 0)
        const id = ctx.getImageData(0, 0, el.width, el.height)
        srcRef.current = { width: id.width, height: id.height, data: id.data }
        setImg(el)
      })
      .catch(() => setError('Could not decode this image.'))
    return () => {
      cancelled = true
    }
  }, [dataUrl])

  const viewScale = img ? Math.min(MAX_VIEW_W / img.width, MAX_VIEW_H / img.height) : 1
  const complete = points.length >= REQUIRED_POINTS
  const front: FrontSide = frontOverride ?? widerFace(points)
  const apex = complete ? (apexOverride ?? defaultApex(points, front)) : null
  const apexMoved = apexOverride !== null
  const proportions = useMemo(
    () => (complete ? photoProportions(points, front) : null),
    [complete, points, front],
  )
  // Until the user picks a size, follow the clicks at the biggest one-page size.
  const dims: GableDims | null = useMemo(
    () => manualDims ?? (proportions ? fitLetterDims(proportions) : null),
    [manualDims, proportions],
  )
  const fits = dims ? fitsLetter(dims) : true

  // ---- Photo + click overlay --------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!img || !canvas) return
    canvas.width = Math.round(img.width * viewScale)
    canvas.height = Math.round(img.height * viewScale)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const v = (p: Pt): [number, number] => [p.x * viewScale, p.y * viewScale]
    const poly = (pts: Pt[], stroke: string, fill?: string, dash?: number[]) => {
      ctx.beginPath()
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(...v(p)) : ctx.lineTo(...v(p))))
      ctx.closePath()
      if (fill) {
        ctx.fillStyle = fill
        ctx.fill()
      }
      ctx.setLineDash(dash ?? [])
      ctx.strokeStyle = stroke
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.setLineDash([])
    }
    const line = (a: Pt, b: Pt, stroke: string) => {
      ctx.beginPath()
      ctx.moveTo(...v(a))
      ctx.lineTo(...v(b))
      ctx.strokeStyle = stroke
      ctx.lineWidth = 2
      ctx.stroke()
    }
    const label = (text: string, at: Pt, color: string) => {
      ctx.font = 'bold 12px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.lineWidth = 3
      ctx.strokeStyle = 'rgba(0,0,0,0.7)'
      ctx.strokeText(text, ...v(at))
      ctx.fillStyle = color
      ctx.fillText(text, ...v(at))
    }
    const FRONT = '#f59e0b'
    const SIDE = '#3b82f6'
    const p = points
    if (p.length >= 6) {
      const faces = bodyFaces(p, front)
      poly(faces.front, FRONT, 'rgba(245,158,11,0.16)')
      poly(faces.side, SIDE, 'rgba(59,130,246,0.16)')
      const c = (q: Pt[]) => ({ x: q.reduce((s, r) => s + r.x, 0) / q.length, y: q.reduce((s, r) => s + r.y, 0) / q.length })
      label('FRONT', c(faces.front), FRONT)
      label('SIDE', c(faces.side), SIDE)
      if (complete) {
        const all = photoFaces(p, front, apex ?? undefined)
        const r = all.roof
        poly([r.bodyTopL, r.bodyTopR, r.ridgeR, r.ridgeL], FRONT, 'rgba(245,158,11,0.10)', [6, 4])
        poly(all.gusset, SIDE, 'rgba(59,130,246,0.10)', [6, 4])
      } else if (p.length === 7) {
        line(p[6], front === 'right' ? p[4] : p[3], FRONT)
      }
    } else {
      // Partial "Y": bottom corners, then verticals as the top ones arrive.
      for (let i = 1; i < Math.min(p.length, 3); i++) line(p[i - 1], p[i], '#fff')
      for (let i = 3; i < p.length; i++) {
        line(p[i - 3], p[i], '#fff')
        if (i > 3) line(p[i - 1], p[i], '#fff')
      }
    }
    const handle = (q: Pt, text: string, fill: string) => {
      const [x, y] = v(q)
      ctx.beginPath()
      ctx.arc(x, y, 7, 0, Math.PI * 2)
      ctx.fillStyle = fill
      ctx.fill()
      ctx.strokeStyle = '#111'
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.font = 'bold 10px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = '#111'
      ctx.fillText(text, x, y + 0.5)
      ctx.textBaseline = 'alphabetic'
    }
    // The peak starts on a ridge end: show it as a pink ring around that handle
    // (grab the ring to move it); once moved it becomes its own "9" handle.
    if (apex && !apexMoved) {
      ctx.beginPath()
      ctx.arc(...v(apex), RING_RADIUS, 0, Math.PI * 2)
      ctx.strokeStyle = '#ec4899'
      ctx.lineWidth = 4
      ctx.stroke()
    }
    p.forEach((q, i) => handle(q, String(i + 1), '#fff'))
    if (apex && apexMoved) handle(apex, '9', '#f9a8d4')
  }, [img, viewScale, points, front, apex, apexMoved, complete])

  // ---- Flat artwork preview (low-res, debounced) ------------------------------
  useEffect(() => {
    const canvas = previewRef.current
    const src = srcRef.current
    if (!canvas || !src || !complete || !dims) return
    const t = setTimeout(() => {
      try {
        const art = composeCartonArt(src, points, front, dims, { pxPerCm: 12, apex: apex ?? undefined })
        canvas.width = art.image.width
        canvas.height = art.image.height
        const ctx = canvas.getContext('2d')!
        ctx.putImageData(new ImageData(art.image.data, art.image.width, art.image.height), 0, 0)
        // Dieline edges on top so it reads as the printed sheet.
        const doc = buildGableCarton(dims)
        const { min, max } = sheetBounds(doc)
        const sx = canvas.width / (max.x - min.x)
        const sy = canvas.height / (max.y - min.y)
        ctx.lineWidth = 1
        for (const e of doc.edges) {
          const a = doc.vertices.find((q) => q.id === e.v1)!.pos
          const b = doc.vertices.find((q) => q.id === e.v2)!.pos
          ctx.strokeStyle = e.kind === 'cut' ? 'rgba(0,0,0,0.8)' : 'rgba(37,99,235,0.7)'
          ctx.setLineDash(e.kind === 'cut' ? [] : [3, 2])
          ctx.beginPath()
          ctx.moveTo((a.x - min.x) * sx, (max.y - a.y) * sy)
          ctx.lineTo((b.x - min.x) * sx, (max.y - b.y) * sy)
          ctx.stroke()
        }
        ctx.setLineDash([])
        setError(null)
      } catch (err) {
        setError(`Those points don't make a usable shape (${err instanceof Error ? err.message : err}).`)
      }
    }, 120)
    return () => clearTimeout(t)
  }, [complete, points, front, dims, apex])

  // ---- Pointer: place the next point, or drag any existing one ----------------
  function toImage(e: React.PointerEvent<HTMLCanvasElement>): Pt {
    const r = e.currentTarget.getBoundingClientRect()
    return {
      x: ((e.clientX - r.left) / r.width) * (img?.width ?? 1),
      y: ((e.clientY - r.top) / r.height) * (img?.height ?? 1),
    }
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!img) return
    const q = toImage(e)
    const r = e.currentTarget.getBoundingClientRect()
    const toView = r.width / img.width
    const dView = (h: Pt) => Math.hypot(h.x - q.x, h.y - q.y) * toView
    let best = -1
    let bestD = HIT_RADIUS
    points.forEach((h, i) => {
      const d = dView(h)
      if (d < bestD) {
        bestD = d
        best = i
      }
    })
    // A moved apex is an ordinary handle. While it still sits on a ridge end
    // it is a ring: pressing the ring grabs it, the numbered core grabs the ridge.
    const apexD = apex ? dView(apex) : Infinity
    const grabApex = apexMoved
      ? apexD < bestD
      : apexD < RING_RADIUS + 4 && !(best >= 0 && bestD < HANDLE_CORE)
    if (grabApex) best = APEX
    if (best >= 0) dragRef.current = best
    else if (points.length < REQUIRED_POINTS) {
      dragRef.current = points.length
      setPoints([...points, q])
    } else return
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const i = dragRef.current
    if (i === null) return
    const q = toImage(e)
    if (i === APEX) setApexOverride(q)
    else setPoints((ps) => ps.map((p, k) => (k === i ? q : p)))
  }

  function onPointerUp() {
    dragRef.current = null
  }

  // ---- Dimensions -------------------------------------------------------------
  function setField(key: 'width' | 'depth' | 'height', v: number) {
    if (!dims || !Number.isFinite(v) || v <= 0) return
    if (key === 'height') {
      // Height scales the whole carton proportionally.
      const k = v / dims.height
      setManualDims(cartonDims(dims.width * k, dims.depth * k, v))
    } else {
      const next = { ...dims, [key]: v }
      setManualDims(cartonDims(next.width, next.depth, next.height))
    }
  }

  function build() {
    const src = srcRef.current
    if (!src || !complete || !dims) return
    try {
      const art = composeCartonArt(src, points, front, dims, { pxPerCm: 60, apex: apex ?? undefined })
      const c = document.createElement('canvas')
      c.width = art.image.width
      c.height = art.image.height
      c.getContext('2d')!.putImageData(new ImageData(art.image.data, c.width, c.height), 0, 0)
      const overlayImage = c.toDataURL('image/jpeg', 0.92)
      useAppStore.getState().newDocument('gable', dims)
      useAppStore.getState().setProjectName(projectNameFromFileName(fileName))
      useAppStore.getState().setMaterial({ ...defaultMaterial(), baseColor: '#ffffff', overlayImage })
      onClose()
    } catch (err) {
      setError(`Could not build the artwork (${err instanceof Error ? err.message : err}).`)
    }
  }

  const sheet = dims ? sheetSizeCm(dims) : null
  const prompt = complete
    ? 'All 8 set. Drag any handle to fine-tune; drag the pink ring to move the side gable’s peak (optional).'
    : `Click ${points.length + 1} of ${REQUIRED_POINTS}: ${POINT_PROMPTS[points.length]}`

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal photo-modal">
        <h2>Carton from photo</h2>
        <div className="photo-layout">
          <div className="photo-left">
            <p className="photo-prompt" data-testid="photo-prompt">
              {prompt}
            </p>
            <canvas
              ref={canvasRef}
              className="photo-canvas"
              data-img-w={img?.width}
              data-img-h={img?.height}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
            <div className="btn-row">
              <button disabled={points.length === 0} onClick={() => setPoints(points.slice(0, -1))}>
                Undo point
              </button>
              <button
                disabled={points.length === 0}
                onClick={() => {
                  setPoints([])
                  setApexOverride(null)
                }}
              >
                Clear
              </button>
              {apexOverride && <button onClick={() => setApexOverride(null)}>Reset peak (9)</button>}
            </div>
          </div>
          <div className="photo-right">
            <p className="hint" style={{ marginTop: 0 }}>
              Pick ONE carton. Click the body corners as a “Y” (bottom three, then top three), then
              the two ends of the roof ridge. Each face is unwarped onto the dieline; the shape is
              always our foldable gable carton.
            </p>
            <div className="photo-field">
              <span>Front face</span>
              <div className="seg">
                {(['left', 'right'] as const).map((f) => (
                  <button key={f} className={front === f ? 'active' : ''} onClick={() => setFrontOverride(f)}>
                    {f === 'left' ? 'Left' : 'Right'}
                    {frontOverride === null && widerFace(points) === f && points.length >= 6 ? ' (wider)' : ''}
                  </button>
                ))}
              </div>
            </div>
            <div className="import-dims photo-dims">
              {(['height', 'width', 'depth'] as const).map((k) => (
                <label key={k} className="import-dim">
                  <span>{k === 'height' ? 'Height (cm)' : k === 'width' ? 'Width (cm)' : 'Depth (cm)'}</span>
                  <input
                    type="number"
                    step={0.1}
                    min={0.5}
                    disabled={!dims}
                    data-dim={k}
                    value={dims ? Math.round((dims[k] as number) * 100) / 100 : ''}
                    onChange={(e) => setField(k, Number(e.target.value))}
                  />
                </label>
              ))}
            </div>
            <div className="btn-row">
              <button disabled={!complete} onClick={() => setManualDims(null)} title="Photo proportions, as big as fits one landscape Letter page">
                Fit Letter
              </button>
              <button disabled={!complete} onClick={() => setManualDims(cartonDims(5.7, 5.7, 7.5))} title="Pure-Pak 250 mL mini: 5.7 × 5.7 × 7.5 cm">
                250 mL mini (5.7×5.7×7.5)
              </button>
            </div>
            {sheet && (
              <p className={`hint ${fits ? '' : 'photo-warn'}`}>
                Flat sheet {sheet.w.toFixed(1)} × {sheet.h.toFixed(1)} cm —{' '}
                {fits ? 'prints on one Letter page at 100%.' : 'too big for one Letter page; it will tile across pages.'}
              </p>
            )}
            <canvas ref={previewRef} className="import-preview photo-preview" style={{ display: complete ? 'block' : 'none' }} />
            {error && <p className="hint photo-warn">{error}</p>}
            <p className="hint">Builds a fresh carton — unsaved work in the current project is lost.</p>
            <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
              <button onClick={onClose}>Cancel</button>
              <button className="primary" disabled={!complete || !dims} onClick={build}>
                Build carton
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
