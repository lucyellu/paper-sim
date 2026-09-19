// File › Export… — one dialog with a section per kind of output (dieline,
// instructions, 3D mesh, project bundle). Format / artwork / pose are picked
// with toggles instead of one menu item per combination. The dialog stays open
// so several files can be exported in a row.

import { useEffect, useState } from 'react'
import { nextExportName } from '../model/naming'
import { useAppStore, type AppState } from '../state/store'
import { materialNeedsTexture } from '../viewer/texture'
import {
  dielineArtworkDataUrl,
  dielinePDF,
  dielinePDFTrueScale,
  dielineSVG,
  dielineTexturePNG,
  downloadBlob,
  downloadText,
  exportProjectBundle,
  instructionsPDF,
  openInstructionSheet,
} from './exports'
import { exportMesh, type MeshFormat, type MeshPose } from './meshExport'

type DielineFormat = 'svg' | 'pdf' | 'png' | 'pdf-1to1'

const DIELINE_FORMATS: Array<{ id: DielineFormat; label: string; title: string }> = [
  { id: 'pdf-1to1', label: 'Print PDF 1:1', title: 'Exact physical size (1 unit = 1 cm) — print at 100%; tiles across pages when bigger than A4' },
  { id: 'pdf', label: 'PDF', title: 'Fit-to-page PDF' },
  { id: 'svg', label: 'SVG', title: 'Vector line art for Illustrator / Cricut / laser cutters' },
  { id: 'png', label: 'PNG', title: 'Raster image of the flat pattern with the printed design' },
]

const MESH_FORMATS: Array<{ id: MeshFormat; label: string; title: string }> = [
  { id: 'glb', label: 'GLB', title: 'glTF binary (Blender / Roblox)' },
  { id: 'obj', label: 'OBJ', title: 'Wavefront OBJ + MTL' },
  { id: 'fbx', label: 'FBX', title: 'ASCII FBX (Maya)' },
]

// Remembered across dialog opens for the session.
const last = { dieline: 'pdf-1to1' as DielineFormat, art: true, mesh: 'glb' as MeshFormat, pose: 'folded' as MeshPose }

