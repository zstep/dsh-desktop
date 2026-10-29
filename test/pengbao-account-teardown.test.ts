import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

function fixture(switching = true) {
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const start = source.indexOf('async function deactivateAccount(')
  const end = source.indexOf('const PRIVATE_MODEL_HANDOFF_VERIFIED', start)
  const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const gatewayStop = vi.fn(async () => {})
  const runtimeStop = vi.fn(async () => {})
  const context = {
    accountCleanupBlocked: false, accountSwitching: switching, quitting: false,
    accountGateway: { stop: gatewayStop }, activeAccount: { home: 'fixture-home' }, accountModels: ['fixture'],
    clearProfileBootConfirmation: vi.fn(), mainWindowNavigationVersion: 1,
    removePengbaoProviderOverlay: vi.fn(async () => {}), harnessLaunchOperation: undefined,
    runtime: { stop: runtimeStop }, mobileBridge: { stop: vi.fn(async () => {}) },
    harnessShell: { reset: vi.fn() }, desktopStorageManager: { flushSync: vi.fn() },
    windowStateManager: { flushSync: vi.fn() }, repairAgentService: { dispose: vi.fn() },
    mobileWindow: undefined, mainWindow: { isDestroyed: () => false, destroy: vi.fn() },
    showAccountWindow: vi.fn(), setTimeout, clearTimeout
  }
  const deactivate: () => Promise<void> = runInNewContext(code + ';deactivateAccount', context)
  return { context, gatewayStop, runtimeStop, deactivate }
}

afterEach(() => { vi.useRealTimers() })

describe('account switch resource teardown', () => {
  it('revokes the gateway and stops the child before destroying windows, without opening a stale login page', async () => {
    const f = fixture()
    const main = f.context.mainWindow
    f.runtimeStop.mockImplementation(async () => {
      expect(f.gatewayStop).toHaveBeenCalledOnce()
      expect(main.destroy).not.toHaveBeenCalled()
    })
    await f.deactivate()
    expect(main.destroy).toHaveBeenCalledOnce()
    expect(f.context.harnessShell.reset).toHaveBeenCalledOnce()
    expect(f.context.activeAccount).toBeUndefined()
    expect(f.context.showAccountWindow).not.toHaveBeenCalled()
    expect(f.context.accountCleanupBlocked).toBe(false)
  })

  it.each(['gateway', 'runtime'] as const)('bounds a stalled %s and keeps the account locked for retry', async stage => {
    vi.useFakeTimers()
    const f = fixture()
    const stop = stage === 'gateway' ? f.gatewayStop : f.runtimeStop
    stop.mockImplementationOnce(() => new Promise(() => {}))
    const assertion = expect(f.deactivate()).rejects.toThrow('Account resources did not stop in time')
    await vi.advanceTimersByTimeAsync(15_001)
    await assertion
    expect(f.context.accountCleanupBlocked).toBe(true)
    expect(f.context.mainWindow.destroy).not.toHaveBeenCalled()
    expect(f.context.activeAccount).toBeDefined()
    expect(f.context.accountGateway).toBeDefined()
    expect(f.context.showAccountWindow).not.toHaveBeenCalled()
  })
})
