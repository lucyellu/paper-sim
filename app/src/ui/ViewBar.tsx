import { useAppStore } from '../state/store'

/** Floating toolbar over the viewport: editor mode, view layout, theme. */
export function ViewBar() {
  const layout = useAppStore((s) => s.viewLayout)
  const theme = useAppStore((s) => s.theme)
  const editorMode = useAppStore((s) => s.editorMode)
  const s = useAppStore.getState()
  return (
    <div className="viewbar">
      <button
        className={editorMode === 'pattern' ? 'active' : ''}
        onClick={() => s.setEditorMode(editorMode === 'pattern' ? '3d' : 'pattern')}
        title="Edit the dieline pattern (draw / delete / retype lines)"
      >
        ✎
      </button>
      <span className="viewbar-sep" />
      <button
        className={layout === 'single' ? 'active' : ''}
        onClick={() => s.setViewLayout('single')}
        title="Single perspective view"
      >
        ◻
      </button>
      <button
        className={layout === 'quad' ? 'active' : ''}
        onClick={() => s.setViewLayout('quad')}
        title="Quad view: perspective / top / front / side"
      >
        ⊞
      </button>
      <span className="viewbar-sep" />
      <button
        onClick={() => s.setTheme(theme === 'light' ? 'dark' : 'light')}
        title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
      >
        {theme === 'light' ? '🌙' : '☀️'}
      </button>
    </div>
  )
}
