import { ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { pathToFileURL } from 'node:url'
import { PENGBAO_ACCOUNT_IPC, isPengbaoMfaInput, isPengbaoSignInInput } from '../../shared/pengbao-account'
import type { PengbaoAccountController } from './account-controller'
import { PENGBAO_PRODUCT } from './config'

/** Only the dedicated, local account window may submit account credentials. */
export function registerPengbaoAccountIpc(options: {
  window: () => BrowserWindow | undefined
  pagePath: string
  controller: PengbaoAccountController
}): () => void {
  const expectedUrl = pathToFileURL(options.pagePath).href
  function trusted(event: IpcMainInvokeEvent): void {
    const window = options.window()
    if (!window || window.isDestroyed() || event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame || event.senderFrame?.url !== expectedUrl) {
      throw new Error('Untrusted account request')
    }
  }
  ipcMain.handle(PENGBAO_ACCOUNT_IPC.state, event => {
    trusted(event)
    return options.controller.snapshot()
  })
  ipcMain.handle(PENGBAO_ACCOUNT_IPC.signIn, (event, input: unknown) => {
    trusted(event)
    if (!isPengbaoSignInInput(input)) throw new Error('Invalid login input')
    return options.controller.signIn(input)
  })
  ipcMain.handle(PENGBAO_ACCOUNT_IPC.verifyMfa, (event, input: unknown) => {
    trusted(event)
    if (!isPengbaoMfaInput(input)) throw new Error('Invalid MFA input')
    return options.controller.verifyMfa(input)
  })
  ipcMain.handle(PENGBAO_ACCOUNT_IPC.signOut, event => {
    trusted(event)
    return options.controller.signOut()
  })
  ipcMain.handle(PENGBAO_ACCOUNT_IPC.enrollment, async event => {
    trusted(event)
    // A fixed destination, never a renderer-supplied URL or challenge token.
    await shell.openExternal(PENGBAO_PRODUCT.serverUrl)
  })
  return () => {
    for (const channel of Object.values(PENGBAO_ACCOUNT_IPC)) ipcMain.removeHandler(channel)
  }
}
