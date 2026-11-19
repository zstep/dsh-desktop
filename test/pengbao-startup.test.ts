import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { PengbaoAccountController } from '../src/main/enterprise/account-controller'
import { PengbaoClient } from '../src/main/enterprise/client'

function fixture() {
  const source = readFileSync(new URL('../src/main/shell/app.ts', import.meta.url), 'utf8')
  const start = source.indexOf('async function activateAccount(')
  const end = source.indexOf('function revokePrivateLeases(', start)
  const code = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const gateway = { url: 'http://127.0.0.1:1234', capabilityToken: 'fixture-token' }
  const resolvedGate = vi.fn()
  const models = vi.fn(async () => [{ id: 'test-model' }])
  const removeOverlay = vi.fn(async () => {})
  const assertModels = vi.fn()
  const startGateway = vi.fn(async () => gateway)
  const context = {
    accountCleanupBlocked: false,
    activeAccount: undefined,
    accountGateway: undefined,
    accountModels: [],
    accountGateResolve: resolvedGate,
    accountClient: { models },
    app: { getPath: () => 'isolated-test-profile' },
    pengbaoAccountPaths: () => ({ home: 'isolated-test-home', partition: 'test' }),
    startPengbaoGateway: startGateway,
    assertServableModels: assertModels,
    removePengbaoProviderOverlay: removeOverlay,
    accountHome: () => 'isolated-test-home'
  }
  const activate: ConstructorParameters<typeof PengbaoAccountController>[0]['activate'] =
    runInNewContext(code + ';activateAccount', context)
  const client = new PengbaoClient({
    fetch: vi.fn(async () => Response.json({
      token: 'fixture-token', id: 'fixture-user', role: 'user', name: 'Fixture'
    }))
  })
  const controller = new PengbaoAccountController({
    client,
    store: { load: async () => 'fixture-token', save: async () => {}, clear: async () => {} },
    activate,
    deactivate: async () => {}
  })
  return { controller, context, gateway, resolvedGate, models, removeOverlay, assertModels, startGateway }
}

describe('Pengbao account activation', () => {
  it.each(['restore', 'sign-in'] as const)('starts the gateway and resolves the boot gate on %s', async method => {
    const f = fixture()
    const state = method === 'restore'
      ? await f.controller.restore()
      : await f.controller.signIn({ email: 'fixture@example.test', password: 'fixture-password' })
    expect(state.phase).toBe('signed-in')
    expect(f.startGateway).toHaveBeenCalledOnce()
    expect(f.models).toHaveBeenCalledOnce()
    expect(f.assertModels).toHaveBeenCalledOnce()
    expect(f.removeOverlay).toHaveBeenCalledWith('isolated-test-home')
    expect(f.context.accountGateway).toBe(f.gateway)
    expect(f.context.activeAccount).toEqual({ home: 'isolated-test-home', partition: 'test' })
    expect(f.resolvedGate).toHaveBeenCalledOnce()
    expect(f.context.accountGateResolve).toBeUndefined()
  })

  it('rejects a second identity without a clean teardown', async () => {
    const f = fixture()
    await f.controller.restore()
    const second = await f.controller.signIn({ email: 'fixture@example.test', password: 'fixture-password' })
    expect(second.phase).toBe('signed-in')
    expect(f.startGateway).toHaveBeenCalledOnce()
  })
})