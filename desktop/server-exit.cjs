'use strict'

// Decides what the desktop shell does when its local server process exits.
// Kept free of Electron imports so it can be unit-tested with plain Node.
//
// - 'quit': the exit was requested (closing the window, the in-app "Закрыть"
//   button, or a clean exit after startup), so the app closes quietly.
// - 'startup-error': the server died before it reported MRX_READY. This must
//   never be silent: the user would only see the app fail to open.
// - 'crash-error': the server died unexpectedly while the window was open.
function serverExitAction({ startupReady, exitExpected, closing, code }) {
  if (exitExpected || closing) return 'quit'
  if (!startupReady) return 'startup-error'
  if (code === 0) return 'quit'
  return 'crash-error'
}

module.exports = { serverExitAction }
