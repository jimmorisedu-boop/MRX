import playwright from '../e2e/node_modules/playwright-core/index.js'
import { cp, link, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIST = path.resolve(process.env.MRX_PORTABLE_DIR || path.join(ROOT, 'dist', 'MRX'))
const SOURCE_APP = path.join(ROOT, 'app')
const SOURCE_DESKTOP = path.join(ROOT, 'desktop')
const PORTABLE = path.join(ROOT, 'tests', 'native', 'layout-portable')
const PORTABLE_APP = path.join(PORTABLE, 'resources', 'app')
const EXE = path.join(PORTABLE, 'MRX.exe')
const DATA = path.join(PORTABLE, 'data')
const OUTPUT_DIR = path.join(ROOT, 'tests', 'native', 'outputs')
const REPORT_PATH = path.join(OUTPUT_DIR, 'layout-report.json')
const VALID_INPUT = path.join(ROOT, 'tests', 'e2e', 'fixtures', 'batch-a.wav')
const ERROR_INPUT = path.join(ROOT, 'tests', 'e2e', 'fixtures', 'no-audio.mp4')
const { _electron: electron } = playwright

const report = {
  startedAt: new Date().toISOString(),
  playwrightCore: '1.64.0',
  packagedExecutable: EXE,
  checks: [],
  errors: []
}

function record(name, status, evidence = '') {
  const entry = { name, status, evidence: String(evidence || '') }
  report.checks.push(entry)
  process.stdout.write(`${status.toUpperCase()} ${name}${entry.evidence ? ` — ${entry.evidence}` : ''}\n`)
}

function errorText(error) {
  return error?.stack || error?.message || String(error)
}

async function setupPortable() {
  await rm(PORTABLE, { recursive: true, force: true })
  await mkdir(PORTABLE_APP, { recursive: true })
  await mkdir(path.join(PORTABLE, 'resources'), { recursive: true })
  for (const entry of await readdir(DIST, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    await link(path.join(DIST, entry.name), path.join(PORTABLE, entry.name))
  }
  for (const name of ['locales', 'runtime', 'weights', 'tools']) {
    await symlink(path.join(DIST, name), path.join(PORTABLE, name), 'junction')
  }
  await link(path.join(DIST, 'resources', 'default_app.asar'), path.join(PORTABLE, 'resources', 'default_app.asar'))
  await cp(SOURCE_APP, path.join(PORTABLE_APP, 'app'), { recursive: true, force: true })
  await cp(SOURCE_DESKTOP, path.join(PORTABLE_APP, 'desktop'), { recursive: true, force: true })
  await cp(path.join(DIST, 'resources', 'app', 'package.json'), path.join(PORTABLE_APP, 'package.json'), { force: true })
  await symlink(path.join(DIST, 'resources', 'app', 'node_modules'), path.join(PORTABLE_APP, 'node_modules'), 'junction')
  await mkdir(DATA, { recursive: true })
}

async function launchApp() {
  const env = {
    ...process.env,
    MRX_NO_BROWSER: '1',
    MRX_PORT: '17962',
    ELECTRON_ENABLE_LOGGING: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  const electronApp = await electron.launch({ executablePath: EXE, cwd: PORTABLE, env, timeout: 45_000 })
  const window = await electronApp.firstWindow({ timeout: 45_000 })
  await window.waitForFunction(() => document.querySelector('#connection-state')?.classList.contains('is-online'), null, { timeout: 30_000 })
  return { electronApp, window }
}

async function resizeWindow(electronApp, window, width, height) {
  const browserWindow = await electronApp.browserWindow(window)
  await browserWindow.evaluate((handle, bounds) => handle.setBounds(bounds), { width, height })
  await window.waitForTimeout(180)
}

async function setZoom(electronApp, window, factor) {
  const browserWindow = await electronApp.browserWindow(window)
  await browserWindow.evaluate((handle, value) => handle.webContents.setZoomFactor(value), factor)
  await window.waitForTimeout(180)
}

async function measure(window, label) {
  return window.evaluate((name) => {
    const rect = (selector) => {
      const node = document.querySelector(selector)
      if (!node) return null
      const value = node.getBoundingClientRect()
      return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height }
    }
    const visible = (selector) => [...document.querySelectorAll(selector)].filter((node) => !node.hidden && getComputedStyle(node).display !== 'none')
    const root = document.documentElement
    const body = document.body
    const cards = visible('.output-row')
    const cardRects = cards.map((node) => {
      const value = node.getBoundingClientRect()
      const controls = node.querySelector('.preview-controls')?.getBoundingClientRect()
      return {
        left: value.left,
        right: value.right,
        top: value.top,
        bottom: value.bottom,
        width: value.width,
        height: value.height,
        controls: controls ? { left: controls.left, right: controls.right, top: controls.top, bottom: controls.bottom, width: controls.width } : null,
        linkVisible: Boolean(node.querySelector('a[download]'))
      }
    })
    const viewport = { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio }
    const outputLinks = visible('.output-row a[download]').map((node) => {
      const value = node.getBoundingClientRect()
      return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height }
    })
    return {
      label: name,
      viewport,
      scroll: { width: root.scrollWidth, height: root.scrollHeight, clientWidth: root.clientWidth, clientHeight: root.clientHeight, bodyWidth: body.scrollWidth },
      workArea: rect('.workspace'),
      topbar: rect('.topbar'),
      brand: rect('.brand'),
      topbarActions: rect('.topbar-actions'),
      connection: rect('#connection-state'),
      shutdown: rect('#shutdown-button'),
      toast: rect('.toast'),
      toastHidden: Boolean(document.querySelector('.toast')?.hidden),
      drop: rect('.drop-zone'),
      privacy: rect('.privacy-note'),
      queue: rect('.queue-section'),
      empty: rect('.empty-queue'),
      footer: rect('.app-footer'),
      job: rect('.job-card[data-status="error"]') || rect('.job-card'),
      error: rect('.job-card[data-status="error"] .job-error') || rect('.job-error'),
      outputWrap: rect('.job-output-wrap'),
      outputHeading: rect('.output-heading'),
      outputList: rect('.output-list'),
      zipRow: rect('.zip-row'),
      folderRow: rect('.output-folder-row'),
      outputLinks,
      cards: cardRects,
      cardCount: cardRects.length,
      status: document.querySelector('.job-card')?.dataset.status || null,
      queueCount: document.querySelectorAll('.job-card').length
    }
  }, label)
}

function assertMetric(condition, message, evidence) {
  if (!condition) throw new Error(`${message}: ${JSON.stringify(evidence)}`)
}

function intersects(first, second) {
  if (!first || !second || first.width <= 0 || second.width <= 0) return false
  return first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top
}

function assertCompletedFit(metrics, label) {
  assertMetric(metrics.scroll.height <= metrics.scroll.clientHeight + 1, `${label} requires vertical scrolling`, metrics.scroll)
  const viewportBottom = metrics.viewport.height + 1
  const actionRects = [
    ...metrics.cards.flatMap((card) => [card, card.controls]),
    ...metrics.outputLinks,
    metrics.zipRow,
    metrics.folderRow
  ].filter(Boolean)
  assertMetric(actionRects.every((rect) => rect.top >= -1 && rect.bottom <= viewportBottom), `${label} action extends outside viewport`, actionRects)
  if (!metrics.toastHidden && metrics.toast) {
    assertMetric(!actionRects.some((rect) => intersects(rect, metrics.toast)), `${label} toast obscures an action`, { toast: metrics.toast, actions: actionRects })
  }
}

async function capture(window, name) {
  const file = path.join(OUTPUT_DIR, `layout-${name}.png`)
  await window.screenshot({ path: file, scale: 'css' })
  return file
}

async function waitForDone(window) {
  await window.waitForFunction(() => document.querySelector('.job-card')?.dataset.status === 'done', null, { timeout: 180_000 })
  await window.waitForFunction(() => document.querySelectorAll('a[download]').length >= 3, null, { timeout: 10_000 })
}

async function waitForError(window) {
  await window.waitForFunction(() => Boolean(document.querySelector('.job-card[data-status="error"]')), null, { timeout: 45_000 })
}

async function run() {
  await mkdir(OUTPUT_DIR, { recursive: true })
  await setupPortable()
  const { electronApp, window } = await launchApp()
  try {
    const browserWindow = await electronApp.browserWindow(window)
    const initialBounds = await browserWindow.evaluate((handle) => handle.getBounds())
    report.initialWindowBounds = initialBounds
    assertMetric(initialBounds.width >= 760 && initialBounds.width <= 762 && initialBounds.height >= 560 && initialBounds.height <= 561, 'default window bounds changed unexpectedly', initialBounds)

    const display = await electronApp.evaluate(({ screen }) => {
      const primary = screen.getPrimaryDisplay()
      return { scaleFactor: primary.scaleFactor, bounds: primary.bounds, workArea: primary.workArea, workAreaSize: primary.workAreaSize }
    })
    report.display = display
    const emptySizes = [
      { width: 760, height: 560, label: 'empty-default-760' },
      { width: 680, height: 540, label: 'empty-min-680' },
      { width: 720, height: 560, label: 'empty-720' },
      { width: 860, height: 680, label: 'empty-legacy-860' },
      { width: 1000, height: 760, label: 'empty-wide-1000' }
    ]
    for (const size of emptySizes) {
      await setZoom(electronApp, window, 1)
      await resizeWindow(electronApp, window, size.width, size.height)
      const metrics = await measure(window, size.label)
      report.checks.push({ name: `${size.label} metrics`, status: 'pass', evidence: metrics })
      assertMetric(metrics.scroll.width <= metrics.scroll.clientWidth + 1, `${size.label} horizontal overflow`, metrics.scroll)
      assertMetric(metrics.drop.width <= metrics.workArea.width + 1, `${size.label} drop exceeds workspace`, metrics)
      assertMetric(metrics.topbar.height <= 72, `${size.label} topbar too tall`, metrics.topbar)
      assertMetric(metrics.empty?.height <= 160, `${size.label} empty queue too tall`, metrics.empty)
      assertMetric(metrics.footer.bottom <= metrics.viewport.height + 1, `${size.label} footer clipped`, metrics)
      await capture(window, size.label)
    }
    await resizeWindow(electronApp, window, 760, 560)
    await window.setInputFiles('#file-input', VALID_INPUT)
    await waitForDone(window)
    const completedSizes = [
      { width: 760, height: 560, label: 'populated-default-760' },
      { width: 680, height: 540, label: 'populated-min-680' },
      { width: 720, height: 560, label: 'populated-720' },
      { width: 860, height: 680, label: 'populated-legacy-860' }
    ]
    for (const size of completedSizes) {
      await setZoom(electronApp, window, 1)
      await resizeWindow(electronApp, window, size.width, size.height)
      await window.evaluate(() => window.scrollTo(0, 0))
      const metrics = await measure(window, size.label)
      assertMetric(metrics.cardCount === 3, `${size.label} does not expose three preview cards`, metrics)
      assertMetric(metrics.cards.every((card) => card.controls && card.controls.left >= card.left - 1 && card.controls.right <= card.right + 1 && card.linkVisible), `${size.label} preview controls overflow card`, metrics.cards)
      assertMetric(metrics.scroll.width <= metrics.scroll.clientWidth + 1, `${size.label} horizontal overflow`, metrics.scroll)
      assertCompletedFit(metrics, size.label)
      report.checks.push({ name: `${size.label} metrics`, status: 'pass', evidence: metrics })
      await capture(window, size.label)
    }

    await resizeWindow(electronApp, window, 680, 540)
    await window.evaluate(() => window.scrollTo(0, 0))
    const interactionResult = await window.evaluate(() => {
      const pointHit = (node) => {
        const rect = node.getBoundingClientRect()
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        return Boolean(hit && (hit === node || node.contains(hit)))
      }
      const actionSelectors = ['.output-row a[download]', '.zip-row a', '.output-folder-row button']
      const actionHits = actionSelectors.flatMap((selector) => [...document.querySelectorAll(selector)].map(pointHit))
      return { actionHits, allActionsHit: actionHits.length === 5 && actionHits.every(Boolean) }
    })
    assertMetric(interactionResult.allActionsHit, 'minimum window action hit-test failed', interactionResult)
    const firstToggle = window.locator('.preview-toggle').first()
    await firstToggle.click()
    await window.waitForFunction(() => document.querySelector('.preview-toggle')?.dataset.playing === 'true', null, { timeout: 5_000 })
    await firstToggle.click()
    await window.waitForFunction(() => document.querySelector('.preview-toggle')?.dataset.playing === 'false', null, { timeout: 5_000 })
    record('minimum window preview and action hit-tests', 'pass', JSON.stringify(interactionResult))

    await setZoom(electronApp, window, 1.25)
    const populatedZoomed = await measure(window, 'populated-min-680-zoom125')
    assertMetric(populatedZoomed.scroll.width <= populatedZoomed.scroll.clientWidth + 1, 'zoomed minimum horizontal overflow', populatedZoomed.scroll)
    assertMetric(populatedZoomed.cards.every((card) => card.controls && card.controls.left >= card.left - 1 && card.controls.right <= card.right + 1), 'zoomed preview controls overflow card', populatedZoomed.cards)
    report.checks.push({ name: 'populated-min-680-zoom125 metrics', status: 'pass', evidence: populatedZoomed })
    await capture(window, 'populated-min-680-zoom125')

    await setZoom(electronApp, window, 1)
    await window.setInputFiles('#file-input', ERROR_INPUT)
    await waitForError(window)
    const errorMetrics = await measure(window, 'error-min-680')
    assertMetric(errorMetrics.scroll.width <= errorMetrics.scroll.clientWidth + 1, 'error horizontal overflow', errorMetrics.scroll)
    assertMetric(Boolean(errorMetrics.error) && errorMetrics.error.right <= errorMetrics.workArea.right + 1, 'error text exceeds workspace', errorMetrics)
    report.checks.push({ name: 'error-min-680 metrics', status: 'pass', evidence: errorMetrics })
    await capture(window, 'error-min-680')

    record('layout geometry and state coverage', 'pass', `${report.checks.filter((item) => item.name.includes('metrics')).length} viewport/state measurements`)
  } finally {
    await electronApp.close().catch(() => {})
  }
}

try {
  await run()
  report.status = 'pass'
} catch (error) {
  report.status = 'fail'
  report.errors.push(errorText(error))
  process.stderr.write(`${errorText(error)}\n`)
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8').catch(() => {})
  await rm(PORTABLE, { recursive: true, force: true }).catch(() => {})
}
