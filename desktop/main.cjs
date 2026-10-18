'use strict'

const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  session,
  shell
} = require('electron')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const fsp = fs.promises
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const APP_DIR = __dirname
const PACKAGED_LAYOUT = path.basename(path.dirname(APP_DIR)).toLowerCase() === 'app' &&
  path.basename(path.dirname(path.dirname(APP_DIR))).toLowerCase() === 'resources'
const APP_ROOT = PACKAGED_LAYOUT ? path.join(process.resourcesPath, 'app') : path.resolve(APP_DIR, '..')
const PORTABLE_ROOT = PACKAGED_LAYOUT ? path.resolve(process.resourcesPath, '..') : APP_ROOT
const SERVER_PATH = path.join(APP_ROOT, 'app', 'server.mjs')
const NODE_PATH = path.join(PORTABLE_ROOT, 'runtime', 'node.exe')
const DATA_DIR = path.join(PORTABLE_ROOT, 'data')
const OUTPUT_DIR = path.join(DATA_DIR, 'outputs')
const WEIGHTS_DIR = path.join(PORTABLE_ROOT, 'weights')
const FFMPEG_PATH = path.join(PORTABLE_ROOT, 'tools', 'ffmpeg.exe')
const LOG_DIR = path.join(DATA_DIR, 'logs')
const LOG_PATH = path.join(LOG_DIR, 'mrx-desktop.log')
const WINDOW = { width: 760, height: 560, minWidth: 680, minHeight: 540 }
const SMOKE_MODE = process.env.MRX_SMOKE === '1' || process.argv.includes('--mrx-smoke') || process.argv.includes('--mrx-smoke-result')
const SMOKE_RESULT_MODE = process.env.MRX_SMOKE_MODE === 'result' || process.argv.includes('--mrx-smoke-result')

let mainWindow = null
let serverProcess = null
let serverUrl = null
let serverExitExpected = false
let allowWindowClose = false
let closeInFlight = false
let startupReady = false
let startupBuffer = ''
let sessionCookie = ''

function log(message) {
  const line = `[${new Date().toISOString()}] ${String(message).replace(/\r?\n/g, '\n')}`
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(LOG_PATH, `${line}\n`, 'utf8')
  } catch {}
}

function resolvedServerUrl(value) {
  try {
    const url = new URL(String(value))
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) return null
    if (!/^\d+$/.test(url.port)) return null
    url.pathname = '/'
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function spawnServer() {
  if (!fs.existsSync(SERVER_PATH)) throw new Error(`Сервер не найден: ${SERVER_PATH}`)
  const nodeExecutable = fs.existsSync(NODE_PATH) ? NODE_PATH : (process.env.MRX_NODE_PATH || 'node')
  const env = {
    ...process.env,
    MRX_NO_BROWSER: '1',
    MRX_DATA_DIR: DATA_DIR,
    MRX_WEIGHTS_DIR: WEIGHTS_DIR,
    MRX_FFMPEG: FFMPEG_PATH,
    ELECTRON_RUN_AS_NODE: undefined
  }
  delete env.ELECTRON_RUN_AS_NODE
  log(`Starting server with ${nodeExecutable}`)
  const child = spawn(nodeExecutable, [SERVER_PATH], {
    cwd: PORTABLE_ROOT,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ignore']
  })
  serverProcess = child
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    startupBuffer = `${startupBuffer}${chunk}`.slice(-16000)
    log(`server: ${chunk}`)
    const match = startupBuffer.match(/MRX_READY\s+(https?:\/\/[^\s]+\/)/)
    if (match && !serverUrl) {
      serverUrl = resolvedServerUrl(match[1])
      if (serverUrl) {
        startupReady = true
        log(`Server ready at ${serverUrl}`)
      }
    }
  })
  child.stderr.on('data', (chunk) => log(`server stderr: ${chunk}`))
  child.on('error', (error) => log(`server process error: ${error.stack || error}`))
  child.on('exit', (code, signal) => {
    log(`Server exited code=${code} signal=${signal || ''}`)
    serverProcess = null
    if (serverExitExpected || closeInFlight || !mainWindow || (startupReady && code === 0)) {
      allowWindowClose = true
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
      if (app.isReady()) app.quit()
      return
    }
    if (startupReady && code !== 0) {
      showStartupError(`Локальный сервер неожиданно завершился (код ${code ?? '—'}).`)
    }
  })
  return child
}

