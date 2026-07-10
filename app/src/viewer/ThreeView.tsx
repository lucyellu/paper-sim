import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { sheetBounds, type PanelTree, type PaperDoc } from '../model/document'
import { computeFaceMatrices, degToRad, radToDeg } from '../model/fold'
import { getDisplayAngles, selectedHinge, useAppStore } from '../state/store'

const PAPER_T = 0.06
const KRAFT = 0xd9bc8d
const OUTLINE = 0x8a6d3b
const CREASE_FLAT = 0xa89a7c
const CREASE_VALLEY = 0x2563eb
const CREASE_MOUNTAIN = 0xdc2626
const CREASE_SELECTED = 0xff9f1c
const SELECT_EMISSIVE = 0x2b4a6f
const SNAP_TOLERANCE = 5 // degrees; soft-snap radius around preset angles

const SCENE_THEMES = {
  light: { bg: 0xf1ece1, grid1: 0xcfc6b4, grid2: 0xe2dac9 },
  dark: { bg: 0x211e19, grid1: 0x474135, grid2: 0x2d2a23 },
}

type ViewKey = 'persp' | 'top' | 'front' | 'side'

interface View {
  key: ViewKey
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera
  controls: OrbitControls
  cell: HTMLDivElement
  home: { position: THREE.Vector3; target: THREE.Vector3; zoom: number }
  halfH: number // ortho frustum half-height at zoom 1 (unused for persp)
}

interface DragState {
  edgeId: number
  startDeg: number
  plane: THREE.Plane
  center: THREE.Vector3
  u0: THREE.Vector3
  axisW: THREE.Vector3
  moved: boolean
}

