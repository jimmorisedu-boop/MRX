import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA = path.join(ROOT, 'tests', 'runtime-data')
const FIXTURES = path.join(ROOT, 'tests', 'fixtures')
const STAGED_FFMPEG = path.join(ROOT, 'tools', 'ffmpeg-staging', 'ffmpeg-master-latest-win64-lgpl', 'bin', 'ffmpeg.exe')
const FFMPEG = process.env.MRX_FFMPEG || (existsSync(STAGED_FFMPEG) ? STAGED_FFMPEG : 'ffmpeg.exe')
const PORT = Number(process.env.MRX_TEST_PORT || 17981)
let server
let base
let cookie
const SESSION_TOKEN = 'mrx-test-session-token-0123456789abcdef'

function runTool(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exit ${code ?? signal}: ${stderr}`)))
  })
}

async function makeFixtures() {
  await mkdir(FIXTURES, { recursive: true })
  await runTool(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', path.join(FIXTURES, 'стерео тест.wav')])
  await runTool(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=24', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=3', '-t', '3', '-c:v', 'mpeg4', '-c:a', 'aac', '-ac', '2', '-ar', '44100', path.join(FIXTURES, 'video test.mp4')])
  await runTool(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=24', '-t', '3', '-c:v', 'mpeg4', path.join(FIXTURES, 'video-only.mp4')])
  await runTool(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '3', '-c:a', 'pcm_s16le', '-ac', '2', '-ar', '44100', path.join(FIXTURES, 'silent.wav')])
  await runTool(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=60', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', path.join(FIXTURES, 'cancel.wav')])
  await writeFile(path.join(FIXTURES, 'invalid.bin'), 'not media')
}

function waitReady(child) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('server did not start')), 15_000)
    child.stdout.on('data', chunk => {
      output += String(chunk)
      const match = output.match(/MRX_READY (http:\/\/127\.0\.0\.1:\d+\/)/)
      if (match) { clearTimeout(timer); resolve(match[1].replace(/\/$/, '')) }
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

async function getState() {
  const response = await request('/api/state')
  assert.equal(response.status, 200)
  return response.json()
}

function getWithHost(host) {
  const port = Number(new URL(base).port)
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: '/api/state', method: 'GET', headers: { host } }, response => {
      response.resume()
      response.on('end', () => resolve(response))
    })
    request.on('error', reject)
    request.end()
  })
}

async function waitFor(predicate, timeout = 60_000) {
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
    form.append('files', new Blob([bytes], { type: file.type || 'application/octet-stream' }), path.basename(file.path))
  }
  const response = await request('/api/jobs', { method: 'POST', body: form })
  assert.equal(response.status, 200)
  return response.json()
}

function parseWav(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF')
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE')
  assert.equal(bytes.toString('ascii', 12, 16), 'fmt ')
  assert.equal(bytes.readUInt16LE(20), 1)
  assert.equal(bytes.readUInt16LE(22), 2)
  assert.equal(bytes.readUInt32LE(24), 44100)
  assert.equal(bytes.readUInt16LE(34), 16)
  assert.equal(bytes.toString('ascii', 36, 40), 'data')
  const dataBytes = bytes.readUInt32LE(40)
  assert.equal(dataBytes, bytes.length - 44)
  assert.ok(dataBytes > 1000)
  return { frames: dataBytes / 4, data: bytes.subarray(44) }
}

function zipEntries(bytes) {
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(eocd >= 0)
  const count = bytes.readUInt16LE(eocd + 10)
  let position = bytes.readUInt32LE(eocd + 16)
  const entries = []
  for (let i = 0; i < count; i += 1) {
    assert.equal(bytes.readUInt32LE(position), 0x02014b50)
    const nameLength = bytes.readUInt16LE(position + 28)
    const extraLength = bytes.readUInt16LE(position + 30)
    const commentLength = bytes.readUInt16LE(position + 32)
    entries.push(bytes.toString('utf8', position + 46, position + 46 + nameLength))
    position += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

before(async () => {
  await rm(DATA, { recursive: true, force: true })
  await makeFixtures()
  server = spawn(process.execPath, ['app/server.mjs'], {
    cwd: ROOT,
    windowsHide: true,
    env: { ...process.env, MRX_NO_BROWSER: '1', MRX_SESSION_TOKEN: SESSION_TOKEN, MRX_PORT: String(PORT), MRX_DATA_DIR: DATA, MRX_FFMPEG: FFMPEG },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  base = await waitReady(server)
  cookie = `mrx_session_${new URL(base).port}=${SESSION_TOKEN}`
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

test('rejects wrong host and cross-origin mutation', async () => {
  await getState()
  const wrongHost = await getWithHost('evil.example')
  assert.equal(wrongHost.statusCode, 403)
  const cross = await request('/api/shutdown', { method: 'POST', headers: { origin: 'http://evil.example' } })
  assert.equal(cross.status, 403)
})

test('rejects file-count limit and recovers from an aborted multipart upload', async () => {
  const tiny = path.join(FIXTURES, 'tiny.bin')
  await writeFile(tiny, 'x')
  const form = new FormData()
  for (let i = 0; i < 21; i += 1) form.append('files', new Blob([Buffer.from('x')]), `tiny-${i}.bin`)
  const tooMany = await request('/api/jobs', { method: 'POST', body: form })
  assert.equal(tooMany.status, 400)

  const port = Number(new URL(base).port)
  const boundary = `----mrx-${Date.now()}`
  await new Promise(resolve => {
    const raw = http.request({ hostname: '127.0.0.1', port, path: '/api/jobs', method: 'POST', headers: {
      host: `127.0.0.1:${port}`,
      cookie,
      origin: base,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    } }, response => { response.resume(); response.on('end', resolve) })
    raw.on('error', resolve)
    raw.write(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="aborted.wav"\r\nContent-Type: audio/wav\r\n\r\n`)
    raw.write(Buffer.alloc(4096, 7))
    raw.destroy()
  })
  await new Promise(resolve => setTimeout(resolve, 500))
  const recovered = await getState()
  assert.equal(recovered.version, '1.0.0')
  const leftovers = (await readdir(path.join(DATA, 'uploads'))).filter(name => !name.startsWith('.'))
  assert.equal(leftovers.length, 0)
})

