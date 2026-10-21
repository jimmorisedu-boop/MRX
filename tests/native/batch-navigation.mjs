import playwright from '../e2e/node_modules/playwright-core/index.js'
import { cp, copyFile, link, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIST = path.resolve(process.env.MRX_PORTABLE_DIR || path.join(ROOT, 'dist', 'MRX'))
const SOURCE_APP = path.join(ROOT, 'app')
const SOURCE_DESKTOP = path.join(ROOT, 'desktop')
const PORTABLE = path.join(ROOT, 'tests', 'native', 'batch-portable')
const PORTABLE_APP = path.join(PORTABLE, 'resources', 'app')
const EXE = path.join(PORTABLE, 'MRX.exe')
const DATA = path.join(PORTABLE, 'data')
const FIXTURES = path.join(ROOT, 'tests', 'native', 'batch-fixtures')
const OUTPUTS = path.join(ROOT, 'outputs')
const REPORT_JSON = path.join(OUTPUTS, 'batch-navigation-evidence.json')
const REPORT_MD = path.join(OUTPUTS, 'batch-navigation-report.md')
const FFMPEG = path.join(DIST, 'tools', 'ffmpeg.exe')
const { _electron: electron } = playwright

const VIDEO_FIXTURES = [
  { name: 'batch-a — речь.mp4', wav: 'batch-a.wav', color: '0x27364d' },
  { name: 'batch-b — музыка.mp4', wav: 'batch-b.wav', color: '0x3d2949' },
  { name: 'batch-c — эффекты.mp4', wav: 'batch-c.wav', color: '0x29463d' },
  { name: 'batch-d — фон.mp4', wav: 'tone-a.wav', color: '0x4c3a28' }
]
const NO_AUDIO_FIXTURE = 'batch-no-audio.mp4'

const report = {
  startedAt: new Date().toISOString(),
  playwrightCore: '1.64.0',
  packagedExecutable: EXE,
  portableLayout: 'tests/native/batch-portable (removed after run)',
  port: 17963,
  checks: [],
  errors: [],
  limitations: [
    'Electron dialog answers and DownloadItem.setSavePath were mocked through electronApp.evaluate; this is not a manual OS-dialog test.',
    'The test uses isolated hardlinks/junctions to dist runtime and a private batch-portable/data directory.'
  ]
}

function record(name, status, evidence = '') {
  const entry = { name, status, evidence: String(evidence || '') }
  report.checks.push(entry)
  process.stdout.write(`${status.toUpperCase()} ${name}${entry.evidence ? ` — ${entry.evidence}` : ''}\n`)
}

function errorText(error) {
  return error?.stack || error?.message || String(error)
}

function waitForChild(child, label) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${label} exited with code ${code ?? 'null'} signal ${signal || 'none'}`))
    })
  })
}

async function ensureFixtures() {
  await mkdir(FIXTURES, { recursive: true })
  if (!(await stat(FFMPEG).catch(() => null))?.isFile()) throw new Error(`Bundled FFmpeg missing: ${FFMPEG}`)
  const sourceFixtures = path.join(ROOT, 'tests', 'e2e', 'fixtures')
  for (const [index, fixture] of VIDEO_FIXTURES.entries()) {
    const destination = path.join(FIXTURES, fixture.name)
    if (await stat(destination).catch(() => null)) continue
    const wav = path.join(sourceFixtures, fixture.wav)
    const child = spawn(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=${fixture.color}:s=320x180:r=12`,
      '-i', wav, '-t', '3', '-shortest',
      '-c:v', 'mpeg4', '-q:v', '8', '-c:a', 'aac', '-b:a', '96k',
      '-movflags', '+faststart', destination
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    try {
      await waitForChild(child, `fixture ${index + 1}`)
    } catch (error) {
      throw new Error(`${errorText(error)}${stderr ? `: ${stderr}` : ''}`)
    }
  }
  const noAudioSource = path.join(sourceFixtures, 'no-audio.mp4')
  const noAudioTarget = path.join(FIXTURES, NO_AUDIO_FIXTURE)
  if (!(await stat(noAudioTarget).catch(() => null))) await copyFile(noAudioSource, noAudioTarget)
  const fixtureInfo = []
  for (const fixture of VIDEO_FIXTURES) {
    const file = path.join(FIXTURES, fixture.name)
    const info = await stat(file)
    if (!info.isFile() || info.size < 10_000) throw new Error(`Invalid generated fixture: ${file}`)
    fixtureInfo.push({ name: fixture.name, path: file, bytes: info.size })
  }
  const noAudioInfo = await stat(noAudioTarget)
  if (noAudioInfo.size < 100) throw new Error(`Invalid no-audio fixture: ${noAudioTarget}`)
  report.fixtures = { video: fixtureInfo, noAudio: { name: NO_AUDIO_FIXTURE, path: noAudioTarget, bytes: noAudioInfo.size } }
  record('video fixtures with sound prepared by bundled FFmpeg', 'pass', JSON.stringify(fixtureInfo.map(item => ({ name: item.name, bytes: item.bytes }))))
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
  const env = { ...process.env, MRX_NO_BROWSER: '1', MRX_PORT: '17963', ELECTRON_ENABLE_LOGGING: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const electronApp = await electron.launch({ executablePath: EXE, cwd: PORTABLE, env, timeout: 45_000 })
  const window = await electronApp.firstWindow({ timeout: 45_000 })
  await window.waitForFunction(() => document.querySelector('#connection-state')?.classList.contains('is-online'), null, { timeout: 30_000 })
  return { electronApp, window }
}

