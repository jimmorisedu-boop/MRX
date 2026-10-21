import playwright from '../e2e/node_modules/playwright-core/index.js'
import { cp, copyFile, link, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIST = path.resolve(process.env.MRX_PORTABLE_DIR || path.join(ROOT, 'dist', 'MRX'))
const SOURCE_APP = path.join(ROOT, 'app')
const SOURCE_DESKTOP = path.join(ROOT, 'desktop')
const PORTABLE = path.join(ROOT, 'tests', 'native', 'save-all-portable')
const PORTABLE_APP = path.join(PORTABLE, 'resources', 'app')
const EXE = path.join(PORTABLE, 'MRX.exe')
const DATA = path.join(PORTABLE, 'data')
const FIXTURES = path.join(ROOT, 'tests', 'native', 'save-all-fixtures')
const OUTPUTS = path.join(ROOT, 'outputs')
const REPORT_JSON = path.join(OUTPUTS, 'save-all-evidence.json')
const REPORT_MD = path.join(OUTPUTS, 'save-all-report.md')
const FFMPEG = path.join(DIST, 'tools', 'ffmpeg.exe')
const { _electron: electron } = playwright

const VIDEO_FIXTURES = [
  { name: 'save-a — речь.mp4', wav: 'batch-a.wav', color: '0x27364d' },
  { name: 'save-b — музыка.mp4', wav: 'batch-b.wav', color: '0x3d2949' }
]
const NO_AUDIO_FIXTURE = 'save-no-audio.mp4'

const report = {
  startedAt: new Date().toISOString(),
  playwrightCore: '1.64.0',
  packagedExecutable: EXE,
  portableLayout: 'tests/native/save-all-portable (removed after run)',
  port: 17964,
  checks: [],
  errors: [],
  limitations: [
    'Electron DownloadItem.setSavePath and dialog methods were mocked through electronApp.evaluate; this is not a manual OS-dialog test.',
    'The test uses a private save-all-portable/data directory and generated local fixtures.'
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
  const video = []
  for (const fixture of VIDEO_FIXTURES) {
    const file = path.join(FIXTURES, fixture.name)
    const info = await stat(file)
    if (!info.isFile() || info.size < 10_000) throw new Error(`Invalid generated fixture: ${file}`)
    video.push({ name: fixture.name, path: file, bytes: info.size })
  }
  const noAudioInfo = await stat(noAudioTarget)
  if (noAudioInfo.size < 100) throw new Error(`Invalid no-audio fixture: ${noAudioTarget}`)
  report.fixtures = { video, noAudio: { name: NO_AUDIO_FIXTURE, path: noAudioTarget, bytes: noAudioInfo.size } }
  record('private video fixtures prepared with bundled FFmpeg', 'pass', JSON.stringify(video.map(item => ({ name: item.name, bytes: item.bytes }))))
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
  const env = { ...process.env, MRX_NO_BROWSER: '1', MRX_PORT: '17964', ELECTRON_ENABLE_LOGGING: '1' }
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
    const state = { downloadDir: options.downloadDir, dialogs: [], downloads: [], openPath: '' }
    globalThis.__mrxSaveAllTest = state
    dialog.showMessageBox = async (...args) => {
      state.dialogs.push({ kind: 'messageBox', title: args.at(-1)?.title || '' })
      return { response: 0, checkboxChecked: false }
    }
    dialog.showMessageBoxSync = (...args) => {
      state.dialogs.push({ kind: 'messageBoxSync', title: args.at(-1)?.title || '' })
      return 0
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
  return electronApp.evaluate(() => JSON.parse(JSON.stringify(globalThis.__mrxSaveAllTest || {})))
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

async function metrics(window) {
  return window.evaluate(() => {
    const saveAction = document.querySelector('#save-all-action')
    const saveButton = document.querySelector('#save-all-button')
    const saveStatus = document.querySelector('#save-all-status')
    const shutdown = document.querySelector('#shutdown-button')
    const toast = document.querySelector('#toast')
    const cards = [...document.querySelectorAll('.job-card')]
    const visibleCard = document.querySelector('.job-card:not([hidden])')
    const previous = document.querySelector('#previous-file')
    const next = document.querySelector('#next-file')
    const rect = node => {
      if (!node) return null
      const value = node.getBoundingClientRect()
      return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height }
    }
    return {
      jobs: cards.map(node => ({ id: node.dataset.jobId || '', status: node.dataset.status || '', name: node.querySelector('.job-name')?.textContent || '' })),
      visibleCards: document.querySelectorAll('.job-card:not([hidden])').length,
      visibleCard: visibleCard ? {
        id: visibleCard.dataset.jobId || '',
        status: visibleCard.dataset.status || '',
        audioCount: visibleCard.querySelectorAll('audio.preview-audio').length,
        playCount: visibleCard.querySelectorAll('button.preview-toggle').length,
        stemCount: visibleCard.querySelectorAll('.output-row a[download]').length,
        zipCount: visibleCard.querySelectorAll('.zip-row a[download]').length,
        folderCount: visibleCard.querySelectorAll('[data-open-folder-id]').length,
      } : null,
      saveAll: {
        hidden: Boolean(saveAction?.hidden || (saveAction && getComputedStyle(saveAction).display === 'none')),
        disabled: Boolean(saveButton?.disabled),
        text: saveButton?.textContent?.trim() || '',
        rect: rect(saveButton),
      },
      saveStatus: {
        text: saveStatus?.textContent?.trim() || '',
        rect: rect(saveStatus),
        clientWidth: saveStatus?.clientWidth || 0,
        scrollWidth: saveStatus?.scrollWidth || 0,
      },
      shutdownDisabled: Boolean(shutdown?.disabled),
      toast: { hidden: Boolean(toast?.hidden), text: toast?.textContent?.trim() || '' },
      selector: { hidden: Boolean(document.querySelector('#file-switcher')?.hidden), value: document.querySelector('#file-select')?.value || '' },
      navigation: { previousDisabled: Boolean(previous?.disabled), nextDisabled: Boolean(next?.disabled), previousRect: rect(previous), nextRect: rect(next) },
      scroll: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight },
      viewport: { width: window.innerWidth, height: window.innerHeight }
    }
  })
}

function assert(condition, message, evidence) {
  if (!condition) throw new Error(`${message}: ${JSON.stringify(evidence)}`)
}

async function hitTestControls(window) {
  return window.evaluate(() => ['#save-all-button', '#previous-file', '#next-file'].map(selector => {
    const node = document.querySelector(selector)
    if (!node || node.disabled || node.hidden) return { selector, disabled: true, inside: true }
    const rect = node.getBoundingClientRect()
    const hit = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2)
    return { selector, disabled: false, inside: hit === node || Boolean(hit && node.contains(hit)), rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } }
  }))
}

