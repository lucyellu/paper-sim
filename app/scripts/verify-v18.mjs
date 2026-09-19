// v18 checks — pattern inset: drag-resize its right edge, collapse/expand, persistence.
import { chromium } from 'playwright'

const URL = process.env.PAPERSIM_URL ?? 'http://localhost:5173/'
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))
await page.goto(URL)
await page.waitForFunction(() => window.paperSim && window.paperSimViewer)
await page.evaluate(() => localStorage.removeItem('paperSim.panel.patternInset'))
await page.reload()
await page.waitForFunction(() => window.paperSim && window.paperSimViewer)
const out = {}
const w = () => page.locator('.inset').evaluate((el) => el.getBoundingClientRect().width)

out.initialW = await w()
const g = await page.locator('.inset-grip').boundingBox()
await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2)
await page.mouse.down()
await page.mouse.move(g.x + 200, g.y + g.height / 2, { steps: 5 })
await page.mouse.up()
out.resizedW = await w()
await page.screenshot({ path: 'scripts/shots/inset-resized.png' })

await page.locator('.inset-head').click()
out.collapsed = (await page.locator('.inset.collapsed').count()) === 1
out.svgHidden = (await page.locator('.inset svg').count()) === 0
await page.screenshot({ path: 'scripts/shots/inset-collapsed.png' })

await page.reload()
await page.waitForFunction(() => window.paperSim && window.paperSimViewer)
out.collapsedAfterReload = (await page.locator('.inset.collapsed').count()) === 1
await page.locator('.inset-head').click()
out.widthAfterReload = await w()

out.ok =
  out.resizedW > out.initialW + 150 &&
  out.collapsed && out.svgHidden && out.collapsedAfterReload &&
  Math.abs(out.widthAfterReload - out.resizedW) < 2
out.pageErrors = pageErrors
console.log(JSON.stringify(out, null, 2))
await browser.close()
