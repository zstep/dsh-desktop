import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { PengbaoAccountController } from '../src/main/enterprise/account-controller'
import { PengbaoClient } from '../src/main/enterprise/client'

function fixture(safeMode = false) {
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const start = source.indexOf('async function activateAccount(')
  const end = source.indexOf('function configureAppIdentity(', start)
  const code = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  let navigation = 0
  let preparedNavigation = 0
  const launches: string[] = []
  const launch = async (mode: string) => { launches.push(mode); navigation++ }
  const bootstrap = vi.fn(async () => {
    await launch(safeMode ? 'safe' : 'normal')
    // Model the prepared document waiting on the first backend's boot IPC.
    preparedNavigation = navigation
  })
  const context = {
    PRIVATE_MODEL_HANDOFF_VERIFIED: true, accountCleanupBlocked: false,
    activeAccount: undefined, runtime: undefined, accountGateway: undefined, accountModels: [],
    app: { getPath: () => 'isolated-test-profile' },
    pengbaoAccountPaths: () => ({ home: 'isolated-test-home', partition: 'test' }),
    startPengbaoGateway: vi.fn(async () => ({ url: 'http://127.0.0.1:1234' })),
    accountClient: { models: vi.fn(async () => [{ id: 'test-model' }]) },
    assertServableModels: vi.fn(), removePengbaoProviderOverlay: vi.fn(async () => {}),
    bootstrapHarnessAfterVerifiedHandoff: bootstrap,
    launchHarness: () => launch('normal')
  }
  const activate: ConstructorParameters<typeof PengbaoAccountController>[0]['activate'] =
    runInNewContext(code + ';activateAccount', context)
  const client = new PengbaoClient({ fetch: vi.fn(async () => Response.json({
    token: 'fixture-token', id: 'fixture-user', role: 'user', name: 'Fixture'
  })) })
  const controller = new PengbaoAccountController({
    client,
    store: { load: async () => 'fixture-token', save: async () => {}, clear: async () => {} },
    activate, deactivate: async () => {}
  })
  return { controller, bootstrap, launches, pageStillCurrent: () => navigation === preparedNavigation }
}

describe('Pengbao initial workspace launch', () => {
  it.each(['restore', 'sign-in'] as const)('keeps the prepared page current after %s', async method => {
    const f = fixture()
    const state = method === 'restore' ? await f.controller.restore()
      : await f.controller.signIn({ email: 'fixture@example.test', password: 'fixture-password' })
    expect(state.phase).toBe('signed-in')
    expect(f.bootstrap).toHaveBeenCalledOnce()
    expect(f.launches).toEqual(['normal'])
    expect(f.pageStillCurrent()).toBe(true)
  })

  it('does not replace the requested Safe Mode launch with a normal launch', async () => {
    const f = fixture(true)
    expect((await f.controller.restore()).phase).toBe('signed-in')
    expect(f.launches).toEqual(['safe'])
    expect(f.pageStillCurrent()).toBe(true)
  })
})