test('processes stereo WAV, video and invalid file independently', async () => {
  const files = [
    { path: path.join(FIXTURES, 'invalid.bin') },
    { path: path.join(FIXTURES, 'video-only.mp4'), type: 'video/mp4' },
    { path: path.join(FIXTURES, 'стерео тест.wav'), type: 'audio/wav' },
    { path: path.join(FIXTURES, 'video test.mp4'), type: 'video/mp4' },
    { path: path.join(FIXTURES, 'silent.wav'), type: 'audio/wav' },
  ]
  const queued = await upload(...files)
  assert.equal(queued.jobs.length, 5)
  const state = await waitFor(value => value.jobs.length === 5 && value.jobs.every(job => ['done', 'error'].includes(job.status)), 120_000)
  const invalid = state.jobs.find(job => job.name === 'invalid.bin')
  const videoOnly = state.jobs.find(job => job.name === 'video-only.mp4')
  const audio = state.jobs.find(job => job.name.includes('стерео'))
  const video = state.jobs.find(job => job.name === 'video test.mp4')
  const silent = state.jobs.find(job => job.name === 'silent.wav')
  assert.equal(invalid.status, 'error')
  assert.equal(videoOnly.status, 'error')
  assert.match(videoOnly.message, /аудиодорожк/i)
  assert.equal(silent.status, 'done', silent.message)
  assert.doesNotMatch(silent.message, /аудиодорожк/i)
  for (const job of [audio, video]) {
    assert.equal(job.status, 'done', job.message)
    assert.equal(job.outputs.length, 3)
    assert.ok(job.zipUrl)
    const hashes = new Set()
    for (const output of job.outputs) {
      assert.ok(output.previewUrl)
      const wav = await request(output.url)
      assert.equal(wav.status, 200)
      assert.match(wav.headers.get('content-disposition') || '', /^attachment;/i)
      const parsed = parseWav(Buffer.from(await wav.arrayBuffer()))
      assert.ok(parsed.frames > 100_000 && parsed.frames < 160_000)
      assert.ok(parsed.data.some(value => value !== 0))
      hashes.add(crypto.createHash('sha256').update(parsed.data).digest('hex'))
    }
    assert.ok(hashes.size >= 2)
    const zip = await request(job.zipUrl)
    assert.equal(zip.status, 200)
    const bytes = Buffer.from(await zip.arrayBuffer())
    assert.ok(bytes.slice(0, 2).equals(Buffer.from('PK')))
    assert.deepEqual(zipEntries(bytes).sort(), job.outputs.map(output => output.filename).sort())
  }

  const previewOutput = audio.outputs[0]
  const fullResponse = await request(previewOutput.previewUrl)
  assert.equal(fullResponse.status, 200)
  assert.equal(fullResponse.headers.get('content-type'), 'audio/wav')
  assert.equal(fullResponse.headers.get('accept-ranges'), 'bytes')
  assert.match(fullResponse.headers.get('content-disposition') || '', /^inline;/i)
  const fullBytes = Buffer.from(await fullResponse.arrayBuffer())
  assert.equal(Number(fullResponse.headers.get('content-length')), fullBytes.length)

  const headResponse = await request(previewOutput.previewUrl, { method: 'HEAD' })
  assert.equal(headResponse.status, 200)
  assert.equal(Number(headResponse.headers.get('content-length')), fullBytes.length)
  assert.equal((await headResponse.arrayBuffer()).byteLength, 0)

  const firstRange = await request(previewOutput.previewUrl, { headers: { range: 'bytes=0-99' } })
  assert.equal(firstRange.status, 206)
  assert.equal(firstRange.headers.get('content-range'), `bytes 0-99/${fullBytes.length}`)
  assert.deepEqual(Buffer.from(await firstRange.arrayBuffer()), fullBytes.subarray(0, 100))

  const openRange = await request(previewOutput.previewUrl, { headers: { range: 'bytes=100-' } })
  assert.equal(openRange.status, 206)
  assert.equal(openRange.headers.get('content-range'), `bytes 100-${fullBytes.length - 1}/${fullBytes.length}`)
  assert.deepEqual(Buffer.from(await openRange.arrayBuffer()), fullBytes.subarray(100))

  const suffixRange = await request(previewOutput.previewUrl, { headers: { range: 'bytes=-100' } })
  assert.equal(suffixRange.status, 206)
  assert.equal(suffixRange.headers.get('content-range'), `bytes ${fullBytes.length - 100}-${fullBytes.length - 1}/${fullBytes.length}`)
  assert.deepEqual(Buffer.from(await suffixRange.arrayBuffer()), fullBytes.subarray(-100))

  const invalidRange = await request(previewOutput.previewUrl, { headers: { range: `bytes=${fullBytes.length}-` } })
  assert.equal(invalidRange.status, 416)
  assert.equal(invalidRange.headers.get('content-range'), `bytes */${fullBytes.length}`)
  const multipleRange = await request(previewOutput.previewUrl, { headers: { range: 'bytes=0-1,2-3' } })
  assert.equal(multipleRange.status, 416)
  assert.equal(multipleRange.headers.get('content-range'), `bytes */${fullBytes.length}`)

  const unknownPreview = await request(`/api/preview/${encodeURIComponent(audio.id)}/missing.wav`)
  assert.equal(unknownPreview.status, 404)
  const zipName = decodeURIComponent(audio.zipUrl.split('/').pop())
  const zipPreview = await request(`/api/preview/${encodeURIComponent(audio.id)}/${encodeURIComponent(zipName)}`)
  assert.equal(zipPreview.status, 404)
  const traversalPreview = await request(`/api/preview/${encodeURIComponent(audio.id)}/..%2F${encodeURIComponent(previewOutput.filename)}`)
  assert.equal(traversalPreview.status, 404)
})

