// End-to-end: project naming + iterated export file names + project bundle zip.
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const URL = process.env.PAPERSIM_URL ?? 'http://localhost:5173/'
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto(URL)
await page.waitForFunction(() => window.paperSim && window.paperSimViewer)

// Fresh counters (the app numbers exports via localStorage).
await page.evaluate(() => window.localStorage.removeItem('paperSim.exportSeq'))

// Name the project, fold to targets, record a step (so instructions exist).
await page.evaluate(() => {
  const store = window.paperSim.store
  store.getState().newDocument('gable')
  store.getState().setProjectName('Test Carton')
  const st = store.getState()
  st.setAnglesTransient({ ...st.doc.targetAngles })
  store.getState().addKeyframe()
})
await page.waitForTimeout(300)

const names = []
async function grab(clickLabel) {
  const dl = page.waitForEvent('download', { timeout: 20000 })
  await page.click(`button:has-text("${clickLabel}")`)
  const d = await dl
  names.push(d.suggestedFilename())
  return d
}

await grab('Dieline SVG')
await grab('Dieline SVG') // second export must iterate, not overwrite
await grab('Save')
const zipDl = await grab('Export project (zip)')
const zipPath = await zipDl.path()

// List the zip's central-directory entries (store-method zip we wrote ourselves).
const buf = readFileSync(zipPath)
const zipEntries = []
for (let i = 0; i + 46 <= buf.length; i++) {
  if (buf.readUInt32LE(i) === 0x02014b50) {
    const nameLen = buf.readUInt16LE(i + 28)
    zipEntries.push(buf.toString('utf8', i + 46, i + 46 + nameLen))
    i += 45 + nameLen
  }
}

// Project name round-trips through the FOLD file (file_title), and falls back
// to a cleaned-up file name when the file has no title.
const roundtrip = await page.evaluate(() => {
  const { store, toFoldFile } = window.paperSim
  const s = store.getState()
  const file = JSON.parse(
    JSON.stringify(toFoldFile(s.doc, s.angles, s.steps, s.history, s.objectRotation, s.projectName)),
  )
  store.getState().loadFile(file, 'whatever.fold')
  const fromTitle = store.getState().projectName
  delete file.file_title
  store.getState().loadFile(file, 'my-carton_012.fold')
  const fromFileName = store.getState().projectName
  return { fromTitle, fromFileName }
})

const expectNames = [
  'test-carton_dieline_001.svg',
  'test-carton_dieline_002.svg',
  'test-carton_001.fold',
  'test-carton_project_001.zip',
]
const expectZip = [
  'test-carton/test-carton.fold',
  'test-carton/test-carton_dieline.svg',
  'test-carton/test-carton_model.png',
  'test-carton/test-carton_instructions.html',
]
const pass =
  JSON.stringify(names) === JSON.stringify(expectNames) &&
  JSON.stringify(zipEntries) === JSON.stringify(expectZip) &&
  roundtrip.fromTitle === 'Test Carton' &&
  roundtrip.fromFileName === 'my-carton' &&
  errors.length === 0

console.log(JSON.stringify({ names, zipEntries, roundtrip, errors, pass }, null, 2))
await browser.close()
process.exit(pass ? 0 : 1)
