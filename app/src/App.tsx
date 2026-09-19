import { useEffect } from 'react'
import { useAppStore } from './state/store'
import { DetailsPanel } from './ui/DetailsPanel'
import { InstructionsView } from './ui/InstructionsView'
import { PatternEditor } from './ui/PatternEditor'
import { PatternInset } from './ui/PatternInset'
import { Sidebar } from './ui/Sidebar'
import { Timeline } from './ui/Timeline'
import { TopBar } from './ui/TopBar'
import { UVEditor } from './ui/UVEditor'
import { ViewBar } from './ui/ViewBar'
import { saveToLibraryWithToast } from './ui/libraryActions'
import { ThreeView } from './viewer/ThreeView'

export default function App() {
  const theme = useAppStore((s) => s.theme)
  const editorMode = useAppStore((s) => s.editorMode)
  const workspaceMode = useAppStore((s) => s.workspaceMode)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      const s = useAppStore.getState()
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) s.redo()
        else s.undo()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        saveToLibraryWithToast()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        s.redo()
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        // Maya-style tool + select-mode hotkeys (fold workspace only — the UV
        // editor uses arrows/Escape, instructions mode has no tools).
        if (s.workspaceMode !== 'fold') return
        switch (e.key.toLowerCase()) {
          case 'q':
            s.setTransformTool('select')
            break
          case 'w':
            s.setTransformTool('move')
            break
          case 'e':
            s.setTransformTool('rotate')
            break
          case 'r':
            s.setTransformTool('scale')
            break
          case '1':
            s.setSelectMode('object')
            break
          case '2':
            s.setSelectMode('face')
            break
          case '3':
            s.setSelectMode('edge')
            break
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className={`app ${theme}`}>
      <TopBar />
      <div className="app-body">
        <Sidebar />
        <div className="main">
          <ThreeView />
          {workspaceMode === 'fold' && editorMode === 'pattern' && <PatternEditor />}
          {workspaceMode === 'flat' && <UVEditor />}
          {workspaceMode === 'instructions' && <InstructionsView />}
          {workspaceMode === 'fold' && <ViewBar />}
          {workspaceMode === 'fold' && editorMode === '3d' && <PatternInset />}
          {workspaceMode === 'fold' && <Timeline />}
        </div>
        <DetailsPanel />
      </div>
    </div>
  )
}
