import http from 'node:http'
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, rm, stat, open, writeFile, rename, realpath } from 'node:fs/promises'
import { pipeline } from 'node:stream'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import Busboy from 'busboy'
import { ZipArchive } from 'archiver'

const APP_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(APP_DIR, '..')
const PUBLIC_DIR = path.join(APP_DIR, 'public')
const DATA_DIR = path.resolve(process.env.MRX_DATA_DIR || path.join(ROOT_DIR, 'data'))
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads')
const OUTPUT_DIR = path.join(DATA_DIR, 'outputs')
const CACHE_DIR = path.join(DATA_DIR, 'cache')
const EXPORT_DIR = path.join(CACHE_DIR, 'exports')
const WEIGHTS_DIR = path.resolve(process.env.MRX_WEIGHTS_DIR || path.join(ROOT_DIR, 'weights'))
const WORKER_PATH = path.join(APP_DIR, 'separate-worker.mjs')
// The portable build ships tools\ffmpeg.exe; a source checkout gets
// tools\ffmpeg\bin\ffmpeg.exe from scripts/fetch-deps.mjs.
const BUNDLED_FFMPEG = path.join(ROOT_DIR, 'tools', 'ffmpeg.exe')
const FFMPEG_PATH = path.resolve(process.env.MRX_FFMPEG || (existsSync(BUNDLED_FFMPEG) ? BUNDLED_FFMPEG : path.join(ROOT_DIR, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe')))
const MAX_FILE_BYTES = Number(process.env.MRX_MAX_FILE_BYTES || 1_500_000_000)
const MAX_FILES = Number(process.env.MRX_MAX_FILES || 20)
const START_PORT = Number(process.env.MRX_PORT || 17863)
// The desktop app generates the session token and passes it in; a server
// started by hand makes its own and prints a one-time sign-in link instead.
const ENV_SESSION_TOKEN = process.env.MRX_SESSION_TOKEN || ''
if (ENV_SESSION_TOKEN && !/^[A-Za-z0-9_-]{32,128}$/.test(ENV_SESSION_TOKEN)) throw new Error('MRX_SESSION_TOKEN must be 32-128 base64url characters')
const SESSION_TOKEN = ENV_SESSION_TOKEN || crypto.randomBytes(32).toString('base64url')
const DESKTOP_MODE = process.env.MRX_DESKTOP === '1'
const PAGE_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
}
const VERSION = '1.0.0'

const jobs = new Map()
const queue = []
let running = null
let stopping = false
let server
let activeExport = null
const exportCache = new Map()
const EXPORT_FILENAME = 'MRX — все дорожки.zip'

const json = (res, status, value, headers = {}) => {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(body)
}

const safeSegment = (value, fallback = 'file') => {
  const normalized = String(value || '').normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim()
  const limited = normalized.slice(0, 120).replace(/[\uD800-\uDBFF]$/u, '')
  return limited || fallback
}

const safeFileName = (value, fallback = 'input') => {
  const base = path.basename(String(value || '')).replace(/\.[^.]*$/, '')
  return safeSegment(base, fallback)
}

function decodePathSegment(value) {
  try { return decodeURIComponent(value) } catch { return null }
}

const id = () => crypto.randomBytes(12).toString('hex')

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

// Windows antivirus and indexers briefly hold freshly written files, so
// recursive removals retry instead of leaving partial results behind.
const removeTree = target => rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})

function uploadWriteError(error, originalName) {
  if (error?.code === 'ENOSPC') return 'Недостаточно места на диске для загрузки файла'
  return `Не удалось сохранить файл «${originalName}»: ${error?.message || error}`
}

function publicJob(job) {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    progress: Math.max(0, Math.min(100, Math.round(job.progress))),
    message: job.message || '',
    outputs: job.outputs || [],
    zipUrl: job.zipUrl || null,
  }
}

function state() {
  return { version: VERSION, jobs: [...jobs.values()].map(publicJob), busy: Boolean(running || queue.length) }
}

function parseCookies(req) {
  const out = {}
  for (const pair of String(req.headers.cookie || '').split(';')) {
    const i = pair.indexOf('=')
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim()
  }
  return out
}

function sessionCookieName() {
  const port = server?.address()?.port
  return port ? `mrx_session_${port}` : 'mrx_session'
}

function localHost(req) {
  const host = String(req.headers.host || '').toLowerCase()
  if (!host) return false
  const port = server?.address()?.port
  return host === `localhost:${port}` || host === `127.0.0.1:${port}` || host === `[::1]:${port}`
}

function sameOrigin(req) {
  const origin = req.headers.origin || req.headers.referer
  if (!origin) return true
  try {
    const u = new URL(origin)
    return (u.protocol === 'http:') && ['localhost', '127.0.0.1', '::1'].includes(u.hostname) && Number(u.port || 80) === server?.address()?.port
  } catch {
    return false
  }
}

