// Downloads and verifies the external pieces listed in scripts/deps.json.
// Every file is checked against its pinned SHA-256; a file already in place
// with the right hash is not downloaded again, so a copy placed by hand (for
// example when an upstream URL has gone away) is used as is.
//
// Usage: node scripts/fetch-deps.mjs [group ...]
// Groups: runtime (Node.js, Electron), model, ffmpeg, ffmpeg-sources.
// Without arguments every group is fetched.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const deps = JSON.parse(await readFile(path.join(ROOT, 'scripts', 'deps.json'), 'utf8'))
const GROUPS = {
  runtime: ['node', 'electron'],
  model: ['model'],
  ffmpeg: ['ffmpeg'],
  'ffmpeg-sources': ['ffmpegSource', 'ffmpegRecipe', 'ffmpegChecksums'],
}

async function sha256File(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function ensureFile(name) {
  const { url, sha256, file } = deps[name]
  const target = path.join(ROOT, file)
  if (existsSync(target)) {
    const actual = await sha256File(target)
    if (actual === sha256) {
      process.stdout.write(`DEPS_OK ${name} ${file}\n`)
      return target
    }
    process.stdout.write(`DEPS_REPLACE ${name}: ${file} has SHA-256 ${actual}\n`)
  }
  await mkdir(path.dirname(target), { recursive: true })
  const part = `${target}.part`
  process.stdout.write(`DEPS_DOWNLOAD ${name} ${url}\n`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`${name}: HTTP ${response.status} for ${url}. Place the file at ${file} by hand if the URL is gone.`)
  const hash = createHash('sha256')
  const hashing = new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk) } })
  await pipeline(Readable.fromWeb(response.body), hashing, createWriteStream(part))
  const actual = hash.digest('hex')
  if (actual !== sha256) {
    await rm(part, { force: true })
    throw new Error(`${name}: SHA-256 mismatch for ${url}: ${actual}, expected ${sha256}`)
  }
  await rename(part, target)
  process.stdout.write(`DEPS_OK ${name} ${file}\n`)
  return target
}

// The BtbN zip is unpacked to a version-independent folder, so tests and the
// build always find tools/ffmpeg/bin/ffmpeg.exe.
async function ensureFfmpeg() {
  const { dir, root, exeSha256 } = deps.ffmpeg
  const exe = path.join(ROOT, dir, 'bin', 'ffmpeg.exe')
  if (existsSync(exe) && await sha256File(exe) === exeSha256) {
    process.stdout.write(`DEPS_OK ffmpeg ${dir}\n`)
    return
  }
  const zip = await ensureFile('ffmpeg')
  const target = path.join(ROOT, dir)
  const staging = `${target}.extract`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  // Windows 10+ ships bsdtar, which reads zip archives.
  if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', staging], { stdio: 'inherit' })
  else execFileSync('unzip', ['-q', zip, '-d', staging], { stdio: 'inherit' })
  await rm(target, { recursive: true, force: true })
  await rename(path.join(staging, root), target)
  await rm(staging, { recursive: true, force: true })
  const actual = await sha256File(exe)
  if (actual !== exeSha256) throw new Error(`ffmpeg: ${dir}/bin/ffmpeg.exe has SHA-256 ${actual}, expected ${exeSha256}`)
  process.stdout.write(`DEPS_OK ffmpeg ${dir}\n`)
}

const requested = process.argv.slice(2)
for (const group of requested) {
  if (!GROUPS[group]) throw new Error(`unknown group "${group}"; use: ${Object.keys(GROUPS).join(', ')}`)
}
for (const group of requested.length ? requested : Object.keys(GROUPS)) {
  for (const name of GROUPS[group]) {
    if (name === 'ffmpeg') await ensureFfmpeg()
    else await ensureFile(name)
  }
}
