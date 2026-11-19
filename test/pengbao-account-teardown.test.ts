import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

function fixture({ switching = true, quitting = false } = {}) {
  const source = readFileSync(new URL('../src/main/shell/app.ts', import.meta.url), 'utf8')
  const start = source.indexOf('async function deactivateAccount(')
  const end = source.indexOf('/** Block Harness startup until', start)
  const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const gatewayStop = vi.fn(async () => {})
  const backendStop = vi.fn(async () => {})
  const flush = vi.fn()
  const showAccountWindow = vi.fn()
  const revokeLeases = vi.fn()
  const context = {
    accountCleanupBlocked: false,
    accountSwitching: switching,
    quitting,
    accountGateway: { stop: gatewayStop },
    activeAccount: { home: 'fixture-home' },
    accountModels: ['fixture'],
    revokePrivateLeases: revokeLeases,
    removePengbaoProviderOverlay: vi.fn(async () => {}),
    stopAccountBackend: backendStop,
    flushAccountStorage: flush,
    showAccountWindow,
    setTimeout,
    clearTimeout
  }
  const deactivate: () => Promise<void> = runInNewContext(code + ';deactivateAccount', context)
  return { context, gatewayStop, backendStop, flush, showAccountWindow, revokeLeases, deactivate }
}

afterEach(() => { vi.useRealTimers() })

describe('account switch resource teardown', () => {
  it('revokes the gateway and stops the backend before clearing the identity', async () => {
    const f = fixture()
    f.backendStop.mockImplementation(async () => {
      expect(f.gatewayStop).toHaveBeenCalledOnce()
      expect(f.context.activeAccount).toBeDefined()
    })
    await f.deactivate()
    expect(f.gatewayStop).toHaveBeenCalledOnce()
    expect(f.revokeLeases).toHaveBeenCalledOnce()
    expect(f.backendStop).toHaveBeenCalledOnce()
    expect(f.flush).toHaveBeenCalledOnce()
    expect(f.context.activeAccount).toBeUndefined()
    expect(f.context.accountCleanupBlocked).toBe(false)
    expect(f.showAccountWindow).not.toHaveBeenCalled()
  })

  it('returns to the account surface only when the app is not switching or quitting', async () => {
    const f = fixture({ switching: false, quitting: false })
    await f.deactivate()
    expect(f.showAccountWindow).toHaveBeenCalledOnce()
  })

  it('does not show the account surface while quitting', async () => {
    const f = fixture({ switching: false, quitting: true })
    await f.deactivate()
    expect(f.showAccountWindow).not.toHaveBeenCalled()
  })
})