'use strict'

const { contextBridge, ipcRenderer, webUtils } = require('electron')

// Keep the renderer web surface small.  The renderer still talks to the
// loopback server for queue operations; this bridge only handles native file
// actions that a browser cannot provide safely.
contextBridge.exposeInMainWorld('mrxDesktop', Object.freeze({
  isDesktop: true,
  openJobFolder: (jobId) => ipcRenderer.invoke('mrx-open-job-folder', String(jobId || '')),
  // Lets dropped or picked files be processed in place instead of being
  // copied through an upload. Returns '' when a file has no disk path.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  }
}))
