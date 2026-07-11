import { useAppStore, type SelectMode, type TransformTool } from '../state/store'

/** Floating toolbar over the viewport: tools, select mode, editor mode, layout, theme. */
export function ViewBar() {
  const layout = useAppStore((s) => s.viewLayout)
  const theme = useAppStore((s) => s.theme)
  const editorMode = useAppStore((s) => s.editorMode)
  const transformTool = useAppStore((s) => s.transformTool)
  const selectMode = useAppStore((s) => s.selectMode)
  const s = useAppStore.getState()

  const tools: Array<[TransformTool, string, string]> = [
    ['select', '⤢', 'Select (Q)'],
    ['move', '✥', 'Move (W)'],
    ['rotate', '⟳', 'Rotate (E)'],
    ['scale', '⤡', 'Scale (R)'],
  ]
  const modes: Array<[SelectMode, string, string]> = [
    ['object', 'Obj', 'Object mode (1)'],
    ['face', 'Face', 'Face mode (2)'],
    ['edge', 'Edge', 'Edge mode (3)'],
  ]

  return (
    <div className="viewbar">
      {tools.map(([t, icon, title]) => (
        <button
          key={t}
          className={transformTool === t ? 'active' : ''}
          onClick={() => s.setTransformTool(t)}
          title={title}
        >
          {icon}
        </button>
      ))}
      <span className="viewbar-sep" />
      {modes.map(([m, label, title]) => (
        <button
          key={m}
          className={`vb-mode ${selectMode === m ? 'active' : ''}`}
          onClick={() => s.setSelectMode(m)}
          title={title}
        >
          {label}
        </button>
      ))}
      <span className="viewbar-sep" />
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
