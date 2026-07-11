// Material settings for the sheet: a base look (flat color, procedural kraft
// paper, or an uploaded texture) plus an optional design overlay image that
// maps onto the dieline like a UV map / product mockup. Persisted in the FOLD
// file as paperSim:material (images as data URLs).

export type BaseKind = 'color' | 'kraft' | 'image'

export interface MaterialSettings {
  /** Base paper color (also tints under the overlay when there's no texture). */
  baseColor: string
  baseKind: BaseKind
  /** Data URL of the uploaded base texture (tiled), when baseKind = 'image'. */
  baseImage?: string
  /** Data URL of the design overlay, stretched over the whole dieline. */
  overlayImage?: string
}

export function defaultMaterial(): MaterialSettings {
  // Matches the pre-material kraft-brown look.
  return { baseColor: '#d9bc8d', baseKind: 'color' }
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
  }
}
