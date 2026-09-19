// Library actions: save the current project into the library (with a folded
// 3D thumbnail), reopen an entry, and a tiny toast channel so the top bar can
// confirm saves that happen in the background (auto-added imports).

import { currentSaveFile, useAppStore, type AppState } from '../state/store'
import {
  getLibraryData,
  getLibraryMeta,
  newLibraryId,
  putLibraryEntry,
  type LibraryKind,
} from '../state/library'
import { captureAvailable, capturePoses, captureReady } from '../viewer/capture'
import { dielineSVG } from './exports'

const THUMB_W = 320
const THUMB_H = 240

/**
 * Save the current project to the library and make it the open entry.
 * Updates the entry the project came from unless `asNew`; `id` targets a
 * specific entry (a re-fit replacing its import). Kind and creation date of
 * an existing entry are kept unless `kind` is given.
 */
export async function saveToLibrary(
  opts: { kind?: LibraryKind; asNew?: boolean; id?: string; sourceName?: string } = {},
): Promise<string> {
  const s = useAppStore.getState()
  const file = currentSaveFile(s)
  const fitSession = s.fitSession ?? undefined
  const id = opts.asNew ? newLibraryId() : (opts.id ?? s.libraryId ?? newLibraryId())
  const prev = await getLibraryMeta(id)
  const thumbnail = await makeThumbnail(s)
  const now = Date.now()
  await putLibraryEntry(
    {
      id,
      name: s.projectName,
      kind: opts.kind ?? prev?.kind ?? 'project',
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      thumbnail,
      sourceName: opts.sourceName ?? prev?.sourceName,
    },
    { id, file, fitSession },
  )
  // Only claim the entry if the user hasn't switched projects meanwhile.
  if (useAppStore.getState().doc === s.doc) useAppStore.getState().setLibraryId(id)
  return id
}

/** Replace the current project with a library entry. */
export async function openLibraryEntry(id: string): Promise<void> {
  const [meta, data] = await Promise.all([getLibraryMeta(id), getLibraryData(id)])
  if (!meta || !data) throw new Error('That library entry no longer exists')
  const st = useAppStore.getState()
  st.loadFile(data.file, meta.name)
  st.setProjectName(meta.name)
  st.setFitSession(data.fitSession ?? null)
  st.setLibraryId(id)
}

/**
 * Folded-model thumbnail (last fold step, or the working pose if there are
 * none), rendered once the artwork texture has loaded. Falls back to the flat
 * dieline if the 3D viewer isn't available.
 */
async function makeThumbnail(s: AppState): Promise<string | undefined> {
  try {
    if (captureAvailable()) {
      await captureReady()
      const pose = s.steps.length > 0 ? s.steps[s.steps.length - 1].angles : s.angles
      const [png] = capturePoses([pose], { w: THUMB_W, h: THUMB_H })
      return await toJpeg(png)
    }
    const svg = dielineSVG(s.doc, s.material.overlayImage)
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  } catch {
    return undefined
  }
}

function toJpeg(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = img.width
      c.height = img.height
      c.getContext('2d')!.drawImage(img, 0, 0)
      resolve(c.toDataURL('image/jpeg', 0.85))
    }
    img.onerror = () => reject(new Error('thumbnail decode failed'))
    img.src = dataUrl
  })
}

// ---- toast -----------------------------------------------------------------
const toastListeners = new Set<(msg: string) => void>()

export function onLibraryToast(fn: (msg: string) => void): () => void {
  toastListeners.add(fn)
  return () => toastListeners.delete(fn)
}

export function libraryToast(msg: string) {
  for (const fn of toastListeners) fn(msg)
}

/** Fire-and-forget save with a toast either way (menu, Ctrl+S, imports). */
export function saveToLibraryWithToast(
  opts: Parameters<typeof saveToLibrary>[0] = {},
  okMsg = 'Saved to library',
): void {
  saveToLibrary(opts).then(
    () => libraryToast(okMsg),
    (err) => libraryToast(`Couldn't save to library: ${err instanceof Error ? err.message : err}`),
  )
}
