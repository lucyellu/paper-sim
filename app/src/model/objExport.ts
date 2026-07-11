// Wavefront OBJ + MTL writer (dependency-free). Emits n-gon faces with UVs and
// normals, and an MTL that either carries a flat diffuse color or references an
// external texture image file (bundled alongside in a zip when present).

import type { BakedMesh } from './meshExport'

export interface ObjMaterial {
  name: string
  /** Diffuse color as #rrggbb (used when there's no texture map). */
  color: string
  /** Texture image file name to reference as map_Kd, if any. */
  textureFile?: string
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export function buildObj(mesh: BakedMesh, material: ObjMaterial, mtlFileName: string): string {
  const lines: string[] = ['# Paper Sim OBJ export', `mtllib ${mtlFileName}`, 'o paper']
  const p = mesh.positions
  for (let i = 0; i < p.length; i += 3) {
    lines.push(`v ${fmt(p[i])} ${fmt(p[i + 1])} ${fmt(p[i + 2])}`)
  }
  const uv = mesh.uvs
  for (let i = 0; i < uv.length; i += 2) {
    lines.push(`vt ${fmt(uv[i])} ${fmt(uv[i + 1])}`)
  }
  const nr = mesh.normals
  for (let i = 0; i < nr.length; i += 3) {
    lines.push(`vn ${fmt(nr[i])} ${fmt(nr[i + 1])} ${fmt(nr[i + 2])}`)
  }
  lines.push(`usemtl ${material.name}`, 's off')
  for (const poly of mesh.polygons) {
    // OBJ indices are 1-based; v/vt/vn share the same index here.
    lines.push('f ' + poly.map((i) => `${i + 1}/${i + 1}/${i + 1}`).join(' '))
  }
  return lines.join('\n') + '\n'
}

export function buildMtl(material: ObjMaterial): string {
  const [r, g, b] = hexToRgb(material.color)
  const lines = [
    '# Paper Sim MTL',
    `newmtl ${material.name}`,
    'Ka 0.0 0.0 0.0',
    `Kd ${fmt(r)} ${fmt(g)} ${fmt(b)}`,
    'Ks 0.0 0.0 0.0',
    'd 1.0',
    'illum 1',
  ]
  if (material.textureFile) lines.push(`map_Kd ${material.textureFile}`)
  return lines.join('\n') + '\n'
}

function fmt(n: number): string {
  return Number.isFinite(n) ? (Math.round(n * 1e6) / 1e6).toString() : '0'
}
