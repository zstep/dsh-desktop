import { BrowserWindow } from 'electron'
import { pathToFileURL } from 'node:url'

export interface PengbaoAccountWindowOptions {
  preloadPath: string
  htmlPath: string
  parent?: BrowserWindow
}

/** Creates the isolated, local-only account surface. IPC handlers belong to the controller. */
export function createPengbaoAccountWindow(options: PengbaoAccountWindowOptions): BrowserWindow {
  const pageUrl = pathToFileURL(options.htmlPath).href
  const window = new BrowserWindow({
    width: 460,
    height: 700,
    minWidth: 400,
    minHeight: 600,
    show: false,
    title: 'Pengbao Account',
    parent: options.parent,
    modal: Boolean(options.parent),
    backgroundColor: '#f5f1e9',
    webPreferences: {
      preload: options.preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, destination) => {
    if (destination !== pageUrl) event.preventDefault()
  })
  void window.loadFile(options.htmlPath).then(() => {
    if (!window.isDestroyed()) window.show()
  }).catch(error => {
    console.error('Failed to load Pengbao account page', error)
    if (!window.isDestroyed()) window.close()
  })
  return window
}
