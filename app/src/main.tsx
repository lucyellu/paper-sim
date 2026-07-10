import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { useAppStore } from './state/store'
import { fromFoldFile, toFoldFile } from './model/foldfile'

// Dev-only handle for scripted smoke tests (scripts/verify.mjs).
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).paperSim = {
    store: useAppStore,
    toFoldFile,
    fromFoldFile,
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
