import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { web } from '@e2e-dev/web'
import type { E2EConfig } from 'e2e'

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(E2E_DIR, '..', '..')
const dataDir = path.resolve(process.env.MRX_E2E_DATA_DIR || path.join(E2E_DIR, '.e2e-data'))

export default {
  tests: ['mrx.e2e.ts'],
  targets: [{
    name: 'mrx-local',
    engine: web({
      browser: 'chromium',
      viewport: { width: 1280, height: 900 },
    }),
    app: {
      url: process.env.MRX_E2E_URL || 'http://127.0.0.1:17961',
      command: {
        executable: 'node',
        args: [path.join(ROOT_DIR, 'app', 'server.mjs')],
        env: {
          MRX_DATA_DIR: dataDir,
          MRX_PORT: '17961',
          MRX_NO_BROWSER: '1',
          MRX_FFMPEG: path.join(ROOT_DIR, 'dist', 'MRX', 'tools', 'ffmpeg.exe'),
          MRX_WEIGHTS_DIR: path.join(ROOT_DIR, 'weights'),
          E2E_TELEMETRY_DISABLED: '1',
        },
        log: '.e2e/mrx-server.log',
        startupTimeout: 120_000,
      },
    },
  }],
  timeout: 600_000,
  launchTimeout: 120_000,
  actionTimeout: 60_000,
  assertionTimeout: 300_000,
  workers: 1,
  retries: 0,
  maxDuration: 1_200_000,
} satisfies E2EConfig
