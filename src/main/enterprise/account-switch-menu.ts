import { dialog } from 'electron'
import type { HarnessLocale } from '../application-locale'
import type { PengbaoAccountController } from './account-controller'
import { createAccountSwitch } from './account-switch'

export function createAccountSwitchMenu(options: {
  controller(): PengbaoAccountController | undefined
  locale(): HarnessLocale
  quitting(): boolean
  setSwitching(value: boolean): void
  restart(): void
}): () => void {
  const reportFailure = async (): Promise<void> => {
    const zh = options.locale() === 'zh'
    await dialog.showMessageBox({
      type: 'error',
      message: zh ? '暂时无法切换账号' : 'Unable to switch accounts',
      detail: zh
        ? '资源停止或本地登录信息清理未完成。未允许其他账号进入，也未删除本地会话。请重试“切换账号”；仍失败时保留日志排查。'
        : 'Resource shutdown or local credential cleanup did not finish. Another account is blocked and local sessions were kept. Retry Switch Account; if it still fails, retain the logs for diagnosis.',
      buttons: [zh ? '知道了' : 'OK']
    })
  }
  const switchAccount = createAccountSwitch({
    confirm: async () => {
      if (options.quitting() || !options.controller()) return false
      const zh = options.locale() === 'zh'
      const { response } = await dialog.showMessageBox({
        type: 'question',
        message: zh ? '退出当前账号并切换登录？' : 'Sign out and switch accounts?',
        detail: zh
          ? '当前任务将停止，应用会重启到登录页。本地会话、配置和项目文件会保留。'
          : 'Running tasks will stop and the app will restart at sign-in. Local sessions, settings and project files will be kept.',
        buttons: zh ? ['取消', '退出并重新登录'] : ['Cancel', 'Sign Out and Restart'],
        defaultId: 0, cancelId: 0, noLink: true
      })
      return response === 1 && !options.quitting()
    },
    signOut: async () => {
      const controller = options.controller()
      if (!controller) throw new Error('Account controller unavailable')
      return controller.signOut()
    },
    snapshot: () => options.controller()?.snapshot() ?? { phase: 'error', reason: 'unknown' },
    setSwitching: options.setSwitching,
    reportFailure,
    warnRemoteLogout: async () => {
      const zh = options.locale() === 'zh'
      await dialog.showMessageBox({
        type: 'warning',
        message: zh ? '已退出本机登录，服务端退出未确认。' : 'Signed out locally; server logout was not confirmed.',
        detail: zh ? '本机授权已清除。应用将重启，你可以登录其他账号。' : 'Local authorization was cleared. The app will restart so you can sign in with another account.',
        buttons: [zh ? '继续' : 'Continue']
      })
    },
    restart: options.restart
  })
  return () => {
    void switchAccount().catch(reportFailure).catch(error => {
      console.warn('[pengbao] account switch dialog failed', error)
    })
  }
}
