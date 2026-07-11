// Material settings for the sheet: a base look (flat color, procedural kraft
// paper, or an uploaded texture) plus an optional design overlay image that
// maps onto the dieline like a UV map / product mockup. Persisted in the FOLD
// file as paperSim:material (images as data URLs).

export type BaseKind = 'color' | 'kraft' | 'image'

/**
 * How the design overlay is placed on the dieline (a UV-editor transform).
 * Units are fractions of the sheet: identity (offset 0, scale 1, rot 0) fills
 * the whole dieline, matching the pre-transform full-stretch behaviour.
 */
export interface OverlayTransform {
  offsetX: number
  offsetY: number
  scaleX: number
  scaleY: number
  rotationDeg: number
}

export interface MaterialSettings {
  /** Base paper color (also tints under the overlay when there's no texture). */
  baseColor: string
  baseKind: BaseKind
  /** Data URL of the uploaded base texture (tiled), when baseKind = 'image'. */
  baseImage?: string
  /** Data URL of the design overlay, mapped onto the dieline. */
  overlayImage?: string
  /** Placement of the overlay on the dieline (defaults to full-stretch). */
  overlayTransform?: OverlayTransform
}

export function identityOverlayTransform(): OverlayTransform {
  return { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotationDeg: 0 }
}

export function defaultMaterial(): MaterialSettings {
  // Matches the pre-material kraft-brown look.
  return { baseColor: '#d9bc8d', baseKind: 'color' }
}

function sanitizeOverlayTransform(t: unknown): OverlayTransform | undefined {
  if (typeof t !== 'object' || t === null) return undefined
  const o = t as Partial<OverlayTransform>
  const num = (v: unknown, fb: number) => (Number.isFinite(v) ? (v as number) : fb)
  return {
    offsetX: num(o.offsetX, 0),
    offsetY: num(o.offsetY, 0),
    scaleX: num(o.scaleX, 1),
    scaleY: num(o.scaleY, 1),
    rotationDeg: num(o.rotationDeg, 0),
  }
}

export function sanitizeMaterial(m: unknown): MaterialSettings {
  const d = defaultMaterial()
  if (typeof m !== 'object' || m === null) return d
  const o = m as Partial<MaterialSettings>
  return {
    baseColor: typeof o.baseColor === 'string' ? o.baseColor : d.baseColor,
    baseKind: o.baseKind === 'kraft' || o.baseKind === 'image' ? o.baseKind : 'color',
    baseImage: typeof o.baseImage === 'string' ? o.baseImage : undefined,
    overlayImage: typeof o.overlayImage === 'string' ? o.overlayImage : undefined,
    overlayTransform: sanitizeOverlayTransform(o.overlayTransform),
  }
}
