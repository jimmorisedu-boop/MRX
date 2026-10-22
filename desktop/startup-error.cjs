'use strict'

// Startup and crash errors are shown in a dialog that takes keyboard focus as
// soon as it appears. With a single "OK" button, an Enter or Space the user
// happens to type into another window closes it before it is read, and MRX
// quits silently. The default button therefore only opens the log and shows
// the dialog again; the dialog closes on "Закрыть", Esc or the close box.
const OPEN_LOG = 0
const CLOSE = 1
const BUTTONS = ['Открыть журнал', 'Закрыть']

// showDialog(options) returns the chosen button index (as
// dialog.showMessageBoxSync does); openLog() opens the log file. After
// maxLogOpens default-button presses the dialog is not shown again, so a key
// held down cannot keep reopening it.
function showStartupErrorDialog(showDialog, openLog, options, maxLogOpens = 3) {
  let logOpens = 0
  for (;;) {
    const choice = showDialog({ ...options, buttons: BUTTONS, defaultId: OPEN_LOG, cancelId: CLOSE, noLink: true })
    if (choice !== OPEN_LOG) return { logOpens }
    openLog()
    logOpens += 1
    if (logOpens >= maxLogOpens) return { logOpens }
  }
}

module.exports = { showStartupErrorDialog, BUTTONS }
