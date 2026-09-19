// File › New… — one dialog listing every starting template (with a flat
// dieline thumbnail) plus the "start from a picture" wizards, instead of a
// long run of "New — …" menu items.

import { useEffect, useMemo, useState } from 'react'
import { buildTemplate, useAppStore, type Template, type TemplateDims } from '../state/store'
import { dielineSVG } from './exports'

interface TemplateDef {
  id: string
  name: string
  /** Short size / variant line under the name. */
  sub: string
  desc: string
  template: Template
  dims?: TemplateDims
}

const TEMPLATES: TemplateDef[] = [
  {
    id: 'tuck-reverse',
    name: 'Tuck box',
    sub: 'Reverse tuck · 6 × 3 × 9 cm',
    desc: 'Parametric tuck-end box: lids on opposite panels, dust flaps on the sides.',
    template: 'tuckbox',
    dims: { width: 6, depth: 3, height: 9, style: 'reverse', order: 'front-first', glueSide: 'right' },
  },
  {
    id: 'tuck-straight',
    name: 'Tuck box',
    sub: 'Straight tuck · 6 × 3 × 9 cm',
    desc: 'Parametric tuck-end box with both lids on the same panel.',
    template: 'tuckbox',
    dims: { width: 6, depth: 3, height: 9, style: 'straight', order: 'front-first', glueSide: 'right' },
  },
  {
    id: 'cross',
    name: 'Cross box',
    sub: 'Cube net · 6 × 5 × 6 cm',
    desc: 'Sides hang off the front; lid, bottom and back run in one strip. The lid tucks into the back.',
    template: 'crossbox',
    dims: { width: 6, depth: 5, height: 6 },
  },
  {
    id: 'flap',
    name: 'Flap box',
    sub: 'Classic',
    desc: 'The original fixed-size box with four top and bottom flaps.',
    template: 'tuck',
  },
  {
    id: 'milk-1l',
    name: 'Milk carton',
    sub: '1 L · tall',
    desc: 'Tall slim gable carton — a wider front than sides, the shape most printed drink cartons use.',
    template: 'gable',
    dims: { width: 5, depth: 3.2, height: 13 },
  },
  {
    id: 'milk-250',
    name: 'Milk carton',
    sub: '250 mL · squat',
    desc: 'Small square-base gable carton on the Pure-Pak 250 mL mini standard (~57 × 57 mm base).',
    template: 'gable',
    dims: { width: 5.7, depth: 5.7, height: 7.5 },
  },
  {
    id: 'can-label',
    name: 'Can label',
    sub: 'Faceted tube',
    desc: 'Faceted cylinder — wrap a label around a can.',
    template: 'can',
  },
  {
    id: 'can-sleeve',
    name: 'Can sleeve',
    sub: '12 oz can',
    desc: 'Faceted band sized to slip over a standard 12 oz drink can — print, fold, glue, slide on.',
    template: 'can',
    dims: { facets: 24, height: 9, radius: 3.45, seam: true },
  },
  {
    id: 'juice-sleeve',
    name: 'Juice box sleeve',
    sub: '200 mL box',
    desc: 'Open-ended band that slips over a standard 200 mL juice box — print, fold, glue, slide on.',
    template: 'sleeve',
    dims: { width: 5.5, depth: 4.3, height: 7, seam: true },
  },
]

export function NewDocDialog({
  onClose,
  onImportDieline,
  onCartonFromPhoto,
}: {
  onClose: () => void
  onImportDieline: () => void
  onCartonFromPhoto: () => void
}) {
  const [picked, setPicked] = useState(TEMPLATES[0].id)
  const def = TEMPLATES.find((t) => t.id === picked)!

  // Thumbnails are the real flat dielines, built once per dialog open.
  const thumbs = useMemo(
    () =>
      Object.fromEntries(
        TEMPLATES.map((t) => [
          t.id,
          `data:image/svg+xml;charset=utf-8,${encodeURIComponent(dielineSVG(buildTemplate(t.template, t.dims)))}`,
        ]),
      ),
    [],
  )

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function create(t: TemplateDef) {
    useAppStore.getState().newDocument(t.template, t.dims)
    onClose()
  }

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal new-modal" role="dialog" aria-label="New project">
        <h2>New project</h2>
        <div className="new-grid">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              className={`new-card ${picked === t.id ? 'picked' : ''}`}
              data-template={t.id}
              title={t.desc}
              onClick={() => setPicked(t.id)}
              onDoubleClick={() => create(t)}
            >
              <img src={thumbs[t.id]} alt="" draggable={false} />
              <span className="new-card-name">{t.name}</span>
              <span className="new-card-sub">{t.sub}</span>
            </button>
          ))}
        </div>
        <p className="hint new-desc">{def.desc} Units are cm.</p>

        <div className="dlg-section-title">Start from a picture</div>
        <div className="new-pic-row">
          <button onClick={onImportDieline} title="Fit a flat dieline picture (jpg/png) onto a foldable box">
            Import dieline image…
          </button>
          <button onClick={onCartonFromPhoto} title="Unwarp a 3/4-view photo of a milk carton onto a gable carton">
            Carton from photo…
          </button>
        </div>

        <p className="hint">Starting a new project replaces the current one — unsaved work is lost.</p>
        <div className="btn-row dlg-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary dlg-primary" onClick={() => create(def)}>
            Create {def.name.toLowerCase()}
          </button>
        </div>
      </div>
    </div>
  )
}
