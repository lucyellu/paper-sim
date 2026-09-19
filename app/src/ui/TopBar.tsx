// Maya-style top menu bar: File / Edit / Mode dropdowns. File › New… and
// File › Export… open dialogs (NewDocDialog, ExportDialog) rather than listing
// every template / format combination. Transform tools and select modes live
// in the always-visible ViewBar instead of a menu.

import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../state/store'
import { ExportDialog } from './ExportDialog'
import { FitDielineDialog, type FitDielineProps } from './FitDielineDialog'
import { NewDocDialog } from './NewDocDialog'
import { PhotoCartonDialog } from './PhotoCartonDialog'

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
  const photoInput = useRef<HTMLInputElement>(null)
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [fitDialog, setFitDialog] = useState<Pick<FitDielineProps, 'source' | 'session'> | null>(null)
  const [photoDialog, setPhotoDialog] = useState<{ dataUrl: string; fileName: string } | null>(null)
  const [dialog, setDialog] = useState<'new' | 'export' | null>(null)
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

  async function onImportImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      setFitDialog({ source: { dataUrl: await fileToDataUrl(file), fileName: file.name } })
    } catch (err) {
      alert(`Could not read image: ${err instanceof Error ? err.message : err}`)
    }
  }

  async function onPhotoImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      setPhotoDialog({ dataUrl: await fileToDataUrl(file), fileName: file.name })
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

  const fileItems: MenuItemDef[] = [
    { label: 'New…', onClick: () => setDialog('new'), title: 'Start from a template (tuck box, milk carton, can, sleeve…)' },
    { label: 'Open…', onClick: () => fileInput.current?.click(), title: 'Open a PaperSim or FOLD file' },
    { label: 'Save (.fold)', onClick: () => s.saveFile() },
    { label: '', separator: true },
    {
      label: 'Import dieline image…',
      title:
        'Fit a flat dieline picture (jpg/png): crop/rotate, pick the box type, drag the fold grid onto it, size it for print — the artwork is registered onto a foldable box',
      onClick: () => imageInput.current?.click(),
    },
    {
      label: 'Re-fit dieline image…',
      title: 'Reopen the last dieline fit (same picture and guides) to adjust it',
      disabled: !s.fitSession,
      onClick: () => s.fitSession && setFitDialog({ session: s.fitSession }),
    },
    {
      label: 'Carton from photo…',
      title:
        'Click the corners of a milk carton in a 3/4-view picture — its faces are unwarped onto a foldable, true-scale gable carton',
      onClick: () => photoInput.current?.click(),
    },
    { label: '', separator: true },
    {
      label: 'Export…',
      title: 'Dieline (SVG / PDF / PNG / print-ready 1:1), instructions, 3D mesh, project bundle',
      onClick: () => setDialog('export'),
    },
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

  const menus: Array<[string, MenuItemDef[]]> = [
    ['File', fileItems],
    ['Edit', editItems],
    ['Mode', modeItems],
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
      <input
        ref={photoInput}
        type="file"
        accept="image/*"
        data-testid="photo-input"
        style={{ display: 'none' }}
        onChange={onPhotoImage}
      />
      {photoDialog && (
        <PhotoCartonDialog
          dataUrl={photoDialog.dataUrl}
          fileName={photoDialog.fileName}
          onClose={() => setPhotoDialog(null)}
        />
      )}
      {dialog === 'new' && (
        <NewDocDialog
          onClose={() => setDialog(null)}
          onImportDieline={() => {
            setDialog(null)
            imageInput.current?.click()
          }}
          onCartonFromPhoto={() => {
            setDialog(null)
            photoInput.current?.click()
          }}
        />
      )}
      {dialog === 'export' && <ExportDialog onClose={() => setDialog(null)} />}
      {fitDialog && <FitDielineDialog {...fitDialog} onClose={() => setFitDialog(null)} />}
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
