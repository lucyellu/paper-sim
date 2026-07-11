// Whole-object placement transform for the 3D scene: a free translate, an XYZ
// euler rotation in degrees, and a uniform scale. Lives in its own module so
// both the store and the FOLD save/load code can share it without a cycle.

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface Transform {
  translate: Vec3
  rotateDeg: Vec3
  scale: number
}

export function identityTransform(): Transform {
  return { translate: { x: 0, y: 0, z: 0 }, rotateDeg: { x: 0, y: 0, z: 0 }, scale: 1 }
}

/** Coerce arbitrary JSON (or a legacy {x,y,z} rotation) into a Transform. */
export function sanitizeTransform(t: unknown, legacyRotation?: unknown): Transform {
  const d = identityTransform()
  const vec3 = (v: unknown, fb: Vec3): Vec3 => {
    if (typeof v !== 'object' || v === null) return fb
    const o = v as Partial<Vec3>
    return {
      x: Number.isFinite(o.x) ? (o.x as number) : fb.x,
      y: Number.isFinite(o.y) ? (o.y as number) : fb.y,
      z: Number.isFinite(o.z) ? (o.z as number) : fb.z,
    }
  }
  if (typeof t === 'object' && t !== null) {
    const o = t as Partial<Transform>
    return {
      translate: vec3(o.translate, d.translate),
      rotateDeg: vec3(o.rotateDeg, d.rotateDeg),
      scale: Number.isFinite(o.scale) && (o.scale as number) > 0 ? (o.scale as number) : 1,
    }
  }
  // Legacy save files stored only a whole-object rotation.
  if (legacyRotation !== undefined) {
    return { ...d, rotateDeg: vec3(legacyRotation, d.rotateDeg) }
  }
  return d
}
