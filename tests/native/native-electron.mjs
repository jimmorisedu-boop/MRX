import playwright from '../e2e/node_modules/playwright-core/index.js'
import { spawn } from 'node:child_process'
import { cp, link, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIST = path.join(ROOT, 'dist', 'MRX')
const SOURCE_APP = path.join(ROOT, 'app')
const SOURCE_DESKTOP = path.join(ROOT, 'desktop')
const PORTABLE = path.join(ROOT, 'tests', 'native', 'portable')
const PORTABLE_APP = path.join(PORTABLE, 'resources', 'app')
const EXE = path.join(PORTABLE, 'MRX.exe')
const DATA = path.join(PORTABLE, 'data')
const REPORT_JSON = path.join(ROOT, 'tests', 'native', 'native-report.json')
const REPORT_MD = path.join(ROOT, 'tests', 'native', 'native-report.md')
const SHORT_INPUT = path.join(ROOT, 'tests', 'ui', 'Проверка звука.wav')
const BUSY_INPUT = path.join(ROOT, 'long.wav')
const { _electron: electron } = playwright

const report = {
  startedAt: new Date().toISOString(),
  playwrightCore: '1.64.0',
  packagedExecutable: EXE,
  portableLayout: 'tests/native/portable (removed after run)',
  dialogStubbing: 'electronApp.evaluate receives Electron module; dialog methods are mocked; no OS-dialog claim',
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

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await predicate()
    if (latest) return latest
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`${label || 'condition'} timed out${latest ? `: ${JSON.stringify(latest)}` : ''}`)
}

async function hashFile(file) {
  const hash = createHash('sha256')
  hash.update(await readFile(file))
  return hash.digest('hex')
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

async function resetData() {
  await rm(DATA, { recursive: true, force: true })
  await mkdir(DATA, { recursive: true })
}

function launchSecondInstance() {
  return new Promise((resolve, reject) => {
    const child = spawn(EXE, [], { cwd: PORTABLE, windowsHide: true, stdio: 'ignore' })
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const timer = setTimeout(() => {
      if (!child.killed) child.kill()
      finish({ exited: false, code: child.exitCode })
    }, 3_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', (code, signal) => { clearTimeout(timer); finish({ exited: true, code, signal }) })
  })
}

async function launchApp() {
  const env = { ...process.env, MRX_NO_BROWSER: '1', ELECTRON_ENABLE_LOGGING: '1' }
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
    globalThis.__mrxNativeTest = state
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
    shell.openPath = async value => {
      state.openPath = String(value || '')
      return ''
    }
    session.defaultSession.on('will-download', (_event, item) => {
      const index = state.downloads.length
      const target = `${state.downloadDir}\\${String(index + 1).padStart(2, '0')}-${item.getFilename()}`
      const download = { filename: item.getFilename(), target, done: false, state: '' }
      state.downloads.push(download)
      item.setSavePath(target)
      item.once('done', (_event, status) => {
        download.done = true
        download.state = status
        download.receivedBytes = item.getReceivedBytes()
      })
    })
  }, { downloadDir })
}

async function readMocks(electronApp) {
  return electronApp.evaluate(() => JSON.parse(JSON.stringify(globalThis.__mrxNativeTest || {})))
}

async function setDialogResponses(electronApp, responses) {
  await electronApp.evaluate((_electronModule, values) => {
    globalThis.__mrxNativeTest.responses = [...values]
  }, responses)
}

async function waitJobDone(window) {
  await window.waitForFunction(() => document.querySelector('.job-card')?.dataset.status === 'done', null, { timeout: 180_000 })
  await window.waitForFunction(() => document.querySelectorAll('a[download]').length >= 4, null, { timeout: 10_000 })
}

async function clickAndWaitDownload(electronApp, window, index) {
  await window.locator('a[download]').nth(index).click()
  return waitFor(async () => {
    const state = await readMocks(electronApp)
    const item = state.downloads?.[index]
    if (!item?.done) return false
    try {
      const info = await stat(item.target)
      return info.size > 0 ? item : false
    } catch {
      return false
    }
  }, 30_000, `download ${index + 1}`)
}

async function closeBrowserWindow(electronApp, window) {
  const browserWindow = await electronApp.browserWindow(window)
  await browserWindow.evaluate(handle => handle.close())
}

async function waitAppClosed(electronApp, timeoutMs = 15_000) {
  await electronApp.waitForEvent('close', { timeout: timeoutMs })
}

async function verifyOutputBytes(electronApp, downloads) {
  const result = []
  for (const [index, item] of downloads.entries()) {
    const bytes = await readFile(item.target)
    const isZip = index === 3
    const magic = bytes.subarray(0, 4).toString('ascii')
    if (isZip) {
      if (!bytes.subarray(0, 2).equals(Buffer.from('PK'))) throw new Error(`ZIP download missing PK header: ${item.target}`)
    } else {
      if (magic !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`WAV download missing RIFF/WAVE header: ${item.target}`)
    }
    result.push({ filename: item.filename, size: bytes.length, magic: isZip ? bytes.subarray(0, 2).toString('ascii') : magic })
  }
  return result
}

