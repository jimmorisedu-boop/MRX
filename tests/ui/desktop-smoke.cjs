'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const { spawn } = require('node:child_process')

const root = path.resolve(__dirname, '..', '..')
const portableDir = path.resolve(process.env.MRX_PORTABLE_DIR || path.join(root, 'dist', 'MRX'))
const executable = path.join(portableDir, 'MRX.exe')
const screenshot = path.join(__dirname, 'desktop-ready.png')
const metadata = path.join(__dirname, 'desktop-ready.json')

async function run() {
  if (process.platform !== 'win32') {
    console.log('DESKTOP_SMOKE_SKIPPED platform=%s (Electron package is Windows x64)', process.platform)
    return
  }
  assert.ok(fs.existsSync(executable), `Packaged MRX.exe not found: ${executable}`)
  await Promise.all([
    fsp.rm(screenshot, { force: true }),
    fsp.rm(metadata, { force: true })
  ])
  const child = spawn(executable, ['--mrx-smoke'], {
    cwd: portableDir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MRX_SMOKE: '1',
      MRX_SMOKE_OUTPUT: screenshot,
      MRX_SMOKE_METADATA: metadata
    }
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const timer = setTimeout(() => child.kill(), 45000)
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  }).finally(() => clearTimeout(timer))
  assert.equal(result.code, 0, `MRX.exe exited with ${result.code ?? result.signal}\n${output}`)
  assert.ok(fs.existsSync(screenshot), `Smoke screenshot missing: ${screenshot}`)
  assert.ok(fs.statSync(screenshot).size > 1000, 'Smoke screenshot is unexpectedly empty')
  const details = JSON.parse(await fsp.readFile(metadata, 'utf8'))
  assert.equal(details.desktop, true)
  assert.equal(details.platform, 'win32')
  // capturePage measures the content area without the window frame, so at
  // 100% display scaling the 680x540 minimum window gives about 664x501.
  assert.ok(details.width >= 640 && details.height >= 480, `Unexpected window size: ${details.width}x${details.height}`)
  console.log(`DESKTOP_SMOKE_OK pid=${details.pid} size=${details.width}x${details.height}`)
}

run().catch((error) => {
  console.error(error.stack || error)
  process.exitCode = 1
})