async function installMocks(electronApp, downloadDir) {
  await mkdir(downloadDir, { recursive: true })
  await electronApp.evaluate((electronModule, options) => {
    const { dialog, session, shell } = electronModule
    const state = { downloadDir: options.downloadDir, dialogs: [], responses: [], downloads: [], openPath: '' }
    globalThis.__mrxBatchTest = state
    dialog.showMessageBox = async (...args) => {
      const response = Number.isInteger(state.responses[0]) ? state.responses.shift() : 0
      state.dialogs.push({ kind: 'messageBox', response, title: args.at(-1)?.title || '' })
      return { response, checkboxChecked: false }
    }
    dialog.showMessageBoxSync = (...args) => {
      const response = Number.isInteger(state.responses[0]) ? state.responses.shift() : 0
      state.dialogs.push({ kind: 'messageBoxSync', response, title: args.at(-1)?.title || '' })
      return response
    }
    dialog.showSaveDialog = async (...args) => {
      const target = `${state.downloadDir}\\dialog-${state.dialogs.length}.bin`
      state.dialogs.push({ kind: 'saveDialog', target, title: args.at(-1)?.title || '' })
      return { canceled: false, filePath: target }
    }
    shell.openPath = async value => { state.openPath = String(value || ''); return '' }
    session.defaultSession.on('will-download', (_event, item) => {
      const index = state.downloads.length
      const target = `${state.downloadDir}\\${String(index + 1).padStart(2, '0')}-${item.getFilename()}`
      const download = { filename: item.getFilename(), target, done: false, state: '' }
      state.downloads.push(download)
      item.setSavePath(target)
      item.once('done', (_doneEvent, status) => {
        download.done = true
        download.state = status
        download.receivedBytes = item.getReceivedBytes()
      })
    })
  }, { downloadDir })
}

async function readMocks(electronApp) {
  return electronApp.evaluate(() => JSON.parse(JSON.stringify(globalThis.__mrxBatchTest || {})))
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await predicate()
    if (latest) return latest
    await new Promise(resolve => setTimeout(resolve, 180))
  }
  throw new Error(`${label || 'condition'} timed out${latest ? `: ${JSON.stringify(latest)}` : ''}`)
}

async function selection(window) {
  return window.evaluate(() => {
    const switcher = document.querySelector('#file-switcher')
    const select = document.querySelector('#file-select')
    const previous = document.querySelector('#previous-file')
    const next = document.querySelector('#next-file')
    const position = document.querySelector('#file-position')
    const allCards = [...document.querySelectorAll('.job-card')]
    const visibleCards = [...document.querySelectorAll('.job-card:not([hidden])')]
    const options = select ? [...select.options].map(option => ({ value: option.value, text: option.textContent || '', selected: option.selected })) : []
    const visible = visibleCards[0]
    const audio = visible?.querySelector('audio.preview-audio')
    return {
      switcherHidden: Boolean(switcher?.hidden || (switcher && getComputedStyle(switcher).display === 'none')),
      selectExists: Boolean(select),
      selectLabel: select?.getAttribute('aria-label') || '',
      selectedValue: select?.value || '',
      options,
      previousDisabled: Boolean(previous?.disabled),
      nextDisabled: Boolean(next?.disabled),
      position: position?.textContent?.trim() || '',
      allCards: allCards.length,
      visibleCards: visibleCards.length,
      visibleJobId: visible?.dataset.jobId || '',
      visibleStatus: visible?.dataset.status || '',
      visibleName: visible?.querySelector('.job-name')?.textContent || '',
      visibleAudioCount: visible?.querySelectorAll('audio.preview-audio').length || 0,
      visibleAudioCurrentTime: audio?.currentTime ?? null,
      visibleAudioPaused: audio?.paused ?? true,
      scroll: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      switcherRect: switcher ? (() => { const r = switcher.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } })() : null,
      visibleCardRect: visible ? (() => { const r = visible.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } })() : null
    }
  })
}