async function resizeWindow(electronApp, window, width, height) {
  const browserWindow = await electronApp.browserWindow(window)
  await browserWindow.evaluate((handle, bounds) => handle.setBounds(bounds), { width, height })
  await window.waitForTimeout(220)
}

async function capture(window, name) {
  const target = path.join(OUTPUTS, `save-all-${name}.png`)
  await window.screenshot({ path: target, scale: 'css' })
  return target
}

async function waitForTerminal(window, count, timeoutMs = 240_000) {
  return waitFor(async () => {
    const current = await metrics(window)
    if (current.jobs.length !== count) return false
    if (current.jobs.some(job => ['queued', 'decoding', 'separating', 'encoding'].includes(job.status))) return false
    return current
  }, timeoutMs, `${count} jobs terminal`)
}

async function waitForDownload(electronApp, index, timeoutMs = 60_000) {
  return waitFor(async () => {
    const mocks = await readMocks(electronApp)
    const item = mocks.downloads?.[index]
    if (!item?.done) return false
    const info = await stat(item.target).catch(() => null)
    return info?.size ? { ...item, size: info.size } : false
  }, timeoutMs, `download ${index + 1}`)
}

function readZipEntries(buffer) {
  const entries = []
  for (let offset = 0; offset + 46 <= buffer.length; offset += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) continue
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const size = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize)
    const content = method === 0 ? compressed : inflateRawSync(compressed)
    entries.push({ name, method, size, compressedSize, magic: content.subarray(0, 4).toString('ascii'), wave: content.toString('ascii', 8, 12) })
    offset += 45 + nameLength + extraLength + commentLength
  }
  return entries
}

