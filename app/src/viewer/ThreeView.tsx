import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import {
  columnFaceIds,
  edgeRing,
  edgesAxis,
  ringRegionVertexIds,
  rowFaceIds,
  sheetBounds,
  type PanelTree,
  type PaperDoc,
} from '../model/document'
import { moveVertices } from '../model/editing'
import { computeFaceMatrices, degToRad, radToDeg } from '../model/fold'
import {
  getDisplayAngles,
  primaryFaceId,
  selectedHinge,
  selectedHinges,
  useAppStore,
} from '../state/store'
import { applyFaceUV, faceUVCentroid } from '../model/uv'
import { registerCapture, type PoseAngles } from './capture'
import { buildSheetCanvas, materialNeedsTexture } from './texture'

const PAPER_T = 0.06
const KRAFT = 0xd9bc8d
const OUTLINE = 0x8a6d3b
const CREASE_FLAT = 0xa89a7c
const CREASE_VALLEY = 0x2563eb
const CREASE_MOUNTAIN = 0xdc2626
const CREASE_SELECTED = 0xff9f1c
const SELECT_EMISSIVE = 0x2b4a6f
const SELECT_EMISSIVE_SECONDARY = 0x1d3a2a
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

interface DragHinge {
  edgeId: number
  startDeg: number
  target: number | undefined
}

interface DragState {
  /** Primary hinge (the gizmo's) first; coupled hinges after. */
  hinges: DragHinge[]
  plane: THREE.Plane
  center: THREE.Vector3
  u0: THREE.Vector3
  axisW: THREE.Vector3
  moved: boolean
}

/** Live edge-ring reshape: drag moves the ring's dieline vertices along a flat axis. */
interface ReshapeState {
  docAtStart: PaperDoc
  vertexIds: number[]
  /** Unit flat-space direction the ring vertices move along. */
  axisFlat: { x: number; y: number }
  /** That axis in current-pose world space (for projecting the drag). */
  worldAxis: THREE.Vector3
  plane: THREE.Plane
  start: THREE.Vector3
  scale: number
}