function assert(condition, message, evidence) {
  if (!condition) throw new Error(`${message}: ${JSON.stringify(evidence)}`)
}

async function assertSelectionContract(window, expectedCount, expectedNames) {
  const state = await selection(window)
  assert(state.allCards === expectedCount, `expected ${expectedCount} job cards`, state)
  assert(state.visibleCards === 1, 'exactly one .job-card:not([hidden]) must be visible', state)
  assert(state.selectExists === (expectedCount > 1), 'file select presence does not match queue size', state)
  assert(state.switcherHidden === (expectedCount <= 1), 'file switcher hidden state does not match queue size', state)
  if (expectedCount > 1) {
    assert(state.selectLabel === 'Выберите файл', 'native file select aria-label changed', state)
    assert(state.options.length === expectedCount, 'file select option count mismatch', state)
    assert(state.options.every((option) => option.value && expectedNames.some((name) => option.text.includes(name)) && /Готово|В очереди|Подготовка|Разделение|Сборка|Ошибка|Отменено/.test(option.text)), 'file select option lacks value, filename, or status', state.options)
    assert(state.options.filter(option => option.selected).length === 1 && state.options.find(option => option.selected)?.value === state.selectedValue, 'file select selected option mismatch', state)
    const selectedIndex = state.options.findIndex(option => option.value === state.selectedValue)
    assert(selectedIndex >= 0, 'selected job is missing from file select', state)
    assert(state.position === `${selectedIndex + 1} из ${expectedCount}`, 'file position text mismatch', state)
    assert(state.previousDisabled === (selectedIndex === 0), 'previous endpoint disabled state mismatch', state)
    assert(state.nextDisabled === (selectedIndex === expectedCount - 1), 'next endpoint disabled state mismatch', state)
    assert(state.visibleJobId === state.selectedValue, 'visible card does not match selected job', state)
  }
  return state
}

async function resizeWindow(electronApp, window, width, height) {
  const browserWindow = await electronApp.browserWindow(window)
  await browserWindow.evaluate((handle, bounds) => handle.setBounds(bounds), { width, height })
  await window.waitForTimeout(220)
}

async function capture(window, name) {
  const target = path.join(OUTPUTS, `batch-navigation-${name}.png`)
  await window.screenshot({ path: target, scale: 'css' })
  return target
}

async function waitForJobs(window, count, timeoutMs = 240_000) {
  return waitFor(async () => {
    const current = await selection(window)
    if (current.allCards !== count) return false
    if (current.options.length && current.options.some(option => /В очереди|Подготовка|Разделение|Сборка/.test(option.text))) return false
    return current
  }, timeoutMs, `${count} jobs complete`)
}

async function clickAndWaitDownload(electronApp, window, index) {
  await window.locator('.job-card:not([hidden]) a[download]').nth(index).click()
  return waitFor(async () => {
    const mocks = await readMocks(electronApp)
    const item = mocks.downloads?.[index]
    if (!item?.done) return false
    const info = await stat(item.target).catch(() => null)
    return info?.size ? item : false
  }, 30_000, `download ${index + 1}`)
}

async function verifyDownloads(electronApp, window, selectedJobId) {
  const links = await window.locator('.job-card:not([hidden]) a[download]').evaluateAll(nodes => nodes.map(node => ({ href: node.href, download: node.getAttribute('download') || '' })))
  assert(links.length === 4, 'selected done job must expose three stems plus ZIP', links)
  const jobMatches = links.every(link => new URL(link.href).pathname.split('/')[3] === selectedJobId)
  assert(jobMatches, 'all selected-job download links must carry the same job id', links)
  const downloads = []
  for (let index = 0; index < links.length; index += 1) downloads.push(await clickAndWaitDownload(electronApp, window, index))
  const bytes = []
  for (const [index, item] of downloads.entries()) {
    const content = await readFile(item.target)
    const magic = content.subarray(0, 4).toString('ascii')
    if (index < 3) assert(magic === 'RIFF' && content.toString('ascii', 8, 12) === 'WAVE', 'stem download is not WAV', { item, magic })
    else assert(content.subarray(0, 2).toString('ascii') === 'PK', 'archive download is not ZIP', { item, magic })
    bytes.push({ filename: item.filename, size: content.length, magic: index < 3 ? 'RIFF/WAVE' : 'PK' })
  }
  return { links, bytes }
}

