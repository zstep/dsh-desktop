import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { HarnessRuntime } from '../src/main/runtime/harness-runtime'
import { ensurePluginMarketDefaults } from '../src/main/state/plugin-market-defaults'
import { HarnessShell, HARNESS_SHELL_URL } from '../src/main/harness-shell'
import { resolveTestNodeExecutable } from './node-executable'

it('boots bundled discovery, searches an index without installing, and persists editable sources across restart', async () => {
  const root = resolve(import.meta.dirname, '..')
  const home = await mkdtemp(join(tmpdir(), 'pengbao-market-runtime-'))
  let requests = 0
  let bodyDelayMs = 0
  const server = createServer((_req, res) => {
    requests += 1
    res.setHeader('content-type', 'application/json')
    const body = JSON.stringify({ format: 1, title: 'Fixture market', plugins: [{
      name: 'fixture-plugin', title: 'Fixture plugin', versions: [{ version: '1.0.0', publishTimestamp: 1, source: { type: 'npm' } }]
    }] })
    res.write(body.slice(0, 1))
    const timer = setTimeout(() => res.end(body.slice(1)), bodyDelayMs)
    res.on('close', () => clearTimeout(timer))
})
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture server')
  const index = `http://127.0.0.1:${address.port}/index.json`
  const dshEntryPath = join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  const profile = join(home, 'profiles', 'web')
  const shell = new HarnessShell({ frontendRoot: home })
  let runtime: HarnessRuntime | undefined
  try {
    await ensurePluginMarketDefaults(home, dshEntryPath)
    await symlink(join(root, 'node_modules'), join(home, 'profiles', 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    const probe = join(home, 'probe.mjs')
    await writeFile(probe, `
export const inject = ['pluginMarket', 'connection'];
export function apply(ctx) {
  ctx.connection.fetch.register({ path: '/api/market-probe', methods: ['POST'], fetch: async request => {
    const action = new URL(request.url).searchParams.get('action');
    if (action === 'configure') { await ctx.pluginMarket.setIndexes([${JSON.stringify(index)}]); return Response.json({ok:true}); }
    if (action === 'search') return Response.json(await ctx.pluginMarket.search(${JSON.stringify(index)}, {text:'Fixture',offset:0,limit:10,sort:{kind:'index'}}));
    if (action === 'timeout') return Response.json({fetchTimeoutMs:ctx.pluginMarket.config.fetchTimeoutMs});
    return Response.json(ctx.pluginMarket.listIndexes());
  }});
}
`)
    const patch = join(home, 'probe.patch.yml')
    await writeFile(patch, `${await readFile(join(root, 'build/dsh-desktop-safe.patch.yml'), 'utf8')}\n- insert:\n    - id: market-probe\n      name: ${JSON.stringify(pathToFileURL(probe).href)}\n`)
    const activeRuntime = new HarnessRuntime({
      dshEntryPath, nodeEntryPath: join(root, 'build/harness-node-entry.mjs'),
      nodeExecutablePath: resolveTestNodeExecutable(), dshPatchPath: patch,
      dshSafePatchPath: join(root, 'build/dsh-desktop-safe.patch.yml'), dshHome: home,
      logPath: join(home, 'runtime.log'), startupTimeoutMs: 30_000, preferredPort: 0,
      launchProcess: (executable, args, options) => spawn(executable, args, options), onChanged() {}
    })
    runtime = activeRuntime
    await mkdir(join(home, 'launch-root'))
    const connect = async () => {
      await activeRuntime.start(join(home, 'launch-root'))
      const snapshot = activeRuntime.snapshot()
      expect(snapshot.phase, snapshot.logs.join('\n')).toBe('ready')
      if (!snapshot.url || !snapshot.authToken) throw new Error('Missing Harness endpoint')
      const login = await fetch(`${snapshot.url}/?token=${encodeURIComponent(snapshot.authToken)}`, { redirect: 'manual' })
      const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
      await shell.connect(`${snapshot.url}/?token=${encodeURIComponent(snapshot.authToken)}`)
      return (path: string) => fetch(new URL(path, snapshot.url), { method: path.startsWith('/api/market-probe') ? 'POST' : 'GET', headers: { Cookie: cookie } })
    }
    let get = await connect()
    expect(requests).toBe(0)
    const configured = await get('/api/market-probe?action=configure')
    expect(configured.status, runtime.snapshot().logs.join('\n')).toBe(200)
    expect(await configured.json()).toEqual({ ok: true })
    const searched = await get('/api/market-probe?action=search')
    expect(searched.status, runtime.snapshot().logs.join('\n')).toBe(200)
    const result = await searched.json()
    expect(result.total).toBe(1)
    expect(result.entries[0].name).toBe('fixture-plugin')
    expect(requests).toBe(1)
    const search = async (refresh = false) => {
      const response = await shell.handle(new Request(`${HARNESS_SHELL_URL}api/pluginMarket/search`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'fixture-market-search', method: 'pluginMarket/search',
          payload: { args: { url: index, query: { offset: 0, limit: 10, sort: { kind: 'index' }, refresh } } } })
      }))
      expect(response.status).toBe(200)
      return response.json()
    }
    expect((await search()).result.ok).toBe(true)
    expect(requests).toBe(1)
    // Delay the body, not only the headers, beyond both former deadlines.
    bodyDelayMs = 31_000
    const delayed = await search(true)
    expect(delayed.result.ok, JSON.stringify(delayed.result.error)).toBe(true)
    expect(delayed.result.value.total).toBe(1)
    expect(requests).toBe(2)
    expect(await (await get('/api/market-probe?action=timeout')).json()).toEqual({ fetchTimeoutMs: 90_000 })
    bodyDelayMs = 0
    const html = await (await get('/')).text()
    expect(html).toContain('@deepseek-ai/dsh-client-ui-plugin-market')
    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    expect(manifest.dependencies).toEqual({})
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toContain(index)
    await runtime.stop()
    expect(await ensurePluginMarketDefaults(home, dshEntryPath)).toBe(false)
    get = await connect()
    expect(JSON.stringify(await (await get('/api/market-probe')).json())).toContain(index)
    expect(requests).toBe(2)
    shell.reset()
    await runtime.stop()
    // An explicit user timeout still wins over the packaged default.
    await writeFile(patch, `${await readFile(patch, 'utf8')}\n- id: plugin-market\n  config:\n    indexes: ${JSON.stringify([index])}\n    fetchTimeoutMs: 100\n`)
    bodyDelayMs = 500
    get = await connect()
    expect(await (await get('/api/market-probe?action=timeout')).json()).toEqual({ fetchTimeoutMs: 100 })
    const timedOut = await search(true)
    expect(timedOut.result.ok).toBe(false)
    expect(timedOut.result.error.code).toBe('plugin-market/fetch-failed')
    expect(timedOut.result.error.details.reason).toContain('timeout')
    expect(requests).toBe(3)
  } finally {
    shell.reset()
    await runtime?.stop()
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 180_000)
