import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deliverPrivateHandoff, type HarnessChildProcess } from '../src/main/runtime/harness-runtime'
import { launchDisclaimedUtilityProcess } from '../src/main/runtime/disclaimed-utility-process'
import { PiAiAdapter, type PiAiAdapterOptions, type ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { createMessage, resolveRetryPolicy, ToolCallId } from '@deepseek-ai/dsh-llm'
import { startPengbaoGateway } from '../src/main/enterprise/gateway'
import type { PengbaoGateway } from '../src/main/enterprise/gateway'
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { patchPath, projectRoot } from './patch-path'

const entry = join(projectRoot, 'build', 'harness-node-entry.mjs')
const capability = 'Private_Capability_0123456789abcdefghijklmnop'
const handoff = { gatewayUrl: 'http://127.0.0.1:43129', capabilityToken: capability }
const modelService = { ...handoff, contractVersion: 1 as const, capabilities: ['chat.completions'] as const }
const modelServiceConsumers = [{ id: '@fixture/model-consumer', version: '1.0.0', status: 'declared' as const, capabilities: ['chat.completions'] as const }]
const launched: ChildProcess[] = []
const directories: string[] = []
const gateways: PengbaoGateway[] = []

afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.stop()))
  for (const child of launched.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; cli: string; output: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-private-message-'))
  directories.push(root)
  const scopedModules = join(root, 'node_modules', '@deepseek-ai')
  await mkdir(scopedModules, { recursive: true })
  await symlink(join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai'), join(scopedModules, 'dsh-llm-pi-ai'), process.platform === 'win32' ? 'junction' : 'dir')
  await symlink(join(projectRoot, 'packages', 'dsh-desktop-model-service'), join(root, 'node_modules', 'dsh-desktop-model-service'), process.platform === 'win32' ? 'junction' : 'dir')
  await symlink(join(projectRoot, 'packages', 'dsh-image-generation'), join(root, 'node_modules', 'dsh-image-generation'), process.platform === 'win32' ? 'junction' : 'dir')
  const cli = join(root, 'cli.mjs')
  const output = join(root, 'child-report.json')
  await writeFile(cli, `
    import { spawnSync } from 'node:child_process'
    import { writeFileSync } from 'node:fs'
    export async function runCli() {
      const tool = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { encoding: 'utf8' })
      const piAi = await import('@deepseek-ai/dsh-llm-pi-ai')
      const serviceModule = await import('dsh-desktop-model-service/private')
      const imageBridge = await import('dsh-image-generation/desktop-bridge')
      const imageRegistered = !!imageBridge.getDesktopImageBridge()
      const serviceImageRegistered = !!serviceModule.getModelServiceImage()
      const modelServiceRegistered = serviceModule.hasChatRegistration()
      let pluginBrokerRegistered = false
      try { const broker = serviceModule.createPluginConfigurationBroker(); pluginBrokerRegistered = true; await broker.dispose() } catch { /* No broker packet was supplied. */ }
      let entryRegistrationHeld = false

      try {
        piAi.registerPrivateModelCredential({ provider: 'other', baseURL: 'http://127.0.0.1:1', apiKey: 'probe'.repeat(8) })
      } catch (error) {
        entryRegistrationHeld = String(error?.message ?? '').includes('already registered')
      }
      writeFileSync(${JSON.stringify(output)}, JSON.stringify({ argv: process.argv, env: process.env,
        toolEnv: tool.stdout, ipc: typeof process.send === 'function' || !!process.parentPort,
        exportNames: Object.keys(piAi).sort(), imageRegistered, serviceImageRegistered, modelServiceRegistered, pluginBrokerRegistered, entryRegistrationHeld }))
    }
  `)
  return { root, cli, output }
}

function waitForExit(child: HarnessChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise(resolve => child.once('exit', () => resolve()))
}

describe('private Harness child message handoff', () => {
  it('registers the capability into the llm plugin module, not argv/env/log/tool children', async () => {
    const { root, cli, output } = await fixture()
    const child = spawn(process.execPath, [entry, cli], {
      cwd: root, env: { ...process.env, DSH_DESKTOP_PRIVATE_MODEL_HANDOFF: '1' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    })
    launched.push(child)
    const logs: string[] = []
    child.stdout!.on('data', chunk => logs.push(String(chunk)))
    child.stderr!.on('data', chunk => logs.push(String(chunk)))
    await deliverPrivateHandoff(child as HarnessChildProcess, handoff, () => true, new AbortController().signal, modelService, modelServiceConsumers)
    await waitForExit(child as HarnessChildProcess)
    expect(child.exitCode).toBe(0)
    const report = JSON.parse(await readFile(output, 'utf8'))
    expect(report.ipc).toBe(true)
    expect(report.modelServiceRegistered).toBe(true)
    expect(report.pluginBrokerRegistered).toBe(false)
    expect(report.entryRegistrationHeld).toBe(true)
    expect(report.exportNames).toContain('registerPrivateModelCredential')
    expect(logs.join('')).toContain('private model credential registered')
    expect(report.argv).not.toContain(capability)
    expect(JSON.stringify(report.env)).not.toContain(capability)
    expect(report.env).not.toHaveProperty('DSH_DESKTOP_PRIVATE_MODEL_HANDOFF')
    expect(report.toolEnv).not.toContain(capability)
    expect(logs.join('')).not.toContain(capability)
    expect(JSON.stringify(await readFile(cli, 'utf8'))).not.toContain(capability)
  })

  it('registers the image lease in the host package without exposing either capability', async () => {
    const { root, cli, output } = await fixture()
    const imageCapability = 'Image_Capability_0123456789abcdefghijklmnop'
    const child = spawn(process.execPath, [entry, cli], {
      cwd: root, env: { ...process.env, DSH_DESKTOP_PRIVATE_MODEL_HANDOFF: '1' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    })
    launched.push(child)
    let logs = ''
    child.stdout!.on('data', chunk => { logs += String(chunk) })
    child.stderr!.on('data', chunk => { logs += String(chunk) })
    await deliverPrivateHandoff(child as HarnessChildProcess, {
      ...handoff, image: { gatewayUrl: handoff.gatewayUrl, capabilityToken: imageCapability }
    }, () => true, new AbortController().signal, modelService, modelServiceConsumers)
    await waitForExit(child as HarnessChildProcess)
    expect(child.exitCode, logs).toBe(0)
    const report = JSON.parse(await readFile(output, 'utf8'))
    expect(report.imageRegistered).toBe(true)
    expect(report.serviceImageRegistered).toBe(true)
    expect(report.modelServiceRegistered).toBe(true)
    expect(report.pluginBrokerRegistered).toBe(false)
    expect(report.entryRegistrationHeld).toBe(true)
    expect(logs).toContain('private image credential registered')
    for (const secret of [capability, imageCapability]) {
      expect(JSON.stringify(report)).not.toContain(secret)
      expect(logs).not.toContain(secret)
      expect(await readFile(cli, 'utf8')).not.toContain(secret)
    }
  })

  it('rejects invalid consumers before sending any capability', async () => {
    const child = new EventEmitter() as HarnessChildProcess
    const send = vi.fn(() => true)
    Object.assign(child, { exitCode: null, send })
    const invalid = [...modelServiceConsumers, ...modelServiceConsumers]
    await expect(deliverPrivateHandoff(child, handoff, () => true, new AbortController().signal,
      modelService, invalid)).rejects.toThrow('Invalid private model consumers')
    expect(send).not.toHaveBeenCalled()
    expect(child.listenerCount('message')).toBe(0)
  })

  it('waits for acknowledgement when send reports backpressure', async () => {
    const child = new EventEmitter() as HarnessChildProcess
    Object.assign(child, { exitCode: null, send: (_packet: unknown, callback?: (error: Error | null) => void) => {
      callback?.(null)
      return false
    } })
    let completed = false
    const delivery = deliverPrivateHandoff(child, handoff, () => true, new AbortController().signal).then(() => { completed = true })
    child.emit('message', { kind: 'dsh-desktop:private-model-ready' })
    await Promise.resolve()
    expect(completed).toBe(false)
    child.emit('message', { kind: 'dsh-desktop:private-model-received' })
    await delivery
    expect(completed).toBe(true)
    expect(child.listenerCount('message')).toBe(0)
  })

  it('cancels a real spawn before the child can receive the capability', async () => {
    const { root, cli, output } = await fixture()
    const child = spawn(process.execPath, [entry, cli], {
      cwd: root, env: { ...process.env, DSH_DESKTOP_PRIVATE_MODEL_HANDOFF: '1' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    })
    launched.push(child)
    const abort = new AbortController()
    const delivery = deliverPrivateHandoff(child as HarnessChildProcess, handoff, () => true, abort.signal)
    abort.abort()
    await expect(delivery).rejects.toThrow('cancelled')
    expect(child.listenerCount('message')).toBe(0)
    child.kill('SIGTERM')
    await waitForExit(child as HarnessChildProcess)
    await expect(readFile(output, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cancels before delivery and leaves no message listener', async () => {
    const child = new EventEmitter() as HarnessChildProcess
    Object.assign(child, { exitCode: null, send: () => true })
    const abort = new AbortController()
    const delivery = deliverPrivateHandoff(child, handoff, () => true, abort.signal)
    abort.abort()
    await expect(delivery).rejects.toThrow('cancelled')
    expect(child.listenerCount('message')).toBe(0)
  })

  it('fails closed when the child cannot acknowledge delivery', async () => {
    const child = new EventEmitter() as HarnessChildProcess
    Object.assign(child, { exitCode: null, send: (_message: unknown, callback?: (error: Error | null) => void) => {
      callback?.(new Error('channel unavailable'))
    } })
    const delivery = deliverPrivateHandoff(child, handoff, () => true, new AbortController().signal)
    child.emit('message', { kind: 'dsh-desktop:private-model-ready' })
    await expect(delivery).rejects.toThrow('Could not send private model handoff')
  })

  it.skipIf(process.env.DSH_TEST_PRIVATE_UTILITY_ELECTRON !== '1')(
    'delivers over a real macOS Electron utilityProcess without exposing the capability', async () => {
      const electron = createRequire(import.meta.url)('electron') as unknown
      if (typeof electron !== 'string') throw new Error('Electron executable unavailable')
      const { root, cli, output } = await fixture()
      const main = join(root, 'main.cjs')
      const adapterBundle = join(root, 'utility-adapter.cjs')
      await build({
        entryPoints: [join(projectRoot, 'src/main/runtime/disclaimed-utility-process.ts')],
        bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: adapterBundle
      })
      await writeFile(main, `
        const { app, utilityProcess } = require('electron')
        const { launchDisclaimedUtilityProcess } = require(${JSON.stringify(adapterBundle)})
        const { readFileSync, writeFileSync, existsSync } = require('node:fs')
        const { join } = require('node:path')
        const secret = ${JSON.stringify(capability)}
        app.whenReady().then(() => {
        const child = launchDisclaimedUtilityProcess(utilityProcess, ['--expose-internals', ${JSON.stringify(entry)}, ${JSON.stringify(cli)}], {
          cwd: ${JSON.stringify(root)}, env: { PATH: process.env.PATH, DSH_DESKTOP_PRIVATE_MODEL_HANDOFF: '1' },
          stdio: ['pipe', 'pipe', 'pipe', 'ipc']
        }, { disclaim: false })
        let logs = ''
        child.stdout.on('data', value => logs += value)
        child.stderr.on('data', value => logs += value)
        child.on('message', event => {
          if (event.kind === 'dsh-desktop:private-model-received') {
            const check = () => {
              if (!existsSync(${JSON.stringify(output)})) return setTimeout(check, 20)
              const report = JSON.parse(readFileSync(${JSON.stringify(output)}, 'utf8'))
              const leaked = JSON.stringify(report).includes(secret) || logs.includes(secret)
              writeFileSync(join(${JSON.stringify(root)}, 'electron-result.json'), JSON.stringify({ leaked, ipc: report.ipc, delivered: report.entryRegistrationHeld, imageRegistered: report.imageRegistered }))
              child.kill()
              app.exit(!leaked && report.ipc && report.entryRegistrationHeld && report.imageRegistered ? 0 : 3)
            }
            check()
          }
          if (event.kind === 'dsh-desktop:private-model-ready') child.send({
            kind: 'dsh-desktop:private-model-delivery', gatewayUrl: 'http://127.0.0.1:43129', capabilityToken: secret,
            image: { gatewayUrl: 'http://127.0.0.1:43129', capabilityToken: secret }
          })
        })
        child.on('exit', code => { if (!existsSync(join(${JSON.stringify(root)}, 'electron-result.json'))) { console.error('utility early exit', code, logs); app.exit(4) } })
        app.whenReady().then(() => setTimeout(() => app.exit(2), 10000).unref())
        })
      `)
      const { spawnSync } = await import('node:child_process')
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const result = spawnSync(electron, [main], { cwd: root, env, encoding: 'utf8', timeout: 15_000 })
      expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined()
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(JSON.parse(await readFile(join(root, 'electron-result.json'), 'utf8'))).toEqual({ leaked: false, ipc: true, delivered: true, imageRegistered: true })
    }, 20_000
  )

  it('answers the memory-only credential only for the gateway route itself', async () => {
    const patch = await readFile(patchPath('@deepseek-ai/dsh-llm-pi-ai'), 'utf8')
    const additions = patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n')
    const register = additions.match(/function registerPrivateModelCredential\(entry\) \{[\s\S]*?^\}/m)?.[0]
    const match = additions.match(/function matchPrivateModelCredential\(provider, baseURL\) \{[\s\S]*?^\}/m)?.[0]
    expect(register).toBeDefined()
    expect(match).toBeDefined()
    const seam = new Function(`let privateModelCredential; ${register} ${match} return { registerPrivateModelCredential, matchPrivateModelCredential }`)() as {
      registerPrivateModelCredential: (entry: unknown) => void
      matchPrivateModelCredential: (provider: string, baseURL: string | undefined) => string | undefined
    }
    const gateway = 'http://127.0.0.1:43129'
    const key = 'Capability_0123456789abcdefghijklmnop'
    seam.registerPrivateModelCredential({ provider: 'pengbao', baseURL: gateway, apiKey: key })
    expect(seam.matchPrivateModelCredential('pengbao', gateway)).toBe(key)
    expect(seam.matchPrivateModelCredential('pengbao', `${gateway}/v1`)).toBe(key)
    expect(seam.matchPrivateModelCredential('other', gateway)).toBeUndefined()
    expect(seam.matchPrivateModelCredential('pengbao', 'http://127.0.0.1:43130')).toBeUndefined()
    expect(seam.matchPrivateModelCredential('pengbao', `${gateway}.evil.example`)).toBeUndefined()
    expect(seam.matchPrivateModelCredential('pengbao', 'https://api.example.com')).toBeUndefined()
    expect(seam.matchPrivateModelCredential('pengbao', undefined)).toBeUndefined()
    expect(() => seam.registerPrivateModelCredential({ provider: 'x', baseURL: gateway, apiKey: key })).toThrow('already registered')
    expect(patch).toContain('const privateKey = matchPrivateModelCredential(provider, profile.baseURL)')
    expect(patch.indexOf('const privateKey = matchPrivateModelCredential')).toBeLessThan(patch.indexOf('const credentials = ctx.get("credentials")'))
    expect(patch).toContain('registerPrivateModelCredential, supportedProtocols };')
  })

  it('sends a tool-call request and its correlated result through the real pi-ai adapter and gateway', async () => {
    const calls: { method: string; body?: Record<string, unknown>; auth?: string }[] = []
    const gateway = await startPengbaoGateway({
      jwt: 'private-jwt', timeoutMs: 100, chatIdleTimeoutMs: 500, chatMaxDurationMs: 5000,
      fetch: async (input, init) => {
        const url = new URL(String(input))
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
        calls.push({ method: init?.method ?? 'GET', body, auth: new Headers(init?.headers).get('authorization') ?? undefined })
        if (url.pathname.endsWith('/models')) return Response.json({ data: [{ id: 'known-tools-model' }] })
        const messages = body?.messages as Array<Record<string, unknown>> | undefined
        if (messages?.some(message => message.role === 'tool')) {
          return new Response(new ReadableStream<Uint8Array>({
            async start(controller) {
              for (const text of ['tool ', 'result ', 'received']) {
                await new Promise(resolve => setTimeout(resolve, 60))
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`))
              }
              controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
              controller.close()
            }
          }), { headers: { 'content-type': 'text/event-stream' } })
        }
        return new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_local_file","arguments":"{\\"path\\":\\"notes.txt\\"}"}}]}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      }
    })
    gateways.push(gateway)
    const providerModule = await import('@deepseek-ai/dsh-llm-pi-ai')
    providerModule.registerPrivateModelCredential({ provider: 'pengbao', baseURL: gateway.url, apiKey: gateway.capabilityToken })
    const baseURL = `${gateway.url}/v1`
    const piProvider = createProvider({
      id: 'pengbao', name: 'Pengbao', baseUrl: baseURL,
      auth: { apiKey: { name: 'Pengbao', resolve: async ({ credential }) => ({ auth: credential?.key ? { apiKey: credential.key } : {}, source: 'test' }) } },
      models: [{ id: 'known-tools-model', name: 'Tools Model', api: 'openai-completions', provider: 'pengbao', baseUrl: baseURL,
        input: ['text'] as const, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 8192, maxTokens: 1024 }],
      api: await openAICompletionsApi()
    })
    const profile: ResolvedPiAiProviderProfile = {
      provider: 'pengbao', displayName: 'Pengbao', api: 'openai-completions',
      baseURL, defaultInput: ['text'], streamIdleTimeoutMs: 5000, maxRequestImageBytes: 1024,
      requestImagePixelBudget: 1024, requestImageMaxBytes: 1024,
      configuredMaxTokens: new Map(), retryPolicy: resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'test'),
      modelErrors: new Map(), piProvider
    }
    const profiles: PiAiAdapterOptions['profiles'] = () => new Map([['pengbao', profile]])
    const adapter = new PiAiAdapter({
      profiles,
      resolveApiKey: async provider => {
        if (provider !== 'pengbao') throw new Error('provider missing')
        return gateway.capabilityToken
      },
      auth: {} as PiAiAdapterOptions['auth']
    })
    const tool = { name: 'read_local_file', description: 'Read one approved file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }
    const first = []
    for await (const chunk of adapter.stream({
      provider: 'pengbao', model: 'known-tools-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Read notes.txt' }] }], tools: [tool]
    } as Parameters<PiAiAdapter['stream']>[0])) first.push(chunk)
    const call = first.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(call).toMatchObject({ type: 'block-end', block: { id: 'call_1', name: 'read_local_file', arguments: '{"path":"notes.txt"}' } })
    const second = []
    for await (const chunk of adapter.stream({
      provider: 'pengbao', model: 'known-tools-model',
      messages: [
        createMessage({ role: 'assistant', source: { kind: 'model', provider: 'pengbao', model: 'known-tools-model' }, content: [{ type: 'tool-call', id: ToolCallId('call_1'), name: 'read_local_file', arguments: '{"path":"notes.txt"}' }] }),
        createMessage({ role: 'tool', source: { kind: 'tool', callId: ToolCallId('call_1') }, toolCallId: ToolCallId('call_1'), content: [{ type: 'text', text: 'file contents' }] })
      ]
    })) second.push(chunk)
    expect(second.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')).toBe('tool result received')
    expect(calls).toHaveLength(2)
    expect(calls.every(call => call.auth === 'Bearer private-jwt' && JSON.stringify(call.body?.features) === '{"memory":true}')).toBe(true)
    expect(calls[0]?.auth).toBe('Bearer private-jwt')
    expect(calls[0]?.body?.tools).toEqual([expect.objectContaining({ function: expect.objectContaining({ name: 'read_local_file' }) })])
    expect(calls[1]?.body?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', tool_calls: [expect.objectContaining({ id: 'call_1' })] }),
      expect.objectContaining({ role: 'tool', tool_call_id: 'call_1', content: 'file contents' })
    ]))
  })

  it('passes private messages over the utilityProcess adapter, not its fork spec', async () => {
    const native = new EventEmitter() as any
    native.stdout = new EventEmitter()
    native.stderr = new EventEmitter()
    native.kill = () => true
    native.postMessage = (message: unknown) => {
      expect(message).toMatchObject({ kind: 'dsh-desktop:private-model-delivery', capabilityToken: capability })
      queueMicrotask(() => native.emit('message', { kind: 'dsh-desktop:private-model-received' }))
    }
    const fork = (...args: unknown[]) => {
      expect(JSON.stringify(args)).not.toContain(capability)
      queueMicrotask(() => native.emit('message', { kind: 'dsh-desktop:private-model-ready' }))
      return native
    }
    const child = launchDisclaimedUtilityProcess({ fork: fork as any }, ['--expose-internals', entry, 'cli.mjs'], {
      env: { DSH_DESKTOP_PRIVATE_MODEL_HANDOFF: '1' }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] as any
    })
    await deliverPrivateHandoff(child, handoff, () => true, new AbortController().signal)
  })
})
