import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: vi.fn() }))
import { closePengbaoAccountWindow } from '../src/main/enterprise/account-window'

function fixture() {
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const start = source.indexOf('async function openHarness(')
  const end = source.indexOf('async function maybeImportWebHome(', start)
  const code = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  let destroyed = false
  const account = { isDestroyed: () => destroyed, destroy: vi.fn(() => { destroyed = true }) }
  const main = { isDestroyed: () => false, webContents: { getURL: () => 'dsh-desktop://harness/' } }
  const connect = vi.fn(async () => {})
  const raise = vi.fn()
  const recovery = vi.fn(async () => {})
  const context = {
    processRecovery: { blocked: false }, quitting: false, accountSwitching: false, gpuFallbackRelaunching: false,
    applicationRollbackVisible: false, safeModeVisible: false, returnToNormalAfterRepair: false,
    mainWindow: main, accountWindow: account, mainWindowNavigationVersion: 1,
    runtime: { launchAttemptId: 1, snapshot: () => ({ phase: 'ready', url: 'http://127.0.0.1:1234/', authToken: 'local-auth' }), note: vi.fn() },
    harnessPagePreparation: undefined, isHarnessShellUrl: () => true,
    harnessShell: { connect }, markHarnessRendered: vi.fn(), syncNativeTheme: vi.fn(async () => {}),
    closePengbaoAccountWindow, raiseWindowWithoutStealingFocus: raise,
    app: { isActive: () => true }, process, showPluginRecovery: recovery
  }
  const open: (url: string, intent?: string) => Promise<void> = runInNewContext(code + ';openHarness', context)
  return { account, main, connect, raise, recovery, context, open: () => open('http://127.0.0.1:1234/') }
}

describe('Pengbao account window handoff', () => {
  it('closes the account window only after connecting and preserves workspace focus policy', async () => {
    const f = fixture()
    let finish: () => void = () => { throw new Error('Connection not started') }
    f.connect.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    const opening = f.open()
    expect(f.account.destroy).not.toHaveBeenCalled()
    finish()
    await opening
    expect(f.account.destroy).toHaveBeenCalledOnce()
    expect(f.raise).toHaveBeenCalledWith(f.main, process.platform, expect.any(Function), 'automatic')
  })

  it('keeps the account window when the workspace connection fails', async () => {
    const f = fixture()
    f.connect.mockRejectedValueOnce(new Error('Workspace failed'))
    await f.open()
    expect(f.account.destroy).not.toHaveBeenCalled()
    expect(f.recovery).toHaveBeenCalledOnce()
    expect(f.raise).not.toHaveBeenCalled()
  })

  it('does not close a login window after a stale workspace navigation completes', async () => {
    const f = fixture()
    f.connect.mockImplementation(async () => { f.context.mainWindowNavigationVersion++ })
    await f.open()
    expect(f.account.destroy).not.toHaveBeenCalled()
    expect(f.raise).not.toHaveBeenCalled()
  })

  it('leaves automatic focus behavior unchanged after the account window is gone', async () => {
    const f = fixture()
    f.account.destroy()
    f.account.destroy.mockClear()
    await f.open()
    expect(f.account.destroy).not.toHaveBeenCalled()
    expect(f.raise).toHaveBeenCalledWith(f.main, process.platform, expect.any(Function), 'automatic')
    expect(closePengbaoAccountWindow(undefined)).toBe(false)
  })

})