function showStartupError(message, detail = '') {
  log(`Startup failure: ${message} ${detail}`)
  const text = `${message}\n\nЖурнал запуска: ${LOG_PATH}`
  dialog.showMessageBoxSync({
    type: 'error',
    title: 'MRX — ошибка запуска',
    message: text,
    detail: detail || 'Проверьте комплект portable и попробуйте запустить MRX.exe ещё раз.'
  })
  serverExitExpected = true
  terminateOwnedServer()
  allowWindowClose = true
  app.quit()
}

function isTrustedUrl(value) {
  if (!serverUrl) return false
  try {
    const requested = new URL(String(value))
    const trusted = new URL(serverUrl)
    return requested.protocol === trusted.protocol && requested.hostname === trusted.hostname && requested.port === trusted.port
  } catch {
    return false
  }
}

async function serverCookieHeader() {
  if (!serverUrl) return ''
  try {
    const cookies = await session.defaultSession.cookies.get({ url: serverUrl })
    const header = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
    return header || sessionCookie
  } catch {
    return sessionCookie
  }
}

async function requestServer(pathname, method = 'GET') {
  if (!serverUrl) throw new Error('Локальный сервер не запущен')
  const target = new URL(pathname, serverUrl)
  if (!isTrustedUrl(target.href)) throw new Error('Недоверенный локальный адрес')
  const cookie = await serverCookieHeader()
  return new Promise((resolve, reject) => {
    const req = http.request(target, {
      method,
      headers: {
        Accept: 'application/json',
        Origin: serverUrl,
        ...(cookie ? { Cookie: cookie } : {})
      }
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        let payload = {}
        try { payload = body ? JSON.parse(body) : {} } catch {}
        const setCookie = res.headers['set-cookie']
        if (!sessionCookie && Array.isArray(setCookie) && setCookie[0]) sessionCookie = setCookie[0].split(';', 1)[0]
        const status = res.statusCode || 0
        if (status < 200 || status >= 300) {
          reject(new Error(payload?.error || `Локальный сервер ответил с кодом ${status}`))
          return
        }
        resolve({ status, payload })
      })
    })
    req.setTimeout(2500, () => req.destroy(new Error('Тайм-аут локального сервера')))
    req.on('error', reject)
    req.end()
  })
}

function smokeDelay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function uploadSmokeInput(inputPath) {
  if (!serverUrl) throw new Error('Локальный сервер не запущен')
  const resolvedInput = path.resolve(inputPath)
  const info = await fsp.stat(resolvedInput).catch(() => null)
  if (!info?.isFile()) throw new Error(`Smoke-файл не найден: ${resolvedInput}`)
  const boundary = `----MRXSmoke${crypto.randomBytes(12).toString('hex')}`
  const fileName = path.basename(resolvedInput).replace(/["\r\n]/g, '_') || 'smoke.wav'
  const preamble = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${fileName}"\r\nContent-Type: audio/wav\r\n\r\n`, 'utf8')
  const ending = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  const target = new URL('/api/jobs', serverUrl)
  const cookie = await serverCookieHeader()
  return new Promise((resolve, reject) => {
    const req = http.request(target, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Origin: serverUrl,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': preamble.length + info.size + ending.length,
        ...(cookie ? { Cookie: cookie } : {})
      }
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        let payload = {}
        try { payload = body ? JSON.parse(body) : {} } catch {}
        const setCookie = res.headers['set-cookie']
        if (!sessionCookie && Array.isArray(setCookie) && setCookie[0]) sessionCookie = setCookie[0].split(';', 1)[0]
        const status = res.statusCode || 0
        if (status < 200 || status >= 300) {
          reject(new Error(payload?.error || `Smoke-загрузка завершилась с кодом ${status}`))
          return
        }
        resolve(payload)
      })
    })
    req.setTimeout(10000, () => req.destroy(new Error('Тайм-аут smoke-загрузки')))
    req.on('error', reject)
    req.write(preamble)
    const stream = fs.createReadStream(resolvedInput)
    stream.on('error', (error) => {
      req.destroy(error)
    })
    stream.on('end', () => req.end(ending))
    stream.pipe(req, { end: false })
  })
}

