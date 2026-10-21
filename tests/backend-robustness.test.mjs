import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const AdmZip = require('adm-zip')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA = path.join(ROOT, 'tests', 'robustness-runtime')
const FIXTURES = path.join(ROOT, 'tests', 'robustness-fixtures')
const FFMPEG = process.env.MRX_FFMPEG || path.join(ROOT, 'tools', 'ffmpeg-staging', 'ffmpeg-master-latest-win64-lgpl', 'bin', 'ffmpeg.exe')
const PORT = Number(process.env.MRX_ROBUSTNESS_PORT || 17986)
const SESSION_TOKEN = 'mrx-robustness-session-token-0123456789'
let server
let base
let cookie

function makeWav(seconds = 1, frequency = 440) {
  const rate = 44100
  const frames = Math.round(rate * seconds)
  const dataSize = frames * 4
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(2, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 4, 28)
  header.writeUInt16LE(4, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)
  const pcm = Buffer.alloc(dataSize)
  for (let frame = 0; frame < frames; frame += 1) {
    const value = Math.round(Math.sin(2 * Math.PI * frequency * frame / rate) * 9000)
    pcm.writeInt16LE(value, frame * 4)
    pcm.writeInt16LE(value, frame * 4 + 2)
  }
  return Buffer.concat([header, pcm])
}