test('cancels a running job and removes partial output', async () => {
  const queued = await upload({ path: path.join(FIXTURES, 'cancel.wav'), type: 'audio/wav' })
  const job = queued.jobs.at(-1)
  const cancel = await request(`/api/jobs/${job.id}/cancel`, { method: 'POST' })
  assert.equal(cancel.status, 200)
  const state = await waitFor(value => value.jobs.find(item => item.id === job.id)?.status === 'cancelled', 30_000)
  const cancelled = state.jobs.find(item => item.id === job.id)
  assert.equal(cancelled.outputs.length, 0)
  assert.equal(existsSync(path.join(DATA, 'outputs', job.id)), false)
})

test('force shutdown exits while a worker is active', async () => {
  const queued = await upload({ path: path.join(FIXTURES, 'cancel.wav'), type: 'audio/wav' })
  const job = queued.jobs.at(-1)
  await waitFor(value => value.jobs.find(item => item.id === job.id)?.status === 'separating', 20_000)
  const response = await request('/api/shutdown?force=1', { method: 'POST' })
  assert.equal(response.status, 200)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not exit after force shutdown')), 8_000)
    server.once('exit', () => { clearTimeout(timer); resolve() })
  })
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.equal(existsSync(path.join(DATA, 'outputs', job.id)), false)
})
