// Project naming: slug for filenames plus per-project export counters, so
// repeated exports iterate (carton_dieline_001.svg, _002…) instead of
// overwriting. Counters live in localStorage keyed by slug + export kind.

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'untitled'
}

const SEQ_KEY = 'paperSim.exportSeq'

function readSeq(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(SEQ_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Next numbered file name for an export, e.g. ("carton", "dieline", "svg")
 * -> "carton_dieline_001.svg" the first time, _002 the next. Empty kind
 * numbers the project file itself: "carton_001.fold". Advances the counter.
 */
export function nextExportName(projectName: string, kind: string, ext: string): string {
  const slug = slugify(projectName)
  const map = readSeq()
  const key = `${slug}/${kind}`
  const n = (map[key] ?? 0) + 1
  map[key] = n
  window.localStorage.setItem(SEQ_KEY, JSON.stringify(map))
  const num = String(n).padStart(3, '0')
  return kind ? `${slug}_${kind}_${num}.${ext}` : `${slug}_${num}.${ext}`
}

/** Project name from a loaded file name: strip extension and our _### suffix. */
export function projectNameFromFileName(fileName: string): string {
  return (
    fileName
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/_\d{3,}$/, '')
      .trim() || 'untitled'
  )
}
