// Minimal ASCII FBX 7400 writer (three.js ships no FBX exporter). Emits one
// mesh with per-polygon-vertex normals + UVs and a single Lambert material,
// optionally referencing an external texture by relative file name (bundled in
// a zip beside the .fbx). Verified to import into Blender's FBX importer.
//
// FBX conventions used here:
//  - Vertices: flat xyz control points.
//  - PolygonVertexIndex: control-point indices; the LAST index of each polygon
//    is stored as -(index+1) to mark the polygon boundary.
//  - Normals / UVs: ByPolygonVertex + Direct, in PolygonVertexIndex order.

import type { BakedMesh } from './meshExport'

export interface FbxMaterial {
  color: string // #rrggbb
  textureFile?: string
}

const GEO_ID = 1000000
const MODEL_ID = 2000000
const MAT_ID = 3000000
const TEX_ID = 4000000
const VIDEO_ID = 5000000

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** Format a numeric array as comma-separated FBX values. */
function arr(nums: number[]): string {
  return nums.map((n) => (Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : 0)).join(',')
}

export function buildFbxAscii(mesh: BakedMesh, material: FbxMaterial): string {
  // PolygonVertexIndex with boundary-negated last index per polygon.
  const pvi: number[] = []
  for (const poly of mesh.polygons) {
    for (let i = 0; i < poly.length; i++) {
      const idx = poly[i]
      pvi.push(i === poly.length - 1 ? -(idx + 1) : idx)
    }
  }

  // Normals / UVs are already stored per polygon-vertex in mesh order, which is
  // the same order polygons enumerate their indices, so emit them directly.
  const normals: number[] = []
  const uvs: number[] = []
  for (const poly of mesh.polygons) {
    for (const idx of poly) {
      normals.push(mesh.normals[idx * 3], mesh.normals[idx * 3 + 1], mesh.normals[idx * 3 + 2])
      uvs.push(mesh.uvs[idx * 2], mesh.uvs[idx * 2 + 1])
    }
  }

  const [r, g, b] = hexToRgb(material.color)
  const hasTex = !!material.textureFile

  const defsCount = hasTex ? 5 : 3
  const parts: string[] = []
  parts.push(header())
  parts.push(globalSettings())
  parts.push(documents())
  parts.push(definitions(defsCount, hasTex))

  // ---- Objects ----
  const objs: string[] = []
  objs.push(`\tGeometry: ${GEO_ID}, "Geometry::paper", "Mesh" {`)
  objs.push(`\t\tVertices: *${mesh.positions.length} {`)
  objs.push(`\t\t\ta: ${arr(mesh.positions)}`)
  objs.push('\t\t}')
  objs.push(`\t\tPolygonVertexIndex: *${pvi.length} {`)
  objs.push(`\t\t\ta: ${pvi.join(',')}`)
  objs.push('\t\t}')
  objs.push('\t\tGeometryVersion: 124')
  objs.push('\t\tLayerElementNormal: 0 {')
  objs.push('\t\t\tVersion: 101')
  objs.push('\t\t\tName: ""')
  objs.push('\t\t\tMappingInformationType: "ByPolygonVertex"')
  objs.push('\t\t\tReferenceInformationType: "Direct"')
  objs.push(`\t\t\tNormals: *${normals.length} {`)
  objs.push(`\t\t\t\ta: ${arr(normals)}`)
  objs.push('\t\t\t}')
  objs.push('\t\t}')
  objs.push('\t\tLayerElementUV: 0 {')
  objs.push('\t\t\tVersion: 101')
  objs.push('\t\t\tName: "map1"')
  objs.push('\t\t\tMappingInformationType: "ByPolygonVertex"')
  objs.push('\t\t\tReferenceInformationType: "Direct"')
  objs.push(`\t\t\tUV: *${uvs.length} {`)
  objs.push(`\t\t\t\ta: ${arr(uvs)}`)
  objs.push('\t\t\t}')
  objs.push('\t\t}')
  objs.push('\t\tLayerElementMaterial: 0 {')
  objs.push('\t\t\tVersion: 101')
  objs.push('\t\t\tName: ""')
  objs.push('\t\t\tMappingInformationType: "AllSame"')
  objs.push('\t\t\tReferenceInformationType: "IndexToDirect"')
  objs.push('\t\t\tMaterials: *1 {')
  objs.push('\t\t\t\ta: 0')
  objs.push('\t\t\t}')
  objs.push('\t\t}')
  objs.push('\t\tLayer: 0 {')
  objs.push('\t\t\tVersion: 100')
  objs.push('\t\t\tLayerElement:  {')
  objs.push('\t\t\t\tType: "LayerElementNormal"')
  objs.push('\t\t\t\tTypedIndex: 0')
  objs.push('\t\t\t}')
  objs.push('\t\t\tLayerElement:  {')
  objs.push('\t\t\t\tType: "LayerElementUV"')
  objs.push('\t\t\t\tTypedIndex: 0')
  objs.push('\t\t\t}')
  objs.push('\t\t\tLayerElement:  {')
  objs.push('\t\t\t\tType: "LayerElementMaterial"')
  objs.push('\t\t\t\tTypedIndex: 0')
  objs.push('\t\t\t}')
  objs.push('\t\t}')
  objs.push('\t}')

  objs.push(`\tModel: ${MODEL_ID}, "Model::paper", "Mesh" {`)
  objs.push('\t\tVersion: 232')
  objs.push('\t\tProperties70:  {')
  objs.push('\t\t\tP: "Lcl Scaling", "Lcl Scaling", "", "A",1,1,1')
  objs.push('\t\t}')
  objs.push('\t\tShading: T')
  objs.push('\t\tCulling: "CullingOff"')
  objs.push('\t}')

  objs.push(`\tMaterial: ${MAT_ID}, "Material::paper", "" {`)
  objs.push('\t\tVersion: 102')
  objs.push('\t\tShadingModel: "lambert"')
  objs.push('\t\tMultiLayer: 0')
  objs.push('\t\tProperties70:  {')
  objs.push('\t\t\tP: "ShadingModel", "KString", "", "", "lambert"')
  objs.push(`\t\t\tP: "DiffuseColor", "Color", "", "A",${r},${g},${b}`)
  objs.push(`\t\t\tP: "Diffuse", "Vector3D", "Vector", "",${r},${g},${b}`)
  objs.push('\t\t}')
  objs.push('\t}')

  if (hasTex) {
    const file = material.textureFile!
    objs.push(`\tVideo: ${VIDEO_ID}, "Video::paperTex", "Clip" {`)
    objs.push('\t\tType: "Clip"')
    objs.push('\t\tProperties70:  {')
    objs.push(`\t\t\tP: "Path", "KString", "XRefUrl", "", "${file}"`)
    objs.push('\t\t}')
    objs.push('\t\tUseMipMap: 0')
    objs.push(`\t\tFilename: "${file}"`)
    objs.push(`\t\tRelativeFilename: "${file}"`)
    objs.push('\t}')
    objs.push(`\tTexture: ${TEX_ID}, "Texture::paperTex", "" {`)
    objs.push('\t\tType: "TextureVideoClip"')
    objs.push('\t\tVersion: 202')
    objs.push('\t\tTextureName: "Texture::paperTex"')
    objs.push('\t\tProperties70:  {')
    objs.push('\t\t\tP: "UVSet", "KString", "", "", "map1"')
    objs.push('\t\t\tP: "UseMaterial", "int", "Integer", "",1')
    objs.push('\t\t}')
    objs.push('\t\tMedia: "Video::paperTex"')
    objs.push(`\t\tFilename: "${file}"`)
    objs.push(`\t\tRelativeFilename: "${file}"`)
    objs.push('\t\tModelUVTranslation: 0,0')
    objs.push('\t\tModelUVScaling: 1,1')
    objs.push('\t}')
  }

  parts.push('Objects:  {\n' + objs.join('\n') + '\n}')

  // ---- Connections ----
  const cons: string[] = []
  cons.push(`\tC: "OO",${MODEL_ID},0`)
  cons.push(`\tC: "OO",${GEO_ID},${MODEL_ID}`)
  cons.push(`\tC: "OO",${MAT_ID},${MODEL_ID}`)
  if (hasTex) {
    cons.push(`\tC: "OP",${TEX_ID},${MAT_ID}, "DiffuseColor"`)
    cons.push(`\tC: "OO",${VIDEO_ID},${TEX_ID}`)
  }
  parts.push('Connections:  {\n' + cons.join('\n') + '\n}')

  return parts.join('\n') + '\n'
}

