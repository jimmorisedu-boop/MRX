'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const { spawn } = require('node:child_process')

const root = path.resolve(__dirname, '..', '..')
const portableDir = path.resolve(process.env.MRX_PORTABLE_DIR || path.join(root, 'dist', 'MRX'))
const executable = path.join(portableDir, 'MRX.exe')
const fixture = path.join(__dirname, '.mrx-smoke-input.wav')
const screenshot = path.join(__dirname, 'desktop-result.png')
const metadata = path.join(__dirname, 'desktop-result.json')

function makeFixture() {
  const sampleRate = 44100
  const seconds = 8
  const channels = 2
  const bits = 16
  const samples = sampleRate * seconds
  const dataLength = samples * channels * (bits / 8)
  const wav = Buffer.alloc(44 + dataLength)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + dataLength, 4)
  wav.write('WAVE', 8)
  wav.write('fmt ', 12)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(channels, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * channels * (bits / 8), 28)
  wav.writeUInt16LE(channels * (bits / 8), 32)
  wav.writeUInt16LE(bits, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(dataLength, 40)
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round((Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.35 + Math.sin((2 * Math.PI * 660 * i) / sampleRate) * 0.18) * 32767)
    wav.writeInt16LE(value, 44 + i * 4)
    wav.writeInt16LE(value, 44 + i * 4 + 2)
  }
  return wav
}

async function run() {
  if (process.platform !== 'win32') {
    console.log('DESKTOP_RESULT_SMOKE_SKIPPED platform=%s (Electron package is Windows x64)', process.platform)
    return
  }
  assert.ok(fs.existsSync(executable), `Packaged MRX.exe not found: ${executable}`)
  await fsp.writeFile(fixture, makeFixture())
  await Promise.all([
    fsp.rm(screenshot, { force: true }),
    fsp.rm(metadata, { force: true })
  ])
  const child = spawn(executable, ['--mrx-smoke-result'], {
    cwd: portableDir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MRX_SMOKE: '1',
      MRX_SMOKE_MODE: 'result',
      MRX_SMOKE_PREVIEW: '1',
      MRX_SMOKE_INPUT: fixture,
      MRX_SMOKE_OUTPUT: screenshot,
      MRX_SMOKE_METADATA: metadata
    }
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const timer = setTimeout(() => {
    if (child.pid) spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).unref()
  }, 210000)
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    assert.equal(result.code, 0, `MRX.exe exited with ${result.code ?? result.signal}\n${output}`)
    assert.ok(fs.existsSync(screenshot), `Result screenshot missing: ${screenshot}`)
    assert.ok(fs.statSync(screenshot).size > 1000, 'Result screenshot is unexpectedly empty')
    const details = JSON.parse(await fsp.readFile(metadata, 'utf8'))
    assert.equal(details.desktop, true)
    assert.equal(details.resultSmoke, true)
    assert.ok(details.previewSmoke, 'Preview smoke metadata missing')
    assert.ok(details.previewSmoke.trackCount >= 2, 'Preview smoke found fewer than two tracks')
    assert.ok(details.previewSmoke.duration > 0, 'Preview duration is empty')
    assert.equal(details.previewSmoke.advanced, true, 'Preview currentTime did not advance')
    assert.equal(details.previewSmoke.pausedAfterPause, true, 'Preview did not pause')
    assert.equal(details.previewSmoke.seekApplied, true, 'Preview seek was not applied')
    assert.equal(details.previewSmoke.switchedTrackPausesPrevious, true, 'Starting another track did not pause the first')
    assert.equal(details.previewSmoke.rapidPlayPauseSafe, true, 'Rapid play/pause marked a track as failed')
    assert.equal(details.previewSmoke.rapidSwitchSafe, true, 'Rapid track switching marked a track as failed')
    assert.equal(details.previewSmoke.preservedAcrossPolls, true, 'Preview node was replaced during polling')
    assert.ok(details.previewSmoke.previewRequests > 0, 'Preview did not request audio data')
    assert.equal(details.previewSmoke.downloadRequests, 0, 'Preview initiated a download')
    assert.ok(details.state?.jobs?.length, 'Result smoke state has no jobs')
    const job = details.state.jobs[details.state.jobs.length - 1]
    assert.equal(job.status, 'done', `Result smoke did not finish: ${job.status} ${job.message || ''}`)
    assert.equal(job.outputs?.length, 3, 'Result smoke did not produce three stems')
    assert.ok(job.zipUrl, 'Result smoke did not produce a ZIP')
    assert.ok(details.width >= 680 && details.height >= 540, `Unexpected window size: ${details.width}x${details.height}`)
    console.log(`DESKTOP_RESULT_SMOKE_OK pid=${details.pid} status=${job.status} size=${details.width}x${details.height}`)
  } finally {
    clearTimeout(timer)
    await fsp.rm(fixture, { force: true })
  }
}

run().catch((error) => {
  console.error(error.stack || error)
  process.exitCode = 1
})
