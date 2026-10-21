import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const AdmZip = require('adm-zip')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA = path.join(ROOT, 'tests', 'backend-export-runtime')
const FIXTURES = path.join(ROOT, 'tests', 'backend-export-fixtures')
const FFMPEG = process.env.MRX_FFMPEG || path.join(ROOT, 'tools', 'ffmpeg-staging', 'ffmpeg-master-latest-win64-lgpl', 'bin', 'ffmpeg.exe')
const NO_AUDIO_SOURCE = path.join(ROOT, 'tests', 'e2e', 'fixtures', 'no-audio.mp4')
const PORT = Number(process.env.MRX_EXPORT_TEST_PORT || 17984)
let server
let base
let cookie
const SESSION_TOKEN = 'mrx-test-session-token-0123456789abcdef'

function makeWav(seconds = 3, frequency = 440) {
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
    const value = Math.round(Math.sin(frame * 2 * Math.PI * frequency / rate) * 12000)
    pcm.writeInt16LE(value, frame * 4)
    pcm.writeInt16LE(value, frame * 4 + 2)
  }
  return Buffer.concat([header, pcm])
}

async function makeFixtures() {
  await mkdir(FIXTURES, { recursive: true })
  await writeFile(path.join(FIXTURES, 'same-a-source.wav'), makeWav(3, 440))
  await writeFile(path.join(FIXTURES, 'same-b-source.wav'), makeWav(3, 660))
  await copyFile(NO_AUDIO_SOURCE, path.join(FIXTURES, 'failed.mp4'))
}

function waitReady(child) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('export server did not start')), 15_000)
    child.stdout.on('data', chunk => {
      output += String(chunk)
      const match = output.match(/MRX_READY (http:\/\/127\.0\.0\.1:\d+\/)/)
      if (match) {
        clearTimeout(timer)
        resolve(match[1].replace(/\/$/, ''))
      }
    })
    child.stderr.on('data', chunk => { output += String(chunk) })
    child.once('error', reject)
    child.once('exit', code => { if (!base) reject(new Error(`export server exited before ready (${code})`)) })
  })
}

async function request(pathname, init = {}) {
  const headers = new Headers(init.headers || {})
  if (cookie) headers.set('cookie', cookie)
  if (init.method && init.method !== 'GET' && !headers.has('origin')) headers.set('origin', `${base}/`)
  const response = await fetch(`${base}${pathname}`, { ...init, headers })
  return response
}

async function requestWithoutSession(pathname, init = {}) {
  const headers = new Headers(init.headers || {})
  if (init.method && init.method !== 'GET' && !headers.has('origin')) headers.set('origin', `${base}/`)
  return fetch(`${base}${pathname}`, { ...init, headers })
}

async function getState() {
  const response = await request('/api/state')
  assert.equal(response.status, 200)
  return response.json()
}

