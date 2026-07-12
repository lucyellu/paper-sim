// Import-dieline-image wizard: shows what the analyzer detected in a raster
// dieline (content box, wall fold lines, body band), lets the user set the
// real body height (cm; everything else scales proportionally) and fine-tune
// the derived dimensions, then rebuilds the parametric gable carton at those
// dims with the artwork auto-registered onto the sheet. The geometry is always
// the parametric builder's — guaranteed foldable — so preview = printout.

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  gableDimsFromAnalysis,
  type DielineImageAnalysis,
} from '../model/dielineImage'
import type { GableDims } from '../model/gable'
import { defaultMaterial } from '../model/material'
import { projectNameFromFileName } from '../model/naming'
import { useAppStore } from '../state/store'
import { loadImage } from '../viewer/texture'

const DEFAULT_HEIGHT_CM = 13

export interface ImportDielineProps {
  dataUrl: string
  fileName: string
  analysis: DielineImageAnalysis
  onClose: () => void
}

export function ImportDielineDialog({ dataUrl, fileName, analysis, onClose }: ImportDielineProps) {
  const detected = analysis.ratios !== null
  const initialDims = useMemo<GableDims>(
    () =>
      gableDimsFromAnalysis(analysis, DEFAULT_HEIGHT_CM) ?? {
        // Standard tall/rect carton with the builder defaults spelled out so
        // every field in the wizard has a concrete, editable value.
        width: 5,
        depth: 3.2,
        height: DEFAULT_HEIGHT_CM,
        gable: 2.4,
        rib: 0.9,
        botFB: 2.2,
        botLR: 1.8,
        glue: 1.2,
      },
    [analysis],
  )
  const [dims, setDims] = useState<GableDims>(initialDims)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Preview: the image with the detected content box + panel lines drawn over.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const img = await loadImage(dataUrl).catch(() => null)
      const canvas = canvasRef.current
      if (!img || !canvas || cancelled) return
      const maxW = 460
      const s = Math.min(maxW / img.width, 300 / img.height)
      canvas.width = Math.round(img.width * s)
      canvas.height = Math.round(img.height * s)
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      // Analysis coordinates are in the analyzer's downscaled space.
      const ax = canvas.width / analysis.imageW
      const ay = canvas.height / analysis.imageH
      if (analysis.content) {
        const b = analysis.content
        ctx.strokeStyle = '#16a34a'
        ctx.lineWidth = 1.5
        ctx.strokeRect(b.x * ax, b.y * ay, b.w * ax, b.h * ay)
      }
      ctx.strokeStyle = '#e8930c'
      ctx.lineWidth = 1.5
      for (const x of analysis.vLines) {
        ctx.beginPath()
        ctx.moveTo(x * ax, (analysis.hBody?.top ?? 0) * ay)
        ctx.lineTo(x * ax, (analysis.hBody?.bottom ?? analysis.imageH) * ay)
        ctx.stroke()
      }
      if (analysis.hBody) {
        for (const y of [analysis.hBody.top, analysis.hBody.bottom]) {
          ctx.beginPath()
          ctx.moveTo((analysis.content?.x ?? 0) * ax, y * ay)
          ctx.lineTo(((analysis.content?.x ?? 0) + (analysis.content?.w ?? analysis.imageW)) * ax, y * ay)
          ctx.stroke()
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [dataUrl, analysis])

  function setHeight(h: number) {
    if (!Number.isFinite(h) || h <= 0) return
    // Height drives everything else proportionally (re-derived from the image).
    const scaled = gableDimsFromAnalysis(analysis, h)
    setDims(scaled ?? { ...dims, height: h })
  }

  function patch(key: keyof GableDims, v: number) {
    if (!Number.isFinite(v) || v <= 0) return
    setDims({ ...dims, [key]: v })
  }

  function build() {
    const s = useAppStore.getState()
    s.newDocument('gable', dims)
    useAppStore.getState().setProjectName(projectNameFromFileName(fileName))
    useAppStore.getState().setMaterial({
      ...defaultMaterial(),
      baseColor: '#f4efe6',
      overlayImage: dataUrl,
      overlayTransform: analysis.overlay,
    })
    onClose()
  }

  const num = (label: string, key: keyof GableDims, title?: string) => (
    <label className="import-dim" title={title}>
      <span>{label}</span>
      <input
        type="number"
        step={0.1}
        min={0.1}
        value={round2(dims[key] as number | undefined)}
        onChange={(e) => patch(key, Number(e.target.value))}
      />
    </label>
  )

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2>Import dieline image</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          {detected
            ? analysis.confidence === 'good'
              ? 'Panel grid detected (green = drawing bounds, orange = wall folds / body band). Set the real body height — everything scales with it.'
              : 'A panel grid was found but it is not cleanly W·D·W·D — check the numbers below against the picture before building.'
            : 'No usable panel grid found in this image — starting from the standard carton. The artwork is still auto-fitted to the drawing bounds; tweak it later with the Texture tool.'}
        </p>
        <canvas ref={canvasRef} className="import-preview" />
        <div className="import-dims">
          <label className="import-dim import-dim-primary">
            <span>Body height (cm)</span>
            <input
              type="number"
              step={0.5}
              min={1}
              value={round2(dims.height)}
              onChange={(e) => setHeight(Number(e.target.value))}
            />
          </label>
          {num('Width', 'width', 'Front/back panel width')}
          {num('Depth', 'depth', 'Side panel width')}
          {num('Gable', 'gable', 'Roof flat height (must exceed half the depth)')}
          {num('Rib', 'rib', 'Seal strip height')}
          {num('Flap F/B', 'botFB', 'Bottom flap height, front/back')}
          {num('Flap sides', 'botLR', 'Bottom flap height, sides')}
          {num('Glue', 'glue', 'Glue flap width')}
        </div>
        <p className="hint">
          Builds a fresh carton at these dimensions with the image registered onto it — unsaved
          work in the current project is lost.
        </p>
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={build}>
            Build carton
          </button>
        </div>
      </div>
    </div>
  )
}

function round2(n: number | undefined): number {
  return n === undefined ? 0 : Math.round(n * 100) / 100
}
