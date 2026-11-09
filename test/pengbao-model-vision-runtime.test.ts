import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import sharp from 'sharp'
import { expect, it } from 'vitest'
import { PengbaoClient } from '../src/main/enterprise/client'
import { startPengbaoGateway } from '../src/main/enterprise/gateway'
import { preparePengbaoProviderOverlay } from '../src/main/enterprise/provider-overlay'
import { HarnessRuntime } from '../src/main/runtime/harness-runtime'
import { resolveTestNodeExecutable } from './node-executable'

it('materializes server vision declarations and sends a stored image through the locked adapter and gateway', async () => {
  const project = resolve(import.meta.dirname, '..')
  const home = await mkdtemp(join(tmpdir(), 'pengbao-model-vision-'))
  const calls: Record<string, unknown>[] = []
  const jwt = 'vision-fixture-jwt-not-a-real-credential'
  const gateway = await startPengbaoGateway({ jwt, fetch: async (input, init) => {
    expect(String(input)).toBe('https://pengbao.ecombus.net/api/v1/chat/completions')
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${jwt}`)
    calls.push(JSON.parse(String(init?.body)))
    return new Response('data: {"choices":[{"delta":{"content":"fixture image received"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' }
    })
  } })
  let runtime: HarnessRuntime | undefined
  try {
    const catalogVision = getBuiltinModels('openai').find(model => model.input.includes('image'))
    if (!catalogVision) throw new Error('Installed OpenAI catalog must include a vision model')
    const models = await new PengbaoClient({ fetch: async () => Response.json({ data: [
      { id: 'vision', info: { meta: { capabilities: { vision: true } } } },
      { id: 'text', info: { meta: { capabilities: { vision: false } } } },
      { id: 'unknown' }
    ] }) }).models()
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } }).png().toBuffer()
    await mkdir(join(home, 'profiles'), { recursive: true })
    await symlink(join(project, 'node_modules'), join(home, 'profiles', 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(join(home, 'cordis.patch.yml'), `- id: llm-pi-ai
  config:
    providers:
      openai:
        api: openai-completions
        baseURL: ${gateway.url}/v1
        models:
          - id: ${catalogVision.id}
            input: [text]
`)
    const probe = join(home, 'probe.mjs')
    await writeFile(probe, `
export const inject = ['llm', 'attachments', 'connection'];
export function apply(ctx) {
  ctx.connection.fetch.register({ path: '/api/model-vision-fixture', methods: ['POST'], fetch: async request => {
    const action = new URL(request.url).searchParams.get('action');
    if (action === 'info') {
      const models = await Promise.all(['vision', 'text', 'unknown', 'legacy', 'empty'].map(async id => {
        const model = await ctx.llm.resolveModelInfo('pengbao', id);
        return { id, input: model.inputModalities };
      }));
      const catalog = await ctx.llm.resolveModelInfo('openai', ${JSON.stringify(catalogVision.id)});
      return Response.json({models, catalogInput: catalog.inputModalities});
    }
    try {
      const content = await ctx.attachments.admitPromptContent([
        {type:'text', text:'Describe this offline fixture'},
        {type:'image', mediaType:'image/png', data:${JSON.stringify(png.toString('base64'))}}
      ]);
      const chunks = [];
      for await (const chunk of ctx.llm.stream({
        provider:'pengbao', model:'vision',
        messages:[{role:'user', content}], signal:request.signal
      })) chunks.push(chunk);
      return Response.json({chunks});
    } catch (error) { return Response.json({code:error.code}, {status:422}); }
  }});
}
`)
    const patch = join(home, 'vision.patch.yml')
    await writeFile(patch, `${await readFile(join(project, 'build/dsh-desktop-safe.patch.yml'), 'utf8')}\n- insert:\n    - id: model-vision-fixture\n      name: ${JSON.stringify(pathToFileURL(probe).href)}\n`)
    const workspace = join(home, 'workspace')
    await mkdir(workspace)
    const activeRuntime = new HarnessRuntime({
      dshEntryPath: join(project, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
      nodeEntryPath: join(project, 'build/harness-node-entry.mjs'), nodeExecutablePath: resolveTestNodeExecutable(),
      dshPatchPath: patch, dshSafePatchPath: join(project, 'build/dsh-desktop-safe.patch.yml'),
      dshHome: home, logPath: join(home, 'runtime.log'), preferredPort: 0, startupTimeoutMs: 30_000,
      privateModelHandoff: () => ({ gatewayUrl: gateway.url, capabilityToken: gateway.capabilityToken }),
      providerOverlay: profile => preparePengbaoProviderOverlay(home, profile, {
        gatewayUrl: gateway.url, models: [...models, { id: 'legacy' }, { id: 'empty', input: [] }]
      }),
      launchProcess: (executable, args, options) => spawn(executable, args, options), onChanged() {}
    })
    runtime = activeRuntime
    await activeRuntime.start(workspace)
    const snapshot = activeRuntime.snapshot()
    expect(snapshot.phase, snapshot.logs.join('\n')).toBe('ready')
    if (!snapshot.url || !snapshot.authToken) throw new Error('Missing Harness endpoint')
    const login = await fetch(`${snapshot.url}/?token=${encodeURIComponent(snapshot.authToken)}`, { redirect: 'manual' })
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    await login.body?.cancel()
    const request = (action: string) => fetch(`${snapshot.url}/api/model-vision-fixture?action=${action}`, {
      method: 'POST', headers: { Cookie: cookie }, signal: AbortSignal.timeout(15_000)
    })
    const info = await request('info')
    expect(info.status).toBe(200)
    expect(await info.json()).toEqual({
      models: [
        { id: 'vision', input: ['text', 'image'] },
        { id: 'text', input: ['text'] },
        { id: 'unknown', input: ['text'] },
        { id: 'legacy', input: ['text'] },
        { id: 'empty', input: ['text'] }
      ],
      catalogInput: ['text']
    })
    expect(calls).toHaveLength(0)
    const rpc = async (method: string, args: unknown) => {
      const response = await fetch(`${snapshot.url}/api/${method}`, {
        method: 'POST', headers: { Cookie: cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args: { request: args } } }),
        signal: AbortSignal.timeout(15_000)
      })
      expect(response.status).toBe(200)
      return (await response.json()).result
    }
    const created = await rpc('session/create', { cwd: workspace })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const sessionId = created.value.sessionId
    const selected = await rpc('session/selectModel', { sessionId, provider: 'pengbao', model: 'text' })
    expect(selected.ok, JSON.stringify(selected)).toBe(true)
    const rejected = await rpc('session/prompt', {
      sessionId, requestId: randomUUID(), mode: 'queue',
      content: [{ type: 'image', mediaType: 'image/png', data: png.toString('base64') }]
    })
    expect(rejected).toMatchObject({ ok: false, error: {
      code: 'session/attachment-invalid', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' }
    } })
    expect(calls).toHaveLength(0)
    const accepted = await request('vision')
    const result = await accepted.json()
    expect(accepted.status, JSON.stringify(result) + '\n' + activeRuntime.snapshot().logs.join('\n')).toBe(200)
    expect(result.chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'fixture image received' }))
    expect(result.chunks).toContainEqual(expect.objectContaining({ type: 'finish', reason: expect.objectContaining({ kind: 'stop' }) }))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ model: 'vision', tools: [] })
    const messages = calls[0]?.messages as Array<{ role: string; content: Array<{ type: string; image_url?: { url: string } }> }>
    const image = messages.find(message => message.role === 'user')?.content.find(part => part.type === 'image_url')
    expect(image?.image_url?.url).toMatch(/^data:image\/(png|jpeg|webp);base64,/)
    const encoded = image!.image_url!.url.split(',')[1]!
    expect(await sharp(Buffer.from(encoded, 'base64')).metadata()).toMatchObject({ width: 8, height: 8 })
    const overlay = await readFile(join(home, 'pengbao-provider.patch.yml'), 'utf8')
    const log = await readFile(join(home, 'runtime.log'), 'utf8')
    for (const secret of [jwt, gateway.capabilityToken]) {
      expect(overlay).not.toContain(secret)
      expect(log).not.toContain(secret)
    }
  } finally {
    await runtime?.stop()
    await gateway.stop()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 60_000)