async function waitFor(predicate, timeout = 120_000) {
  const started = Date.now()
  for (;;) {
    const value = await getState()
    if (predicate(value)) return value
    if (Date.now() - started > timeout) throw new Error(`state timeout: ${JSON.stringify(value)}`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

async function upload(...files) {
  const form = new FormData()
  for (const file of files) {
    const bytes = await readFile(file.path)
    form.append('files', new Blob([bytes], { type: file.type || 'application/octet-stream' }), file.name || path.basename(file.path))
  }
  const response = await request('/api/jobs', { method: 'POST', body: form })
  assert.equal(response.status, 200)
  return response.json()
}

function sha(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

async function outputHashes(state) {
  const result = new Map()
  for (const job of state.jobs.filter(item => item.status === 'done')) {
    for (const output of job.outputs) {
      const file = path.join(DATA, 'outputs', job.id, output.filename)
      result.set(`${job.id}/${output.filename}`, sha(await readFile(file)))
    }
  }
  return result
}

before(async () => {
  await rm(DATA, { recursive: true, force: true })
  await rm(FIXTURES, { recursive: true, force: true })
  await makeFixtures()
  await mkdir(DATA, { recursive: true })
  server = spawn(process.execPath, ['app/server.mjs'], {
    cwd: ROOT,
    windowsHide: true,
    env: { ...process.env, MRX_NO_BROWSER: '1', MRX_SESSION_TOKEN: SESSION_TOKEN, MRX_PORT: String(PORT), MRX_DATA_DIR: DATA, MRX_FFMPEG: FFMPEG },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  base = await waitReady(server)
  cookie = `mrx_session_${new URL(base).port}=${SESSION_TOKEN}`
  await getState()
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
  await rm(FIXTURES, { recursive: true, force: true })
})

test('guards export readiness, processing, and authentication', async () => {
  const noReady = await request('/api/exports', { method: 'POST' })
  assert.equal(noReady.status, 409)
  assert.match(await noReady.text(), /готовых результатов|готов/i)

  const unauthenticated = await requestWithoutSession('/api/exports', { method: 'POST' })
  assert.equal(unauthenticated.status, 403)

  const queued = await upload(
    { path: path.join(FIXTURES, 'same-a-source.wav'), name: 'Одинаковое.wav', type: 'audio/wav' },
    { path: path.join(FIXTURES, 'same-b-source.wav'), name: 'Одинаковое.wav', type: 'audio/wav' },
  )
  const busy = await getState()
  assert.equal(busy.busy, true)
  assert.equal(busy.jobs.length, 2)
  const whileBusy = await request('/api/exports', { method: 'POST' })
  assert.equal(whileBusy.status, 409)
  assert.match(await whileBusy.text(), /Дождитесь завершения/i)
  const done = await waitFor(state => state.jobs.length === 2 && state.jobs.every(job => job.status === 'done'), 180_000)
  assert.equal(done.jobs.length, queued.jobs.length)
})

test('exports done WAVs into unique folders, skips terminal failures, and reuses concurrent builds', async () => {
  const uploaded = await upload({ path: path.join(FIXTURES, 'failed.mp4'), name: 'failed.mp4', type: 'video/mp4' })
  assert.equal(uploaded.jobs.length, 3)
  const terminal = await waitFor(state => state.jobs.length === 3 && state.jobs.every(job => ['done', 'error'].includes(job.status)), 180_000)
  const doneJobs = terminal.jobs.filter(job => job.status === 'done')
  const failedJobs = terminal.jobs.filter(job => job.status === 'error')
  assert.equal(doneJobs.length, 2)
  assert.equal(failedJobs.length, 1)
  const beforeHashes = await outputHashes(terminal)

  const [firstResponse, concurrentResponse] = await Promise.all([
    request('/api/exports', { method: 'POST' }),
    request('/api/exports', { method: 'POST' }),
  ])
  assert.equal(firstResponse.status, 200)
  assert.equal(concurrentResponse.status, 200)
  const first = await firstResponse.json()
  const concurrent = await concurrentResponse.json()
  assert.deepEqual(concurrent, first)
  assert.match(first.url, /^\/api\/download\/all\/[a-f0-9]{24}\.zip$/)
  assert.equal(first.filename, 'MRX — все дорожки.zip')
  assert.equal(first.jobCount, 2)
  assert.equal(first.skippedCount, 1)

  const archiveResponse = await request(first.url)
  assert.equal(archiveResponse.status, 200)
  assert.equal(archiveResponse.headers.get('content-type'), 'application/zip')
  assert.match(decodeURIComponent(archiveResponse.headers.get('content-disposition') || ''), /MRX — все дорожки\.zip/)
  const archiveBytes = Buffer.from(await archiveResponse.arrayBuffer())
  const archive = new AdmZip(archiveBytes)
  const entries = archive.getEntries().filter(entry => !entry.isDirectory)
  assert.equal(entries.length, 6)
  assert.equal(entries.filter(entry => /\.zip$/i.test(entry.entryName)).length, 0)
  const folders = new Set(entries.map(entry => entry.entryName.split('/')[0]))
  assert.deepEqual([...folders].sort(), ['001-Одинаковое', '002-Одинаковое'])
  assert.equal(entries.filter(entry => entry.entryName.startsWith('001-Одинаковое/')).length, 3)
  assert.equal(entries.filter(entry => entry.entryName.startsWith('002-Одинаковое/')).length, 3)
  assert.ok(entries.every(entry => /^\d{3}-Одинаковое\/.+\.wav$/i.test(entry.entryName)))

  const expectedHashes = [...beforeHashes.values()].sort()
  const archivedHashes = entries.map(entry => sha(entry.getData())).sort()
  assert.deepEqual(archivedHashes, expectedHashes)
  assert.deepEqual(await outputHashes(terminal), beforeHashes)
  const cacheDir = path.join(DATA, 'cache', 'exports')
  const cacheEntries = await readdir(cacheDir)
  assert.ok(cacheEntries.every(name => name.endsWith('.zip')))

  // A changed terminal-job snapshot must not reuse the previous archive when
  // one of its completed WAVs has disappeared. The failed build must leave no
  // partial archive behind, and a restored source must be exportable again.
  const missingJob = doneJobs[0]
  const missingOutputName = missingJob.outputs.find(item => /\.wav$/i.test(item.filename)).filename
  const missingPath = path.join(DATA, 'outputs', missingJob.id, missingOutputName)
  const missingBytes = await readFile(missingPath)
  await rm(missingPath, { force: true })
  await upload({ path: path.join(FIXTURES, 'failed.mp4'), name: 'second-failed.mp4', type: 'video/mp4' })
  const changedSnapshot = await waitFor(state => state.jobs.length === 4 && state.jobs.every(job => ['done', 'error'].includes(job.status)), 180_000)
  assert.equal(changedSnapshot.jobs.filter(job => job.status === 'done').length, 2)
  const brokenResponse = await request('/api/exports', { method: 'POST' })
  assert.equal(brokenResponse.status, 500)
  assert.match((await brokenResponse.json()).error, /не найдена|не найден|не доступна/i)
  const afterBroken = await readdir(cacheDir)
  assert.ok(afterBroken.every(name => name.endsWith('.zip')))
  assert.equal(afterBroken.length, cacheEntries.length)
  assert.equal((await request(first.url)).status, 200)

  await writeFile(missingPath, missingBytes)
  const rebuiltResponse = await request('/api/exports', { method: 'POST' })
  assert.equal(rebuiltResponse.status, 200)
  const rebuilt = await rebuiltResponse.json()
  assert.notEqual(rebuilt.url, first.url)
  assert.equal(rebuilt.jobCount, 2)
  assert.equal(rebuilt.skippedCount, 2)
  const afterRebuild = await readdir(cacheDir)
  assert.ok(afterRebuild.every(name => name.endsWith('.zip')))
})

test('allowlists current-session export downloads and returns 404 for unknown IDs', async () => {
  const repeated = await request('/api/exports', { method: 'POST' })
  assert.equal(repeated.status, 200)
  const repeatedBody = await repeated.json()
  const unknown = await request('/api/download/all/000000000000000000000000.zip')
  assert.equal(unknown.status, 404)
  const noCookie = await requestWithoutSession(repeatedBody.url)
  assert.equal(noCookie.status, 403)
  const current = await request(repeatedBody.url)
  assert.equal(current.status, 200)
  assert.equal(Number(current.headers.get('content-length')), Number((await stat(path.join(DATA, 'cache', 'exports', `${repeatedBody.url.split('/').pop()}`))).size))
})
