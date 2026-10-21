import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { serverExitAction } = require('../desktop/server-exit.cjs')

test('a server that dies before MRX_READY is a startup error, never a silent quit', () => {
  assert.equal(serverExitAction({ startupReady: false, exitExpected: false, closing: false, code: 1 }), 'startup-error')
  assert.equal(serverExitAction({ startupReady: false, exitExpected: false, closing: false, code: 0 }), 'startup-error')
  assert.equal(serverExitAction({ startupReady: false, exitExpected: false, closing: false, code: null }), 'startup-error')
})

test('requested exits close the app quietly', () => {
  assert.equal(serverExitAction({ startupReady: true, exitExpected: true, closing: false, code: 1 }), 'quit')
  assert.equal(serverExitAction({ startupReady: true, exitExpected: false, closing: true, code: 1 }), 'quit')
  assert.equal(serverExitAction({ startupReady: false, exitExpected: true, closing: false, code: 1 }), 'quit')
  // The in-app "Закрыть" button stops the server with exit code 0.
  assert.equal(serverExitAction({ startupReady: true, exitExpected: false, closing: false, code: 0 }), 'quit')
})

test('an unexpected failure after startup is reported as a crash', () => {
  assert.equal(serverExitAction({ startupReady: true, exitExpected: false, closing: false, code: 1 }), 'crash-error')
  assert.equal(serverExitAction({ startupReady: true, exitExpected: false, closing: false, code: null }), 'crash-error')
})