export function ThreeView() {
  const mountRef = useRef<HTMLDivElement>(null)
  const perspRef = useRef<HTMLDivElement>(null)
  const topRef = useRef<HTMLDivElement>(null)
  const frontRef = useRef<HTMLDivElement>(null)
  const sideRef = useRef<HTMLDivElement>(null)
  const viewLayout = useAppStore((s) => s.viewLayout)
  const editorMode = useAppStore((s) => s.editorMode)

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

    // Hierarchy: placementGroup (user translate) > pivotGroup (auto-centering)
    // > orientGroup (whole-object rotate + uniform scale) > modelGroup
    // (sheet-to-world: flat xy plane -> ground plane). Rotate/scale live inside
    // the pivot so the model stays centered and grounded; translate is a free
    // scene offset on top.
    const placementGroup = new THREE.Group()
    const pivotGroup = new THREE.Group()
    const orientGroup = new THREE.Group()
    const modelGroup = new THREE.Group()
    modelGroup.rotation.x = -Math.PI / 2
    orientGroup.add(modelGroup)
    pivotGroup.add(orientGroup)
    placementGroup.add(pivotGroup)
    scene.add(placementGroup)

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
      // Ortho front/side look a bit higher: a folded model can stand tall on
      // the ground plane and would otherwise clip below the frustum.
      const yo = dim * 0.3
      const homes: Record<ViewKey, [THREE.Vector3, THREE.Vector3]> = {
        persp: [new THREE.Vector3(dim * 0.85, dim * 0.8, dim * 1.05), new THREE.Vector3(0, y, 0)],
        top: [new THREE.Vector3(0, dim * 2.2, 0), new THREE.Vector3(0, 0, 0)],
        front: [new THREE.Vector3(0, yo, dim * 2.2), new THREE.Vector3(0, yo, 0)],
        side: [new THREE.Vector3(dim * 2.2, yo, 0), new THREE.Vector3(0, yo, 0)],
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
    let facePoints = new Map<number, THREE.Vector3[]>() // flat verts per face
    let edgeProxies = new Map<number, THREE.Mesh>() // edgeId -> pick/highlight tube

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
      facePoints = new Map()
      edgeProxies = new Map()
    }

    /** The face that owns an edge (has its two vertices consecutive in the loop). */
    function ownerFaceId(doc: PaperDoc, v1: number, v2: number): number | null {
      for (const f of doc.faces) {
        const n = f.vertexIds.length
        for (let i = 0; i < n; i++) {
          const a = f.vertexIds[i]
          const b = f.vertexIds[(i + 1) % n]
          if ((a === v1 && b === v2) || (a === v2 && b === v1)) return f.id
        }
      }
      return null
    }

    function buildModel(doc: PaperDoc, tree: PanelTree) {
      disposeModel()
      const { min, max } = sheetBounds(doc)
      const bw = Math.max(max.x - min.x, 0.001)
      const bh = Math.max(max.y - min.y, 0.001)
      // Fold-tree depth per face: a flap folded flat (180°) onto its parent is
      // coplanar with it and z-fights. Deeper (later-folded) panels get a more
      // negative polygon offset so they win the depth test deterministically —
      // the flicker where a glue flap overlaps a body panel goes away.
      const depthOf = new Map<number, number>()
      for (const fid of tree.order) {
        const node = tree.nodes.get(fid)
        const parent = node?.parentFaceId
        depthOf.set(fid, parent == null ? 0 : (depthOf.get(parent) ?? 0) + 1)
      }
      for (const face of doc.faces) {
        const pts = face.vertexIds.map((id) => {
          const v = doc.vertices.find((v) => v.id === id)!
          return new THREE.Vector2(v.pos.x, v.pos.y)
        })
        const shape = new THREE.Shape(pts)
        const geom = new THREE.ExtrudeGeometry(shape, { depth: PAPER_T, bevelEnabled: false })
        geom.translate(0, 0, -PAPER_T / 2)
        // UVs = flat sheet coords normalized to the sheet bounds: the dieline
        // is the object's UV map, so overlay artwork lands where it's drawn.
        // A UV-mode edit shifts this face's coords off the dieline (the print
        // exports compensate with the same transform — see buildPrintCanvas).
        const uvEdit = useAppStore.getState().uvEdits[face.id]
        const uvC = uvEdit ? faceUVCentroid(doc, face) : null
        const pos = geom.attributes.position as THREE.BufferAttribute
        const uv = geom.attributes.uv as THREE.BufferAttribute
        for (let i = 0; i < uv.count; i++) {
          let u = (pos.getX(i) - min.x) / bw
          let v = (pos.getY(i) - min.y) / bh
          if (uvEdit && uvC) [u, v] = applyFaceUV(uvEdit, uvC, u, v)
          uv.setXY(i, u, v)
        }
        uv.needsUpdate = true
        const depth = face.layer ?? depthOf.get(face.id) ?? 0
        const mat = new THREE.MeshStandardMaterial({
          color: KRAFT,
          roughness: 0.92,
          // Render both faces so a flap seen from behind never disappears
          // (the "one-sided plane flicker" when a panel is viewed edge-on).
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -depth,
          polygonOffsetUnits: -depth * 2,
        })
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
        facePoints.set(
          face.id,
          pts.map((p) => new THREE.Vector3(p.x, p.y, 0)),
        )
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
      // Per-edge pick/highlight tubes: thin cylinders along each edge, parented
      // to the face that owns the edge so they follow the fold. Invisible until
      // hovered/selected; used for edge-mode picking.
      const yAxis = new THREE.Vector3(0, 1, 0)
      for (const e of doc.edges) {
        const owner = ownerFaceId(doc, e.v1, e.v2)
        if (owner === null) continue
        const p1 = doc.vertices.find((v) => v.id === e.v1)!.pos
        const p2 = doc.vertices.find((v) => v.id === e.v2)!.pos
        const len = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 0.001
        const tube = new THREE.Mesh(
          new THREE.CylinderGeometry(0.08, 0.08, len, 6),
          new THREE.MeshBasicMaterial({ color: CREASE_SELECTED, depthTest: false }),
        )
        tube.material.visible = false
        tube.renderOrder = 998
        const dir = new THREE.Vector3(p2.x - p1.x, p2.y - p1.y, 0).normalize()
        tube.quaternion.setFromUnitVectors(yAxis, dir)
        tube.position.set((p1.x + p2.x) / 2, (p1.y + p2.y) / 2, PAPER_T / 2 + 0.02)
        tube.userData.edgeId = e.id
        faceMeshes.get(owner)!.add(tube)
        edgeProxies.set(e.id, tube)
      }
      const cx = (min.x + max.x) / 2
      const cy = (min.y + max.y) / 2
      modelGroup.position.set(-cx, 0, cy)
      setHomes(Math.max(bw, bh))
      applySheetMaterial()
    }

    // ---- sheet material (base color / paper texture / design overlay) -----
    let sheetTex: THREE.CanvasTexture | null = null
    let texGen = 0
    /** The in-flight sheet-texture build (thumbnails wait for it). */
    let texPending: Promise<void> = Promise.resolve()

    function applySheetMaterial() {
      const m = useAppStore.getState().material
      for (const mesh of faceMeshes.values()) {
        const mat = mesh.material as THREE.MeshStandardMaterial
        mat.map = sheetTex
        if (sheetTex) mat.color.setHex(0xffffff)
        else mat.color.set(m.baseColor)
        mat.needsUpdate = true
      }
    }

    function refreshSheetTexture() {
      const s = useAppStore.getState()
      if (!materialNeedsTexture(s.material)) {
        texGen++
        sheetTex?.dispose()
        sheetTex = null
        applySheetMaterial()
        return
      }
      const gen = ++texGen
      texPending = buildSheetCanvas(s.doc, s.material)
        .then((canvas) => {
          if (gen !== texGen) return // superseded by a newer material/doc
          sheetTex?.dispose()
          sheetTex = new THREE.CanvasTexture(canvas)
          sheetTex.colorSpace = THREE.SRGBColorSpace
          sheetTex.anisotropy = 4
          applySheetMaterial()
        })
        .catch((err) => console.warn('sheet texture failed', err))
    }

    /** Rewrite every face's UV attribute in place (live UV-mode edits). */
    function refreshUVs() {
      const s = useAppStore.getState()
      const { min, max } = sheetBounds(s.doc)
      const bw = Math.max(max.x - min.x, 0.001)
      const bh = Math.max(max.y - min.y, 0.001)
      for (const [fid, mesh] of faceMeshes) {
        const face = s.doc.faces.find((f) => f.id === fid)
        if (!face) continue
        const uvEdit = s.uvEdits[fid]
        const uvC = uvEdit ? faceUVCentroid(s.doc, face) : null
        const geom = mesh.geometry as THREE.BufferGeometry
        const pos = geom.attributes.position as THREE.BufferAttribute
        const uv = geom.attributes.uv as THREE.BufferAttribute
        for (let i = 0; i < uv.count; i++) {
          let u = (pos.getX(i) - min.x) / bw
          let v = (pos.getY(i) - min.y) / bh
          if (uvEdit && uvC) [u, v] = applyFaceUV(uvEdit, uvC, u, v)
          uv.setXY(i, u, v)
        }
        uv.needsUpdate = true
      }
    }

    buildModel(useAppStore.getState().doc, useAppStore.getState().tree)
    refreshSheetTexture()

    let currentDoc = useAppStore.getState().doc
    let currentMaterial = useAppStore.getState().material
    let currentUVEdits = useAppStore.getState().uvEdits
    const unsub = useAppStore.subscribe((s) => {
      if (s.doc !== currentDoc) {
        currentDoc = s.doc
        currentMaterial = s.material
        currentUVEdits = s.uvEdits
        // A live edge-ring reshape rebuilds the doc every move; keep the camera
        // put (buildModel would otherwise snap views back to their home).
        const cams = reshaping
          ? views.map((v) => ({
              p: v.camera.position.clone(),
              t: v.controls.target.clone(),
              z: v.camera instanceof THREE.OrthographicCamera ? v.camera.zoom : 1,
            }))
          : null
        buildModel(s.doc, s.tree)
        refreshSheetTexture() // sheet bounds (the UV frame) may have changed
        if (cams) {
          views.forEach((v, i) => {
            v.camera.position.copy(cams[i].p)
            v.controls.target.copy(cams[i].t)
            if (v.camera instanceof THREE.OrthographicCamera) {
              v.camera.zoom = cams[i].z
              v.camera.updateProjectionMatrix()
            }
            v.controls.update()
          })
        }
      } else if (s.material !== currentMaterial) {
        currentMaterial = s.material
        refreshSheetTexture()
      } else if (s.uvEdits !== currentUVEdits) {
        currentUVEdits = s.uvEdits
        refreshUVs()
      }
    })

    // ---- auto-centering pivot ---------------------------------------------
    // Keep the folded model's bounding box centered on the world origin and
    // resting on the grid, whatever the fold pose / object rotation is.
    const bboxMin = new THREE.Vector3()
    const bboxMax = new THREE.Vector3()
    const tmpV = new THREE.Vector3()
    const tmpM = new THREE.Matrix4()

    /** Model bounds in pivot-local space (after orient + fold, before pivot). */
    function computeModelBounds(): { min: THREE.Vector3; max: THREE.Vector3 } | null {
      orientGroup.updateMatrix()
      modelGroup.updateMatrix()
      let any = false
      bboxMin.set(Infinity, Infinity, Infinity)
      bboxMax.set(-Infinity, -Infinity, -Infinity)
      for (const [fid, mesh] of faceMeshes) {
        const pts = facePoints.get(fid)
        if (!pts) continue
        tmpM.multiplyMatrices(orientGroup.matrix, modelGroup.matrix).multiply(mesh.matrix)
        for (const p of pts) {
          tmpV.copy(p).applyMatrix4(tmpM)
          bboxMin.min(tmpV)
          bboxMax.max(tmpV)
          any = true
        }
      }
      return any ? { min: bboxMin, max: bboxMax } : null
    }

    const pivotTarget = new THREE.Vector3()
    function updatePivot(dt: number, snap: boolean) {
      const b = computeModelBounds()
      if (!b) return
      pivotTarget.set(
        -(b.min.x + b.max.x) / 2,
        -b.min.y,
        -(b.min.z + b.max.z) / 2,
      )
      if (snap) pivotGroup.position.copy(pivotTarget)
      else pivotGroup.position.lerp(pivotTarget, Math.min(1, dt * 10))
    }

    // ---- picking & gizmo drag ---------------------------------------------
    const raycaster = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    let drag: DragState | null = null
    let reshape: ReshapeState | null = null
    // True while an edge-ring reshape is live: preserves camera across the doc
    // rebuilds that reshape previews trigger.
    let reshaping = false
    let downPos: { x: number; y: number } | null = null
    // Manual multi-click tracking (pointerup has no reliable click count).
    const clickChain = { t: 0, x: 0, y: 0, count: 0 }

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
      const fid = primaryFaceId(s)
      if (fid === null) return null
      const node = s.tree.nodes.get(fid)
      if (!node || node.hingeEdgeId === null) return null
      const parentM = computeFaceMatrices(s.doc, s.tree, radAngles(getDisplayAngles(s))).get(
        node.parentFaceId!,
      )
      if (!parentM) return null
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

    /** Angle map for a group drag driven by the primary hinge's new angle. */
    function groupAngles(hinges: DragHinge[], primaryDeg: number): Record<number, number> {
      const out: Record<number, number> = {}
      const primary = hinges[0]
      out[primary.edgeId] = primaryDeg
      for (let i = 1; i < hinges.length; i++) {
        const h = hinges[i]
        let deg: number
        if (
          primary.target !== undefined &&
          primary.target !== 0 &&
          h.target !== undefined
        ) {
          // Fold coupled hinges proportionally toward their own targets.
          deg = h.target * (primaryDeg / primary.target)
        } else {
          deg = h.startDeg + (primaryDeg - primary.startDeg)
        }
        out[h.edgeId] = Math.max(-179, Math.min(179, deg))
      }
      return out
    }

    /**
     * Set up an edge-ring reshape from the current selection. `ndc` must already
     * be set to the pointer. Returns null if there's nothing draggable.
     */
    /**
     * The selected edge ring's world centroid + reshape axis (following the
     * fold). Used both to place the drag handle and to begin a reshape.
     */
    function edgeRingWorld(
      s: ReturnType<typeof useAppStore.getState>,
    ): { center: THREE.Vector3; worldAxis: THREE.Vector3; axisFlat: { x: number; y: number } } | null {
      const edges = s.selectedEdges
      if (edges.length === 0) return null
      const axisFlat = edgesAxis(s.doc, edges)
      const worldAxis = new THREE.Vector3()
      const center = new THREE.Vector3()
      const tmp = new THREE.Vector3()
      let count = 0
      for (const eid of edges) {
        const proxy = edgeProxies.get(eid)
        const owner = proxy?.parent as THREE.Mesh | undefined
        if (!proxy || !owner) continue
        owner.updateWorldMatrix(true, false)
        worldAxis.add(new THREE.Vector3(axisFlat.x, axisFlat.y, 0).transformDirection(owner.matrixWorld))
        center.add(proxy.getWorldPosition(tmp))
        count++
      }
      if (count === 0 || worldAxis.lengthSq() === 0) return null
      worldAxis.normalize()
      center.multiplyScalar(1 / count)
      return { center, worldAxis, axisFlat }
    }

    function beginReshape(
      s: ReturnType<typeof useAppStore.getState>,
      camera: THREE.Camera,
    ): ReshapeState | null {
      // Move the whole region beyond the ring, not just the ring's own
      // vertices — panels past the ring keep their shape so folds stay valid.
      const vertexIds = ringRegionVertexIds(s.doc, s.selectedEdges)
      if (vertexIds.length === 0) return null
      const rw = edgeRingWorld(s)
      if (!rw) return null
      const { center, worldAxis, axisFlat } = rw
      const camDir = new THREE.Vector3()
      camera.getWorldDirection(camDir)
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, center)
      raycaster.setFromCamera(ndc, camera)
      const start = new THREE.Vector3()
      if (!raycaster.ray.intersectPlane(plane, start)) return null
      return { docAtStart: s.doc, vertexIds, axisFlat, worldAxis, plane, start, scale: s.transform.scale }
    }

    function attachCellEvents(view: View) {
      const { cell, camera, controls } = view

      function onPointerDown(e: PointerEvent) {
        if (e.button !== 0) return
        downPos = { x: e.clientX, y: e.clientY }
        const s = useAppStore.getState()
        // Edge-ring reshape: edge mode + Move tool, grab a selected edge (or the
        // arrow handle) and drag it along the ring's axis to resize the model.
        // This is a DIELINE edit, so it also works while the model is folded
        // (scrubbed to a step) — the fold steps re-apply at the new size.
        if (s.selectMode === 'edge' && s.transformTool === 'move' && s.selectedEdges.length > 0) {
          setNdcForCell(e, cell)
          raycaster.setFromCamera(ndc, camera)
          const selProxies = s.selectedEdges
            .map((id) => edgeProxies.get(id))
            .filter((m): m is THREE.Mesh => !!m)
          // Grab either the visible arrow handle or a selected edge tube.
          const grabTargets = [...selProxies, ...(edgeHandle.visible ? handleMeshes : [])]
          if (grabTargets.length > 0 && raycaster.intersectObjects(grabTargets, false).length > 0) {
            const rs = beginReshape(s, camera)
            if (rs) {
              reshape = rs
              reshaping = true
              controls.enabled = false
              cell.setPointerCapture(e.pointerId)
              return
            }
          }
        }
        // Everything below folds hinges, which only makes sense at the edit head.
        if (s.playback.mode !== 'edit') return
        if (!gizmo.visible) return
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
        const hingeIds = selectedHinges(s)
        // Primary (the gizmo's hinge) first, then the rest of the selection.
        const ordered = [axis.edgeId, ...hingeIds.filter((h) => h !== axis.edgeId)]
        drag = {
          hinges: ordered.map((edgeId) => ({
            edgeId,
            startDeg: s.angles[edgeId] ?? 0,
            target: s.doc.targetAngles?.[edgeId],
          })),
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
        if (reshape) {
          setNdcForCell(e, cell)
          raycaster.setFromCamera(ndc, camera)
          const hit = new THREE.Vector3()
          if (!raycaster.ray.intersectPlane(reshape.plane, hit)) return
          const along = hit.sub(reshape.start).dot(reshape.worldAxis)
          const flatDist = reshape.scale !== 0 ? along / reshape.scale : along
          const res = moveVertices(reshape.docAtStart, reshape.vertexIds, {
            x: reshape.axisFlat.x * flatDist,
            y: reshape.axisFlat.y * flatDist,
          })
          if ('doc' in res) useAppStore.getState().setDocTransient(res.doc)
          return
        }
        if (!drag) return
        setNdcForCell(e, cell)
        raycaster.setFromCamera(ndc, camera)
        const hit = new THREE.Vector3()
        if (!raycaster.ray.intersectPlane(drag.plane, hit)) return
        const u1 = hit.sub(drag.center).normalize()
        const cross = new THREE.Vector3().crossVectors(drag.u0, u1)
        const delta = Math.atan2(drag.axisW.dot(cross), drag.u0.dot(u1))
        let deg = drag.hinges[0].startDeg + radToDeg(delta)
        if (e.shiftKey) {
          deg = Math.round(deg / 15) * 15
        } else if (!e.altKey) {
          // Soft-snap to preset/target angles (Alt = free rotation).
          for (const c of snapCandidates(drag.hinges[0].edgeId)) {
            if (Math.abs(deg - c) <= SNAP_TOLERANCE) {
              deg = c
              break
            }
          }
        }
        deg = Math.max(-179, Math.min(179, deg))
        drag.moved = true
        useAppStore.getState().setAnglesTransient(groupAngles(drag.hinges, deg))
      }

      function onPointerUp(e: PointerEvent) {
        if (reshape) {
          const s = useAppStore.getState()
          if (s.doc !== reshape.docAtStart) {
            s.dispatch(
              { type: 'setDoc', label: 'reshape edge ring', prev: reshape.docAtStart, next: s.doc },
              { alreadyApplied: true },
            )
          }
          reshape = null
          reshaping = false
          controls.enabled = true
          downPos = null
          return
        }
        if (drag) {
          const s = useAppStore.getState()
          if (drag.moved) {
            const changes = drag.hinges
              .map((h) => ({
                edgeId: h.edgeId,
                prev: h.startDeg,
                next: s.angles[h.edgeId] ?? 0,
              }))
              .filter((c) => c.prev !== c.next)
            if (changes.length === 1) {
              s.dispatch(
                { type: 'setAngle', edgeId: changes[0].edgeId, prev: changes[0].prev, next: changes[0].next },
                { alreadyApplied: true },
              )
            } else if (changes.length > 1) {
              s.dispatch({ type: 'setAngles', changes }, { alreadyApplied: true })
            }
          }
          drag = null
          controls.enabled = true
          downPos = null
          return
        }
        // A transform-gizmo drag just ended: don't treat it as a click-select.
        if (gizmoDragging) {
          downPos = null
          return
        }
        if (!downPos) return
        const dist = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y)
        downPos = null
        if (dist > 5) return
        setNdcForCell(e, cell)
        raycaster.setFromCamera(ndc, camera)
        const s = useAppStore.getState()
        const additive = e.ctrlKey || e.metaKey
        const now = performance.now()
        const near =
          now - clickChain.t < 450 &&
          Math.hypot(e.clientX - clickChain.x, e.clientY - clickChain.y) < 8
        clickChain.count = near ? clickChain.count + 1 : 1
        clickChain.t = now
        clickChain.x = e.clientX
        clickChain.y = e.clientY

        if (s.selectMode === 'edge') {
          const hits = raycaster.intersectObjects([...edgeProxies.values()], false)
          if (hits.length > 0) {
            const eid = hits[0].object.userData.edgeId as number
            if (clickChain.count >= 2) {
              // Double-click: the whole edge ring (Maya-style loop select).
              s.selectEdges(edgeRing(s.doc, eid))
            } else {
              s.selectEdge(eid, additive)
            }
          } else if (!additive) {
            clickChain.count = 0
            s.selectEdge(null)
          }
          return
        }

        const hits = raycaster.intersectObjects([...faceMeshes.values()], false)
        if (hits.length === 0) {
          if (!additive) {
            clickChain.count = 0
            s.selectFace(null)
          }
          return
        }
        const fid = hits[0].object.userData.faceId as number
        if (s.selectMode === 'object') {
          // Object mode: any click grabs the whole object (clicked face primary).
          s.selectFaces([...s.doc.faces.map((f) => f.id).filter((id) => id !== fid), fid])
          return
        }
        // Face mode: single = face, double = row, shift+double = column, triple = object.
        if (clickChain.count >= 3) {
          s.selectFaces([...s.doc.faces.map((f) => f.id).filter((id) => id !== fid), fid])
        } else if (clickChain.count === 2) {
          const band = e.shiftKey ? columnFaceIds(s.doc, fid) : rowFaceIds(s.doc, fid)
          s.selectFaces([...band.filter((id) => id !== fid), fid])
        } else {
          s.selectFace(fid, additive)
        }
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

    // ---- W/E/R transform gizmo (move / rotate / scale the whole object) -----
    // Bound to the perspective view; the helper renders in every view but is
    // only interactive in the persp cell. Writes back into store.transform.
    const perspView = views[0]
    const transformControls = new TransformControls(perspView.camera, perspView.cell)
    transformControls.setSpace('world')
    let gizmoDragging = false
    transformControls.addEventListener('dragging-changed', (e) => {
      gizmoDragging = (e as unknown as { value: boolean }).value
      for (const v of views) v.controls.enabled = !gizmoDragging
    })
    transformControls.addEventListener('objectChange', () => {
      const st = useAppStore.getState()
      if (st.transformTool === 'move') {
        const p = placementGroup.position
        st.setTransform({ translate: { x: p.x, y: p.y, z: p.z } })
      } else if (st.transformTool === 'rotate') {
        const r = orientGroup.rotation
        st.setTransform({
          rotateDeg: { x: radToDeg(r.x), y: radToDeg(r.y), z: radToDeg(r.z) },
        })
      } else if (st.transformTool === 'scale') {
        // On a rotated object TransformControls can report wild (even
        // negative) per-axis values; average the magnitudes and write the
        // uniform value back so the drag never shears or collapses the model.
        const sc = orientGroup.scale
        const uniform = Math.max(0.05, (Math.abs(sc.x) + Math.abs(sc.y) + Math.abs(sc.z)) / 3)
        orientGroup.scale.setScalar(uniform)
        st.setTransform({ scale: uniform })
      }
    })
    // r0.166 TransformControls is an Object3D; newer versions expose getHelper().
    const tcAny = transformControls as unknown as { getHelper?: () => THREE.Object3D }
    scene.add(tcAny.getHelper ? tcAny.getHelper() : (transformControls as unknown as THREE.Object3D))
    transformControls.enabled = false
    transformControls.visible = false
    let lastTool: string | null = null

    /** Attach/detach the gizmo to the right group when the tool changes. */
    function syncTransformGizmo(s: ReturnType<typeof useAppStore.getState>) {
      const hasModel = faceMeshes.size > 0
      // The whole-object transform is pose-independent, so it works while a
      // folded pose is shown too (just not during active playback). In edge
      // mode the ring handle owns the Move tool, so keep this out of the way.
      const playing = s.playback.mode === 'scrub' && s.playback.playing
      const active =
        s.editorMode === '3d' &&
        !playing &&
        s.transformTool !== 'select' &&
        s.selectMode !== 'edge' &&
        hasModel
      const key = active ? s.transformTool : 'off'
      if (key === lastTool) return
      lastTool = key
      if (!active) {
        transformControls.detach()
        transformControls.enabled = false
        transformControls.visible = false
        return
      }
      const mode = s.transformTool === 'move' ? 'translate' : s.transformTool
      transformControls.setMode(mode as 'translate' | 'rotate' | 'scale')
      // Scale must run in LOCAL space: world-space scaling of a rotated
      // object is ill-defined and used to collapse the model to the 0.05
      // floor (the "model shrinks and can't be fixed" bug).
      transformControls.setSpace(s.transformTool === 'scale' ? 'local' : 'world')
      transformControls.attach(s.transformTool === 'move' ? placementGroup : orientGroup)
      transformControls.enabled = true
      transformControls.visible = true
    }

    // ---- edge-ring move handle (Move tool + edge mode) ---------------------
    // A visible double-arrow on the selected ring, along its reshape axis. Drag
    // it (or the ring itself) to resize the model — e.g. a carton's height.
    const edgeHandleMat = new THREE.MeshBasicMaterial({
      color: 0xff9f1c,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
    })
    const edgeHandle = new THREE.Group()
    const handleShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2, 12), edgeHandleMat)
    const handleUp = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.42, 16), edgeHandleMat)
    handleUp.position.y = 1.15
    const handleDn = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.42, 16), edgeHandleMat)
    handleDn.position.y = -1.15
    handleDn.rotation.z = Math.PI
    const handleMeshes = [handleShaft, handleUp, handleDn]
    edgeHandle.add(...handleMeshes)
    edgeHandle.renderOrder = 999
    edgeHandle.visible = false
    scene.add(edgeHandle)

    /** Place/orient/scale the edge-ring handle; hide it when not applicable. */
    function updateEdgeHandle(s: ReturnType<typeof useAppStore.getState>) {
      const playing = s.playback.mode === 'scrub' && s.playback.playing
      const active =
        s.editorMode === '3d' &&
        !playing &&
        s.selectMode === 'edge' &&
        s.transformTool === 'move' &&
        s.selectedEdges.length > 0
      const rw = active ? edgeRingWorld(s) : null
      if (!rw) {
        edgeHandle.visible = false
        return
      }
      edgeHandle.visible = true
      edgeHandle.position.copy(rw.center)
      edgeHandle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), rw.worldAxis)
      const b = computeModelBounds()
      const size = b ? b.min.distanceTo(b.max) : 6
      edgeHandle.scale.setScalar(Math.max(0.5, size * 0.11))
    }

    // ---- capture for instruction-sheet export ------------------------------
    function capture(poses: PoseAngles[], size = { w: 720, h: 540 }): string[] {
      const s = useAppStore.getState()
      const off = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
      off.setSize(size.w, size.h)
      const cam = new THREE.PerspectiveCamera(40, size.w / size.h, 0.1, 500)
      const prevBg = scene.background
      const prevGrid = grid.visible
      const prevGizmo = gizmo.visible
      scene.background = new THREE.Color(0xf7f3ea)
      grid.visible = false
      gizmo.visible = false
      const urls: string[] = []
      try {
        for (const pose of poses) {
          const matrices = computeFaceMatrices(s.doc, s.tree, radAngles(pose))
          for (const [fid, mesh] of faceMeshes) {
            const m = matrices.get(fid)
            if (m) mesh.matrix.copy(m)
          }
          updatePivot(0, true)
          scene.updateMatrixWorld(true)
          const b = computeModelBounds()
          const c = b
            ? new THREE.Vector3(0, (b.max.y - b.min.y) / 2, 0)
            : new THREE.Vector3()
          const radius = b ? Math.max(1.5, b.min.distanceTo(b.max) / 2) : 5
          const dist = radius / Math.tan(degToRad(cam.fov / 2)) + radius * 0.4
          cam.position.copy(c).add(new THREE.Vector3(0.85, 0.75, 1).normalize().multiplyScalar(dist))
          cam.lookAt(c)
          off.render(scene, cam)
          urls.push(off.domElement.toDataURL('image/png'))
        }
      } finally {
        scene.background = prevBg
        grid.visible = prevGrid
        gizmo.visible = prevGizmo
        off.dispose()
      }
      return urls
    }
    registerCapture(capture, async () => {
      // A newer build may start while we wait; settle on the latest one.
      let p: Promise<void>
      do {
        p = texPending
        await p
      } while (p !== texPending)
    })

    // Dev-only handle for scripted verification (scripts/verify-*.mjs).
    if (import.meta.env.DEV) {
      ;(window as unknown as Record<string, unknown>).paperSimViewer = {
        gizmo,
        transformControls,
        views,
        placementGroup,
        pivotGroup,
        orientGroup,
        capture,
        faceMeshes: () => faceMeshes,
        edgeProxies: () => edgeProxies,
        edgeHandleVisible: () => edgeHandle.visible,
      }
    }

    // ---- F to frame --------------------------------------------------------
    function frameOn(center: THREE.Vector3, radius: number) {
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

    function frameViews() {
      const s = useAppStore.getState()
      const fid = primaryFaceId(s)
      if (fid === null) {
        // Nothing selected: frame the whole model where it currently is.
        updatePivot(0, true)
        const b = computeModelBounds()
        if (!b) {
          views.forEach(applyHome)
          return
        }
        const center = new THREE.Vector3(0, (b.max.y - b.min.y) / 2, 0)
        const radius = Math.max(2, b.min.distanceTo(b.max) / 2)
        frameOn(center, radius)
        return
      }
      const face = s.doc.faces.find((f) => f.id === fid)
      const mesh = faceMeshes.get(fid)
      if (!face || !mesh) return
      pivotGroup.updateMatrixWorld(true)
      const pts = face.vertexIds.map((id) => {
        const v = s.doc.vertices.find((v) => v.id === id)!
        return new THREE.Vector3(v.pos.x, v.pos.y, 0)
          .applyMatrix4(mesh.matrix)
          .applyMatrix4(modelGroup.matrixWorld)
      })
      const center = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(pts.length)
      const radius = Math.max(1.5, ...pts.map((p) => p.distanceTo(center)))
      frameOn(center, radius)
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
    let firstFrame = true
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
        const inSel = s.selection.includes(fid)
        const isPrimary = fid === primaryFaceId(s)
        mat.emissive.setHex(
          isPrimary ? SELECT_EMISSIVE : inSel ? SELECT_EMISSIVE_SECONDARY : 0x000000,
        )
        mat.emissiveIntensity = 0.35
      }

      // Whole-object transform. While the transform gizmo owns a group we let
      // it drive that group and read the value back (in objectChange); the
      // other components still track the store.
      syncTransformGizmo(s)
      const tf = s.transform
      if (!(gizmoDragging && s.transformTool === 'rotate')) {
        orientGroup.rotation.set(
          degToRad(tf.rotateDeg.x),
          degToRad(tf.rotateDeg.y),
          degToRad(tf.rotateDeg.z),
        )
      }
      if (!(gizmoDragging && s.transformTool === 'scale')) orientGroup.scale.setScalar(tf.scale)
      if (!(gizmoDragging && s.transformTool === 'move')) {
        placementGroup.position.set(tf.translate.x, tf.translate.y, tf.translate.z)
      }
      // Auto-center pivot: frozen only while dragging the fold gizmo (so the
      // model doesn't shift under the cursor). Runs during transform-gizmo
      // drags so rotate/scale stay centered on the model.
      if (!drag) updatePivot(dt, firstFrame)
      firstFrame = false

      const hinge = selectedHinge(s)
      const groupHinges = selectedHinges(s)
      for (const [edgeId, line] of creaseLines) {
        const mat = line.material as THREE.LineBasicMaterial
        if (edgeId === hinge || groupHinges.includes(edgeId)) {
          mat.color.setHex(CREASE_SELECTED)
        } else {
          const a = display[edgeId] ?? 0
          mat.color.setHex(a > 1 ? CREASE_VALLEY : a < -1 ? CREASE_MOUNTAIN : CREASE_FLAT)
        }
      }

      // Highlight selected edges (edge mode): show their pick tubes.
      const edgeSel = s.selectMode === 'edge' ? s.selectedEdges : []
      for (const [edgeId, tube] of edgeProxies) {
        ;(tube.material as THREE.MeshBasicMaterial).visible = edgeSel.includes(edgeId)
      }
      // Position the edge-ring move handle over the current selection.
      updateEdgeHandle(s)

      // Fold arc gizmo only in the default folding mode (face + Select tool);
      // the W/E/R transform gizmo and edge mode replace it otherwise.
      const foldMode = s.selectMode === 'face' && s.transformTool === 'select'
      const axis = s.playback.mode === 'edit' && foldMode ? selectedAxis() : null
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
      transformControls.detach()
      transformControls.dispose()
      views.forEach((v) => v.controls.dispose())
      registerCapture(null)
      disposeModel()
      sheetTex?.dispose()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
    }
  }, [])

  return (
    <div
      ref={mountRef}
      className={`viewport layout-${viewLayout}`}
      style={editorMode === 'pattern' ? { display: 'none' } : undefined}
    >
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