function header(): string {
  return `; FBX 7.4.0 project file
; Created by Paper Sim
FBXHeaderExtension:  {
\tFBXHeaderVersion: 1003
\tFBXVersion: 7400
\tCreator: "Paper Sim"
}`
}

function globalSettings(): string {
  return `GlobalSettings:  {
\tVersion: 1000
\tProperties70:  {
\t\tP: "UpAxis", "int", "Integer", "",1
\t\tP: "UpAxisSign", "int", "Integer", "",1
\t\tP: "FrontAxis", "int", "Integer", "",2
\t\tP: "FrontAxisSign", "int", "Integer", "",1
\t\tP: "CoordAxis", "int", "Integer", "",0
\t\tP: "CoordAxisSign", "int", "Integer", "",1
\t\tP: "UnitScaleFactor", "double", "Number", "",1
\t}
}`
}

function documents(): string {
  return `Documents:  {
\tCount: 1
\tDocument: 1, "", "Scene" {
\t\tRootNode: 0
\t}
}`
}

function definitions(count: number, hasTex: boolean): string {
  const lines = [
    'Definitions:  {',
    '\tVersion: 100',
    `\tCount: ${count}`,
    '\tObjectType: "Geometry" {\n\t\tCount: 1\n\t}',
    '\tObjectType: "Model" {\n\t\tCount: 1\n\t}',
    '\tObjectType: "Material" {\n\t\tCount: 1\n\t}',
  ]
  if (hasTex) {
    lines.push('\tObjectType: "Texture" {\n\t\tCount: 1\n\t}')
    lines.push('\tObjectType: "Video" {\n\t\tCount: 1\n\t}')
  }
  lines.push('}')
  return lines.join('\n')
}