export function ThreeView() {
  const mountRef = useRef<HTMLDivElement>(null)
  const perspRef = useRef<HTMLDivElement>(null)
  const topRef = useRef<HTMLDivElement>(null)
  const frontRef = useRef<HTMLDivElement>(null)
  const sideRef = useRef<HTMLDivElement>(null)
  const viewLayout = useAppStore((s) => s.viewLayout)

  useEffect(() => {
    const mount = mountRef.current!
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.domElement.className = 'gl-canvas'
    mount.insertBefore(renderer.domElement, mount.firstChild)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(SCENE_THEMES.light.bg)

    scene.add(new THREE.HemisphereLight(0xfff8ec, 0xb0a794, 1.1))
    const sun = new THREE.DirectionalLight(0xffffff, 1.5)
    sun.position.set(15, 25, 10)
    scene.add(sun)
    const fill = new THREE.DirectionalLight(0xfff3e0, 0.5)
    fill.position.set(-12, -8, -14)
    scene.add(fill)

    let grid = makeGrid('light')
    scene.add(grid)
    let appliedTheme: 'light' | 'dark' = 'light'

    function makeGrid(theme: 'light' | 'dark') {
      const t = SCENE_THEMES[theme]
      const g = new THREE.GridHelper(80, 40, t.grid1, t.grid2)
      g.position.y = -0.05
      return g
    }

    const modelGroup = new THREE.Group()
    modelGroup.rotation.x = -Math.PI / 2
    scene.add(modelGroup)

    // ---- views -----------------------------------------------------------
    function makeView(key: ViewKey, cell: HTMLDivElement): View {
      const isPersp = key === 'persp'
      const camera = isPersp
        ? new THREE.PerspectiveCamera(45, 1, 0.1, 500)
        : new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 500)
      const controls = new OrbitControls(camera, cell)
      controls.enableDamping = isPersp
      controls.dampingFactor = 0.12
      if (!isPersp) {
        controls.enableRotate = false
        controls.mouseButtons = {
          LEFT: THREE.MOUSE.PAN,
          MIDDLE: THREE.MOUSE.DOLLY,
          RIGHT: THREE.MOUSE.PAN,
        }
      }
      return {
        key,
        camera,
        controls,
        cell,
        home: { position: new THREE.Vector3(), target: new THREE.Vector3(), zoom: 1 },
        halfH: 10,
      }
    }

    const views: View[] = [
      makeView('persp', perspRef.current!),
      makeView('top', topRef.current!),
      makeView('front', frontRef.current!),
      makeView('side', sideRef.current!),
    ]

    function setHomes(dim: number) {
      const y = dim * 0.14
      const homes: Record<ViewKey, [THREE.Vector3, THREE.Vector3]> = {
        persp: [new THREE.Vector3(dim * 0.85, dim * 0.8, dim * 1.05), new THREE.Vector3(0, y, 0)],
        top: [new THREE.Vector3(0, dim * 2.2, 0), new THREE.Vector3(0, 0, 0)],
        front: [new THREE.Vector3(0, y, dim * 2.2), new THREE.Vector3(0, y, 0)],
        side: [new THREE.Vector3(dim * 2.2, y, 0), new THREE.Vector3(0, y, 0)],
      }
      for (const v of views) {
        const [pos, target] = homes[v.key]
        v.home.position.copy(pos)
        v.home.target.copy(target)
        v.home.zoom = 1
        v.halfH = dim * 0.72
        if (v.key === 'top') v.camera.up.set(0, 0, -1)
        applyHome(v)
      }
    }

    function applyHome(v: View) {
      v.camera.position.copy(v.home.position)
      v.controls.target.copy(v.home.target)
      if (v.camera instanceof THREE.OrthographicCamera) {
        v.camera.zoom = v.home.zoom
        v.camera.updateProjectionMatrix()
      }
      v.controls.update()
    }

    // ---- model -----------------------------------------------------------
    let faceMeshes = new Map<number, THREE.Mesh>()
    let creaseLines = new Map<number, THREE.Line>()

    const gizmo = new THREE.Group()
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.03, 12, 96),
      new THREE.MeshBasicMaterial({
        color: CREASE_SELECTED,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
      }),
    )
    ring.renderOrder = 999
    const gizmoPick = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.22, 8, 48),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    gizmo.add(ring, gizmoPick)
    gizmo.visible = false
    modelGroup.add(gizmo)

    function disposeModel() {
      for (const mesh of faceMeshes.values()) {
        mesh.traverse((o) => {
          if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
            o.geometry.dispose()
            ;(o.material as THREE.Material).dispose()
          }
        })
        modelGroup.remove(mesh)
      }
      faceMeshes = new Map()
      creaseLines = new Map()
    }

    function buildModel(doc: PaperDoc, tree: PanelTree) {
      disposeModel()
      for (const face of doc.faces) {
        const pts = face.vertexIds.map((id) => {
          const v = doc.vertices.find((v) => v.id === id)!
          return new THREE.Vector2(v.pos.x, v.pos.y)
        })
        const shape = new THREE.Shape(pts)
        const geom = new THREE.ExtrudeGeometry(shape, { depth: PAPER_T, bevelEnabled: false })
        geom.translate(0, 0, -PAPER_T / 2)
        const mat = new THREE.MeshStandardMaterial({ color: KRAFT, roughness: 0.92 })
        const mesh = new THREE.Mesh(geom, mat)
        mesh.matrixAutoUpdate = false
        mesh.userData.faceId = face.id
        const loop = [...pts, pts[0]].map((p) => new THREE.Vector3(p.x, p.y, PAPER_T / 2 + 0.01))
        const outline = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(loop),
          new THREE.LineBasicMaterial({ color: OUTLINE, transparent: true, opacity: 0.55 }),
        )
        mesh.add(outline)
        modelGroup.add(mesh)
        faceMeshes.set(face.id, mesh)
      }
      for (const [fid, node] of tree.nodes) {
        if (node.hingeEdgeId === null) continue
        const a = node.axisA!
        const b = node.axisB!
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(a.x, a.y, PAPER_T / 2 + 0.012),
            new THREE.Vector3(b.x, b.y, PAPER_T / 2 + 0.012),
          ]),
          new THREE.LineBasicMaterial({ color: CREASE_FLAT }),
        )
        faceMeshes.get(fid)!.add(line)
        creaseLines.set(node.hingeEdgeId, line)
      }
      const { min, max } = sheetBounds(doc)
      const cx = (min.x + max.x) / 2
      const cy = (min.y + max.y) / 2
      modelGroup.position.set(-cx, 0, cy)
      setHomes(Math.max(max.x - min.x, max.y - min.y))
    }

    buildModel(useAppStore.getState().doc, useAppStore.getState().tree)

    let currentDoc = useAppStore.getState().doc
    const unsub = useAppStore.subscribe((s) => {
      if (s.doc !== currentDoc) {
        currentDoc = s.doc
        buildModel(s.doc, s.tree)
      }
    })

    // ---- picking & gizmo drag ---------------------------------------------
    const raycaster = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    let drag: DragState | null = null
    let downPos: { x: number; y: number } | null = null

    function setNdcForCell(e: PointerEvent, cell: HTMLDivElement) {
      const rect = cell.getBoundingClientRect()
      ndc.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      )
    }

    function selectedAxis(): {
      edgeId: number
      mid: THREE.Vector3
      dir: THREE.Vector3
      radius: number
    } | null {
      const s = useAppStore.getState()
      if (s.selectedFaceId === null) return null
      const node = s.tree.nodes.get(s.selectedFaceId)
      if (!node || node.hingeEdgeId === null) return null
      const parentM = computeFaceMatrices(s.doc, s.tree, radAngles(getDisplayAngles(s))).get(
        node.parentFaceId!,
      )!
      const a = new THREE.Vector3(node.axisA!.x, node.axisA!.y, 0).applyMatrix4(parentM)
      const b = new THREE.Vector3(node.axisB!.x, node.axisB!.y, 0).applyMatrix4(parentM)
      const mid = a.clone().add(b).multiplyScalar(0.5)
      const dir = b.clone().sub(a)
      const len = dir.length()
      dir.normalize()
      return {
        edgeId: node.hingeEdgeId,
        mid,
        dir,
        radius: Math.min(Math.max(len * 0.42, 1.2), 4),
      }
    }

    /** Soft-snap candidates: the preset buttons plus the model's target angle. */
    function snapCandidates(edgeId: number): number[] {
      const s = useAppStore.getState()
      const out = [-179, -90, 0, 90, 179]
      const target = s.doc.targetAngles?.[edgeId]
      if (target !== undefined && !out.includes(Math.round(target))) out.push(target)
      return out
    }

    function attachCellEvents(view: View) {
      const { cell, camera, controls } = view

      function onPointerDown(e: PointerEvent) {
        if (e.button !== 0) return
        downPos = { x: e.clientX, y: e.clientY }
        const s = useAppStore.getState()
        if (s.playback.mode !== 'edit' || !gizmo.visible) return
        setNdcForCell(e, cell)
        raycaster.setFromCamera(ndc, camera)
        if (raycaster.intersectObject(gizmoPick, false).length === 0) return
        const axis = selectedAxis()
        if (!axis) return
        modelGroup.updateMatrixWorld()
        const axisW = axis.dir.clone().transformDirection(modelGroup.matrixWorld)
        const centerW = axis.mid.clone().applyMatrix4(modelGroup.matrixWorld)
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(axisW, centerW)
        const hit = new THREE.Vector3()
        if (!raycaster.ray.intersectPlane(plane, hit)) return
        drag = {
          edgeId: axis.edgeId,
          startDeg: s.angles[axis.edgeId] ?? 0,
          plane,
          center: centerW,
          u0: hit.sub(centerW).normalize(),
          axisW,
          moved: false,
        }
        controls.enabled = false
        cell.setPointerCapture(e.pointerId)
      }

      function onPointerMove(e: PointerEvent) {
        if (!drag) return
        setNdcForCell(e, cell)
        raycaster.setFromCamera(ndc, camera)
        const hit = new THREE.Vector3()
        if (!raycaster.ray.intersectPlane(drag.plane, hit)) return
        const u1 = hit.sub(drag.center).normalize()
        const cross = new THREE.Vector3().crossVectors(drag.u0, u1)
        const delta = Math.atan2(drag.axisW.dot(cross), drag.u0.dot(u1))
        let deg = drag.startDeg + radToDeg(delta)
        if (e.shiftKey) {
          deg = Math.round(deg / 15) * 15
        } else if (!e.altKey) {
          // Soft-snap to preset/target angles (Alt = free rotation).
          for (const c of snapCandidates(drag.edgeId)) {
            if (Math.abs(deg - c) <= SNAP_TOLERANCE) {
              deg = c
              break
            }
          }
        }
        deg = Math.max(-179, Math.min(179, deg))
        drag.moved = true
        useAppStore.getState().setAngleTransient(drag.edgeId, deg)
      }

      function onPointerUp(e: PointerEvent) {
        if (drag) {
          const s = useAppStore.getState()
          const finalDeg = s.angles[drag.edgeId] ?? 0
          if (drag.moved && finalDeg !== drag.startDeg) {
            s.dispatch(
              { type: 'setAngle', edgeId: drag.edgeId, prev: drag.startDeg, next: finalDeg },
              { alreadyApplied: true },
            )
          }
          drag = null
          controls.enabled = true
          downPos = null
          return
        }
        if (!downPos) return
        const dist = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y)
        downPos = null
        if (dist > 5) return
        setNdcForCell(e, cell)
        raycaster.setFromCamera(ndc, camera)
        const hits = raycaster.intersectObjects([...faceMeshes.values()], false)
        const s = useAppStore.getState()
        if (hits.length > 0) s.selectFace(hits[0].object.userData.faceId as number)
        else s.selectFace(null)
      }

      cell.addEventListener('pointerdown', onPointerDown)
      cell.addEventListener('pointermove', onPointerMove)
      cell.addEventListener('pointerup', onPointerUp)
      return () => {
        cell.removeEventListener('pointerdown', onPointerDown)
        cell.removeEventListener('pointermove', onPointerMove)
        cell.removeEventListener('pointerup', onPointerUp)
      }
    }

    const detachers = views.map(attachCellEvents)

    // Dev-only handle for scripted verification (scripts/verify-*.mjs).
    if (import.meta.env.DEV) {
      ;(window as unknown as Record<string, unknown>).paperSimViewer = { gizmo, views }
    }

    // ---- F to frame --------------------------------------------------------
    function frameViews() {
      const s = useAppStore.getState()
      if (s.selectedFaceId === null) {
        views.forEach(applyHome)
        return
      }
      const face = s.doc.faces.find((f) => f.id === s.selectedFaceId)
      const mesh = faceMeshes.get(s.selectedFaceId)
      if (!face || !mesh) return
      modelGroup.updateMatrixWorld()
      const pts = face.vertexIds.map((id) => {
        const v = s.doc.vertices.find((v) => v.id === id)!
        return new THREE.Vector3(v.pos.x, v.pos.y, 0)
          .applyMatrix4(mesh.matrix)
          .applyMatrix4(modelGroup.matrixWorld)
      })
      const center = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(pts.length)
      const radius = Math.max(1.5, ...pts.map((p) => p.distanceTo(center)))
      for (const v of views) {
        if (v.camera instanceof THREE.PerspectiveCamera) {
          const dir = v.camera.position.clone().sub(v.controls.target).normalize()
          const dist = (radius * 1.4) / Math.tan(degToRad(v.camera.fov / 2)) + radius
          v.controls.target.copy(center)
          v.camera.position.copy(center.clone().add(dir.multiplyScalar(dist)))
        } else {
          const offset = v.home.position.clone().sub(v.home.target)
          v.controls.target.copy(center)
          v.camera.position.copy(center.clone().add(offset))
          v.camera.zoom = Math.min(Math.max(v.halfH / (radius * 1.5), 0.2), 25)
          v.camera.updateProjectionMatrix()
        }
        v.controls.update()
      }
    }

    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        frameViews()
      }
    }
    window.addEventListener('keydown', onKeyDown)

    // ---- resize ------------------------------------------------------------
    function resize() {
      renderer.setSize(mount.clientWidth, mount.clientHeight)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(mount)

    // ---- render loop ---------------------------------------------------------
    renderer.setScissorTest(true)
    const clock = new THREE.Clock()
    let raf = 0
    function tick() {
      raf = requestAnimationFrame(tick)
      const dt = clock.getDelta()
      const s = useAppStore.getState()

      if (s.theme !== appliedTheme) {
        appliedTheme = s.theme
        ;(scene.background as THREE.Color).setHex(SCENE_THEMES[appliedTheme].bg)
        scene.remove(grid)
        grid.geometry.dispose()
        ;(grid.material as THREE.Material).dispose()
        grid = makeGrid(appliedTheme)
        scene.add(grid)
      }

      if (s.playback.mode === 'scrub' && s.playback.playing) {
        const t = s.playback.t + dt * 1.0
        if (t >= s.steps.length) {
          s.setScrub(s.steps.length)
          s.setPlaying(false)
        } else {
          s.setScrub(t)
        }
      }

      const display = getDisplayAngles(s)
      const matrices = computeFaceMatrices(s.doc, s.tree, radAngles(display))
      for (const [fid, mesh] of faceMeshes) {
        const m = matrices.get(fid)
        if (m) {
          mesh.matrix.copy(m)
          mesh.matrixWorldNeedsUpdate = true
        }
        const mat = mesh.material as THREE.MeshStandardMaterial
        mat.emissive.setHex(fid === s.selectedFaceId ? SELECT_EMISSIVE : 0x000000)
        mat.emissiveIntensity = 0.35
      }

      const hinge = selectedHinge(s)
      for (const [edgeId, line] of creaseLines) {
        const mat = line.material as THREE.LineBasicMaterial
        if (edgeId === hinge) {
          mat.color.setHex(CREASE_SELECTED)
        } else {
          const a = display[edgeId] ?? 0
          mat.color.setHex(a > 1 ? CREASE_VALLEY : a < -1 ? CREASE_MOUNTAIN : CREASE_FLAT)
        }
      }

      const axis = s.playback.mode === 'edit' ? selectedAxis() : null
      if (axis) {
        gizmo.visible = true
        gizmo.position.copy(axis.mid)
        gizmo.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis.dir)
        gizmo.scale.setScalar(axis.radius)
      } else {
        gizmo.visible = false
      }

      // Multi-view render with scissor rects taken from the overlay cells.
      const canvasRect = renderer.domElement.getBoundingClientRect()
      renderer.setViewport(0, 0, canvasRect.width, canvasRect.height)
      renderer.setScissor(0, 0, canvasRect.width, canvasRect.height)
      renderer.setClearColor(SCENE_THEMES[appliedTheme].bg)
      renderer.clear()
      for (const v of views) {
        if (v.cell.offsetWidth === 0 || v.cell.offsetParent === null) continue
        const r = v.cell.getBoundingClientRect()
        const x = r.left - canvasRect.left
        const yBottom = canvasRect.height - (r.top - canvasRect.top + r.height)
        if (v.camera instanceof THREE.PerspectiveCamera) {
          v.camera.aspect = r.width / r.height
        } else {
          const aspect = r.width / r.height
          v.camera.left = -v.halfH * aspect
          v.camera.right = v.halfH * aspect
          v.camera.top = v.halfH
          v.camera.bottom = -v.halfH
        }
        v.camera.updateProjectionMatrix()
        v.controls.update()
        renderer.setViewport(x, yBottom, r.width, r.height)
        renderer.setScissor(x, yBottom, r.width, r.height)
        renderer.render(scene, v.camera)
      }
    }
    tick()

    return () => {
      cancelAnimationFrame(raf)
      unsub()
      ro.disconnect()
      window.removeEventListener('keydown', onKeyDown)
      detachers.forEach((d) => d())
      views.forEach((v) => v.controls.dispose())
      disposeModel()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
    }
  }, [])

  return (
    <div ref={mountRef} className={`viewport layout-${viewLayout}`}>
      <div ref={perspRef} className="view-cell" data-label="Perspective" />
      <div ref={topRef} className="view-cell view-ortho" data-label="Top" />
      <div ref={frontRef} className="view-cell view-ortho" data-label="Front" />
      <div ref={sideRef} className="view-cell view-ortho" data-label="Side" />
    </div>
  )
}

function radAngles(deg: Record<number, number>): Record<number, number> {
  const out: Record<number, number> = {}
  for (const k of Object.keys(deg)) out[Number(k)] = degToRad(deg[Number(k)])
  return out
}
