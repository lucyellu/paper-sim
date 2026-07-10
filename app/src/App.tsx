import { useEffect } from 'react'
import { useAppStore } from './state/store'
import { DetailsPanel } from './ui/DetailsPanel'
import { PatternInset } from './ui/PatternInset'
import { Sidebar } from './ui/Sidebar'
import { Timeline } from './ui/Timeline'
import { ViewBar } from './ui/ViewBar'
import { ThreeView } from './viewer/ThreeView'

export default function App() {
  const theme = useAppStore((s) => s.theme)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      const s = useAppStore.getState()
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) s.redo()
        else s.undo()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        s.redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className={`app ${theme}`}>
      <Sidebar />
      <div className="main">
        <ThreeView />
        <ViewBar />
        <PatternInset />
        <Timeline />
      </div>
      <DetailsPanel />
    </div>
  )
}
