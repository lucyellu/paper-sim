// Layout chrome: side panels that drag-resize and collapse to a thin strip,
// and collapsible titled sections inside them. Both persist their state in
// localStorage so the workspace layout survives reloads.

import { useRef, useState, type ReactNode } from 'react'

function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw !== null ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writePref(key: string, value: unknown) {
  window.localStorage.setItem(key, JSON.stringify(value))
}

/** Collapsible titled block used inside the side panels. */
export function Section({
  id,
  title,
  className,
  children,
}: {
  id: string
  title: ReactNode
  className?: string
  children: ReactNode
}) {
  const key = `paperSim.sec.${id}`
  const [open, setOpen] = useState(() => readPref(key, true))
  return (
    <section className={`${className ?? ''} ${open ? '' : 'sec-collapsed'}`}>
      <h3
        className="sec-head"
        title={open ? 'Collapse section' : 'Expand section'}
        onClick={() => {
          setOpen(!open)
          writePref(key, !open)
        }}
      >
        <span className={`chev ${open ? 'open' : ''}`}>▸</span>
        {title}
      </h3>
      {open && children}
    </section>
  )
}

const MIN_W = 180
const MAX_W = 480
const STRIP_W = 26

/**
 * A left/right side panel: drag its inner edge to resize, or collapse it to a
 * thin labeled strip with the arrow button.
 */
export function SidePanel({
  id,
  side,
  title,
  defaultWidth,
  children,
}: {
  id: string
  side: 'left' | 'right'
  title: string
  defaultWidth: number
  children: ReactNode
}) {
  const key = `paperSim.panel.${id}`
  const saved = readPref(key, { width: defaultWidth, collapsed: false })
  const [width, setWidth] = useState(
    Math.max(MIN_W, Math.min(MAX_W, saved.width ?? defaultWidth)),
  )
  const [collapsed, setCollapsed] = useState(saved.collapsed ?? false)
  const rootRef = useRef<HTMLDivElement>(null)

  function persist(w: number, c: boolean) {
    writePref(key, { width: w, collapsed: c })
  }

  function onGripDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    const grip = e.currentTarget
    grip.setPointerCapture(e.pointerId)
    const onMove = (ev: PointerEvent) => {
      const rect = rootRef.current!.getBoundingClientRect()
      const w = side === 'left' ? ev.clientX - rect.left : rect.right - ev.clientX
      setWidth(Math.max(MIN_W, Math.min(MAX_W, Math.round(w))))
    }
    const onUp = () => {
      grip.removeEventListener('pointermove', onMove)
      grip.removeEventListener('pointerup', onUp)
      setWidth((w) => {
        persist(w, false)
        return w
      })
    }
    grip.addEventListener('pointermove', onMove)
    grip.addEventListener('pointerup', onUp)
  }

  const inArrow = side === 'left' ? '⟨' : '⟩'
  const outArrow = side === 'left' ? '⟩' : '⟨'

  if (collapsed) {
    return (
      <div className={`side-panel strip ${side}`} style={{ width: STRIP_W }}>
        <button
          className="panel-toggle"
          title={`Expand ${title} panel`}
          onClick={() => {
            setCollapsed(false)
            persist(width, false)
          }}
        >
          {outArrow}
        </button>
        <div className="panel-vtitle">{title}</div>
      </div>
    )
  }

  return (
    <div ref={rootRef} className={`side-panel ${side}`} style={{ width }}>
      <div className="panel-scroll">{children}</div>
      <div className={`panel-grip ${side}`} onPointerDown={onGripDown} title="Drag to resize" />
      <button
        className={`panel-toggle open ${side}`}
        title={`Collapse ${title} panel`}
        onClick={() => {
          setCollapsed(true)
          persist(width, true)
        }}
      >
        {inArrow}
      </button>
    </div>
  )
}
