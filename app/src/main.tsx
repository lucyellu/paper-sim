import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { useAppStore } from './state/store'
import { fromFoldFile, toFoldFile } from './model/foldfile'
import { buildCarton } from './model/carton'
import { buildGableCarton } from './model/gable'
import { buildPanelTree } from './model/document'
import { computeFaceMatrices, degToRad } from './model/fold'
import * as editing from './model/editing'
import { dielineSVG } from './ui/exports'

// Dev-only handle for scripted smoke tests (scripts/verify*.mjs).
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).paperSim = {
    store: useAppStore,
    toFoldFile,
    fromFoldFile,
    buildCarton,
    buildGableCarton,
    buildPanelTree,
    computeFaceMatrices,
    degToRad,
    editing,
    dielineSVG,
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