async function runIdleScenario() {
  const downloadDir = path.join(DATA, 'native-downloads')
  const { electronApp, window } = await launchApp()
  try {
    const appPath = await electronApp.evaluate(({ app }) => app.getAppPath())
    if (!appPath.endsWith(path.join('resources', 'app'))) throw new Error(`unexpected packaged app path: ${appPath}`)
    record('packaged layout uses resources/app', 'pass', appPath)

    await installMocks(electronApp, downloadDir)
    const second = await launchSecondInstance()
    const oneWindow = electronApp.windows().length === 1
    if (!oneWindow) throw new Error(`single-instance window count=${electronApp.windows().length}`)
    record('single-instance second launch', 'pass', JSON.stringify(second))

    await window.setInputFiles('#file-input', SHORT_INPUT)
    await waitJobDone(window)
    const linkCount = await window.locator('a[download]').count()
    if (linkCount !== 4) throw new Error(`expected 4 downloads, got ${linkCount}`)
    const downloaded = []
    for (let index = 0; index < 4; index += 1) downloaded.push(await clickAndWaitDownload(electronApp, window, index))
    const bytes = await verifyOutputBytes(electronApp, downloaded)
    record('three WAV + ZIP saved through DownloadItem.setSavePath', 'pass', JSON.stringify(bytes))

    await window.getByRole('button', { name: /Открыть папку/ }).click()
    await waitFor(async () => (await readMocks(electronApp)).openPath, 5_000, 'open folder IPC')
    const openPath = (await readMocks(electronApp)).openPath
    if (!openPath.includes(path.join('data', 'outputs'))) throw new Error(`unexpected shell.openPath target: ${openPath}`)
    record('open-folder IPC stays inside portable data', 'pass', openPath)

    const closePromise = waitAppClosed(electronApp)
    await closeBrowserWindow(electronApp, window)
    await closePromise
    record('idle window close shuts down owned server', 'pass', 'Electron close event observed')
    await electronApp.close().catch(() => {})
  } catch (error) {
    await electronApp.close().catch(() => {})
    throw error
  }
}

async function runBusyScenario() {
  await resetData()
  const { electronApp, window } = await launchApp()
  try {
    await installMocks(electronApp, path.join(DATA, 'busy-downloads'))
    await window.setInputFiles('#file-input', BUSY_INPUT)
    await window.waitForFunction(() => ['queued', 'decoding', 'separating', 'encoding'].includes(document.querySelector('.job-card')?.dataset.status), null, { timeout: 30_000 })
    await setDialogResponses(electronApp, [0])
    await closeBrowserWindow(electronApp, window)
    await new Promise(resolve => setTimeout(resolve, 1_000))
    if (window.isClosed()) throw new Error('busy close response 0 closed the window')
    if (await window.locator('.job-card').count() !== 1) throw new Error('busy close response 0 removed the job card')
    const firstDialog = (await readMocks(electronApp)).dialogs.at(-1)
    if (firstDialog?.response !== 0) throw new Error(`expected mocked cancel response 0, got ${JSON.stringify(firstDialog)}`)
    record('busy close response 0 keeps window and job', 'pass', JSON.stringify(firstDialog))

    await setDialogResponses(electronApp, [1])
    const closePromise = waitAppClosed(electronApp)
    await closeBrowserWindow(electronApp, window)
    await closePromise
    await new Promise(resolve => setTimeout(resolve, 1_000))
    const leftovers = (await readdir(path.join(DATA, 'outputs'), { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory())
    if (leftovers.length) throw new Error(`cancelled busy close left output directories: ${leftovers.map(entry => entry.name).join(', ')}`)
    record('busy close response 1 cancels worker and cleans outputs', 'pass', 'Electron close event observed; no output job directory')
    await electronApp.close().catch(() => {})
  } catch (error) {
    await electronApp.close().catch(() => {})
    throw error
  }
}

async function writeReport() {
  report.finishedAt = new Date().toISOString()
  report.status = report.errors.length ? 'blocked_or_failed' : 'pass'
  await writeFile(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`)
  const lines = [
    '# Native Electron QA',
    '',
    `Status: **${report.status}**`,
    '',
    'Dialogs were mocked through `electronApp.evaluate` and no claim is made about manual OS dialog behavior.',
    '',
    ...report.checks.map(item => `- **${item.status}** ${item.name}: ${item.evidence}`),
    '',
    ...(report.errors.length ? ['Errors:', ...report.errors.map(error => `- ${error}`)] : [])
  ]
  await writeFile(REPORT_MD, `${lines.join('\n')}\n`)
}

async function main() {
  try {
    await setupPortable()
    const sourceHash = await hashFile(path.join(SOURCE_APP, 'server.mjs'))
    const packagedHash = await hashFile(path.join(PORTABLE_APP, 'app', 'server.mjs'))
    if (sourceHash !== packagedHash) throw new Error('source app was not copied into packaged resources/app')
    record('source-updated app copied into packaged layout', 'pass', sourceHash)
    await runIdleScenario()
    await runBusyScenario()
  } catch (error) {
    const message = errorText(error)
    report.errors.push(message)
    record('native harness', 'blocked', message)
  } finally {
    await writeReport()
    await rm(PORTABLE, { recursive: true, force: true }).catch(() => {})
  }
  if (report.errors.length) process.exitCode = 1
}

main()
