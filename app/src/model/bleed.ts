// Print bleed: grow painted pixels outward into unpainted ones, each taking
// its nearest painted pixel's color, so a slightly-off cut shows artwork
// instead of paper. Two raster passes of 8-neighbour nearest-seed propagation
// (a chamfer-style distance transform): O(pixels), near-exact distances.

/**
 * Extend `mask`ed pixels of `data` (RGBA, w × h) by up to `radius` px.
 * Returns the grown mask; `data` is written in place.
 */
export function bleedPixels(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  mask: Uint8Array,
  radius: number,
): Uint8Array {
  const n = w * h
  const seed = new Int32Array(n).fill(-1)
  const d2 = new Float64Array(n).fill(Infinity)
  for (let i = 0; i < n; i++) {
    if (mask[i]) {
      seed[i] = i
      d2[i] = 0
    }
  }
  const relax = (i: number, x: number, y: number, nx: number, ny: number) => {
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) return
    const s = seed[ny * w + nx]
    if (s < 0) return
    const dx = (s % w) - x
    const dy = Math.floor(s / w) - y
    const d = dx * dx + dy * dy
    if (d < d2[i]) {
      d2[i] = d
      seed[i] = s
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (d2[i] === 0) continue
      relax(i, x, y, x - 1, y)
      relax(i, x, y, x - 1, y - 1)
      relax(i, x, y, x, y - 1)
      relax(i, x, y, x + 1, y - 1)
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x
      if (d2[i] === 0) continue
      relax(i, x, y, x + 1, y)
      relax(i, x, y, x + 1, y + 1)
      relax(i, x, y, x, y + 1)
      relax(i, x, y, x - 1, y + 1)
    }
  }
  const out = new Uint8Array(n)
  const r2 = radius * radius
  for (let i = 0; i < n; i++) {
    if (mask[i]) {
      out[i] = 1
    } else if (seed[i] >= 0 && d2[i] <= r2) {
      const s = seed[i] * 4
      data[i * 4] = data[s]
      data[i * 4 + 1] = data[s + 1]
      data[i * 4 + 2] = data[s + 2]
      data[i * 4 + 3] = 255
      out[i] = 1
    }
  }
  return out
}
