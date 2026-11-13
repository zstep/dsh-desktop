import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { expect, it } from 'vitest'
import { startPengbaoGateway } from '../src/main/enterprise/gateway'
import { preparePengbaoProviderOverlay } from '../src/main/enterprise/provider-overlay'
import { HarnessRuntime } from '../src/main/runtime/harness-runtime'
import { resolveTestNodeExecutable } from './node-executable'

/** Ambient provider credentials would make the composition default routable and hide the defect. */
function withoutProviderKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/API_KEY/i.test(key)))
}

it('initializes the foundation default model from the account server default and persists it', async () => {
  const project = resolve(import.meta.dirname, '..')
  const home = await mkdtemp(join(tmpdir(), 'desktop-default-model-'))
  const workspace = join(home, 'workspace')
  await mkdir(workspace)
  const jwt = 'default-model-fixture-not-a-real-jwt'
  const gateway = await startPengbaoGateway({ jwt, fetch: async (input, init) => {
    const url = new URL(String(input))
    expect(url.origin).toBe('https://pengbao.ecombus.net')
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${jwt}`)
    if (url.pathname === '/api/v1/models') return Response.json({ data: [{ id: 'chat-a', name: 'Fixture Chat Alpha' }, { id: 'chat-b', name: 'Fixture Chat Beta' }] })
    if (url.pathname === '/api/config') return Response.json({ default_models: 'chat-a' })
    throw new Error(`Unexpected mock route: ${url.pathname}`)
  } })
  let runtime: HarnessRuntime | undefined
  let profileName = ''
  try {
    const probe = join(home, 'default-model-probe.mjs')
    await writeFile(probe, `
export const inject = ['agentDefaultModel', 'llm', 'connection'];
export function apply(ctx) {
  ctx.connection.fetch.register({ path: '/api/default-model-fixture/selection', methods: ['GET'], requestBody: 'buffered', fetch: async () => {
    let providers = [];
    let models = [];
    try { providers = (await ctx.llm.listProviders()).map(item => item.id) } catch { providers = [] }
    try { models = (await ctx.llm.listModels('pengbao')).map(item => item.id) } catch { models = [] }
    return Response.json({ selection: ctx.agentDefaultModel.currentSelection(), providers, models });
  } });
}
`)
    const patch = join(home, 'default-model.patch.yml')
    await writeFile(patch, `${await readFile(join(project, 'build/dsh-desktop-safe.patch.yml'), 'utf8')}\n- insert:\n    - id: default-model-fixture\n      name: ${JSON.stringify(pathToFileURL(probe).href)}\n`)
    const boot = () => new HarnessRuntime({
      dshEntryPath: join(project, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
      nodeEntryPath: join(project, 'build/harness-node-entry.mjs'), nodeExecutablePath: resolveTestNodeExecutable(),
      dshPatchPath: patch, dshSafePatchPath: join(project, 'build/dsh-desktop-safe.patch.yml'),
      dshHome: home, logPath: join(home, 'runtime.log'), preferredPort: 0, startupTimeoutMs: 30_000,
      privateModelHandoff: () => ({ gatewayUrl: gateway.url, capabilityToken: gateway.capabilityToken }),
      privateModelServiceGrant: capabilities => gateway.createModelServiceGrant(capabilities),
      providerOverlay: profile => {
        profileName = profile
        return preparePengbaoProviderOverlay(home, profile, {
          gatewayUrl: gateway.url, models: [{ id: 'chat-a', name: 'Fixture Chat Alpha' }, { id: 'chat-b', name: 'Fixture Chat Beta' }]
        })
      },
      launchProcess: (executable, args, options) =>
        spawn(executable, args, { ...options, env: withoutProviderKeys(options.env ?? process.env) }),
      onChanged() {}
    })
    const start = async () => {
      runtime = boot()
      await runtime.start(workspace)
      const snapshot = runtime.snapshot()
      expect(snapshot.phase, snapshot.logs.join('\n')).toBe('ready')
      if (!snapshot.url || !snapshot.authToken) throw new Error('Missing Harness endpoint')
      const login = await fetch(`${snapshot.url}/?token=${encodeURIComponent(snapshot.authToken)}`, { redirect: 'manual' })
      const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
      await login.body?.cancel()
      const selection = async () => {
        const response = await fetch(`${snapshot.url}/api/default-model-fixture/selection`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(15_000) })
        const text = await response.text()
        if (response.status !== 200) throw new Error(`selection ${response.status}: ${text}\n${runtime!.snapshot().logs.join('\n')}`)
        return JSON.parse(text) as { selection: { provider?: unknown; model?: unknown }; providers: string[]; models: string[] }
      }
      const until = async (check: (value: Awaited<ReturnType<typeof selection>>) => boolean, label: string) => {
        const deadline = Date.now() + 20_000
        let last: Awaited<ReturnType<typeof selection>> | undefined
        while (Date.now() < deadline) {
          last = await selection()
          if (check(last)) return last
          await new Promise(resolveWait => setTimeout(resolveWait, 100))
        }
        throw new Error(`${label}: ${JSON.stringify(last)}\n${runtime!.snapshot().logs.join('\n')}`)
      }
      return { selection, until }
    }

    const first = await start()
    const state = await first.until(value =>
      value.selection.provider === 'pengbao' && value.selection.model === 'chat-a', 'server default initialization')
    expect(state.providers).toContain('pengbao')
    expect(state.models).toEqual(expect.arrayContaining(['chat-a', 'chat-b']))

    const patchPath = join(home, 'profiles', profileName, 'cordis.patch.yml')
    const persisted = parse(await readFile(patchPath, 'utf8')) as { id?: unknown; config?: unknown }[]
    const rows = persisted.filter(row => row?.id === 'agent-default-model')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.config).toEqual({ provider: 'pengbao', model: 'chat-a' })
    const overlay = await readFile(join(home, 'pengbao-provider.patch.yml'), 'utf8')
    expect(overlay).not.toContain('agent-default-model')

    await runtime?.stop()
    const afterFirstBoot = await readFile(patchPath, 'utf8')
    const second = await start()
    expect((await second.selection()).selection).toMatchObject({ provider: 'pengbao', model: 'chat-a' })
    await new Promise(resolveWait => setTimeout(resolveWait, 1500))
    expect(await readFile(patchPath, 'utf8')).toBe(afterFirstBoot)
    for (const secret of [jwt, gateway.capabilityToken]) {
      expect(await readFile(join(home, 'runtime.log'), 'utf8')).not.toContain(secret)
      expect(afterFirstBoot).not.toContain(secret)
    }
  } finally {
    await runtime?.stop()
    await gateway.stop()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 90_000)