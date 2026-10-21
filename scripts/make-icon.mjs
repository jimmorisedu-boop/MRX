// Renders desktop/assets/mrx.ico from the in-app brand mark (three faders,
// see .brand-mark in app/public/index.html) with Playwright's Chromium.
// It is a placeholder icon: replace desktop/assets/mrx.ico with a designed
// one at any time; the build embeds whatever file is there.
//
// Usage: node scripts/make-icon.mjs   (needs tests/e2e dependencies installed)
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import playwright from '../tests/e2e/node_modules/playwright-core/index.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = path.join(ROOT, 'desktop', 'assets', 'mrx.ico')
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]

// 24-unit grid of the in-app mark, on a solid tile in the app's --blue.
const svg = size => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}">
  <rect x="0.5" y="0.5" width="23" height="23" rx="5.5" fill="#3d6fdb"/>
  <g transform="translate(12 12) scale(0.74) translate(-12 -12)">
    <path d="M3 6h18M3 12h18M3 18h18" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" fill="none"/>
    <circle cx="7" cy="6" r="2.5" fill="#ffffff"/>
    <circle cx="15" cy="12" r="2.5" fill="#ffffff"/>
    <circle cx="10" cy="18" r="2.5" fill="#ffffff"/>
  </g>
</svg>`

// An .ico file may hold PNG images directly (Windows Vista and later).
function icoFrom(images) {
  const header = Buffer.alloc(6 + images.length * 16)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16
    header.writeUInt8(size >= 256 ? 0 : size, entry)
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1)
    header.writeUInt8(0, entry + 2)
    header.writeUInt8(0, entry + 3)
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...images.map(image => image.png)])
}

const browser = await playwright.chromium.launch()
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  const images = []
  for (const size of SIZES) {
    await page.setViewportSize({ width: size, height: size })
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg(size)}</body></html>`)
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } })
    images.push({ size, png })
  }
  await mkdir(path.dirname(OUTPUT), { recursive: true })
  await writeFile(OUTPUT, icoFrom(images))
  process.stdout.write(`ICON=${OUTPUT}\n`)
} finally {
  await browser.close()
}