async function waitForSmokeResult(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    const response = await requestServer('/api/state')
    latest = response.payload || {}
    const jobs = Array.isArray(latest.jobs) ? latest.jobs : []
    const job = jobs[jobs.length - 1]
    if (job && ['done', 'error', 'cancelled'].includes(job.status)) return latest
    await smokeDelay(600)
  }
  const job = latest?.jobs?.[latest.jobs.length - 1]
  throw new Error(`Smoke-обработка не завершилась за ${Math.round(timeoutMs / 1000)} с${job ? ` (статус: ${job.status})` : ''}`)
}

async function runPreviewSmoke(window) {
  if (!window || window.isDestroyed()) throw new Error('Окно MRX недоступно для preview-smoke')
  const script = `
    (async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitMetadata = (audio) => new Promise((resolve, reject) => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) { resolve(); return; }
        const timer = setTimeout(() => reject(new Error('Метаданные preview-аудио не загрузились')), 15000);
        audio.addEventListener('loadedmetadata', () => { clearTimeout(timer); resolve(); }, { once: true });
        audio.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Preview-аудио завершилось ошибкой')); }, { once: true });
      });
      const audios = Array.from(document.querySelectorAll('audio.preview-audio'));
      if (audios.length < 2) throw new Error('В результате меньше двух preview-дорожек');
      audios.forEach((audio) => { audio.muted = true; audio.volume = 0; });
      const first = audios[0];
      const firstNode = first;
      await waitMetadata(first);
      await first.play();
      const startedAt = first.currentTime;
      await wait(3500);
      const advancedTo = first.currentTime;
      const preservedAcrossPolls = document.querySelector('audio.preview-audio') === firstNode;
      first.pause();
      const pausedAfterPause = first.paused;
      const seek = document.querySelector('.preview-seek');
      const seekTarget = Math.max(0.1, Math.min(first.duration - 0.1, first.duration * 0.55));
      seek.value = String(seekTarget);
      seek.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(120);
      const seekApplied = Math.abs(first.currentTime - seekTarget) < 0.25;
      const second = audios[1];
      await waitMetadata(second);
      const firstRow = first.closest('.output-row');
      const rapidPlay = first.play();
      first.pause();
      const rapidPlayPauseResult = await Promise.resolve(rapidPlay).then(() => true).catch((error) => error?.name === 'AbortError');
      await wait(120);
      const firstError = firstRow?.querySelector('.preview-error');
      const rapidPlayPauseSafe = rapidPlayPauseResult && (!firstError || firstError.hidden);
      const rapidSwitch = first.play();
      const rapidSecondSwitch = second.play();
      await Promise.allSettled([rapidSwitch, rapidSecondSwitch]);
      await wait(120);
      const rapidSwitchSafe = first.paused && !second.paused && (!firstError || firstError.hidden);
      second.pause();
      await second.play();
      await wait(300);
      const switchedTrackPausesPrevious = first.paused && !second.paused;
      second.pause();
      await wait(120);
      const downloadRequests = performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/download/')).length;
      return {
        trackCount: audios.length,
        duration: first.duration,
        startedAt,
        advancedTo,
        advanced: advancedTo > startedAt + 0.05,
        pausedAfterPause,
        seekApplied,
        switchedTrackPausesPrevious,
        rapidPlayPauseSafe,
        rapidSwitchSafe,
        preservedAcrossPolls,
        previewRequests: performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/preview/')).length,
        downloadRequests
      };
    })()
  `
  const result = await window.webContents.executeJavaScript(script, true)
  if (!result?.advanced || !result.pausedAfterPause || !result.seekApplied || !result.switchedTrackPausesPrevious || !result.rapidPlayPauseSafe || !result.rapidSwitchSafe || !result.preservedAcrossPolls) {
    throw new Error(`Preview-smoke не пройден: ${JSON.stringify(result)}`)
  }
  if (result.downloadRequests) throw new Error(`Preview-smoke запустил ${result.downloadRequests} загрузок`)
  return result
}

