import type { PengbaoAccountState } from '../../shared/pengbao-account'

export interface AccountSwitchOptions {
  confirm(): Promise<boolean>
  signOut(): Promise<{ remoteConfirmed: boolean }>
  snapshot(): PengbaoAccountState
  setSwitching(value: boolean): void
  reportFailure(): Promise<void>
  warnRemoteLogout(): Promise<void>
  restart(): void
}

/** Local cleanup, not the remote response, authorizes a fresh login process. */
export function createAccountSwitch(options: AccountSwitchOptions): () => Promise<void> {
  let pending: Promise<void> | undefined
  return () => {
    if (pending) return pending
    pending = (async () => {
      if (!await options.confirm()) return
      options.setSwitching(true)
      try {
        const result = await options.signOut()
        if (options.snapshot().phase !== 'signed-out') {
          await options.reportFailure()
          return
        }
        if (!result.remoteConfirmed) await options.warnRemoteLogout()
        options.restart()
      } finally {
        options.setSwitching(false)
      }
    })().finally(() => { pending = undefined })
    return pending
  }
}