function Seg<T extends string>({
  options,
  value,
  onChange,
  name,
}: {
  options: Array<{ id: T; label: string; title?: string; disabled?: boolean }>
  value: T
  onChange: (v: T) => void
  name: string
}) {
  return (
    <div className="seg" data-seg={name}>
      {options.map((o) => (
        <button
          key={o.id}
          className={value === o.id ? 'active' : ''}
          title={o.title}
          disabled={o.disabled}
          data-value={o.id}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const s = useAppStore()
  const [dieline, setDieline] = useState(last.dieline)
  const [art, setArt] = useState(last.art)
  const [meshFormat, setMeshFormat] = useState(last.mesh)
  const [pose, setPose] = useState(last.pose)
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null)

  useEffect(() => {
    Object.assign(last, { dieline, art, mesh: meshFormat, pose })
  }, [dieline, art, meshFormat, pose])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const hasArt = materialNeedsTexture(s.material)
  const hasSteps = s.steps.length > 0
  // PNG only exists as "with artwork"; the others offer a line-art-only version.
  const withArt = dieline === 'png' || (art && hasArt)

  function run(label: string, job: () => Promise<unknown> | void) {
    setStatus({ text: `Exporting ${label}…` })
    // The executor runs synchronously, so window.open (Print…) keeps the click's user activation.
    new Promise((resolve) => resolve(job()))
      .then(() => setStatus({ text: `Exported ${label}.` }))
      .catch((e) => setStatus({ text: `${label} export failed: ${e instanceof Error ? e.message : e}`, error: true }))
  }

  function exportDieline() {
    const { doc, projectName, material, uvEdits } = s
    const stem = withArt ? 'dieline_art' : 'dieline'
    switch (dieline) {
      case 'svg':
        return run('dieline SVG', async () => {
          const url = withArt ? await dielineArtworkDataUrl(doc, material, uvEdits) : undefined
          downloadText(dielineSVG(doc, url), nextExportName(projectName, stem, 'svg'), 'image/svg+xml')
        })
      case 'pdf':
        return run('dieline PDF', async () => {
          const pdf = withArt ? await dielinePDF(doc, projectName, material, uvEdits) : await dielinePDF(doc, projectName)
          downloadBlob(pdf, nextExportName(projectName, stem, 'pdf'))
        })
      case 'png':
        return run('dieline PNG', async () => {
          downloadBlob(await dielineTexturePNG(doc, material, uvEdits), nextExportName(projectName, 'dieline_art', 'png'))
        })
      case 'pdf-1to1':
        return run('print-ready PDF', async () => {
          const pdf = withArt
            ? await dielinePDFTrueScale(doc, projectName, material, uvEdits)
            : await dielinePDFTrueScale(doc, projectName)
          downloadBlob(pdf, nextExportName(projectName, `${stem}_1to1`, 'pdf'))
        })
    }
  }

  const artHint =
    dieline === 'png'
      ? 'PNG always includes the printed design.'
      : hasArt
        ? null
        : 'No artwork yet — add a design with the dieline editor’s Texture tool.'

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal export-modal" role="dialog" aria-label="Export">
        <h2>Export</h2>

        <section className="dlg-section">
          <div className="dlg-section-title">Dieline</div>
          <div className="dlg-row">
            <span>Format</span>
            <Seg name="dieline-format" options={DIELINE_FORMATS} value={dieline} onChange={setDieline} />
          </div>
          <label className="dlg-check">
            <input
              type="checkbox"
              data-testid="export-art"
              checked={withArt}
              disabled={dieline === 'png' || !hasArt}
              onChange={(e) => setArt(e.target.checked)}
            />
            Include artwork
          </label>
          {artHint && <p className="hint">{artHint}</p>}
          <button className="dlg-go" data-export="dieline" onClick={exportDieline}>
            Export dieline
          </button>
        </section>

        <section className="dlg-section">
          <div className="dlg-section-title">Instructions</div>
          {!hasSteps && <p className="hint">Record at least one keyframe first — instructions show one image per step.</p>}
          <div className="btn-row">
            <button
              data-export="instructions-print"
              disabled={!hasSteps}
              onClick={() =>
                run('instruction sheet', () => openInstructionSheet(s.doc, s.steps, s.projectName, s.material, s.uvEdits))
              }
            >
              Print…
            </button>
            <button
              data-export="instructions-pdf"
              disabled={!hasSteps}
              onClick={() =>
                run('instructions PDF', async () => {
                  const pdf = await instructionsPDF(s.doc, s.steps, s.projectName, s.material, s.uvEdits)
                  if (pdf) downloadBlob(pdf, nextExportName(s.projectName, 'instructions', 'pdf'))
                })
              }
            >
              PDF
            </button>
          </div>
        </section>

        <section className="dlg-section">
          <div className="dlg-section-title">3D mesh</div>
          <div className="dlg-row">
            <span>Format</span>
            <Seg name="mesh-format" options={MESH_FORMATS} value={meshFormat} onChange={setMeshFormat} />
          </div>
          <div className="dlg-row">
            <span>Pose</span>
            <Seg
              name="mesh-pose"
              options={[
                { id: 'folded' as MeshPose, label: 'Folded' },
                { id: 'flat' as MeshPose, label: 'Flat' },
              ]}
              value={pose}
              onChange={setPose}
            />
          </div>
          <button
            className="dlg-go"
            data-export="mesh"
            onClick={() =>
              run(`${meshFormat.toUpperCase()} mesh`, () => exportMesh(useAppStore.getState() as AppState, meshFormat, pose))
            }
          >
            Export mesh
          </button>
        </section>

        <section className="dlg-section">
          <div className="dlg-section-title">Project bundle</div>
          <p className="hint">Everything in one zip: the .fold file, dieline SVG + PDF, a model render and the instructions.</p>
          <button
            className="dlg-go"
            data-export="bundle"
            onClick={() => run('project bundle', () => exportProjectBundle(useAppStore.getState() as AppState))}
          >
            Download zip
          </button>
        </section>

        <div className="btn-row dlg-actions">
          {status && (
            <span className={`dlg-status ${status.error ? 'error' : ''}`} data-testid="export-status">
              {status.text}
            </span>
          )}
          <button onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
