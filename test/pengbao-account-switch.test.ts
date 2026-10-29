import { describe, expect, it, vi } from 'vitest'
import type { PengbaoAccountState } from '../src/shared/pengbao-account'
import { createAccountSwitch } from '../src/main/enterprise/account-switch'
import { windowsMenuTemplate } from '../src/main/windows-menu'
import { isDesktopMenuCommand } from '../src/shared/desktop-menu'

function fixture() {
  const state: PengbaoAccountState = { phase: 'signed-out' }
  const options = {
    confirm: vi.fn(async () => true), signOut: vi.fn(async () => ({ remoteConfirmed: true })),
    snapshot: vi.fn((): PengbaoAccountState => state), setSwitching: vi.fn(),
    reportFailure: vi.fn(async () => {}), warnRemoteLogout: vi.fn(async () => {}), restart: vi.fn()
  }
  return { options, run: createAccountSwitch(options) }
}

describe('controlled Pengbao account switch', () => {
  it('does nothing after cancellation', async () => {
    const f = fixture()
    f.options.confirm.mockResolvedValue(false)
    await f.run()
    expect(f.options.signOut).not.toHaveBeenCalled()
    expect(f.options.setSwitching).not.toHaveBeenCalled()
    expect(f.options.restart).not.toHaveBeenCalled()
  })

  it('coalesces repeat clicks and waits for confirmed local cleanup before restarting', async () => {
    const f = fixture()
    let finish: () => void = () => { throw new Error('Logout not started') }
    f.options.signOut.mockImplementation(() => new Promise(resolve => {
      finish = () => resolve({ remoteConfirmed: true })
    }))
    const first = f.run()
    expect(f.run()).toBe(first)
    await Promise.resolve()
    expect(f.options.setSwitching).toHaveBeenCalledWith(true)
    expect(f.options.restart).not.toHaveBeenCalled()
    finish()
    await first
    expect(f.options.confirm).toHaveBeenCalledOnce()
    expect(f.options.signOut).toHaveBeenCalledOnce()
    expect(f.options.restart).toHaveBeenCalledOnce()
    expect(f.options.setSwitching.mock.calls).toEqual([[true], [false]])
  })

  it.each(['signed-in', 'storage'] as const)('blocks restart after %s cleanup failure and permits retry', async phase => {
    const f = fixture()
    f.options.snapshot.mockReturnValueOnce(phase === 'storage'
      ? { phase: 'error', reason: 'storage' }
      : { phase: 'signed-in', name: '', email: '', persistent: true })
    await f.run()
    expect(f.options.reportFailure).toHaveBeenCalledOnce()
    expect(f.options.restart).not.toHaveBeenCalled()
    await f.run()
    expect(f.options.restart).toHaveBeenCalledOnce()
  })

  it('warns about offline remote logout but still restarts after local revocation', async () => {
    const f = fixture()
    f.options.signOut.mockResolvedValue({ remoteConfirmed: false })
    await f.run()
    expect(f.options.warnRemoteLogout).toHaveBeenCalledOnce()
    expect(f.options.restart).toHaveBeenCalledOnce()
    expect(f.options.warnRemoteLogout.mock.invocationCallOrder[0]).toBeLessThan(f.options.restart.mock.invocationCallOrder[0] ?? 0)
  })

  it('releases transition ownership when cleanup throws without restarting', async () => {
    const f = fixture()
    f.options.signOut.mockRejectedValueOnce(new Error('Shutdown failed'))
    await expect(f.run()).rejects.toThrow('Shutdown failed')
    expect(f.options.setSwitching).toHaveBeenLastCalledWith(false)
    expect(f.options.restart).not.toHaveBeenCalled()
  })

  it.each(['zh', 'en'] as const)('exposes a native caption command in %s without a credential IPC', locale => {
    const run = vi.fn()
    const menu = windowsMenuTemplate('application', locale, 1, { run, sendEditingKey: vi.fn() })
    const item = menu.find(entry => entry.label === (locale === 'zh' ? '切换账号…' : 'Switch Account…'))
    expect(item).toBeDefined()
    // Electron supplies these arguments; this command does not consume them.
    item?.click?.({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent)
    expect(run).toHaveBeenCalledWith('switch-account')
    expect(isDesktopMenuCommand('switch-account')).toBe(true)
  })
})
