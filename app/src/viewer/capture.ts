// Bridge between the UI (export buttons) and the live three.js viewer:
// ThreeView registers a capture function that renders arbitrary fold poses
// to image data URLs for the instruction-sheet export.

export type PoseAngles = Record<number, number> // hinge edge id -> degrees

export type CaptureFn = (poses: PoseAngles[], size?: { w: number; h: number }) => string[]

let captureFn: CaptureFn | null = null
let readyFn: (() => Promise<void>) | null = null

export function registerCapture(fn: CaptureFn | null, ready?: () => Promise<void>): void {
  captureFn = fn
  readyFn = fn ? (ready ?? null) : null
}

/** Resolves once the viewer's sheet texture matches the current material. */
export function captureReady(): Promise<void> {
  return readyFn ? readyFn() : Promise.resolve()
}

export function captureAvailable(): boolean {
  return captureFn !== null
}

export function capturePoses(poses: PoseAngles[], size?: { w: number; h: number }): string[] {
  if (!captureFn) throw new Error('3D viewer is not ready to capture')
  return captureFn(poses, size)
}
