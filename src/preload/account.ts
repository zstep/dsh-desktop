import { contextBridge, ipcRenderer } from 'electron'
import {
  PENGBAO_ACCOUNT_IPC,
  type PengbaoAccountBridge,
  type PengbaoAccountState,
  type PengbaoMfaInput,
  type PengbaoSignInInput
} from '../shared/pengbao-account'

const account: PengbaoAccountBridge = {
  getState: (): Promise<PengbaoAccountState> => ipcRenderer.invoke(PENGBAO_ACCOUNT_IPC.state),
  signIn: (input: PengbaoSignInInput): Promise<PengbaoAccountState> =>
    ipcRenderer.invoke(PENGBAO_ACCOUNT_IPC.signIn, input),
  verifyMfa: (input: PengbaoMfaInput): Promise<PengbaoAccountState> =>
    ipcRenderer.invoke(PENGBAO_ACCOUNT_IPC.verifyMfa, input),
  signOut: (): Promise<{ remoteConfirmed: boolean }> => ipcRenderer.invoke(PENGBAO_ACCOUNT_IPC.signOut),
  openEnrollment: (): Promise<void> => ipcRenderer.invoke(PENGBAO_ACCOUNT_IPC.enrollment)
}

contextBridge.exposeInMainWorld('pengbaoAccount', account)