async function run() {
  await mkdir(OUTPUTS, { recursive: true })
  await ensureFixtures()
  await setupPortable()
  const { electronApp, window } = await launchApp()
  const downloadDir = path.join(DATA, 'batch-downloads')
  try {
    await installMocks(electronApp, downloadDir)
    const initial = await selection(window)
    assert(initial.switcherHidden && initial.allCards === 0, 'empty queue should hide the file switcher', initial)
    record('empty queue hides switcher', 'pass', JSON.stringify(initial))

    const firstThree = report.fixtures.video.slice(0, 3).map(item => item.path)
    await window.setInputFiles('#file-input', firstThree)
    await waitForJobs(window, 3)
    const names = report.fixtures.video.slice(0, 3).map(item => item.name)
    let current = await assertSelectionContract(window, 3, names)
    report.initialJobIds = current.options.map(option => option.value)
    record('three video jobs expose stable native selector contract', 'pass', JSON.stringify(current))

    const firstJobId = current.options[0].value
    const firstName = current.options[0].text
    await resizeWindow(electronApp, window, 680, 540)
    const minMetrics = await selection(window)
    assert(minMetrics.scroll.width <= minMetrics.scroll.clientWidth + 1 && minMetrics.scroll.height <= minMetrics.scroll.clientHeight + 1, '680x540 batch view scrolls', minMetrics)
    await capture(window, '680x540')
    await resizeWindow(electronApp, window, 760, 560)
    const defaultMetrics = await selection(window)
    assert(defaultMetrics.scroll.width <= defaultMetrics.scroll.clientWidth + 1 && defaultMetrics.scroll.height <= defaultMetrics.scroll.clientHeight + 1, '760x560 batch view scrolls', defaultMetrics)
    await capture(window, '760x560')
    record('batch switcher fits 680x540 and 760x560 without page scroll', 'pass', JSON.stringify({ min: minMetrics.scroll, default: defaultMetrics.scroll }))

    await window.locator('#next-file').click()
    current = await assertSelectionContract(window, 3, names)
    const secondJobId = current.selectedValue
    assert(secondJobId !== firstJobId, 'next-file did not change selected job', current)
    await window.locator('#previous-file').press('Enter')
    current = await assertSelectionContract(window, 3, names)
    assert(current.selectedValue === firstJobId, 'keyboard Enter on previous-file did not return to first job', current)
    await window.evaluate(() => document.querySelector('#previous-file')?.click())
    current = await assertSelectionContract(window, 3, names)
    assert(current.selectedValue === firstJobId && current.previousDisabled, 'previous-file endpoint should be disabled at first job', current)
    await window.locator('#file-select').selectOption(current.options.at(-1).value)
    current = await assertSelectionContract(window, 3, names)
    assert(current.nextDisabled, 'next-file endpoint should be disabled at last job', current)
    await window.evaluate(() => document.querySelector('#next-file')?.click())
    const endpointAfterClick = await selection(window)
    assert(endpointAfterClick.selectedValue === current.selectedValue, 'disabled next-file changed selection', endpointAfterClick)
    await window.locator('#file-select').selectOption(firstJobId)
    current = await assertSelectionContract(window, 3, names)
    assert(current.selectedValue === firstJobId, 'selectOption could not restore first job', current)
    record('keyboard, select, and endpoint navigation', 'pass', JSON.stringify({ firstJobId, secondJobId, final: current.selectedValue }))

    const downloadEvidence = await verifyDownloads(electronApp, window, firstJobId)
    record('selected job exposes mapped three WAV stems and ZIP downloads', 'pass', JSON.stringify(downloadEvidence))

    const previewState = await window.evaluate(async () => {
      const audio = document.querySelector('.job-card:not([hidden]) audio.preview-audio')
      if (!audio) return { available: false }
      audio.muted = true
      await audio.play()
      await new Promise(resolve => setTimeout(resolve, 350))
      const node = audio
      const beforePoll = { currentTime: audio.currentTime, selected: document.querySelector('#file-select')?.value || '' }
      await new Promise(resolve => setTimeout(resolve, 1_100))
      return { available: true, nodeSameAfterPoll: document.querySelector('.job-card:not([hidden]) audio.preview-audio') === node, currentTimeAfterPoll: node.currentTime, beforePoll, playingAfterPoll: !node.paused }
    })
    assert(previewState.available && previewState.nodeSameAfterPoll && previewState.playingAfterPoll, 'selected preview was not preserved across background polling', previewState)
    const beforeSwitch = await window.evaluate(() => {
      const audio = document.querySelector('.job-card:not([hidden]) audio.preview-audio')
      return { currentTime: audio?.currentTime ?? 0, jobId: document.querySelector('#file-select')?.value || '' }
    })
    await window.locator('#next-file').click()
    await waitFor(() => selection(window).then(state => state.selectedValue !== beforeSwitch.jobId ? state : false), 5000, 'preview switch')
    const afterSwitch = await window.evaluate(() => ({ paused: [...document.querySelectorAll('.job-card audio.preview-audio')].find(audio => audio.closest('.job-card')?.dataset.jobId !== document.querySelector('#file-select')?.value)?.paused ?? true }))
    assert(afterSwitch.paused, 'switching files did not pause outgoing preview audio', afterSwitch)
    await window.locator('#previous-file').click()
    const afterReturn = await window.evaluate(() => ({ currentTime: document.querySelector('.job-card:not([hidden]) audio.preview-audio')?.currentTime ?? 0 }))
    assert(Math.abs(afterReturn.currentTime - beforeSwitch.currentTime) < 0.45, 'returning to a file did not preserve preview position', { beforeSwitch, afterReturn })
    record('preview playback pauses on switch and keeps media position across polling', 'pass', JSON.stringify({ previewState, beforeSwitch, afterSwitch, afterReturn }))

    await window.setInputFiles('#file-input', [report.fixtures.video[3].path])
    await waitForJobs(window, 4)
    current = await assertSelectionContract(window, 4, [...names, report.fixtures.video[3].name])
    assert(current.selectedValue === firstJobId, 'new upload changed the selected job', current)
    record('background completion and new upload keep current selection', 'pass', JSON.stringify(current))

    await window.setInputFiles('#file-input', [report.fixtures.noAudio.path])
    await waitFor(async () => {
      const state = await selection(window)
      return state.allCards === 5 && state.options.some(option => option.text.includes(NO_AUDIO_FIXTURE) && /Ошибка/.test(option.text)) ? state : false
    }, 90_000, 'no-audio error job')
    const allNames = [...names, report.fixtures.video[3].name, NO_AUDIO_FIXTURE]
    const errorOption = (await selection(window)).options.find(option => option.text.includes(NO_AUDIO_FIXTURE))
    assert(errorOption?.value, 'no-audio error option missing', await selection(window))
    await window.locator('#file-select').selectOption(errorOption.value)
    const errorState = await assertSelectionContract(window, 5, allNames)
    assert(errorState.visibleStatus === 'error' && errorState.visibleJobId === errorOption.value, 'no-audio error was not selectable', errorState)
    await window.locator('#file-select').selectOption(firstJobId)
    const recovered = await assertSelectionContract(window, 5, allNames)
    assert(recovered.visibleStatus === 'done' && recovered.selectedValue === firstJobId, 'navigation did not recover from selected error job', recovered)
    record('error/no-audio job remains selectable and navigation recovers', 'pass', JSON.stringify({ error: errorState, recovered }))
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
  await writeFile(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`, 'utf8').catch(() => {})
  const lines = [
    '# Batch navigation Electron QA',
    '',
    `Status: **${report.status}**`,
    '',
    'Selectors were exercised in an isolated packaged Electron layout on port 17963.',
    'DownloadItem.setSavePath and Electron dialog methods were mocked through electronApp.evaluate; this does not claim manual OS-dialog behavior.',
    '',
    ...report.checks.map(item => `- **${item.status}** ${item.name}: ${item.evidence}`),
    '',
    ...(report.errors.length ? ['Errors:', ...report.errors.map(error => `- ${error}`)] : []),
    '',
    'Fixtures and screenshots remain under tests/native/batch-fixtures and outputs/batch-navigation-*.png.'
  ]
  await writeFile(REPORT_MD, `${lines.join('\n')}\n`, 'utf8').catch(() => {})
  await rm(PORTABLE, { recursive: true, force: true }).catch(() => {})
}
