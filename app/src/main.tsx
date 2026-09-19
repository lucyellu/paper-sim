import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { useAppStore } from './state/store'
import { fromFoldFile, toFoldFile } from './model/foldfile'
import { buildCarton } from './model/carton'
import { buildGableCarton } from './model/gable'
import { buildCan } from './model/can'
import { buildSleeve } from './model/sleeve'
import { buildTuckBox } from './model/tuck'
import {
  buildPanelTree,
  columnFaceIds,
  edgeRing,
  edgesAxis,
  edgesVertexIds,
  ringRegionVertexIds,
  rowFaceIds,
  sheetBounds,
} from './model/document'
import { computeFaceMatrices, degToRad } from './model/fold'
import * as editing from './model/editing'
import { bakeMesh } from './model/meshExport'
import { buildMtl, buildObj } from './model/objExport'
import { buildFbxAscii } from './model/fbxExport'
import { templateSteps } from './model/templates'
import { analyzeDielineImage, analyzeImageData, gableDimsFromAnalysis } from './model/dielineImage'
import { applyFaceUV, faceUVAffine, faceUVCentroid, identityFaceUV, pruneUVEdits, sanitizeUVEdits } from './model/uv'
import { buildPrintCanvas, buildSheetCanvas } from './viewer/texture'
import {
  buildInstructionSheetHTML,
  dielineArtworkDataUrl,
  dielinePDF,
  dielinePDFTrueScale,
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
    buildSleeve,
    buildTuckBox,
    buildPanelTree,
    computeFaceMatrices,
    degToRad,
    editing,
    dielineSVG,
    dielinePDF,
    dielinePDFTrueScale,
    dielineTextureCanvas,
    dielineTexturePNG,
    dielineArtworkDataUrl,
    instructionsPDF,
    buildInstructionSheetHTML,
    rowFaceIds,
    columnFaceIds,
    edgeRing,
    edgesVertexIds,
    ringRegionVertexIds,
    edgesAxis,
    sheetBounds,
    bakeMesh,
    buildObj,
    buildMtl,
    buildFbxAscii,
    templateSteps,
    analyzeDielineImage,
    analyzeImageData,
    gableDimsFromAnalysis,
    applyFaceUV,
    faceUVAffine,
    faceUVCentroid,
    identityFaceUV,
    pruneUVEdits,
    sanitizeUVEdits,
    buildPrintCanvas,
    buildSheetCanvas,
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
