// Maya-style top menu bar: File / Edit / Export dropdowns. The heavy export
// logic lives in ui/exports.ts and ui/meshExport helpers; this just wires menu
// items to those and to store actions. Transform tools and select modes live
// in the always-visible ViewBar instead of a menu.

import { useEffect, useRef, useState } from 'react'
import { nextExportName } from '../model/naming'
import { useAppStore, type AppState, type Template, type TemplateDims } from '../state/store'
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
import { materialNeedsTexture } from '../viewer/texture'
import { analyzeDielineImage, type DielineImageAnalysis } from '../model/dielineImage'
import { ImportDielineDialog } from './ImportDielineDialog'
import { exportMesh, type MeshFormat, type MeshPose } from './meshExport'

interface MenuItemDef {
  label: string
  onClick?: () => void
  disabled?: boolean
  separator?: boolean
  title?: string
  /** Radio-style check mark (used by the Mode menu). */
  checked?: boolean
}

/** A single top-bar dropdown menu. */
function Menu({
  label,
  items,
  open,
  onToggle,
  onClose,
}: {
  label: string
  items: MenuItemDef[]
  open: boolean
  onToggle: () => void
  onClose: () => void
}) {
  return (
    <div className={`menu ${open ? 'open' : ''}`}>
      <button className="menu-label" onClick={onToggle}>
        {label}
      </button>
      {open && (
        <div className="menu-drop" role="menu">
          {items.map((it, i) =>
            it.separator ? (
              <div key={i} className="menu-sep" />
            ) : (
              <button
                key={i}
                className="menu-item"
                disabled={it.disabled}
                title={it.title}
                onClick={() => {
                  onClose()
                  it.onClick?.()
                }}
              >
                {it.checked !== undefined && (
                  <span className="menu-check">{it.checked ? '✓' : ''}</span>
                )}
                {it.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  )
}

export function TopBar() {
  const s = useAppStore()
  const fileInput = useRef<HTMLInputElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [importDialog, setImportDialog] = useState<{
    dataUrl: string
    fileName: string
    analysis: DielineImageAnalysis
  } | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  // Click-away closes any open menu.
  useEffect(() => {
    if (!openMenu) return
    function onDown(e: PointerEvent) {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpenMenu(null)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [openMenu])

  function newDoc(template: Template, label: string, dims?: TemplateDims) {
    if (confirm(`Start a new ${label}? Unsaved work will be lost.`)) s.newDocument(template, dims)
  }

  async function onImportImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const dataUrl = await fileToDataUrl(file)
      const analysis = await analyzeDielineImage(dataUrl)
      setImportDialog({ dataUrl, fileName: file.name, analysis })
    } catch (err) {
      alert(`Could not read image: ${err instanceof Error ? err.message : err}`)
    }
  }

  async function onLoadFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const json = JSON.parse(await file.text())
      s.loadFile(json, file.name)
    } catch (err) {
      alert(`Could not load file: ${err instanceof Error ? err.message : err}`)
    }
  }

  function mesh(format: MeshFormat, pose: MeshPose) {
    exportMesh(useAppStore.getState() as AppState, format, pose).catch((err) =>
      alert(`Export failed: ${err instanceof Error ? err.message : err}`),
    )
  }

  function needSteps(fn: () => boolean) {
    if (!fn()) alert('Record at least one keyframe first — instructions show one image per step.')
  }

  const fileItems: MenuItemDef[] = [
    { label: 'New — Tuck box', onClick: () => newDoc('tuck', 'tuck box') },
    {
      label: 'New — Milk carton — 1 L (tall)',
      title:
        'Tall slim gable carton (~1 litre) — a wider front than sides, the shape most printed drink cartons use (e.g. the strawberry-milk dieline). Units are cm. Add artwork with the dieline editor’s Texture tool.',
      onClick: () => newDoc('gable', 'milk carton 1L', { width: 5, depth: 3.2, height: 13 }),
    },
    {
      label: 'New — Milk carton — 250 mL (squat)',
      title:
        'Small square-base gable carton on the real Pure-Pak 250 mL mini standard: ~57×57 mm base, ~122 mm tall (1 unit = 1 cm). The short school-milk carton, distinct from the tall 1 L one.',
      onClick: () => newDoc('gable', 'milk carton 250ml', { width: 5.7, depth: 5.7, height: 7.5 }),
    },
    { label: 'New — Can label (tube)', title: 'Faceted cylinder — wrap a label around a can', onClick: () => newDoc('can', 'can label') },
    {
      label: 'New — Juice box sleeve',
      title:
        'Open-ended band that slips over a standard 200 ml juice box (like a phone case for your drink) — print, fold, glue, slide on',
      onClick: () => newDoc('sleeve', 'juice box sleeve', { width: 5.5, depth: 4.3, height: 7, seam: true }),
    },
    {
      label: 'New — Can sleeve (12 oz)',
      title:
        'Faceted band sized to slip over a standard 12 oz drink can — print, fold, glue, slide on',
      onClick: () => newDoc('can', 'can sleeve', { facets: 24, height: 9, radius: 3.45, seam: true }),
    },
    { label: '', separator: true },
    {
      label: 'Import dieline image…',
      title:
        'Measure a flat dieline picture (jpg/png), rebuild the carton at its proportions, and register the artwork onto it',
      onClick: () => imageInput.current?.click(),
    },
    { label: '', separator: true },
    { label: 'Open…', onClick: () => fileInput.current?.click(), title: 'Open a PaperSim or FOLD file' },
    { label: 'Save (.fold)', onClick: () => s.saveFile() },
  ]

  const editItems: MenuItemDef[] = [
    { label: 'Undo', onClick: () => s.undo(), disabled: !s.canUndo(), title: 'Ctrl+Z' },
    { label: 'Redo', onClick: () => s.redo(), disabled: !s.canRedo(), title: 'Ctrl+Y' },
    { label: '', separator: true },
    {
      label: 'Delete history (bake)',
      disabled: s.history.log.length === 0,
      onClick: () => {
        if (confirm(`Bake ${s.history.log.length} action(s) into the current state and clear history?`))
          s.deleteHistory()
      },
    },
  ]

  const modeItems: MenuItemDef[] = [
    {
      label: 'Fold mode',
      checked: s.workspaceMode === 'fold',
      title: 'Fold the model, edit the dieline, record steps (the default workspace)',
      onClick: () => s.setWorkspaceMode('fold'),
    },
    {
      label: 'Flat mode',
      checked: s.workspaceMode === 'flat',
      title:
        'Work on the flat sheet: move the artwork to fit the dieline (default), reshape the geometry to trace the artwork, or fine-tune per-panel UVs. Prints stay matched to the 3D preview.',
      onClick: () => s.setWorkspaceMode('flat'),
    },
    {
      label: 'Instructions mode',
      checked: s.workspaceMode === 'instructions',
      title: 'Preview the step-by-step instruction sheet (print it or export a PDF)',
      onClick: () => s.setWorkspaceMode('instructions'),
    },
  ]

  const hasArt = materialNeedsTexture(s.material)

  const exportItems: MenuItemDef[] = [
    {
      label: 'Dieline SVG (line art)',
      onClick: () =>
        downloadText(dielineSVG(s.doc), nextExportName(s.projectName, 'dieline', 'svg'), 'image/svg+xml'),
    },
    {
      label: 'Dieline PDF (line art)',
      onClick: () =>
        dielinePDF(s.doc, s.projectName)
          .then((pdf) => downloadBlob(pdf, nextExportName(s.projectName, 'dieline', 'pdf')))
          .catch((e) => alert(`PDF export failed: ${e}`)),
    },
    {
      label: 'Dieline PNG — with artwork',
      title: hasArt
        ? 'Flat pattern with the printed design + cut/crease lines'
        : 'Add a design in the dieline editor (Texture tool) to include artwork',
      onClick: () =>
        dielineTexturePNG(s.doc, s.material, s.uvEdits)
          .then((png) => downloadBlob(png, nextExportName(s.projectName, 'dieline_art', 'png')))
          .catch((e) => alert(`PNG export failed: ${e}`)),
    },
    {
      label: 'Dieline SVG — with artwork',
      onClick: () =>
        dielineArtworkDataUrl(s.doc, s.material, s.uvEdits)
          .then((url) =>
            downloadText(
              dielineSVG(s.doc, url),
              nextExportName(s.projectName, 'dieline_art', 'svg'),
              'image/svg+xml',
            ),
          )
          .catch((e) => alert(`SVG export failed: ${e}`)),
    },
    {
      label: 'Dieline PDF — with artwork',
      onClick: () =>
        dielinePDF(s.doc, s.projectName, s.material, s.uvEdits)
          .then((pdf) => downloadBlob(pdf, nextExportName(s.projectName, 'dieline_art', 'pdf')))
          .catch((e) => alert(`PDF export failed: ${e}`)),
    },
    {
      label: 'Print-ready PDF — true scale 1:1',
      title: 'Exact physical size (1 unit = 1 cm) — print at 100%; tiles across pages when bigger than A4',
      onClick: () =>
        dielinePDFTrueScale(s.doc, s.projectName)
          .then((pdf) => downloadBlob(pdf, nextExportName(s.projectName, 'dieline_1to1', 'pdf')))
          .catch((e) => alert(`PDF export failed: ${e}`)),
    },
    {
      label: 'Print-ready PDF — true scale, with artwork',
      title: hasArt
        ? 'Exact physical size with the printed design — print at 100%, cut, fold'
        : 'Add a design in the dieline editor (Texture tool) to include artwork',
      onClick: () =>
        dielinePDFTrueScale(s.doc, s.projectName, s.material, s.uvEdits)
          .then((pdf) => downloadBlob(pdf, nextExportName(s.projectName, 'dieline_art_1to1', 'pdf')))
          .catch((e) => alert(`PDF export failed: ${e}`)),
    },
    {
      label: 'Instructions (print)',
      onClick: () => {
        if (s.steps.length === 0) return needSteps(() => false)
        void openInstructionSheet(s.doc, s.steps, s.projectName, s.material, s.uvEdits)
      },
    },
    {
      label: 'Instructions PDF',
      onClick: () =>
        instructionsPDF(s.doc, s.steps, s.projectName, s.material, s.uvEdits)
          .then((pdf) => {
            if (!pdf) needSteps(() => false)
            else downloadBlob(pdf, nextExportName(s.projectName, 'instructions', 'pdf'))
          })
          .catch((e) => alert(`PDF export failed: ${e}`)),
    },
    { label: '', separator: true },
    { label: '3D mesh — OBJ (folded)', onClick: () => mesh('obj', 'folded'), title: 'Wavefront OBJ + MTL' },
    { label: '3D mesh — OBJ (flat)', onClick: () => mesh('obj', 'flat') },
    { label: '3D mesh — GLB (folded)', onClick: () => mesh('glb', 'folded'), title: 'glTF binary (Blender/Roblox)' },
    { label: '3D mesh — GLB (flat)', onClick: () => mesh('glb', 'flat') },
    { label: '3D mesh — FBX (folded)', onClick: () => mesh('fbx', 'folded'), title: 'ASCII FBX (Maya)' },
    { label: '3D mesh — FBX (flat)', onClick: () => mesh('fbx', 'flat') },
    { label: '', separator: true },
    {
      label: 'Project bundle (zip)',
      onClick: () =>
        exportProjectBundle(useAppStore.getState() as AppState).catch((e) => alert(`Export failed: ${e}`)),
    },
  ]

  const menus: Array<[string, MenuItemDef[]]> = [
    ['File', fileItems],
    ['Edit', editItems],
    ['Mode', modeItems],
    ['Export', exportItems],
  ]

  return (
    <div className="topbar" ref={barRef}>
      <span className="topbar-brand">Paper Sim</span>
      {menus.map(([label, items]) => (
        <Menu
          key={label}
          label={label}
          items={items}
          open={openMenu === label}
          onToggle={() => setOpenMenu(openMenu === label ? null : label)}
          onClose={() => setOpenMenu(null)}
        />
      ))}
      <input
        ref={fileInput}
        type="file"
        accept=".fold,application/json"
        style={{ display: 'none' }}
        onChange={onLoadFile}
      />
      <input
        ref={imageInput}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={onImportImage}
      />
      {importDialog && (
        <ImportDielineDialog
          dataUrl={importDialog.dataUrl}
          fileName={importDialog.fileName}
          analysis={importDialog.analysis}
          onClose={() => setImportDialog(null)}
        />
      )}
    </div>
  )
}

/** Read an image file as a data URL, downscaled so stored textures stay light. */
async function fileToDataUrl(file: File, maxDim = 2048): Promise<string> {
  const raw = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(new Error('could not read file'))
    r.readAsDataURL(file)
  })
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('could not decode image'))
    el.src = raw
  })
  if (Math.max(img.width, img.height) <= maxDim) return raw
  const scale = maxDim / Math.max(img.width, img.height)
  const c = document.createElement('canvas')
  c.width = Math.round(img.width * scale)
  c.height = Math.round(img.height * scale)
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
  return c.toDataURL('image/png')
}