function startServer(env) {
  const child = spawn(process.execPath, ['app/server.mjs'], {
    cwd: ROOT,
    windowsHide: true,
    env: { ...process.env, MRX_NO_BROWSER: '1', MRX_FFMPEG: FFMPEG, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const ready = new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 15_000)
    child.stdout.on('data', chunk => {
      output += String(chunk)
      const match = output.match(/MRX_READY (http:\/\/127\.0\.0\.1:\d+)\//)
      if (match && (env.MRX_SESSION_TOKEN || /MRX_OPEN \S+\n/.test(output))) {
        clearTimeout(timer)
        resolve({ base: match[1], output })
      }
    })
    child.stderr.on('data', chunk => { output += String(chunk) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited before ready (${code}): ${output}`)) })
  })
  return { child, ready }
}

async function stopServer(child, origin, sessionCookie) {
  if (!child || child.exitCode !== null) return
  try {
    await fetch(`${origin}/api/shutdown?force=1`, { method: 'POST', headers: { cookie: sessionCookie, origin: `${origin}/` } })
  } catch {}
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill(); resolve() }, 10_000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
}

async function request(pathname, init = {}) {
  const headers = new Headers(init.headers || {})
  headers.set('cookie', cookie)
  if (init.method && init.method !== 'GET' && !headers.has('origin')) headers.set('origin', `${base}/`)
  return fetch(`${base}${pathname}`, { ...init, headers, redirect: 'manual' })
}

async function getState() {
  const response = await request('/api/state')
  assert.equal(response.status, 200)
  return response.json()
}

async function waitForJob(jobId, statuses = ['done', 'error', 'cancelled'], timeout = 120_000) {
  const started = Date.now()
  for (;;) {
    const state = await getState()
    const job = state.jobs.find(item => item.id === jobId)
    if (job && statuses.includes(job.status)) return job
    if (Date.now() - started > timeout) throw new Error(`job timeout: ${JSON.stringify(job)}`)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

async function upload(name, bytes) {
  const form = new FormData()
  form.append('files', new Blob([bytes], { type: 'audio/wav' }), name)
  const response = await request('/api/jobs', { method: 'POST', body: form })
  assert.equal(response.status, 200, await response.clone().text())
  return (await response.json()).jobs.at(-1)
}

async function submitLocal(paths) {
  return request('/api/jobs/local', { method: 'POST', body: JSON.stringify({ paths }), headers: { 'content-type': 'application/json' } })
}

before(async () => {
  await rm(DATA, { recursive: true, force: true })
  await rm(FIXTURES, { recursive: true, force: true })
  await mkdir(FIXTURES, { recursive: true })
  await writeFile(path.join(FIXTURES, 'tone.wav'), makeWav(1, 440))
  await writeFile(path.join(FIXTURES, 'local source.wav'), makeWav(1, 330))
  await writeFile(path.join(FIXTURES, 'long source.wav'), makeWav(40, 220))
  // Leftovers of a "crashed" session that the next start must clean up.
  await mkdir(path.join(DATA, 'uploads'), { recursive: true })
  await writeFile(path.join(DATA, 'uploads', 'stale-input.wav'), 'stale')
  await mkdir(path.join(DATA, 'cache', 'exports'), { recursive: true })
  await writeFile(path.join(DATA, 'cache', 'exports', 'stale.zip'), 'stale')
  await mkdir(path.join(DATA, 'outputs', 'kept-result'), { recursive: true })
  await writeFile(path.join(DATA, 'outputs', 'kept-result', 'kept.wav'), 'kept')
  const started = startServer({ MRX_SESSION_TOKEN: SESSION_TOKEN, MRX_DESKTOP: '1', MRX_PORT: String(PORT), MRX_DATA_DIR: DATA })
  server = started.child
  const ready = await started.ready
  base = ready.base
  cookie = `mrx_session_${new URL(base).port}=${SESSION_TOKEN}`
  assert.doesNotMatch(ready.output, new RegExp(SESSION_TOKEN), 'an injected session token must not be printed')
})

after(async () => {
  await stopServer(server, base, cookie)
  await rm(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  await rm(FIXTURES, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

test('startup removes stale uploads and export archives but keeps results', async () => {
  assert.deepEqual(await readdir(path.join(DATA, 'uploads')), [])
  assert.equal(existsSync(path.join(DATA, 'cache', 'exports', 'stale.zip')), false)
  assert.equal(await readFile(path.join(DATA, 'outputs', 'kept-result', 'kept.wav'), 'utf8'), 'kept')
})

test('API requires the session cookie; the sign-in link issues it', async () => {
  const anonymous = await fetch(`${base}/api/state`)
  assert.equal(anonymous.status, 403)
  const wrong = await fetch(`${base}/signin/wrong-token`, { redirect: 'manual' })
  assert.equal(wrong.status, 303)
  assert.equal(wrong.headers.get('set-cookie'), null)
  const signIn = await fetch(`${base}/signin/${SESSION_TOKEN}`, { redirect: 'manual' })
  assert.equal(signIn.status, 303)
  assert.equal(signIn.headers.get('location'), '/')
  const issued = (signIn.headers.get('set-cookie') || '').split(';')[0]
  assert.equal(issued, cookie)
  assert.match(signIn.headers.get('set-cookie'), /HttpOnly/i)
  assert.match(signIn.headers.get('set-cookie'), /SameSite=Strict/i)
  const page = await fetch(`${base}/`)
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('set-cookie'), null)
  assert.match(page.headers.get('content-security-policy') || '', /default-src 'self'/)
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff')
})

test('a server without an injected token prints a working sign-in link and has no local-path API', async () => {
  const started = startServer({ MRX_PORT: String(PORT + 10), MRX_DATA_DIR: path.join(DATA, 'browser-mode') })
  const ready = await started.ready
  let browserCookie = ''
  try {
    const link = ready.output.match(/MRX_OPEN (\S+)/)[1]
    assert.match(link, /\/signin\/[A-Za-z0-9_-]{32,}$/)
    const signIn = await fetch(link, { redirect: 'manual' })
    browserCookie = (signIn.headers.get('set-cookie') || '').split(';')[0]
    assert.ok(browserCookie)
    const state = await fetch(`${ready.base}/api/state`, { headers: { cookie: browserCookie } })
    assert.equal(state.status, 200)
    const local = await fetch(`${ready.base}/api/jobs/local`, {
      method: 'POST',
      headers: { cookie: browserCookie, origin: `${ready.base}/`, 'content-type': 'application/json' },
      body: JSON.stringify({ paths: [path.join(FIXTURES, 'local source.wav')] }),
    })
    assert.equal(local.status, 404)
  } finally {
    await stopServer(started.child, ready.base, browserCookie)
  }
})

test('a failed upload write answers promptly instead of stalling the request', async () => {
  const uploads = path.join(DATA, 'uploads')
  await rm(uploads, { recursive: true, force: true })
  await writeFile(uploads, 'not a directory')
  try {
    const form = new FormData()
    form.append('files', new Blob([Buffer.alloc(8 * 1024 * 1024, 1)], { type: 'audio/wav' }), 'большой файл.wav')
    const started = Date.now()
    const response = await request('/api/jobs', { method: 'POST', body: form, signal: AbortSignal.timeout(10_000) })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /большой файл\.wav/)
    assert.ok(Date.now() - started < 5_000, `upload error took ${Date.now() - started} ms`)
    assert.equal(server.exitCode, null)
  } finally {
    await rm(uploads, { force: true })
    await mkdir(uploads, { recursive: true })
  }
  assert.equal((await request('/api/state')).status, 200)
})

test('results keep only WAVs on disk, stream the ZIP and survive an unreadable file', async () => {
  const queued = await upload('tone.wav', await readFile(path.join(FIXTURES, 'tone.wav')))
  const job = await waitForJob(queued.id)
  assert.equal(job.status, 'done', job.message)
  const outputDir = path.join(DATA, 'outputs', job.id)
  assert.deepEqual((await readdir(outputDir)).sort(), job.outputs.map(item => item.filename).sort())

  const zip = await request(job.zipUrl)
  assert.equal(zip.status, 200)
  assert.equal(zip.headers.get('content-type'), 'application/zip')
  const entries = new AdmZip(Buffer.from(await zip.arrayBuffer())).getEntries().map(entry => entry.entryName).sort()
  assert.deepEqual(entries, job.outputs.map(item => item.filename).sort())

  if (process.platform !== 'win32') return
  const locked = path.join(outputDir, job.outputs[0].filename)
  const user = process.env.USERNAME
  execFileSync('icacls', [locked, '/deny', `${user}:(RD)`], { stdio: 'ignore' })
  try {
    const response = await request(job.outputs[0].url)
    assert.equal(response.status, 500)
    assert.match((await response.json()).error, /Не удалось прочитать файл/)
    assert.equal(server.exitCode, null)
    assert.equal((await request('/api/state')).status, 200)
  } finally {
    execFileSync('icacls', [locked, '/remove:d', user], { stdio: 'ignore' })
  }
  assert.equal((await request(job.outputs[0].url)).status, 200)
})

test('only the newest "save all" archive is kept on disk', async () => {
  const first = await request('/api/exports', { method: 'POST' })
  assert.equal(first.status, 200)
  const firstBody = await first.json()
  const queued = await upload('second.wav', makeWav(1, 550))
  assert.equal((await waitForJob(queued.id)).status, 'done')
  const second = await request('/api/exports', { method: 'POST' })
  assert.equal(second.status, 200)
  const secondBody = await second.json()
  assert.notEqual(secondBody.url, firstBody.url)
  const cached = await readdir(path.join(DATA, 'cache', 'exports'))
  assert.deepEqual(cached, [secondBody.url.split('/').pop()])
  assert.equal((await request(firstBody.url)).status, 404)
  assert.equal((await request(secondBody.url)).status, 200)
})

test('desktop local-path jobs never delete the original file', async () => {
  const source = path.join(FIXTURES, 'local source.wav')
  const original = await readFile(source)
  const accepted = await submitLocal([source])
  assert.equal(accepted.status, 200, await accepted.clone().text())
  const job = (await accepted.json()).jobs.at(-1)
  assert.equal(job.name, 'local source.wav')
  assert.equal((await waitForJob(job.id)).status, 'done')
  assert.deepEqual(await readFile(source), original)

  const longSource = path.join(FIXTURES, 'long source.wav')
  const running = (await (await submitLocal([longSource])).json()).jobs.at(-1)
  const queued = (await (await submitLocal([source])).json()).jobs.at(-1)
  await waitForJob(running.id, ['decoding', 'separating'], 30_000)
  assert.equal((await request(`/api/jobs/${queued.id}/cancel`, { method: 'POST' })).status, 200)
  assert.equal((await request(`/api/jobs/${running.id}/cancel`, { method: 'POST' })).status, 200)
  assert.equal((await waitForJob(running.id, ['cancelled'], 30_000)).status, 'cancelled')
  assert.equal((await waitForJob(queued.id, ['cancelled'], 5_000)).status, 'cancelled')
  assert.ok(existsSync(longSource), 'cancelled running job removed its source')
  assert.deepEqual(await readFile(source), original)

  const relative = await submitLocal(['relative.wav'])
  assert.equal(relative.status, 400)
  const missing = await submitLocal([path.join(FIXTURES, 'missing.wav')])
  assert.equal(missing.status, 400)
  assert.match((await missing.json()).error, /missing\.wav/)
  const directory = await submitLocal([FIXTURES])
  assert.equal(directory.status, 400)
})

test('worker rejects an over-long file before decoding it', async () => {
  const outputDir = path.join(DATA, 'worker-limit')
  const child = spawn(process.execPath, [
    path.join(ROOT, 'app', 'separate-worker.mjs'),
    '--input', path.join(FIXTURES, 'long source.wav'),
    '--output-dir', outputDir,
    '--weights', path.join(ROOT, 'weights'),
    '--ffmpeg', FFMPEG,
    '--base-name', 'limit',
  ], {
    cwd: ROOT,
    windowsHide: true,
    // 2 seconds of 44.1 kHz stereo float PCM.
    env: { ...process.env, MRX_MAX_DECODE_BYTES: String(44_100 * 8 * 2) },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  const messages = []
  const decodingStarted = []
  child.on('message', message => {
    messages.push(message)
    if (message?.message === 'Декодирование аудио…') decodingStarted.push(message)
  })
  const code = await new Promise(resolve => child.once('exit', resolve))
  const error = messages.find(message => message?.type === 'error')
  assert.equal(code, 1)
  assert.match(error?.message || '', /слишком длинный.*не больше 2 с/)
  assert.equal(decodingStarted.length, 0, 'the file was decoded before the length check')
})

test('force shutdown leaves desktop source files in place', async () => {
  const longSource = path.join(FIXTURES, 'long source.wav')
  const job = (await (await submitLocal([longSource])).json()).jobs.at(-1)
  await waitForJob(job.id, ['decoding', 'separating'], 30_000)
  await stopServer(server, base, cookie)
  assert.notEqual(server.exitCode, null)
  assert.ok(existsSync(longSource))
  assert.equal(existsSync(path.join(DATA, 'outputs', job.id)), false)
})