function tokenMatches(value) {
  const given = Buffer.from(String(value || ''))
  const expected = Buffer.from(SESSION_TOKEN)
  return given.length === expected.length && crypto.timingSafeEqual(given, expected)
}

function authorizedMutation(req) {
  return authorizedSession(req) && sameOrigin(req) && req.headers['sec-fetch-site'] !== 'cross-site'
}

function authorizedSession(req) {
  return localHost(req) && tokenMatches(parseCookies(req)[sessionCookieName()])
}

function setSession(res) {
  res.setHeader('set-cookie', `${sessionCookieName()}=${SESSION_TOKEN}; HttpOnly; SameSite=Strict; Path=/`)
}

function parseBody(req, limit = 256_000) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function saveMultipart(req) {
  return new Promise((resolve, reject) => {
    const files = []
    const tempPaths = new Set()
    let failed = false
    let fileCount = 0
    let pending = 0
    let ended = false
    let settled = false
    const active = new Set()
    const cleanup = async () => {
      await Promise.all([...tempPaths].map(file => rm(file, { force: true }).catch(() => {})))
    }
    const stopActiveStreams = () => {
      for (const pair of active) {
        pair.stream.destroy()
        pair.out.destroy()
      }
    }
    const finish = async () => {
      if (!ended || pending || settled) return
      ended = true
      if (failed) {
        settled = true
        await cleanup()
        reject(new Error(failed))
      } else if (!files.length) {
        settled = true
        reject(new Error('Выберите хотя бы один аудио или видео файл'))
      } else {
        settled = true
        resolve(files)
      }
    }
    let bb
    const failUpload = message => {
      if (settled) return
      failed ||= message
      ended = true
      stopActiveStreams()
      try { bb?.destroy() } catch {}
      finish()
    }
    try {
      bb = Busboy({ defParamCharset: 'utf8', headers: req.headers, limits: { files: MAX_FILES, fileSize: MAX_FILE_BYTES, fields: 8 } })
    } catch (error) {
      reject(error)
      return
    }
    bb.on('file', (field, stream, info) => {
      if (failed) return stream.resume()
      if (field !== 'files') return stream.resume()
      fileCount += 1
      if (fileCount > MAX_FILES) {
        failed = `Допустимо не более ${MAX_FILES} файлов`
        stream.resume()
        return
      }
      const originalName = info.filename || `input-${fileCount}`
      const extension = path.extname(originalName).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 12)
      const stored = `${id()}${extension || '.bin'}`
      const destination = path.join(UPLOAD_DIR, stored)
      tempPaths.add(destination)
      pending += 1
      const out = createWriteStream(destination, { flags: 'wx' })
      const pair = { stream, out }
      active.add(pair)
      let tooLarge = false
      stream.on('limit', () => { tooLarge = true; failed = `Файл «${originalName}» превышает допустимый размер` })
      stream.on('error', error => { failed ||= error.message; active.delete(pair); out.destroy() })
      // A failed write unpipes the busboy stream; left unread it would stall
      // the whole request. The rest of the body is drained (no disk writes)
      // so the client receives the error instead of a connection reset.
      out.on('error', error => {
        failed ||= uploadWriteError(error, originalName)
        stream.unpipe(out)
        stream.resume()
      })
      out.on('close', () => {
        active.delete(pair)
        pending -= 1
        if (!tooLarge && !failed) files.push({ path: destination, originalName, field, mime: info.mimeType || '' })
        finish()
      })
      stream.pipe(out)
    })
    bb.on('filesLimit', () => { failed ||= `Допустимо не более ${MAX_FILES} файлов` })
    bb.on('error', error => { failed ||= error.message; failUpload(failed) })
    bb.on('finish', () => { ended = true; finish() })
    req.on('aborted', () => failUpload('Загрузка прервана'))
    req.on('error', error => failUpload(error.message || 'Ошибка загрузки'))
    req.pipe(bb)
  })
}