function terminateOwnedServer() {
  if (!serverProcess || serverProcess.killed) return
  const pid = serverProcess.pid
  if (process.platform === 'win32' && pid) {
    const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    killer.unref()
  } else {
    serverProcess.kill('SIGTERM')
  }
}

function waitForServerExit(timeoutMs = 2600) {
  if (!serverProcess) return Promise.resolve()
  const child = serverProcess
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    child.once('exit', finish)
  })
}

async function confirmAndClose() {
  if (closeInFlight) return
  closeInFlight = true
  try {
    let payload = {}
    try {
      const state = await requestServer('/api/state')
      payload = state.payload || {}
    } catch (error) {
      log(`State before close failed: ${error.stack || error}`)
    }
    if (payload.busy) {
      const choice = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'MRX ещё обрабатывает файл',
        message: 'Закрыть MRX и отменить текущую обработку?',
        detail: 'Незавершённые результаты этой задачи будут удалены.',
        buttons: ['Отмена', 'Закрыть и отменить'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      if (choice.response !== 1) return
      await requestServer('/api/shutdown?force=1', 'POST')
    } else {
      await requestServer('/api/shutdown', 'POST')
    }
    serverExitExpected = true
    allowWindowClose = true
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
    await waitForServerExit()
    terminateOwnedServer()
    await waitForServerExit(1200)
    app.quit()
  } catch (error) {
    log(`Close request failed: ${error.stack || error}`)
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'MRX — сервер не отвечает',
      message: 'Не удалось корректно закрыть локальный сервер.',
      detail: `Журнал: ${LOG_PATH}\n\nЗакрыть окно и завершить собственный сервер?`,
      buttons: ['Отмена', 'Закрыть'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (choice.response === 1) {
      serverExitExpected = true
      allowWindowClose = true
      terminateOwnedServer()
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
      await waitForServerExit(1200)
      app.quit()
    }
  } finally {
    closeInFlight = false
  }
}

async function captureSmoke(window) {
  if (!SMOKE_MODE || !window || window.isDestroyed()) return
  const outputPath = path.resolve(process.env.MRX_SMOKE_OUTPUT || path.join(PORTABLE_ROOT, 'desktop-ready.png'))
  const metadataPath = process.env.MRX_SMOKE_METADATA
    ? path.resolve(process.env.MRX_SMOKE_METADATA)
    : `${outputPath}.json`
  let smokeState = null
  let previewSmoke = null
  try {
    if (SMOKE_RESULT_MODE) {
      const inputPath = process.env.MRX_SMOKE_INPUT
      if (!inputPath) throw new Error('Для smoke-результата не задан MRX_SMOKE_INPUT')
      // Bootstrap the HttpOnly session cookie before posting the fixture.
      await requestServer('/api/state')
      await uploadSmokeInput(inputPath)
      smokeState = await waitForSmokeResult()
      await smokeDelay(900)
      if (process.env.MRX_SMOKE_PREVIEW === '1') previewSmoke = await runPreviewSmoke(window)
    } else {
      await smokeDelay(900)
    }
    const image = await window.webContents.capturePage()
    await fsp.mkdir(path.dirname(outputPath), { recursive: true })
    await fsp.writeFile(outputPath, image.toPNG())
    await fsp.writeFile(metadataPath, JSON.stringify({
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      url: serverUrl,
      width: image.getSize().width,
      height: image.getSize().height,
      desktop: true,
      resultSmoke: SMOKE_RESULT_MODE,
      state: smokeState,
      previewSmoke
    }, null, 2))
    log(`Smoke capture written to ${outputPath}`)
  } catch (error) {
    log(`Smoke capture failed: ${error.stack || error}`)
    throw error
  } finally {
    serverExitExpected = true
    allowWindowClose = true
    await requestServer('/api/shutdown', 'POST').catch((error) => log(`Smoke shutdown failed: ${error.message || error}`))
    if (window && !window.isDestroyed()) window.close()
    app.quit()
  }
}

function createWindow() {
  const preloadPath = path.join(APP_ROOT, 'desktop', 'preload.cjs')
  mainWindow = new BrowserWindow({
    ...WINDOW,
    title: 'MRX — Разделить звук',
    backgroundColor: '#f5f6f8',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  })
  mainWindow.setMenuBarVisibility(false)
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url)) event.preventDefault()
  })
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    if (code !== -3) showStartupError(`Не удалось открыть интерфейс MRX (${code}).`, description)
  })
  mainWindow.on('close', (event) => {
    if (!allowWindowClose) {
      event.preventDefault()
      confirmAndClose().catch((error) => log(`Close handler failed: ${error.stack || error}`))
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })
  session.defaultSession.on('will-download', (event, item) => {
    const url = item.getURL()
    if (!isTrustedUrl(url) || !new URL(url).pathname.startsWith('/api/download/')) {
      item.cancel()
      return
    }
    const filename = path.basename(item.getFilename() || 'mrx-output.wav')
    const defaultPath = path.join(OUTPUT_DIR, filename)
    item.setSaveDialogOptions({
      title: 'Сохранить результат MRX',
      defaultPath,
      buttonLabel: 'Сохранить',
      filters: [{ name: 'Результат MRX', extensions: [path.extname(filename).slice(1) || 'wav'] }]
    })
  })
  return mainWindow
}

