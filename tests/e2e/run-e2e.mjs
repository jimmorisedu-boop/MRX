process.env.E2E_TELEMETRY_DISABLED = '1'
await import('./node_modules/e2e/dist/cli/bin.js')
