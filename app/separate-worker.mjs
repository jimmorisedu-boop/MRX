import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import separate from '@audio/neural-separate'

const args = parseArgs(process.argv.slice(2))
const input = required('--input')
const outputDir = required('--output-dir')
const weightsDir = required('--weights')
const ffmpeg = required('--ffmpeg')
const baseName = safeName(required('--base-name'))
const sampleRate = 44100
let cancelled = false
let activeProcess = null
const MAX_PCM_BYTES = Number(process.env.MRX_MAX_DECODE_BYTES || 1_500_000_000)

process.on('message', message => {
  if (message?.type === 'cancel') {
    cancelled = true
    if (activeProcess && !activeProcess.killed) activeProcess.kill()
  }
})

function abortFromSignal() {
  cancelled = true
  if (activeProcess && !activeProcess.killed) activeProcess.kill()
  setTimeout(() => process.exit(2), 1000).unref()
}
process.on('SIGTERM', abortFromSignal)
process.on('SIGINT', abortFromSignal)

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) out[argv[i]] = argv[i + 1] || ''
  }
  return out
}

function required(key) {
  const value = args[key]
  if (!value) throw new Error(`missing ${key}`)
  return value
}

function safeName(value) {
  const normalized = String(value).normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim()
  return normalized.slice(0, 120).replace(/[\uD800-\uDBFF]$/u, '') || 'input'
}

function progress(status, value, message) {
  if (process.send) process.send({ type: 'progress', status, progress: value, message })
}

function runFfmpeg() {
  return new Promise((resolve, reject) => {
    progress('decoding', 2, 'Декодирование аудио…')
    // Select only the first audio stream. The optional map lets FFmpeg report
    // a deterministic "no output stream" diagnostic for video-only files,
    // while keeping normal malformed-input errors on their generic path.
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-i', input, '-map', '0:a:0?', '-vn', '-sn', '-dn', '-f', 'f32le', '-acodec', 'pcm_f32le', '-ar', String(sampleRate), '-ac', '2', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    activeProcess = child
    const chunks = []
    let stderr = ''
    let totalBytes = 0
    child.stdout.on('data', chunk => {
      totalBytes += chunk.length
      if (totalBytes > MAX_PCM_BYTES) {
        stderr = 'Декодированный файл слишком большой для безопасной обработки'
        child.kill()
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-6000) })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      activeProcess = null
      if (cancelled) return reject(new Error('cancelled'))
      if (code !== 0) {
        // This message is emitted when the optional audio map found no stream.
        // Keep malformed/unsupported media on the normal FFmpeg error path
        // instead of mislabelling it as a missing track.
        if (/Output file does not contain any stream/i.test(stderr) && !/Invalid data found when processing input|Error opening input|No such file or directory/i.test(stderr)) {
          return reject(new Error('В файле отсутствует аудиодорожка'))
        }
        return reject(new Error(stderr.trim() || `ffmpeg завершился с кодом ${code ?? signal}`))
      }
      const bytes = Buffer.concat(chunks)
      if (bytes.length < 8 || bytes.length % 4) return reject(new Error('ffmpeg не вернул PCM-аудио'))
      const values = new Float32Array(bytes.byteLength / 4)
      for (let i = 0; i < values.length; i += 1) values[i] = bytes.readFloatLE(i * 4)
      const frames = Math.floor(values.length / 2)
      const left = new Float32Array(frames)
      const right = new Float32Array(frames)
      for (let i = 0; i < frames; i += 1) {
        left[i] = values[i * 2]
        right[i] = values[i * 2 + 1]
      }
      resolve([left, right])
    })
  })
}

function writeWav(file, channels, rate) {
  const count = channels.length
  const frames = channels[0]?.length || 0
  const bits = 16
  const blockAlign = count * (bits / 8)
  const dataSize = frames * blockAlign
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(count, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * blockAlign, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)
  const pcm = Buffer.allocUnsafe(dataSize)
  for (let i = 0; i < frames; i += 1) {
    for (let ch = 0; ch < count; ch += 1) {
      let sample = Number(channels[ch]?.[i] || 0)
      if (!Number.isFinite(sample)) sample = 0
      sample = Math.max(-1, Math.min(1, sample))
      const value = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767)
      pcm.writeInt16LE(value, (i * count + ch) * 2)
    }
  }
  return writeFile(file, Buffer.concat([header, pcm]))
}

async function main() {
  await mkdir(outputDir, { recursive: true })
  const channels = await runFfmpeg()
  if (cancelled) throw new Error('cancelled')
  progress('separating', 12, 'Разделение моделью MRX…')
  const result = await separate({ channelData: channels, sampleRate }, {
    model: 'mrx',
    weights: weightsDir,
    chunk: 20,
    overlap: 2,
    wiener: 1,
    device: 'node',
    progress: ({ chunk, totalChunks }) => {
      if (cancelled) throw new Error('cancelled')
      const ratio = totalChunks ? chunk / totalChunks : 0
      progress('separating', 12 + ratio * 76, `Разделение моделью MRX… ${chunk}/${totalChunks}`)
    },
  })
  if (cancelled) throw new Error('cancelled')
  const outputs = []
  for (const label of ['dialogue', 'music', 'effects']) {
    if (cancelled) throw new Error('cancelled')
    const stem = result.stems[label]
    if (!stem?.length) throw new Error(`Модель не вернула дорожку ${label}`)
    const channelsOut = stem.length === 1 ? stem : [stem[0], stem[1] || stem[0]]
    const filename = `${baseName} — ${label}.wav`
    await writeWav(path.join(outputDir, filename), channelsOut, result.sampleRate || sampleRate)
    outputs.push({ label, filename })
    progress('encoding', 90 + outputs.length, `Сохранение ${label}…`)
  }
  if (process.send) {
    process.send({ type: 'done', outputs }, () => {
      process.disconnect()
      process.exit(0)
    })
  } else process.exit(0)
}

main().catch(error => {
  const code = cancelled || error?.message === 'cancelled' ? 2 : 1
  if (process.send) {
    process.send({ type: 'error', message: String(error?.message || error) }, () => {
      process.disconnect()
      process.exit(code)
    })
  } else process.exit(code)
})
