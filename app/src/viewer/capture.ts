// Bridge between the UI (export buttons) and the live three.js viewer:
// ThreeView registers a capture function that renders arbitrary fold poses
// to image data URLs for the instruction-sheet export.

export type PoseAngles = Record<number, number> // hinge edge id -> degrees

export type CaptureFn = (poses: PoseAngles[], size?: { w: number; h: number }) => string[]

let captureFn: CaptureFn | null = null

export function registerCapture(fn: CaptureFn | null): void {
  captureFn = fn
}

export function captureAvailable(): boolean {
  return captureFn !== null
}

export function capturePoses(poses: PoseAngles[], size?: { w: number; h: number }): string[] {
  if (!captureFn) throw new Error('3D viewer is not ready to capture')
  return captureFn(poses, size)
}