function spawnWorker(job) {
  const outputDir = path.join(OUTPUT_DIR, job.id)
  const workerArgs = [WORKER_PATH, '--input', job.inputPath, '--output-dir', outputDir, '--weights', WEIGHTS_DIR, '--ffmpeg', FFMPEG_PATH, '--base-name', job.baseName]
  const child = spawn(process.execPath, workerArgs, {
    cwd: ROOT_DIR,
    windowsHide: true,
    env: { ...process.env, AUDIO_NEURAL_CACHE: CACHE_DIR, MRX_OFFLINE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const runner = { child, outputDir, stderr: '' }
  child.stderr.on('data', data => { runner.stderr = (runner.stderr + String(data)).slice(-10_000) })
  child.stdout.on('data', () => {})
  child.on('message', message => {
    if (!message || typeof message !== 'object') return
    if (message.type === 'progress') {
      job.progress = message.progress
      job.status = message.status || job.status
      job.message = message.message || job.message
    } else if (message.type === 'done') {
      job.workerResult = message
    } else if (message.type === 'error') {
      job.workerError = message.message
    }
  })
  return runner
}

// The per-job ZIP is streamed on request instead of being stored next to the
// WAVs, which would roughly double the disk space every job takes.
async function streamJobZip(res, job) {
  const root = path.resolve(OUTPUT_DIR, job.id)
  const files = []
  for (const item of job.outputs || []) {
    const file = path.resolve(root, item.filename)
    if (!pathInside(root, file)) return json(res, 404, { error: 'Файл не найден' })
    try {
      if (!(await stat(file)).isFile()) throw new Error('not a file')
    } catch {
      return json(res, 404, { error: `Дорожка «${item.filename}» не найдена` })
    }
    files.push({ file, name: item.filename })
  }
  if (!files.length) return json(res, 404, { error: 'Файл не найден' })
  res.writeHead(200, {
    'content-type': 'application/zip',
    'cache-control': 'no-store',
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(job.zipName)}`,
  })
  const archive = new ZipArchive({ zlib: { level: 1 } })
  res.once('close', () => { if (!res.writableFinished) archive.abort() })
  archive.on('warning', error => res.destroy(error))
  pipeline(archive, res, () => {})
  for (const item of files) archive.file(item.file, { name: item.name })
  archive.finalize().catch(() => {})
}

async function removeInput(job) {
  // Inputs picked from disk in the desktop app are the user's own files.
  if (!job.ownedInput || !job.inputPath) return
  await rm(job.inputPath, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
}

async function processJob(job) {
  running = job
  job.status = 'decoding'
  job.progress = 1
  job.message = 'Подготовка входного файла…'
  let runner
  try {
    runner = spawnWorker(job)
    job.runner = runner
    const exit = await new Promise(resolve => {
      runner.child.once('exit', (code, signal) => resolve({ code, signal }))
      runner.child.once('error', error => resolve({ code: -1, signal: error.message }))
    })
    if (job.cancelRequested) {
      job.status = 'cancelled'
      job.progress = 0
      job.message = 'Отменено пользователем'
      await removeTree(runner.outputDir)
    } else if (exit.code !== 0 || !job.workerResult?.outputs) {
      const detail = job.workerError || runner.stderr?.trim().split(/\r?\n/).slice(-2).join(' ') || `worker exit ${exit.code ?? exit.signal}`
      throw new Error(detail)
    } else {
      job.outputs = job.workerResult.outputs.map(item => ({
        label: item.label,
        filename: item.filename,
        url: `/api/download/${encodeURIComponent(job.id)}/${encodeURIComponent(item.filename)}`,
        previewUrl: `/api/preview/${encodeURIComponent(job.id)}/${encodeURIComponent(item.filename)}`,
      }))
      job.zipName = `${job.baseName} — MRX stems.zip`
      job.zipUrl = `/api/download/${encodeURIComponent(job.id)}/${encodeURIComponent(job.zipName)}`
      job.status = 'done'
      job.progress = 100
      job.message = 'Готово'
    }
  } catch (error) {
    if (job.cancelRequested) {
      job.status = 'cancelled'
      job.progress = 0
      job.message = 'Отменено пользователем'
      if (runner) await removeTree(runner.outputDir)
    } else {
      job.status = 'error'
      job.progress = 0
      job.message = String(error?.message || error).slice(0, 500)
      if (runner) await removeTree(runner.outputDir)
    }
  } finally {
    await removeInput(job)
    delete job.runner
    delete job.workerResult
    delete job.workerError
    delete job.inputPath
    running = null
    pump()
  }
}

function pump() {
  if (running || stopping) return
  const next = queue.shift()
  if (!next) return
  if (next.status === 'cancelled') return pump()
  processJob(next).catch(() => {})
}

function cancelJob(job) {
  if (!job || ['done', 'error', 'cancelled'].includes(job.status)) return false
  job.cancelRequested = true
  if (job === running && job.runner?.child) {
    job.message = 'Остановка…'
    job.runner.child.send({ type: 'cancel' }, () => {})
    setTimeout(() => {
      if (job.runner?.child && !job.runner.child.killed) job.runner.child.kill()
    }, 2000).unref()
  } else {
    const index = queue.indexOf(job)
    if (index >= 0) queue.splice(index, 1)
    job.status = 'cancelled'
    job.progress = 0
    job.message = 'Отменено пользователем'
    removeInput(job).catch(() => {})
  }
  return true
}

function terminateWorkerTree(child) {
  if (!child || child.killed) return
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    killer.unref()
  } else child.kill('SIGTERM')
}

function pathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function exportFolderName(job, index, total) {
  const width = Math.max(3, String(total).length)
  const base = safeFileName(job.name || job.baseName, `input-${job.id.slice(0, 6)}`)
  return `${String(index + 1).padStart(width, '0')}-${base}`
}

function exportFileName(value, fallback) {
  const raw = path.basename(String(value || ''))
  const extension = path.extname(raw).toLowerCase()
  const stem = extension ? raw.slice(0, -extension.length) : raw
  return `${safeSegment(stem, fallback)}${extension || '.wav'}`
}

function exportSnapshot() {
  const allJobs = [...jobs.values()]
  const doneJobs = allJobs.filter(job => job.status === 'done')
  const key = crypto.createHash('sha256').update(JSON.stringify(allJobs.map(job => ({
    id: job.id,
    name: job.name,
    baseName: job.baseName,
    status: job.status,
    outputs: (job.outputs || []).map(item => item?.filename || ''),
  })))).digest('hex')
  return {
    key,
    jobs: doneJobs.map(job => ({
      id: job.id,
      name: job.name,
      baseName: job.baseName,
      outputs: (job.outputs || []).map(item => ({ filename: item?.filename || '' })),
    })),
    jobCount: doneJobs.length,
    skippedCount: allJobs.length - doneJobs.length,
  }
}

async function prepareExportEntries(snapshot) {
  const entries = []
  const seenNames = new Set()
  for (const [index, job] of snapshot.jobs.entries()) {
    const outputRoot = path.resolve(OUTPUT_DIR, job.id)
    if (!pathInside(OUTPUT_DIR, outputRoot)) throw new Error('Недопустимый путь результатов')
    let realRoot
    try {
      realRoot = await realpath(outputRoot)
    } catch {
      throw new Error(`Результаты файла «${job.name}» не найдены`)
    }
    const wavs = job.outputs.filter(item => /\.wav$/i.test(item.filename))
    if (!wavs.length) throw new Error(`У файла «${job.name}» нет WAV-дорожек`)
    const folder = exportFolderName(job, index, snapshot.jobs.length)
    for (const [trackIndex, item] of wavs.entries()) {
      const originalName = String(item.filename || '')
      if (!originalName || originalName !== path.basename(originalName)) throw new Error('Недопустимое имя дорожки')
      const candidate = path.resolve(outputRoot, originalName)
      if (!pathInside(outputRoot, candidate)) throw new Error('Недопустимый путь дорожки')
      let source
      let info
      try {
        source = await realpath(candidate)
        if (!pathInside(realRoot, source)) throw new Error('Недопустимый путь дорожки')
        info = await stat(source)
      } catch (error) {
        throw new Error(`Дорожка «${originalName}» файла «${job.name}» не найдена: ${error?.message || error}`)
      }
      if (!info.isFile() || info.size <= 0) throw new Error(`Дорожка «${originalName}» файла «${job.name}» недоступна`)
      const archiveName = `${folder}/${exportFileName(originalName, `track-${trackIndex + 1}`)}`
      const key = archiveName.toLocaleLowerCase()
      if (seenNames.has(key)) throw new Error('Повторяющееся имя дорожки в общем архиве')
      seenNames.add(key)
      entries.push({ source, archiveName })
    }
  }
  return entries
}

async function writeExportArchive(exportId, snapshot) {
  const entries = await prepareExportEntries(snapshot)
  await mkdir(EXPORT_DIR, { recursive: true })
  const temporaryPath = path.join(EXPORT_DIR, `${exportId}.part`)
  const finalPath = path.join(EXPORT_DIR, `${exportId}.zip`)
  await rm(temporaryPath, { force: true }).catch(() => {})
  try {
    await new Promise((resolve, reject) => {
      const output = createWriteStream(temporaryPath, { flags: 'wx' })
      const archive = new ZipArchive({ zlib: { level: 6 } })
      let settled = false
      let failure = null
      const fail = error => {
        if (settled || failure) return
        failure = error instanceof Error ? error : new Error(String(error))
        try { archive.abort() } catch {}
        // Wait for the write stream's close event before the caller removes the
        // temporary file. Windows can otherwise still hold the handle here,
        // leaving a stale `.part` file after an archive error.
        output.destroy()
      }
      output.on('close', () => {
        if (settled) return
        settled = true
        if (failure) reject(failure)
        else resolve()
      })
      output.on('error', fail)
      archive.on('error', fail)
      archive.on('warning', error => fail(new Error(`Предупреждение архива: ${error?.message || error}`)))
      archive.pipe(output)
      for (const entry of entries) archive.file(entry.source, { name: entry.archiveName })
      Promise.resolve(archive.finalize()).catch(fail)
    })
    const info = await stat(temporaryPath)
    if (!info.isFile() || info.size <= 0) throw new Error('Общий архив пуст')
    await rename(temporaryPath, finalPath)
    return finalPath
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {})
    await rm(finalPath, { force: true }).catch(() => {})
    throw error
  }
}

async function buildExport(snapshot) {
  const cached = exportCache.get(snapshot.key)
  if (cached) {
    try {
      const info = await stat(cached.filePath)
      if (info.isFile() && info.size > 0) return cached.result
    } catch {}
    exportCache.delete(snapshot.key)
  }
  if (activeExport) {
    if (activeExport.key === snapshot.key) return activeExport.promise
    const error = new Error('Другой общий архив уже собирается')
    error.code = 'EXPORT_BUSY'
    throw error
  }
  const exportId = id()
  const promise = (async () => {
    const filePath = await writeExportArchive(exportId, snapshot)
    const result = {
      url: `/api/download/all/${exportId}.zip`,
      filename: EXPORT_FILENAME,
      jobCount: snapshot.jobCount,
      skippedCount: snapshot.skippedCount,
    }
    // Only the newest archive stays; older ones are full copies of the WAVs.
    for (const [key, entry] of exportCache) {
      exportCache.delete(key)
      await rm(entry.filePath, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
    }
    exportCache.set(snapshot.key, { filePath, result })
    return result
  })()
  activeExport = { key: snapshot.key, promise }
  try {
    return await promise
  } finally {
    if (activeExport?.promise === promise) activeExport = null
  }
}

async function downloadExport(req, res, encodedName) {
  if (!authorizedSession(req)) return json(res, 403, { error: 'Недействительная локальная сессия' })
  let name
  try { name = decodeURIComponent(encodedName) } catch { return json(res, 400, { error: 'Неверное имя архива' }) }
  if (!/^[a-f0-9]{24}\.zip$/i.test(name)) return json(res, 404, { error: 'Архив не найден' })
  const exportId = name.slice(0, -4)
  const cached = [...exportCache.values()].find(item => item.result.url === `/api/download/all/${exportId}.zip`)
  if (!cached) return json(res, 404, { error: 'Архив не найден' })
  const file = path.resolve(cached.filePath)
  if (!pathInside(EXPORT_DIR, file)) return json(res, 404, { error: 'Архив не найден' })
  return serveFile(res, file, 'application/zip', EXPORT_FILENAME)
}

// The file is opened before any header is written, so a locked or vanished
// file becomes an ordinary error response. pipeline() closes the handle when
// the client aborts and keeps a read error from crashing the server.
async function serveFile(res, filePath, contentType, downloadName = null, extraHeaders = {}) {
  let handle
  let info
  try {
    handle = await open(filePath, 'r')
    info = await handle.stat()
    if (!info.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' })
  } catch (error) {
    await handle?.close().catch(() => {})
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error?.code)) return json(res, 404, { error: 'Файл не найден' })
    return json(res, 500, { error: `Не удалось прочитать файл (${error?.code || 'ошибка'}). Попробуйте ещё раз.` })
  }
  const headers = { 'content-type': contentType, 'content-length': info.size, 'cache-control': 'no-store', ...extraHeaders }
  if (downloadName) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`
  res.writeHead(200, headers)
  pipeline(handle.createReadStream(), res, () => {})
}

async function download(req, res, jobId, encodedName) {
  const job = jobs.get(jobId)
  if (!job || !['done'].includes(job.status)) return json(res, 404, { error: 'Результат ещё не готов' })
  let name
  try { name = decodeURIComponent(encodedName) } catch { return json(res, 400, { error: 'Неверное имя файла' }) }
  if (job.zipName && name === job.zipName) return streamJobZip(res, job)
  if (!(job.outputs || []).some(x => x.filename === name)) return json(res, 404, { error: 'Файл не найден' })
  const root = path.resolve(OUTPUT_DIR, job.id)
  const file = path.resolve(root, name)
  if (!pathInside(root, file)) return json(res, 400, { error: 'Недопустимый путь' })
  return serveFile(res, file, 'audio/wav', name)
}

function parseSingleRange(value, size) {
  if (typeof value !== 'string' || !value.startsWith('bytes=') || value.includes(',')) return null
  const spec = value.slice('bytes='.length).trim()
  const separator = spec.indexOf('-')
  if (!spec || separator < 0 || spec.indexOf('-', separator + 1) >= 0) return null
  const left = spec.slice(0, separator).trim()
  const right = spec.slice(separator + 1).trim()
  if (size <= 0) return null
  if (!left) {
    if (!/^\d+$/.test(right)) return null
    const suffix = Number(right)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  if (!/^\d+$/.test(left)) return null
  const start = Number(left)
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return null
  let end = size - 1
  if (right) {
    if (!/^\d+$/.test(right)) return null
    end = Number(right)
    if (!Number.isSafeInteger(end) || end < start) return null
    end = Math.min(end, size - 1)
  }
  return { start, end }
}

async function preview(req, res, jobId, encodedName) {
  const job = jobs.get(jobId)
  if (!job || job.status !== 'done') return json(res, 404, { error: 'Результат ещё не готов' })
  let name
  try { name = decodeURIComponent(encodedName) } catch { return json(res, 400, { error: 'Неверное имя файла' }) }
  // Preview is deliberately limited to the three worker-produced WAVs. This
  // keeps ZIPs, temporary files and arbitrary paths out of the media surface.
  if (!(job.outputs || []).some(item => item.filename === name)) return json(res, 404, { error: 'Файл не найден' })
  const root = path.resolve(OUTPUT_DIR, job.id)
  const file = path.resolve(root, name)
  if (!file.startsWith(root + path.sep) || file === root) return json(res, 404, { error: 'Файл не найден' })
  let info
  try {
    info = await stat(file)
    if (!info.isFile()) throw new Error('not a file')
  } catch {
    return json(res, 404, { error: 'Файл не найден' })
  }

  const range = req.headers.range
  const parsed = range === undefined ? null : parseSingleRange(range, info.size)
  if (range !== undefined && !parsed) {
    const headers = { 'accept-ranges': 'bytes', 'content-range': `bytes */${info.size}`, 'cache-control': 'no-store' }
    if (req.method === 'HEAD') {
      res.writeHead(416, headers)
      return res.end()
    }
    return json(res, 416, { error: 'Диапазон недоступен' }, headers)
  }

  const start = parsed ? parsed.start : 0
  const end = parsed ? parsed.end : Math.max(0, info.size - 1)
  const status = parsed ? 206 : 200
  const length = info.size === 0 ? 0 : end - start + 1
  const headers = {
    'content-type': 'audio/wav',
    'content-length': String(length),
    'accept-ranges': 'bytes',
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(name))}`,
    'cache-control': 'no-store',
  }
  if (parsed) headers['content-range'] = `bytes ${start}-${end}/${info.size}`
  res.writeHead(status, headers)
  if (req.method === 'HEAD' || info.size === 0) return res.end()

  const stream = createReadStream(file, { start, end })
  const closeStream = () => { if (!stream.destroyed) stream.destroy() }
  const cleanup = () => {
    req.off('aborted', closeStream)
    res.off('close', closeStream)
  }
  const onError = () => {
    cleanup()
    // Headers are already sent, so destroying the response is the only safe
    // way to stop a partial stream without buffering or sending a second body.
    if (!res.destroyed && !res.writableEnded) res.destroy()
  }
  req.once('aborted', closeStream)
  res.once('close', closeStream)
  stream.once('close', cleanup)
  stream.once('error', onError)
  stream.pipe(res)
}

function addJob(name, inputPath, ownedInput) {
  const jobId = id()
  const job = { id: jobId, name, baseName: safeFileName(name, `input-${jobId.slice(0, 6)}`), inputPath, ownedInput, status: 'queued', progress: 0, message: 'В очереди', outputs: [], zipUrl: null }
  jobs.set(jobId, job)
  queue.push(job)
}

// Desktop drops are processed in place: copying multi-gigabyte videos through
// HTTP would double their disk use. These inputs are never deleted.
async function resolveLocalInputs(value) {
  if (!Array.isArray(value) || !value.length) throw new Error('Выберите хотя бы один аудио или видео файл')
  if (value.length > MAX_FILES) throw new Error(`Допустимо не более ${MAX_FILES} файлов`)
  const inputs = []
  for (const raw of value) {
    if (typeof raw !== 'string' || !raw || raw.includes('\0') || !path.isAbsolute(raw)) throw new Error('Недопустимый путь к файлу')
    const resolved = path.resolve(raw)
    let info
    try {
      info = await stat(resolved)
    } catch {
      throw new Error(`Файл «${path.basename(resolved)}» не найден`)
    }
    if (!info.isFile()) throw new Error(`«${path.basename(resolved)}» не является файлом`)
    inputs.push({ name: path.basename(resolved), path: resolved })
  }
  return inputs
}

async function handle(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  if (!localHost(req)) return json(res, 403, { error: 'Доступ только через localhost' })
  if (url.pathname.startsWith('/api/') && !authorizedSession(req)) {
    req.resume()
    return json(res, 403, { error: 'Недействительная локальная сессия' })
  }
  if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, state())
  if (url.pathname.startsWith('/api/preview/')) {
    const parts = url.pathname.split('/').filter(Boolean)
    if (!['GET', 'HEAD'].includes(req.method) || parts.length !== 4) return json(res, 404, { error: 'Не найдено' })
    let jobId
    try { jobId = decodeURIComponent(parts[2]) } catch { return json(res, 400, { error: 'Неверный идентификатор задачи' }) }
    return preview(req, res, jobId, parts[3])
  }
  if (url.pathname.startsWith('/api/download/')) {
    const parts = url.pathname.split('/').filter(Boolean)
    if (req.method !== 'GET' || parts.length !== 4) return json(res, 404, { error: 'Не найдено' })
    if (parts[2] === 'all') return downloadExport(req, res, parts[3])
    const jobId = decodePathSegment(parts[2])
    if (jobId === null) return json(res, 400, { error: 'Неверный идентификатор задачи' })
    return download(req, res, jobId, parts[3])
  }
  if (req.method === 'POST' && !authorizedMutation(req)) return json(res, 403, { error: 'Недействительная локальная сессия' })
  if (req.method === 'POST' && url.pathname === '/api/exports') {
    req.resume()
    if (running || queue.length || [...jobs.values()].some(job => ['queued', 'decoding', 'separating', 'encoding'].includes(job.status))) {
      return json(res, 409, { error: 'Дождитесь завершения обработки файлов перед экспортом' })
    }
    const snapshot = exportSnapshot()
    if (!snapshot.jobCount) return json(res, 409, { error: 'Нет готовых результатов для общего архива' })
    try {
      return json(res, 200, await buildExport(snapshot))
    } catch (error) {
      if (error?.code === 'EXPORT_BUSY') return json(res, 409, { error: error.message })
      return json(res, 500, { error: `Не удалось собрать общий архив: ${String(error?.message || error).slice(0, 500)}` })
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/jobs') {
    if (running && queue.length >= MAX_FILES) return json(res, 429, { error: 'Очередь заполнена' })
    try {
      const files = await saveMultipart(req)
      for (const file of files) addJob(file.originalName, file.path, true)
      pump()
      return json(res, 200, state())
    } catch (error) {
      return json(res, 400, { error: String(error?.message || error).slice(0, 500) })
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/jobs/local') {
    if (!DESKTOP_MODE) {
      req.resume()
      return json(res, 404, { error: 'Не найдено' })
    }
    if (running && queue.length >= MAX_FILES) {
      req.resume()
      return json(res, 429, { error: 'Очередь заполнена' })
    }
    try {
      let body
      try { body = JSON.parse(await parseBody(req)) } catch { throw new Error('Неверный запрос') }
      for (const input of await resolveLocalInputs(body?.paths)) addJob(input.name, input.path, false)
      pump()
      return json(res, 200, state())
    } catch (error) {
      return json(res, 400, { error: String(error?.message || error).slice(0, 500) })
    }
  }
  const removeMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/remove$/)
  if (req.method === 'POST' && removeMatch) {
    req.resume()
    const jobId = decodePathSegment(removeMatch[1])
    if (jobId === null) return json(res, 400, { error: 'Неверный идентификатор задачи' })
    const job = jobs.get(jobId)
    if (!job) return json(res, 404, { error: 'Задача не найдена' })
    if (!['done', 'error', 'cancelled'].includes(job.status)) return json(res, 409, { error: 'Сначала дождитесь окончания обработки или отмените её' })
    // Only this job's own results folder is removed; the user's source file
    // is never touched.
    const outputDir = path.resolve(OUTPUT_DIR, job.id)
    if (!/^[a-f0-9]{24}$/.test(job.id) || !pathInside(OUTPUT_DIR, outputDir)) return json(res, 400, { error: 'Недопустимый путь результатов' })
    await removeTree(outputDir)
    if (existsSync(outputDir)) return json(res, 500, { error: 'Не удалось удалить папку результатов: файлы заняты другой программой' })
    jobs.delete(job.id)
    return json(res, 200, state())
  }
  const match = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/)
  if (req.method === 'POST' && match) {
    const jobId = decodePathSegment(match[1])
    if (jobId === null) return json(res, 400, { error: 'Неверный идентификатор задачи' })
    const job = jobs.get(jobId)
    if (!job) return json(res, 404, { error: 'Задача не найдена' })
    cancelJob(job)
    return json(res, 200, publicJob(job))
  }
  if (req.method === 'POST' && url.pathname === '/api/shutdown') {
    const force = url.searchParams.get('force') === '1'
    if ((running || queue.length) && !force) return json(res, 409, { error: 'Дождитесь завершения или отмените задачи' })
    json(res, 200, { ok: true, stopping: true })
    setTimeout(() => shutdown(force), 30).unref()
    return
  }
  if (req.method !== 'GET' || !url.pathname.startsWith('/') || url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Не найдено' })
  if (url.pathname.startsWith('/signin/')) {
    // Sign-in link: trade the token for the HttpOnly cookie and drop it from
    // the address bar. A wrong token simply gets no session.
    if (tokenMatches(decodePathSegment(url.pathname.slice('/signin/'.length)))) setSession(res)
    // Always back to the app root: echoing the path would let "//host" act
    // as an open redirect.
    res.writeHead(303, { location: '/', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
    return res.end()
  }
  const decodedPath = decodePathSegment(url.pathname.slice(1) || 'index.html')
  if (decodedPath === null) return json(res, 400, { error: 'Неверный путь' })
  let relative = decodedPath
  if (relative.includes('..') || relative.includes('\0')) relative = 'index.html'
  const file = path.resolve(PUBLIC_DIR, relative)
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) return json(res, 404, { error: 'Не найдено' })
  if (!existsSync(file)) return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8', null, PAGE_HEADERS)
  const ext = path.extname(file).toLowerCase()
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }[ext] || 'application/octet-stream'
  return serveFile(res, file, mime, null, PAGE_HEADERS)
}

async function shutdown(force = false) {
  if (stopping) return
  if (!force && (running || queue.length)) return
  stopping = true
  for (const job of queue.splice(0)) {
    job.cancelRequested = true
    job.status = 'cancelled'
    job.progress = 0
    job.message = 'Сервер завершает работу'
    await removeInput(job)
  }
  setTimeout(() => process.exit(0), 8000).unref()
  if (running?.runner?.child) {
    const job = running
    const { child, outputDir } = job.runner
    job.cancelRequested = true
    job.status = 'cancelled'
    job.message = 'Сервер завершает работу'
    const exited = new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) resolve()
      else child.once('exit', resolve)
    })
    child.send({ type: 'cancel' }, () => {})
    // Partial WAVs are removed only after the worker and FFmpeg have exited;
    // removing them earlier fails on Windows while the files are still open.
    if (!await Promise.race([exited.then(() => true), delay(500).then(() => false)])) {
      terminateWorkerTree(child)
      await Promise.race([exited, delay(2000)])
    }
    await removeTree(outputDir)
  }
  await removeTree(EXPORT_DIR)
  await writeFile(path.join(DATA_DIR, 'server.json'), '', { flag: 'w' }).catch(() => {})
  server?.close(() => process.exit(0))
  server?.closeAllConnections()
  setTimeout(() => process.exit(0), 500).unref()
}

// Leftovers of a crashed or killed session: inputs of unfinished uploads and
// cached "save all" archives. Finished results in OUTPUT_DIR are kept.
async function sweepStaleFiles() {
  await removeTree(UPLOAD_DIR)
  await removeTree(EXPORT_DIR)
}

async function start() {
  await sweepStaleFiles()
  await Promise.all([mkdir(UPLOAD_DIR, { recursive: true }), mkdir(OUTPUT_DIR, { recursive: true }), mkdir(CACHE_DIR, { recursive: true })])
  // requestTimeout is disabled: one upload request can carry several large
  // videos and legitimately take longer than Node's default five minutes.
  server = http.createServer({ requestTimeout: 0 }, (req, res) => {
    handle(req, res).catch(error => {
      if (res.headersSent) res.destroy()
      else json(res, 500, { error: String(error?.message || error).slice(0, 500) })
    })
  })
  let port = START_PORT
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await new Promise((resolve, reject) => {
        const onError = error => { server.off('listening', onListen); reject(error) }
        const onListen = () => { server.off('error', onError); resolve() }
        server.once('error', onError)
        server.once('listening', onListen)
        server.listen(port, '127.0.0.1')
      })
      break
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || attempt === 19) throw error
      port += 1
    }
  }
  const address = server.address()
  await writeFile(path.join(DATA_DIR, 'server.json'), JSON.stringify({ pid: process.pid, port: address.port, version: VERSION }, null, 2))
  process.stdout.write(`MRX_READY http://127.0.0.1:${address.port}/\n`)
  if (ENV_SESSION_TOKEN) return
  // The token is printed only when this process made it; in the desktop app
  // stdout goes to a log file and the token stays with Electron.
  const signInUrl = `http://127.0.0.1:${address.port}/signin/${SESSION_TOKEN}`
  process.stdout.write(`MRX_OPEN ${signInUrl}\n`)
  if (process.env.MRX_NO_BROWSER !== '1' && process.platform === 'win32') {
    const child = spawn('cmd.exe', ['/d', '/c', 'start', '', signInUrl], { windowsHide: true, detached: true, stdio: 'ignore' })
    child.unref()
  }
}

process.on('SIGINT', () => { shutdown(true) })
process.on('SIGTERM', () => { shutdown(true) })
start().catch(error => { console.error(error); process.exitCode = 1 })
