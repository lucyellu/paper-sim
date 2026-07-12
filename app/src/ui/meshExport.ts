// Orchestrates 3D mesh export in OBJ / GLB / FBX, folded or flat. Bakes the
// mesh (model/meshExport), renders the sheet texture when the material needs
// one, and downloads: OBJ and textured FBX ship as a small zip (mesh + .mtl /
// texture) via ui/zip; GLB is a single self-contained binary; untextured FBX
// is a plain .fbx.

import { bakeMesh, type MeshPose } from '../model/meshExport'
import { buildFbxAscii } from '../model/fbxExport'
import { buildMtl, buildObj, type ObjMaterial } from '../model/objExport'
import { nextExportName, slugify } from '../model/naming'
import * as THREE from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { getDisplayAngles, type AppState } from '../state/store'
import { buildSheetCanvas, materialNeedsTexture } from '../viewer/texture'
import { downloadBlob, downloadText } from './exports'
import { buildZip, dataUrlBytes, type ZipEntry } from './zip'

export type { MeshPose } from '../model/meshExport'
export type MeshFormat = 'obj' | 'glb' | 'fbx'

function poseKind(pose: MeshPose): string {
  return pose === 'flat' ? 'model_flat' : 'model'
}

/** Render the sheet texture to PNG bytes, or null when the material is flat color. */
async function texturePng(s: AppState): Promise<Uint8Array | null> {
  if (!materialNeedsTexture(s.material)) return null
  const canvas = await buildSheetCanvas(s.doc, s.material)
  return dataUrlBytes(canvas.toDataURL('image/png'))
}

export async function exportMesh(s: AppState, format: MeshFormat, pose: MeshPose): Promise<void> {
  const slug = slugify(s.projectName)
  const mesh = bakeMesh(s.doc, s.tree, getDisplayAngles(s), pose, s.uvEdits)
  const kind = poseKind(pose)
  const base = `${slug}_${kind}`
  const png = await texturePng(s)

  if (format === 'obj') {
    const mat: ObjMaterial = {
      name: 'paper',
      color: s.material.baseColor,
      textureFile: png ? `${base}.png` : undefined,
    }
    const obj = buildObj(mesh, mat, `${base}.mtl`)
    const mtl = buildMtl(mat)
    const entries: ZipEntry[] = [
      { name: `${base}.obj`, data: obj },
      { name: `${base}.mtl`, data: mtl },
    ]
    if (png) entries.push({ name: `${base}.png`, data: png })
    downloadBlob(buildZip(entries), nextExportName(s.projectName, `obj_${pose}`, 'zip'))
    return
  }

  if (format === 'fbx') {
    const fbx = buildFbxAscii(mesh, {
      color: s.material.baseColor,
      textureFile: png ? `${base}.png` : undefined,
    })
    if (png) {
      downloadBlob(
        buildZip([
          { name: `${base}.fbx`, data: fbx },
          { name: `${base}.png`, data: png },
        ]),
        nextExportName(s.projectName, `fbx_${pose}`, 'zip'),
      )
    } else {
      downloadText(fbx, nextExportName(s.projectName, kind, 'fbx'), 'application/octet-stream')
    }
    return
  }

  // GLB — single self-contained binary via three's GLTFExporter.
  const blob = await buildGlb(mesh, s, png !== null)
  downloadBlob(blob, nextExportName(s.projectName, kind, 'glb'))
}

async function buildGlb(
  mesh: ReturnType<typeof bakeMesh>,
  s: AppState,
  textured: boolean,
): Promise<Blob> {
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(mesh.positions, 3))
  // glTF uses a top-left UV origin and GLTFExporter can't bake flipY=true, so
  // flip V here (equivalent to the viewer's default flipY=true CanvasTexture).
  const uvFlipped = mesh.uvs.map((v, i) => (i % 2 === 1 ? 1 - v : v))
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvFlipped, 2))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(mesh.normals, 3))
  geom.setIndex(mesh.triangles)

  const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, side: THREE.DoubleSide })
  let tex: THREE.CanvasTexture | null = null
  if (textured) {
    const canvas = await buildSheetCanvas(s.doc, s.material)
    tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.flipY = false // glTF UV convention (top-left origin)
    mat.map = tex
    mat.color.setHex(0xffffff)
  } else {
    mat.color.set(s.material.baseColor)
  }

  const scene = new THREE.Scene()
  const meshObj = new THREE.Mesh(geom, mat)
  meshObj.name = 'paper'
  scene.add(meshObj)

  const result = await new Promise<ArrayBuffer>((resolve, reject) => {
    new GLTFExporter().parse(
      scene,
      (out) => resolve(out as ArrayBuffer),
      (err) => reject(err),
      { binary: true },
    )
  })
  geom.dispose()
  mat.dispose()
  tex?.dispose()
  return new Blob([result], { type: 'model/gltf-binary' })
}
