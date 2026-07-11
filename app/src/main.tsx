import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { useAppStore } from './state/store'
import { fromFoldFile, toFoldFile } from './model/foldfile'
import { buildCarton } from './model/carton'
import { buildGableCarton } from './model/gable'
import { buildCan } from './model/can'
import {
  buildPanelTree,
  columnFaceIds,
  edgeRing,
  edgesAxis,
  edgesVertexIds,
  rowFaceIds,
  sheetBounds,
} from './model/document'
import { computeFaceMatrices, degToRad } from './model/fold'
import * as editing from './model/editing'
import { bakeMesh } from './model/meshExport'
import { buildMtl, buildObj } from './model/objExport'
import { buildFbxAscii } from './model/fbxExport'
import { templateSteps } from './model/templates'
import {
  dielineArtworkDataUrl,
  dielinePDF,
  dielineSVG,
  dielineTextureCanvas,
  dielineTexturePNG,
  instructionsPDF,
} from './ui/exports'

// Dev-only handle for scripted smoke tests (scripts/verify*.mjs).
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).paperSim = {
    store: useAppStore,
    toFoldFile,
    fromFoldFile,
    buildCarton,
    buildGableCarton,
    buildCan,
    buildPanelTree,
    computeFaceMatrices,
    degToRad,
    editing,
    dielineSVG,
    dielinePDF,
    dielineTextureCanvas,
    dielineTexturePNG,
    dielineArtworkDataUrl,
    instructionsPDF,
    rowFaceIds,
    columnFaceIds,
    edgeRing,
    edgesVertexIds,
    edgesAxis,
    sheetBounds,
    bakeMesh,
    buildObj,
    buildMtl,
    buildFbxAscii,
    templateSteps,
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
