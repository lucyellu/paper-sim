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
import { exportMesh, type MeshFormat, type MeshPose } from './meshExport'

interface MenuItemDef {
  label: string
  onClick?: () => void
  disabled?: boolean
  separator?: boolean
  title?: string
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
  const [openMenu, setOpenMenu] = useState<string | null>(null)
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
      label: 'New — Milk carton (tall/rect)',
      title:
        'Rectangular gable carton (wider front than sides) — the shape most printed drink cartons use, e.g. the strawberry-milk dieline. Add its artwork with the dieline editor’s Texture tool.',
      onClick: () => newDoc('gable', 'milk carton', { width: 5, depth: 3.2, height: 13 }),
    },
    {
      label: 'New — Milk carton (square base)',
      title: 'Square-footprint gable carton (front = side width)',
      onClick: () => newDoc('gable', 'milk carton'),
    },
    { label: 'New — Can label (tube)', title: 'Faceted cylinder — wrap a label around a can', onClick: () => newDoc('can', 'can label') },
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
        dielineTexturePNG(s.doc, s.material)
          .then((png) => downloadBlob(png, nextExportName(s.projectName, 'dieline_art', 'png')))
          .catch((e) => alert(`PNG export failed: ${e}`)),
    },
    {
      label: 'Dieline SVG — with artwork',
      onClick: () =>
        dielineArtworkDataUrl(s.doc, s.material)
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
        dielinePDF(s.doc, s.projectName, s.material)
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
        dielinePDFTrueScale(s.doc, s.projectName, s.material)
          .then((pdf) => downloadBlob(pdf, nextExportName(s.projectName, 'dieline_art_1to1', 'pdf')))
          .catch((e) => alert(`PDF export failed: ${e}`)),
    },
    {
      label: 'Instructions (print)',
      onClick: () => needSteps(() => openInstructionSheet(s.doc, s.steps, s.projectName)),
    },
    {
      label: 'Instructions PDF',
      onClick: () =>
        instructionsPDF(s.doc, s.steps, s.projectName)
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
    </div>
  )
}
