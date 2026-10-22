import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { showStartupErrorDialog, BUTTONS } = require('../desktop/startup-error.cjs')

function scripted(choices) {
  const shown = []
  const show = (options) => {
    shown.push(options)
    return choices.shift()
  }
  return { show, shown }
}

test('the default button (Enter or Space) opens the log instead of closing the error', () => {
  const { show, shown } = scripted([0, 1])
  let opened = 0
  const result = showStartupErrorDialog(show, () => { opened += 1 }, { type: 'error', message: 'boom' })
  assert.equal(opened, 1)
  assert.equal(shown.length, 2, 'the dialog must come back after the log was opened')
  assert.deepEqual(result, { logOpens: 1 })
  assert.equal(BUTTONS[shown[0].defaultId], 'Открыть журнал')
  assert.equal(BUTTONS[shown[0].cancelId], 'Закрыть')
  assert.deepEqual(shown[0].buttons, BUTTONS)
  assert.equal(shown[0].message, 'boom')
})

test('"Закрыть", Esc or the close box end the dialog without opening the log', () => {
  const { show, shown } = scripted([1])
  let opened = 0
  showStartupErrorDialog(show, () => { opened += 1 }, { message: 'boom' })
  assert.equal(opened, 0)
  assert.equal(shown.length, 1)
})

test('a held-down key cannot reopen the dialog forever', () => {
  const { show, shown } = scripted(Array(20).fill(0))
  let opened = 0
  const result = showStartupErrorDialog(show, () => { opened += 1 }, { message: 'boom' }, 3)
  assert.equal(opened, 3)
  assert.equal(shown.length, 3)
  assert.deepEqual(result, { logOpens: 3 })
})
