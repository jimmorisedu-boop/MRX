'use strict'

const { contextBridge, ipcRenderer } = require('electron')

// Keep the renderer web surface small.  The renderer still talks to the
// loopback server for queue operations; this bridge only handles native file
// actions that a browser cannot provide safely.
contextBridge.exposeInMainWorld('mrxDesktop', Object.freeze({
  isDesktop: true,
  openJobFolder: (jobId) => ipcRenderer.invoke('mrx-open-job-folder', String(jobId || ''))
}))