ipcMain.handle('mrx-open-job-folder', async (_event, value) => {
  const jobId = String(value || '')
  if (!/^[a-f0-9]{24}$/i.test(jobId)) throw new Error('Недопустимый идентификатор задачи')
  const outputRoot = path.resolve(OUTPUT_DIR)
  const folder = path.resolve(outputRoot, jobId)
  if (!folder.startsWith(`${outputRoot}${path.sep}`) || folder === outputRoot) throw new Error('Недопустимый путь результата')
  const info = await fsp.stat(folder).catch(() => null)
  if (!info?.isDirectory()) throw new Error('Папка результата ещё не найдена')
  const error = await shell.openPath(folder)
  if (error) throw new Error(error)
  return { ok: true }
})

app.setPath('userData', path.join(DATA_DIR, 'electron-user-data'))
app.setPath('cache', path.join(DATA_DIR, 'electron-cache'))

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
  app.on('before-quit', (event) => {
    if (allowWindowClose || !serverProcess) return
    event.preventDefault()
    confirmAndClose().catch((error) => log(`before-quit failed: ${error.stack || error}`))
  })
  app.whenReady().then(async () => {
    try {
      nativeTheme.themeSource = 'light'
      await fsp.mkdir(LOG_DIR, { recursive: true })
      spawnServer()
      const deadline = Date.now() + 30000
      while (!startupReady && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
      if (!startupReady || !serverUrl) throw new Error(startupBuffer || 'Сервер не сообщил адрес MRX_READY')
      const window = createWindow()
      await window.loadURL(serverUrl)
      window.show()
      window.focus()
      if (SMOKE_MODE) captureSmoke(window).catch((error) => showStartupError('Smoke‑проверка окна MRX не удалась.', error?.message || String(error)))
    } catch (error) {
      showStartupError('Не удалось запустить MRX.', error?.message || String(error))
    }
  }).catch((error) => showStartupError('Не удалось инициализировать окно MRX.', error?.message || String(error)))
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
}
