// Instructions mode: an in-app preview of the step-by-step instruction sheet
// (dieline + one numbered 3D snapshot per fold step) with buttons to open the
// printable page or download the PDF. Snapshots come from the live viewer via
// viewer/capture, so the sheet always reflects the current model + material.

import { useEffect, useState } from 'react'
import { nextExportName } from '../model/naming'
import { useAppStore } from '../state/store'
import { captureAvailable, capturePoses } from '../viewer/capture'
import { materialNeedsTexture } from '../viewer/texture'
import {
  dielineArtworkDataUrl,
  dielineSVG,
  downloadBlob,
  instructionsPDF,
  openInstructionSheet,
} from './exports'

export function InstructionsView() {
  const s = useAppStore()
  const [shots, setShots] = useState<string[]>([])
  const [artUrl, setArtUrl] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (s.steps.length === 0 || !captureAvailable()) {
      setShots([])
      return
    }
    // The 3D viewer stays mounted underneath this overlay, so it can render
    // every pose offscreen (same path as the instruction-sheet export).
    try {
      setShots(capturePoses([{}, ...s.steps.map((st) => st.angles)], { w: 720, h: 540 }))
    } catch {
      setShots([])
    }
  }, [s.doc, s.steps, s.material, s.uvEdits])

  // The dieline preview carries the printed design when the project has one.
  useEffect(() => {
    if (!materialNeedsTexture(s.material)) {
      setArtUrl(undefined)
      return
    }
    let stale = false
    void dielineArtworkDataUrl(s.doc, s.material, s.uvEdits).then((url) => {
      if (!stale) setArtUrl(url)
    })
    return () => {
      stale = true
    }
  }, [s.doc, s.material, s.uvEdits])

  const svg = dielineSVG(s.doc, artUrl)

  return (
    <div className="instructions-view">
      <div className="pe-toolbar">
        <span className="pe-title">Instructions</span>
        <button
          disabled={s.steps.length === 0}
          onClick={() =>
            void openInstructionSheet(s.doc, s.steps, s.projectName, s.material, s.uvEdits)
          }
          title="Open the printable instruction sheet in a new tab"
        >
          🖨 Print view
        </button>
        <button
          disabled={s.steps.length === 0}
          onClick={() =>
            instructionsPDF(s.doc, s.steps, s.projectName, s.material, s.uvEdits)
              .then((pdf) => {
                if (pdf) downloadBlob(pdf, nextExportName(s.projectName, 'instructions', 'pdf'))
              })
              .catch((e) => alert(`PDF export failed: ${e}`))
          }
        >
          ⤓ PDF
        </button>
        <span className="pe-sep" />
        <button onClick={() => s.setWorkspaceMode('fold')}>✔ Done</button>
      </div>

      <div className="iv-scroll">
      <div className="iv-body">
        <h1>{s.projectName} — folding instructions</h1>
        <h2>Dieline</h2>
        <p className="iv-legend">
          <b>solid</b> = cut &nbsp;·&nbsp; <b style={{ color: '#2563eb' }}>dashed blue</b> = valley
          fold &nbsp;·&nbsp; <b style={{ color: '#dc2626' }}>dashed red</b> = mountain fold
        </p>
        <div className="iv-dieline" dangerouslySetInnerHTML={{ __html: svg }} />
        <h2>Folding steps</h2>
        {s.steps.length === 0 ? (
          <p className="iv-empty">
            No fold steps yet — switch to Fold mode, fold the model, and record keyframes; each
            step becomes one numbered picture here.
          </p>
        ) : (
          <div className="iv-steps">
            {shots.map((url, i) => (
              <figure className="iv-step" key={i}>
                <img src={url} alt={`Step ${i}`} />
                <figcaption>
                  <span className="iv-num">{i === 0 ? '·' : i}</span>
                  {i === 0 ? 'Start: flat sheet' : s.steps[i - 1].name}
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>
      </div>
    </div>
  )
}