async function run() {
  await mkdir(OUTPUTS, { recursive: true })
  await ensureFixtures()
  await setupPortable()
  const { electronApp, window } = await launchApp()
  const downloadDir = path.join(DATA, 'save-all-downloads')
  try {
    await installMocks(electronApp, downloadDir)
    const initial = await metrics(window)
    assert(initial.saveAll.hidden || initial.saveAll.disabled, 'SaveAll should not be actionable on an empty queue', initial)
    record('empty queue disables SaveAll', 'pass', JSON.stringify(initial.saveAll))

    const paths = [report.fixtures.video[0].path, report.fixtures.video[1].path, report.fixtures.noAudio.path]
    await window.setInputFiles('#file-input', paths)
    const processing = await waitFor(async () => {
      const current = await metrics(window)
      return current.jobs.length === 3 && current.saveAll.disabled ? current : false
    }, 30_000, 'SaveAll disabled while jobs process')
    record('SaveAll stays disabled while processing', 'pass', JSON.stringify({ statuses: processing.jobs.map(job => job.status), disabled: processing.saveAll.disabled }))

    const terminal = await waitForTerminal(window, 3)
    assert(!terminal.saveAll.disabled, 'SaveAll should enable after at least one done job and no processing', terminal)
    assert(terminal.saveStatus.text.includes('пропущено: 1'), 'SaveAll status should disclose excluded terminal job', terminal.saveStatus)
    record('completed queue enables SaveAll and discloses skipped count', 'pass', JSON.stringify({ jobs: terminal.jobs, saveAll: terminal.saveAll, status: terminal.saveStatus }))

    const firstDoneId = terminal.jobs.find(job => job.status === 'done')?.id
    assert(firstDoneId, 'completed queue did not expose a done job for visual preview', terminal.jobs)
    await window.locator('#file-select').selectOption(firstDoneId)
    await waitFor(async () => {
      const current = await metrics(window)
      return current.selector.value === firstDoneId && current.visibleCards === 1 ? current : false
    }, 5_000, 'select done job for SaveAll screenshots')

    for (const [width, height, label] of [[680, 540, '680x540'], [760, 560, '760x560']]) {
      await resizeWindow(electronApp, window, width, height)
      const view = await metrics(window)
      assert(view.scroll.width <= view.scroll.clientWidth + 1 && view.scroll.height <= view.scroll.clientHeight + 1, `${label} SaveAll view scrolls`, view)
      assert(view.saveAll.rect && view.saveAll.rect.left >= 0 && view.saveAll.rect.right <= view.viewport.width + 1 && view.saveAll.rect.bottom <= view.viewport.height + 1, `${label} SaveAll button is outside viewport`, view)
      assert(view.saveStatus.scrollWidth <= view.saveStatus.clientWidth + 1, `${label} SaveAll status is clipped`, view.saveStatus)
      assert(view.visibleCard?.status === 'done' && view.visibleCard.audioCount === 3 && view.visibleCard.playCount === 3 && view.visibleCard.stemCount === 3 && view.visibleCard.zipCount === 1 && view.visibleCard.folderCount === 1, `${label} selected done card is missing preview/save controls`, view.visibleCard)
      const hitTests = await hitTestControls(window)
      assert(hitTests.every(item => item.inside), `${label} navigation or SaveAll hit-test failed`, hitTests)
      await capture(window, label)
      record(`${label} SaveAll layout fits without scroll`, 'pass', JSON.stringify({ scroll: view.scroll, button: view.saveAll.rect, status: view.saveStatus, visibleCard: view.visibleCard, hitTests }))
    }

    const originalReadyIds = new Set(terminal.jobs.filter(job => job.status === 'done').map(job => job.id))
    await window.evaluate(() => {
      const original = window.fetch.bind(window)
      const gate = { count: 0, bodyMissing: true, release: null, original }
      globalThis.__mrxSaveAllGate = gate
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input?.url || ''
        if (!String(url).endsWith('/api/exports')) return original(input, init)
        gate.count += 1
        gate.bodyMissing = gate.bodyMissing && !(init && init.body)
        return original(input, init).then(response => new Promise(resolve => { gate.release = () => resolve(response) }))
      }
    })
    await window.locator('#save-all-button').click()
    await waitFor(async () => window.evaluate(() => {
      const gate = globalThis.__mrxSaveAllGate
      const button = document.querySelector('#save-all-button')
      return gate?.count === 1 && button?.disabled ? true : false
    }), 10_000, 'SaveAll pending gate')
    await window.evaluate(() => document.querySelector('#save-all-button')?.click())
    const pending = await metrics(window)
    assert(pending.saveAll.disabled && pending.shutdownDisabled, 'pending SaveAll should disable duplicate and Close actions', pending)

    await window.setInputFiles('#file-input', [report.fixtures.video[0].path])
    await waitFor(async () => {
      const current = await metrics(window)
      return current.jobs.length === 4 ? current : false
    }, 30_000, 'new upload during SaveAll')
    await window.evaluate(() => globalThis.__mrxSaveAllGate?.release?.())
    const archiveDownload = await waitForDownload(electronApp, 0)
    const bodyMissing = await window.evaluate(() => globalThis.__mrxSaveAllGate?.bodyMissing ?? false)
    await window.evaluate(() => {
      const gate = globalThis.__mrxSaveAllGate
      if (gate) window.fetch = gate.original
      delete globalThis.__mrxSaveAllGate
    })
    const archiveBytes = await readFile(archiveDownload.target)
    const entries = readZipEntries(archiveBytes)
    const folders = [...new Set(entries.map(entry => entry.name.split('/')[0]))]
    assert(archiveDownload.filename === 'MRX — все дорожки.zip', 'SaveAll download filename mismatch', archiveDownload)
    assert(archiveBytes.subarray(0, 2).toString('ascii') === 'PK', 'SaveAll archive is not a ZIP', { bytes: archiveBytes.length })
    assert(entries.length === originalReadyIds.size * 3 && entries.every(entry => entry.name.endsWith('.wav') && entry.magic === 'RIFF' && entry.wave === 'WAVE' && entry.size > 44), 'SaveAll archive must contain only three valid WAVs per ready job', { entries, folders })
    assert(folders.length === originalReadyIds.size && folders.every(folder => /^\d{3}-/.test(folder)), 'SaveAll archive must separate jobs into unique folders', { entries, folders })
    const finished = await metrics(window)
    assert(finished.toast.text.includes('Новые файлы не вошли'), 'SaveAll should disclose files uploaded during export snapshot', finished)
    assert(finished.selector.value === firstDoneId, 'SaveAll changed the selected file', finished.selector)
    record('SaveAll pending/double-click guard, snapshot upload, and ZIP download', 'pass', JSON.stringify({ pending, download: archiveDownload, archiveBytes: archiveBytes.length, entries, folders, bodyMissing }))

    await waitForTerminal(window, 4)
    await window.evaluate(() => {
      const original = window.fetch.bind(window)
      globalThis.__mrxSaveAllFailure = { count: 0, original }
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input?.url || ''
        if (String(url).endsWith('/api/exports')) {
          globalThis.__mrxSaveAllFailure.count += 1
          return Promise.reject(new Error('Проверка ошибки общего архива'))
        }
        return original(input, init)
      }
    })
    await window.locator('#save-all-button').click()
    const recovered = await waitFor(async () => {
      const current = await metrics(window)
      return !current.saveAll.disabled && !current.toast.hidden && current.toast.text.includes('Проверка ошибки') ? current : false
    }, 10_000, 'SaveAll failure recovery')
    assert(recovered.saveAll.disabled === false, 'SaveAll should re-enable after export failure', recovered)
    await window.evaluate(() => {
      const failure = globalThis.__mrxSaveAllFailure
      if (failure) window.fetch = failure.original
      delete globalThis.__mrxSaveAllFailure
    })
    record('SaveAll error recovers and re-enables button', 'pass', JSON.stringify(recovered))
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
    '# Save all Electron QA',
    '',
    `Status: **${report.status}**`,
    '',
    'The global SaveAll action was exercised in an isolated packaged Electron layout on port 17964.',
    'DownloadItem.setSavePath and Electron dialog methods were mocked through electronApp.evaluate; this does not claim manual OS-dialog behavior.',
    '',
    ...report.checks.map(item => `- **${item.status}** ${item.name}: ${item.evidence}`),
    '',
    ...(report.errors.length ? ['Errors:', ...report.errors.map(error => `- ${error}`)] : []),
    '',
    'Fixtures and screenshots remain under tests/native/save-all-fixtures and outputs/save-all-*.png.'
  ]
  await writeFile(REPORT_MD, `${lines.join('\n')}\n`, 'utf8').catch(() => {})
  await rm(PORTABLE, { recursive: true, force: true }).catch(() => {})
}
