import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA = path.join(ROOT, 'tests', 'regression-runtime')
const INPUT = path.join(ROOT, 'tests', 'regression-input.wav')
const STAGED_FFMPEG = path.join(ROOT, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe')
const PORT = Number(process.env.MRX_REGRESSION_PORT || 17982)
let server
let base
let cookie
const SESSION_TOKEN = 'mrx-test-session-token-0123456789abcdef'

function makeWav(seconds = 1) {
  const rate = 44100
  const frames = rate * seconds
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
    const value = Math.round(Math.sin(frame * 2 * Math.PI * 440 / rate) * 12000)
    pcm.writeInt16LE(value, frame * 4)
    pcm.writeInt16LE(value, frame * 4 + 2)
  }
  return Buffer.concat([header, pcm])
}

function waitReady(child) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('server did not start')), 15_000)
    child.stdout.on('data', chunk => {
      output += String(chunk)
      const match = output.match(/MRX_READY (http:\/\/127\.0\.0\.1:\d+\/)/)
      if (match) {
        clearTimeout(timer)
        resolve(match[1].replace(/\/$/, ''))
      }
    })
    child.once('error', reject)
    child.once('exit', code => { if (!base) reject(new Error(`server exited before ready (${code})`)) })
  })
}

async function request(pathname, init = {}) {
  const headers = new Headers(init.headers || {})
  if (cookie) headers.set('cookie', cookie)
  if (init.method && init.method !== 'GET' && !headers.has('origin')) headers.set('origin', `${base}/`)
  const response = await fetch(`${base}${pathname}`, { ...init, headers })
  return response
}

before(async () => {
  await rm(DATA, { recursive: true, force: true })
  await writeFile(INPUT, makeWav())
  await mkdir(DATA, { recursive: true })
  server = spawn(process.execPath, ['app/server.mjs'], {
    cwd: ROOT,
    windowsHide: true,
    env: { ...process.env, MRX_NO_BROWSER: '1', MRX_SESSION_TOKEN: SESSION_TOKEN, MRX_PORT: String(PORT), MRX_DATA_DIR: DATA, MRX_FFMPEG: STAGED_FFMPEG },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  base = await waitReady(server)
  cookie = `mrx_session_${new URL(base).port}=${SESSION_TOKEN}`
  assert.equal((await request('/api/state')).status, 200)
})

after(async () => {
  if (server && !server.killed) {
    try { await request('/api/shutdown?force=1', { method: 'POST' }) } catch {}
    await new Promise(resolve => {
      const timer = setTimeout(() => { server.kill(); resolve() }, 5_000)
      server.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
  await rm(DATA, { recursive: true, force: true })
  await rm(INPUT, { force: true })
})

test('malformed download and cancel identifiers are client errors', async () => {
  const download = await request('/api/download/%ZZ/file.wav')
  assert.equal(download.status, 400)
  const cancel = await request('/api/jobs/%ZZ/cancel', { method: 'POST' })
  assert.equal(cancel.status, 400)
})

test('malformed multipart body returns promptly and leaves no upload', async () => {
  const port = Number(new URL(base).port)
  const body = '--mrx-bad\r\nContent-Disposition: form-data; name="files"; filename="broken.wav"\r\n\r\npartial'
  const result = await new Promise((resolve, reject) => {
    const raw = http.request({ hostname: '127.0.0.1', port, path: '/api/jobs', method: 'POST', headers: {
      host: `127.0.0.1:${port}`,
      cookie,
      origin: base,
      'content-type': 'multipart/form-data; boundary=mrx-bad',
      'content-length': Buffer.byteLength(body),
    } }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode, body }))
    })
    raw.setTimeout(3_000, () => { raw.destroy(new Error('multipart request timed out')) })
    raw.on('error', reject)
    raw.end(body)
  })
  assert.equal(result.status, 400)
  const state = await request('/api/state')
  assert.equal(state.status, 200)
  assert.deepEqual(await readdir(path.join(DATA, 'uploads')), [])
})

test('valid long emoji filename remains processable', async () => {
  const form = new FormData()
  const originalName = `a${'😀'.repeat(60)}mix.wav`
  form.append('files', new Blob([await readFile(INPUT)], { type: 'audio/wav' }), originalName)
  const uploaded = await request('/api/jobs', { method: 'POST', body: form })
  const uploadedBody = await uploaded.text()
  assert.equal(uploaded.status, 200, uploadedBody)
  const queued = JSON.parse(uploadedBody)
  const jobId = queued.jobs.at(-1).id
  const started = Date.now()
  let state
  for (;;) {
    state = await (await request('/api/state')).json()
    const job = state.jobs.find(item => item.id === jobId)
    if (job && ['done', 'error'].includes(job.status)) break
    if (Date.now() - started > 60_000) throw new Error(`emoji filename timeout: ${JSON.stringify(state)}`)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  const job = state.jobs.find(item => item.id === jobId)
  assert.equal(job.status, 'done', job.message)
  assert.equal(job.outputs.length, 3)
  assert.ok(job.zipUrl)
})
