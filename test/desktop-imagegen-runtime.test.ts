import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { build } from 'esbuild'
import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-official-bundles'
import { expect, it } from 'vitest'
import { startPengbaoGateway } from '../src/main/enterprise/gateway'
import { preparePengbaoProviderOverlay } from '../src/main/enterprise/provider-overlay'
import { HarnessRuntime } from '../src/main/runtime/harness-runtime'
import { discoverModelServiceConsumers } from '../src/main/state/model-service-discovery'
import { resolveTestNodeExecutable } from './node-executable'

const selectableImageModelIds = ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2', 'gemini-3-pro-image', 'gemini-3.1-flash-image']

it('loads the image studio in a temporary Harness and follows server image / current chat defaults', async () => {
  const project = resolve(import.meta.dirname, '..')
  const home = await mkdtemp(join(tmpdir(), 'desktop-imagegen-runtime-'))
  const workspace = join(home, 'workspace')
  await mkdir(workspace)
  const png = await sharp({ create: { width: 16, height: 12, channels: 4, background: '#12345680' } }).png().toBuffer()
  const jwt = 'imagegen-runtime-fixture-not-a-real-jwt'
  const images: unknown[] = []
  const parameterRevision = 'a'.repeat(64)
  const generationParameters = { contractVersion: 1, revision: parameterRevision, models: [{ id: 'dall-e-3', maxImages: 4, qualities: ['auto', 'low', 'medium', 'high'], details: ['', 'standard', 'high'] }] }
  const chats: unknown[] = []
  let selectedModelAvailable = true
  let partialBatch = false
  const imageModels = () => [{ id: 'gpt-image-1', name: 'GPT Image 1' }, ...(selectedModelAvailable ? [{ id: 'dall-e-3', name: 'DALL·E 3' }] : []), ...selectableImageModelIds.map(id => ({ id, name: id }))]
  const gateway = await startPengbaoGateway({ jwt, fetch: async (input, init) => {
    const url = new URL(String(input))
    expect(url.origin).toBe('https://pengbao.ecombus.net')
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${jwt}`)
    if (url.pathname === '/api/v1/models') return Response.json({ data: [{ id: 'chat-a', name: 'Fixture Chat Alpha' }, { id: 'chat-b', name: 'Fixture Chat Beta' }] })
    if (url.pathname === '/api/config') return Response.json({ features: { enable_image_generation: true }, default_models: 'chat-a' })
    if (url.pathname === '/api/v1/auths/') return Response.json({ role: 'user', permissions: { features: { image_generation: true } }, token: jwt })
    if (url.pathname === '/api/v1/images/metadata') return Response.json({
      defaultModel: { id: 'gpt-image-1', name: 'GPT Image 1' }, selection: 'request-local', catalogStatus: 'available',
      models: imageModels(), generationParameters
    }, { headers: { 'X-Image-Model-Selection': 'request-local-v1' } })
    if (url.pathname === '/api/v1/images/models') return Response.json(imageModels(), { headers: { 'X-Image-Model-Selection': 'request-local-v1' } })
    if (url.pathname === '/api/v1/images/generations') {
      const input = JSON.parse(String(init?.body))
      images.push(input)
      return Response.json(Array.from({ length: input.n ?? 1 }, (_, index) => ({ id: `fixture-${index}`, url: `/api/v1/files/fixture-${index}/content` })))
    }
    if (/^\/api\/v1\/files\/fixture-[0-3]\/content$/.test(url.pathname)) {
      if (partialBatch && url.pathname.endsWith('fixture-1/content')) return new Response('unavailable', { status: 502 })
      return new Response(png, { headers: { 'content-type': 'image/png' } })
    }
    if (url.pathname === '/api/v1/chat/completions') {
      chats.push(JSON.parse(String(init?.body)))
      return new Response('data: {"choices":[{"delta":{"reasoning_content":"private"}}]}\n\ndata: {"choices":[{"delta":{"content":"A blue flower in soft light"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }
    throw new Error(`Unexpected mock route: ${url.pathname}`)
  } })
  const probe = join(home, 'selection.mjs')
  await writeFile(probe, `
export const inject = ['agentDefaultModel', 'connection'];
export function apply(ctx) {
  ctx.connection.fetch.register({path:'/api/imagegen-fixture/select',methods:['POST'],fetch:async request=>{
    const {model}=await request.json();
    await ctx.agentDefaultModel.saveSelection({provider:'pengbao',model});
    return Response.json({ok:true});
  }});
}
`)
  const consumerId = 'fixture-model-service-consumer'
  const profileDirectory = join(home, 'profiles', 'web')
  const consumerDirectory = join(profileDirectory, 'node_modules', consumerId)
  await mkdir(consumerDirectory, { recursive: true })
  await writeFile(join(consumerDirectory, 'package.json'), JSON.stringify({ name: consumerId, version: '1.0.0', type: 'module', main: 'index.js',
    dsh: { bundle: { patch: 'cordis.patch.yml' }, modelService: { contractVersion: 1, capabilities: ['chat.completions', 'image.generate'] } } }))
  await writeFile(join(consumerDirectory, 'cordis.patch.yml'), `- insert:\n    - id: fixture-model-service-consumer\n      name: ${consumerId}\n`)
  await writeFile(join(consumerDirectory, 'index.js'), `
export const inject=['modelService','connection'];
export function apply(ctx){
  const scope=ctx.modelService.forConsumer('fixture-model-service-consumer');
  ctx.effect(()=>()=>scope.dispose());
  ctx.connection.fetch.register({path:'/api/model-service-fixture/use',methods:['POST'],fetch:async request=>{
    const input=await request.json();
    try{
      if(input.action==='image'){const bytes=await scope.image.generate('Fixture facade image');return Response.json({bytes:bytes.byteLength})}
      let text='';for await(const event of scope.chat.stream({messages:[{role:'user',content:[{type:'text',text:'Fixture facade chat'}]}]})){if(event.type==='text-delta')text+=event.text}
      return Response.json({text});
    }catch(error){return Response.json({code:error.code||'FAILED'})}
  }});
}
`)
  await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [...PROFILE_TEMPLATES.web!.bundles, consumerId] } } }))
  const patch = join(home, 'imagegen.patch.yml')
  await mkdir(join(home, 'profiles', 'web'), { recursive: true })
  // User preferences belong in the editable Profile, not the higher-priority host overlay.
  await writeFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), `- id: agent-default-model
  config:
    provider: pengbao
    model: chat-a
- id: imagegen
  config:
    desktopImageMode: inherit
    channels: []
    defaultChannelId: deleted-channel
    defaultModel: deleted-model
    channelSecrets:
      deleted-channel: orphaned-fixture-secret
`)
  await writeFile(patch, `${await readFile(join(project, 'build/dsh-desktop-safe.patch.yml'), 'utf8')}
- insert:
    - id: imagegen
      name: dsh-desktop-imagegen
    - id: imagegen-fixture
      name: ${JSON.stringify(pathToFileURL(probe).href)}
`)
  const leases: ReturnType<typeof gateway.createImageLease>[] = []
  const runtime = new HarnessRuntime({
    dshEntryPath: join(project, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
    nodeEntryPath: join(project, 'build/harness-node-entry.mjs'), nodeExecutablePath: resolveTestNodeExecutable(),
    dshPatchPath: patch, dshSafePatchPath: join(project, 'build/dsh-desktop-safe.patch.yml'),
    dshHome: home, logPath: join(home, 'runtime.log'), preferredPort: 0, startupTimeoutMs: process.env.DSH_TEST_IMAGEGEN_GUI === '1' ? 60_000 : 30_000,
    privateModelHandoff: () => ({ gatewayUrl: gateway.url, capabilityToken: gateway.capabilityToken }),
    privateModelServiceGrant: capabilities => gateway.createModelServiceGrant(capabilities),
    privateModelServiceConsumers: (profile, sourcePatch, overlays) => discoverModelServiceConsumers(home, profile,
      join(project, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), sourcePatch, overlays),
    providerOverlay: profile => preparePengbaoProviderOverlay(home, profile, { gatewayUrl: gateway.url, models: [{ id: 'chat-a', name: 'Fixture Chat Alpha' }, { id: 'chat-b', name: 'Fixture Chat Beta' }] }),
    privateImageLease: () => { const lease = gateway.createImageLease(); leases.push(lease); return { gatewayUrl: gateway.url, ...lease } },
    launchProcess: (executable, args, options) => spawn(executable, args, options), onChanged() {}
  })
  try {
    await runtime.start(workspace)
    const snapshot = runtime.snapshot()
    expect(snapshot.phase, snapshot.logs.join('\n')).toBe('ready')
    if (!snapshot.url || !snapshot.authToken) throw new Error('Missing Harness endpoint')
    const login = await fetch(`${snapshot.url}/?token=${encodeURIComponent(snapshot.authToken)}`, { redirect: 'manual' })
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    await login.body?.cancel()
    const post = async (path: string, body: unknown = {}) => {
      const response = await fetch(`${snapshot.url}${path}`, { method: 'POST', headers: { Cookie: cookie, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) })
      expect(response.status, await response.clone().text() + '\n' + runtime.snapshot().logs.join('\n')).toBe(200)
      return response.json()
    }
    const overview = async () => {
      const response = await fetch(`${snapshot.url}/api/model-service.overview`, { headers: { Cookie: cookie } })
      expect(response.status, await response.clone().text() + '\n' + runtime.snapshot().logs.join('\n')).toBe(200)
      return response.json()
    }
    const initialOverview = await overview()
    expect(initialOverview.consumers).toContainEqual(expect.objectContaining({ id: consumerId, state: 'not-connected', adapter: 'facade' }))
    expect(initialOverview.video).toEqual({ available: false, reason: 'unverified' })
    expect(initialOverview.editable).toEqual({ chat: false, image: false })
    expect(initialOverview.consumers).toContainEqual(expect.objectContaining({ id: 'dsh-desktop-imagegen', state: 'already-connected' }))
    expect(initialOverview.consumers.map((consumer: { id: string }) => consumer.id)).not.toEqual(expect.arrayContaining(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']))
    expect(await post('/api/model-service-fixture/use')).toEqual({ code: 'FORBIDDEN' })

    const skipped = await post('/api/model-service.plan', { action: 'connect-all', skipConsumerIds: [consumerId] })
    expect(skipped.candidates).toContainEqual({ id: consumerId, state: 'skipped' })
    expect(skipped.changes).toHaveLength(0)
    const connectionPlan = await post('/api/model-service.plan', { action: 'connect-all' })
    expect(connectionPlan.candidates).toContainEqual({ id: consumerId, state: 'ready' })
    const connectionReceipt = await post('/api/model-service.apply', { planId: connectionPlan.id })
    expect((await overview()).consumers).toContainEqual(expect.objectContaining({ id: consumerId, state: 'connected' }))
    expect(await post('/api/model-service-fixture/use'), runtime.snapshot().logs.join('\\n')).toEqual({ text: 'A blue flower in soft light' })
    expect(chats.at(-1)).toMatchObject({ model: 'chat-a' })
    expect(await post('/api/model-service-fixture/use', { action: 'image' })).toEqual({ bytes: png.byteLength })
    expect(images.at(-1)).toMatchObject({ prompt: 'Fixture facade image' })
    const persistedConnections = await readFile(join(profileDirectory, 'cordis.patch.yml'), 'utf8')
    expect(persistedConnections).toContain(consumerId)
    expect(persistedConnections).not.toContain(jwt)
    expect((await overview()).defaults.chat.model).toBe('chat-a')
    expect(await post('/api/model-service.rollback', { receiptId: connectionReceipt.receiptId })).toMatchObject({ state: 'rolled-back' })
    expect(await post('/api/model-service-fixture/use')).toEqual({ code: 'FORBIDDEN' })

    if (process.env.DSH_TEST_MODEL_SERVICE_GUI === '1') {
      await driveModelConnections(project, home, `${snapshot.url}/?token=${encodeURIComponent(snapshot.authToken)}`)
      expect((await overview()).consumers).toContainEqual(expect.objectContaining({ id: consumerId, state: 'not-connected' }))
    }
    images.length = 0
    chats.length = 0
    const described = await post('/api/dsh-imagegen/settings/describe')
    const namespaces = described.value?.namespaces ?? []
    expect(namespaces, JSON.stringify(described)).toContainEqual(expect.objectContaining({ host: expect.objectContaining({ image: expect.objectContaining({ active: true, ready: true, models: expect.arrayContaining([{ alias: 'gpt-image-1', id: 'gpt-image-1', name: 'GPT Image 1' }, { alias: 'desktop-managed', id: 'desktop-managed', name: 'GPT Image 1' }]), label: 'GPT Image 1' }), prompt: expect.objectContaining({ active: true, ready: true, label: 'Fixture Chat Alpha' }) }) }))
    const generated = await post('/api/dsh-imagegen/generate', { prompt: 'A blue flower', mode: 'text', size: '1024x768', n: 1 })
    expect(generated, JSON.stringify(generated)).toMatchObject({ ok: true, images: [expect.objectContaining({ b64: png.toString('base64'), mime: 'image/png' })] })
    expect(images).toEqual([{ prompt: 'A blue flower', size: '1024x768', n: 1 }])
    expect(chats).toHaveLength(0)
    expect(await post('/api/dsh-imagegen/image-models', { channelId: 'desktop-managed' })).toMatchObject({ ok: true, models: ['desktop-managed', 'gpt-image-1', 'dall-e-3', ...selectableImageModelIds], modelNames: { 'desktop-managed': 'GPT Image 1', 'gpt-image-1': 'GPT Image 1', 'dall-e-3': 'DALL·E 3', ...Object.fromEntries(selectableImageModelIds.map(id => [id, id])) } })
    expect(await post('/api/dsh-imagegen/generate', { prompt: 'A selected flower', model: 'gpt-image-1', channelId: 'desktop-managed', n: 1 })).toMatchObject({ ok: true })
    expect(images[1]).toEqual({ prompt: 'A selected flower', model: 'gpt-image-1', n: 1 })
    expect(await post('/api/dsh-imagegen/generate', { prompt: 'unknown', model: 'missing-model', channelId: 'desktop-managed', n: 1 })).toMatchObject({ ok: false })
    expect(images).toHaveLength(2)
    expect(await post('/api/dsh-imagegen/prompt-enhance/models')).toEqual({ ok: true, models: ['chat-a', 'chat-b'] })
    const enhanced = await post('/api/dsh-imagegen/prompt-enhance', { prompt: 'blue flower' })
    expect(enhanced).toMatchObject({ ok: true, prompt: 'A blue flower in soft light' })
    expect(chats).toEqual([expect.objectContaining({ model: 'chat-a' })])
    await post('/api/imagegen-fixture/select', { model: 'chat-b' })
    expect((await post('/api/dsh-imagegen/settings/describe')).value.namespaces[0].host.prompt.label).toBe('Fixture Chat Beta')
    expect(await post('/api/dsh-imagegen/prompt-enhance', { prompt: 'blue flower', mode: 'polish' })).toMatchObject({ ok: true })
    expect(chats).toHaveLength(2)
    expect(chats[1]).toMatchObject({ model: 'chat-b' })
    expect(await post('/api/dsh-imagegen/generate', { prompt: 'two flowers', n: 2 })).toMatchObject({ ok: false })
    expect(images).toHaveLength(2)
    const history = await post('/api/dsh-imagegen/history/list')
    expect(JSON.stringify(history)).toContain('A blue flower')
    const html = await fetch(snapshot.url, { headers: { Cookie: cookie } }).then(response => response.text())
    expect(html).toContain('dsh-desktop-imagegen')
    if (process.env.DSH_TEST_IMAGEGEN_CATALOG_GUI === '1') {
      await driveStudio(project, home, `${snapshot.url}/?token=${encodeURIComponent(snapshot.authToken)}`, true, png.toString('base64'))
      expect(images).toHaveLength(2)
      expect((await post('/api/dsh-imagegen/settings/describe')).value.namespaces[0].value.desktopImageModelId).toBe(selectableImageModelIds.at(-1))
      expect(await post('/api/dsh-imagegen/settings/mutate', { ns: 'dsh-imagegen', ops: [{ op: 'set', path: ['desktopImageModelId'], value: '' }] })).toMatchObject({ ok: true })
    }
    if (process.env.DSH_TEST_IMAGEGEN_GUI === '1') {
      try {
        await driveStudio(project, home, `${snapshot.url}/?token=${encodeURIComponent(snapshot.authToken)}`, false, png.toString('base64'))
      } catch (error) {
        console.log('GUI-RUNTIME-FAILURE '+JSON.stringify({ images, logs: runtime.snapshot().logs }))
        throw error
      }
      expect(images).toHaveLength(3)
      expect(images[2]).toMatchObject({ model: 'dall-e-3', n: 2, quality: 'high', detail: 'standard', parameterContractVersion: 1, parameterRevision })
      expect(chats).toHaveLength(3)
      expect(chats[2]).toMatchObject({ model: 'chat-b' })
      expect((await post('/api/dsh-imagegen/settings/describe')).value.namespaces[0].value.desktopImageModelId).toBe('dall-e-3')
      expect(await post('/api/dsh-imagegen/generate', { prompt: 'Saved model without an explicit request model', n: 1 })).toMatchObject({ ok: true })
      expect(images[3]).toMatchObject({ model: 'dall-e-3', prompt: 'Saved model without an explicit request model' })
    }
    const beforeBatch = images.length
    const batch = await post('/api/dsh-imagegen/generate', { prompt: 'Two declared images', model: 'dall-e-3', channelId: 'desktop-managed', n: 2, quality: 'high', detail: 'standard', parameterContractVersion: 1, parameterRevision })
    expect(batch).toMatchObject({ ok: true, images: [expect.objectContaining({ mime: 'image/png' }), expect.objectContaining({ mime: 'image/png' })] })
    expect(images).toHaveLength(beforeBatch + 1)
    expect(images.at(-1)).toMatchObject({ n: 2, quality: 'high', detail: 'standard', parameterContractVersion: 1, parameterRevision })
    const batchHistory = await post('/api/dsh-imagegen/history/list')
    expect(JSON.stringify(batchHistory)).toContain('Two declared images')
    partialBatch = true
    const partial = await post('/api/dsh-imagegen/generate', { prompt: 'One surviving batch image', model: 'dall-e-3', channelId: 'desktop-managed', n: 2, parameterContractVersion: 1, parameterRevision })
    expect(partial).toMatchObject({ ok: true, requested: 2, complete: false, images: [{ index: 0, mime: 'image/png' }], failures: [{ index: 1 }] })
    expect(partial.images[0].b64).toBe(png.toString('base64'))
    expect(partial.partialMessage).toMatch(/1\/2/)
    const partialHistory = await post('/api/dsh-imagegen/history/list')
    expect(JSON.stringify(partialHistory)).toContain('One surviving batch image')
    expect(images).toHaveLength(beforeBatch + 2)
    partialBatch = false
    const generatedCount = images.length
    selectedModelAvailable = false
    for (const path of ['/api/dsh-imagegen/generate', '/api/dsh-imagegen/tasks/submit']) {
      expect(await post(path, { prompt: 'Removed model', model: 'dall-e-3', channelId: 'desktop-managed', n: 1 })).toMatchObject({ ok: false, code: 'image-model-not-configured' })
      if (process.env.DSH_TEST_IMAGEGEN_GUI === '1') {
        expect(await post(path, { prompt: 'Saved removed model without an explicit request model', n: 1 })).toMatchObject({ ok: false, code: 'image-model-not-configured' })
      }
    }
    expect(images).toHaveLength(generatedCount)
    const mutate = async (ops: unknown[]) => post('/api/dsh-imagegen/settings/mutate', { ns: 'dsh-imagegen', ops })
    const imageHost = async () => (await post('/api/dsh-imagegen/settings/describe')).value.namespaces[0].host.image
    for (const mode of ['off', 'custom']) {
      expect(await mutate([{ op: 'set', path: ['desktopImageMode'], value: mode }])).toMatchObject({ ok: true })
      expect(await imageHost()).toMatchObject({ active: false, ready: false })
      expect(await post('/api/dsh-imagegen/generate', { prompt: 'Must not generate', n: 1 })).toMatchObject({ ok: false })
    }
    const customChannels = [{ id: 'custom-fixture', name: 'Custom fixture', apiUrl: 'https://fixture.invalid', models: [{ alias: 'custom-model', id: 'custom-model' }] }]
    expect(await mutate([
      { op: 'set', path: ['desktopImageMode'], value: 'inherit' },
      { op: 'set', path: ['channels'], value: customChannels }
    ])).toMatchObject({ ok: true })
    expect(await imageHost()).toMatchObject({ active: false, ready: false })
    expect(await mutate([{ op: 'set', path: ['channels'], value: [] }])).toMatchObject({ ok: true })
    expect(await imageHost()).toMatchObject({ active: true, ready: true, models: expect.arrayContaining(selectableImageModelIds.map(id => ({ alias: id, id, name: id }))) })
    const restored = (await post('/api/dsh-imagegen/settings/describe')).value.namespaces[0].value
    expect(restored).toMatchObject({ defaultChannelId: 'deleted-channel', defaultModel: 'deleted-model', channels: [] })
    expect(images).toHaveLength(generatedCount)
    await runtime.stop()
    expect(leases).toHaveLength(1)
    for (const lease of leases) {
      expect((await fetch(`${gateway.url}/v1/image-generation/status`, { headers: { Authorization: `Bearer ${lease.capabilityToken}` } })).status).toBe(401)
    }
    const logs = await readFile(join(home, 'runtime.log'), 'utf8')
    for (const secret of [jwt, gateway.capabilityToken, ...leases.map(lease => lease.capabilityToken)]) {
      expect(logs).not.toContain(secret)
      expect(html).not.toContain(secret)
      expect(JSON.stringify(described)).not.toContain(secret)
    }
  } finally {
    await runtime.stop()
    await gateway.stop()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, process.env.DSH_TEST_IMAGEGEN_GUI === '1' || process.env.DSH_TEST_MODEL_SERVICE_GUI === '1' ? 180_000 : 90_000)

async function driveModelConnections(project: string, home: string, url: string) {
  const electron: unknown = createRequire(import.meta.url)('electron')
  if (typeof electron !== 'string') throw new Error('Native Electron executable required')
  const screenshot = join(tmpdir(), `desktop-model-connections-${Date.now()}.png`)
  const script = join(home, 'model-connections-gui.cjs')
  await build({
    stdin: { resolveDir: project, loader: 'js', contents: `
const {app,BrowserWindow}=require('electron');
const {registerDesktopScheme,installDesktopProtocol}=require(${JSON.stringify(join(project, 'src/main/desktop-protocol.ts'))});
const assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(join(home, 'model-gui-data'))});
app.enableSandbox();
registerDesktopScheme();
app.whenReady().then(async()=>{
  installDesktopProtocol(name=>require('node:path').join(${JSON.stringify(join(project, 'build'))},name));
  const window=new BrowserWindow({width:1200,height:1050,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  window.webContents.on('console-message',event=>console.log('MODEL-GUI '+event.message));
  const js=source=>window.webContents.executeJavaScript(source);
  const wait=async(fn,label)=>{for(let i=0;i<150;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100))}throw Error(label+' timed out: '+await js('document.body.innerText'))};
  const click=labels=>js('(()=>{const labels='+JSON.stringify(labels)+';const root=document.querySelector("[data-testid=desktop-model-service-settings]")||document;const e=[...root.querySelectorAll("button,a,[role=button],[role=tab],[role=menuitem]")].find(e=>!e.disabled&&e.getClientRects().length&&labels.includes((e.innerText||e.getAttribute("aria-label")||e.title||"").trim()));if(!e)return false;e.click();return true})()');
  const open=async()=>{
    await wait(()=>js('document.querySelectorAll("button").length>0'),'Shell');
    await wait(()=>click(['Settings','设置']),'Open settings');
    await wait(()=>click(['Pengbao model foundation','鹏宝模型底座']),'Open primary model foundation');
    await wait(()=>js('!!document.querySelector("[data-testid=desktop-model-service-settings]")'),'Read primary model catalog');
  };
  await window.loadURL(${JSON.stringify(url)});
  await js('(()=>{const original=window.fetch;window.fetch=async(...args)=>{const response=await original(...args);if(!response.ok&&String(args[0]).includes("model-service"))console.log("MODEL-API-ERROR "+response.status+" "+await response.clone().text());return response}})()');
  await open();
  await wait(()=>js('(()=>{const root=document.querySelector("[data-testid=desktop-model-service-settings]");const cards=root?.querySelectorAll(".dshModelServiceCard")||[];return cards.length>=2&&!cards[0].querySelector("select")&&!cards[1].querySelector("select")&&root.innerText.includes("chat-a")&&root.innerText.includes("gpt-image-1")})()'),'Read-only server defaults');
  await wait(()=>js('(()=>{const root=document.querySelector("[role=dialog]");const e=[...(root||document).querySelectorAll("button,[role=tab]")].find(e=>e.getClientRects().length&&["Built-in plugins","内置插件"].includes(e.innerText.trim()));if(!e)return false;e.click();return true})()'),'Open compatibility plugin settings');
  await wait(()=>click(['Model connections','模型连接']),'Open compatibility model settings');
  await wait(()=>js('!!document.querySelector("[data-testid=desktop-model-service-settings]")'),'Same model component through legacy entry');
  await wait(()=>click(['Connect all compatible plugins','连接所有兼容插件']),'Preview connections');
  await wait(()=>js('document.querySelectorAll("[role=dialog] input[type=checkbox]").length===1'),'Connection preview');
  await js('document.querySelector("[role=dialog] input[type=checkbox]").click()');
  await wait(()=>js('(()=>{const e=document.querySelector("[role=dialog] input[type=checkbox]");return e&&!e.checked&&!e.disabled})()'),'Skip candidate');
  await js('document.querySelector("[role=dialog] input[type=checkbox]").click()');
  await wait(()=>js('(()=>{const e=document.querySelector("[role=dialog] input[type=checkbox]");return e&&e.checked&&!e.disabled})()'),'Reinclude candidate');
  await wait(()=>click(['Apply','应用']),'Apply connection');
  await wait(()=>js('fetch("/api/model-service.overview").then(r=>r.json()).then(v=>v.consumers.some(c=>c.id==="fixture-model-service-consumer"&&c.state==="connected"))'),'Persisted binding');
  await window.loadURL(window.webContents.getURL());
  await open();
  assert.equal(await js('document.querySelector("[data-testid=desktop-model-service-settings]").innerText.includes("fixture-model-service-consumer")'),true);
  await wait(()=>click(['Undo last change','撤销上次变更']),'Rollback after reload');
  await wait(()=>js('fetch("/api/model-service.overview").then(r=>r.json()).then(v=>v.consumers.some(c=>c.id==="fixture-model-service-consumer"&&c.state==="not-connected"))'),'Rollback binding');
  await wait(()=>js('(()=>{const root=document.querySelector("[data-testid=desktop-model-service-settings]");return root&&[...root.querySelectorAll("select")].every(e=>!e.disabled)&&[...root.querySelectorAll(".dshModelServiceCard")].some(e=>e.innerText.includes("fixture-model-service-consumer")&&/未连接|Not connected/.test(e.innerText))})()'),'Settled rollback UI');
  await wait(()=>js('[...document.querySelectorAll("img")].some(e=>e.src==="dsh-desktop://desktop/pengbao-b2-mark.png"&&e.complete&&e.naturalWidth>0)'),'Real desktop logo');
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const image=await window.webContents.capturePage();require('node:fs').writeFileSync(${JSON.stringify(screenshot)},image.toPNG());
  console.log('MODEL-GUI-PASSED defaults preview skip reinclude apply reload rollback');
  console.log('MODEL-GUI-SCREENSHOT '+${JSON.stringify(screenshot)});
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
setTimeout(()=>app.exit(2),65000);
` }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: script
  })
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: home }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [script], { cwd: project, env, signal: AbortSignal.timeout(70_000), stdio: 'pipe' })
  let output = ''
  child.stdout.on('data', part => { output += String(part) })
  child.stderr.on('data', part => { output += String(part) })
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  console.log(output)
  expect(code, output).toBe(0)
  expect(output).toContain('MODEL-GUI-PASSED')
}

async function driveStudio(project: string, home: string, url: string, catalogOnly = false, expectedPngBase64 = '') {
  const electron: unknown = createRequire(import.meta.url)('electron')
  if (typeof electron !== 'string') throw new Error('Native Electron executable required')
  const screenshot = join(tmpdir(), `desktop-imagegen-${Date.now()}.png`)
  const script = join(home, 'studio-gui.cjs')
  const logo = await sharp(join(project, 'build/pengbao-b2-mark.png')).metadata()
  // Compile the real main-process handler into the isolated fixture rather than
  // teaching Chromium a fake scheme or inferring a production asset failure.
  await build({
    stdin: { resolveDir: project, loader: 'js', contents: `
const {app,BrowserWindow}=require('electron');
const {registerDesktopScheme,installDesktopProtocol}=require(${JSON.stringify(join(project, 'src/main/desktop-protocol.ts'))});
const assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(join(home, 'gui-data'))});
for(const name of ['logs','crashDumps']){
  const directory=require('node:path').join(${JSON.stringify(home)},'gui-'+name);
  require('node:fs').mkdirSync(directory,{recursive:true});app.setPath(name,directory);
}
app.enableSandbox();
registerDesktopScheme();
app.whenReady().then(async()=>{
  installDesktopProtocol(name=>require('node:path').join(${JSON.stringify(join(project, 'build'))},name));
  const window=new BrowserWindow({width:1400,height:1000,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  const downloads=[];
  window.webContents.session.on('will-download',(_event,item)=>{
    const target=require('node:path').join(${JSON.stringify(home)},'fixture-'+item.getFilename());
    item.setSavePath(target);
    item.once('done',(_event,state)=>{if(state==='completed')downloads.push(target)});
  });
  window.webContents.on('console-message',event=>console.log('GUI '+event.message));
  window.webContents.session.webRequest.onCompleted({urls:['http://127.0.0.1/*']},details=>{if(details.url.includes('/tasks/'))console.log('GUI-TASK-HTTP '+JSON.stringify({path:new URL(details.url).pathname,status:details.statusCode}));});
  await window.loadURL(${JSON.stringify(url)});
  if(${JSON.stringify(catalogOnly)})await window.webContents.executeJavaScript('(()=>{const original=window.fetch;window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).includes("/api/dsh-imagegen/settings/mutate")){const result=await response.clone().json();if(!result.ok)console.log("GUI-MUTATION-REFUSAL "+JSON.stringify({code:result.code,message:result.message}));}return response;};})()');
  const wait=async(fn,label='UI condition')=>{
    for(let i=0;i<150;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}
    console.log('GUI-TIMEOUT '+label+' '+await window.webContents.executeJavaScript('JSON.stringify({text:document.body.innerText,buttons:[...document.querySelectorAll("button")].filter(e=>e.getClientRects().length>0).map(e=>({text:e.innerText,label:e.getAttribute("aria-label"),title:e.title,disabled:e.disabled})),textareas:[...document.querySelectorAll("textarea")].map(e=>({value:e.value,visible:e.getClientRects().length>0})),images:[...document.querySelectorAll("img")].map(e=>({src:e.src.slice(0,100),complete:e.complete,width:e.naturalWidth,height:e.naturalHeight,visible:e.getClientRects().length>0,parent:e.parentElement.outerHTML.slice(0,1200)})),previewGrids:document.querySelectorAll("[data-result-preview-grid]").length})'));
    const image=await window.webContents.capturePage();require('fs').writeFileSync(${JSON.stringify(screenshot)},image.toPNG());
    console.log('GUI-FAILURE-SCREENSHOT '+${JSON.stringify(screenshot)});
    throw Error(label+' timed out');
  };
  // Hidden workspaces can contain the same labels; choose an actionable match,
  // rather than repeatedly finding a hidden control before the visible one.
  const click=async(text)=>window.webContents.executeJavaScript('(()=>{const e=[...document.querySelectorAll("button,a,[role=button],[role=menuitem],[role=menuitemradio],[role=tab]")].find(e=>!e.disabled&&e.getClientRects().length>0&&(e.innerText||e.getAttribute("aria-label")||e.title||"").trim()==='+JSON.stringify(text)+');if(e){e.click();return true}return false})()');
  const logoState=()=>window.webContents.executeJavaScript('JSON.stringify([...document.querySelectorAll("img")].filter(e=>e.src==="dsh-desktop://desktop/pengbao-b2-mark.png"&&e.getClientRects().length>0).map(e=>({src:e.src,complete:e.complete,width:e.naturalWidth,height:e.naturalHeight})))');
  const checkLogo=async()=>{
    await wait(async()=>JSON.parse(await logoState()).some(e=>e.complete&&e.width===${JSON.stringify(logo.width)}&&e.height===${JSON.stringify(logo.height)}),'Desktop Logo load');
    console.log('GUI-LOGO '+await logoState());
  };
  await wait(()=>window.webContents.executeJavaScript('document.querySelectorAll("button").length>0'),'Initial shell controls');
  await checkLogo();
  console.log('GUI-CONTROLS '+await window.webContents.executeJavaScript('JSON.stringify([...document.querySelectorAll("button,a,[role=button],[role=tab]")].map(e=>({text:e.innerText,label:e.getAttribute("aria-label"),title:e.title})))'));
  await wait(()=>click('Image').then(async ok=>ok||await click('生图')),'Image studio navigation');
  await wait(()=>window.webContents.executeJavaScript('!!document.querySelector("textarea")'),'Studio prompt control');
  console.log('GUI-STUDIO '+await window.webContents.executeJavaScript('document.body.innerText'));
  await wait(()=>window.webContents.executeJavaScript('(()=>{const q=document.querySelector("[data-testid=imagegen-quality-high]");const n=document.querySelector("[data-testid=imagegen-count-2]");const d=document.querySelector("[data-testid=imagegen-detail-high]");const status=document.querySelector("[data-managed-parameter-status]");return q?.disabled&&n?.disabled&&d?.disabled&&!!status?.innerText})()'),'Undeclared model options disabled with reason');
  await wait(()=>window.webContents.executeJavaScript('(()=>{const e=[...document.querySelectorAll("button[aria-haspopup=menu]")].find(button=>button.title.includes("GPT Image 1"));if(!e||e.disabled)return false;e.click();return true})()'),'Open managed model menu');
  await wait(()=>click('Pengbao'),'Open managed channel model choices');
  const requiredModels=${JSON.stringify(selectableImageModelIds)};
  await wait(()=>window.webContents.executeJavaScript('JSON.stringify([...document.querySelectorAll("[role=menuitem],[role=menuitemradio]")].filter(e=>e.getClientRects().length>0&&!e.hasAttribute("disabled")&&e.getAttribute("aria-disabled")!=="true").map(e=>e.innerText.trim()))').then(value=>requiredModels.every(id=>JSON.parse(value).includes(id))),'All five managed image models in picker');
  console.log('GUI-MODEL-PICKER '+JSON.stringify(requiredModels));
  if(${JSON.stringify(catalogOnly)}){
    for(const id of requiredModels){
      await wait(()=>click(id),'Select '+id);
      await wait(()=>window.webContents.executeJavaScript('fetch("/api/dsh-imagegen/settings/describe",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}).then(r=>r.json()).then(r=>r.value?.namespaces?.some(n=>n.value?.desktopImageModelId==='+JSON.stringify(id)+'))'),'Save '+id);
      if(id!==requiredModels.at(-1)){
        await wait(()=>window.webContents.executeJavaScript('(()=>{const e=[...document.querySelectorAll("button[aria-haspopup=menu]")].find(e=>e.getClientRects().length>0&&e.title.includes('+JSON.stringify(id)+'));if(!e||e.disabled)return false;e.click();return true})()'),'Reopen selected model menu');
        await wait(()=>click('Pengbao'),'Reopen managed channel');
      }
    }
    await window.loadURL(window.webContents.getURL());
    await wait(()=>click('Image').then(async ok=>ok||await click('生图')),'Reload studio');
    await wait(()=>window.webContents.executeJavaScript('[...document.querySelectorAll("button[aria-haspopup=menu]")].some(e=>e.getClientRects().length>0&&e.title.includes("gemini-3.1-flash-image"))'),'Reload last selected model');
    const image=await window.webContents.capturePage();require('fs').writeFileSync(${JSON.stringify(screenshot)},image.toPNG());
    console.log('GUI-CATALOG-PERSISTENCE all five selections saved; last selection survives reload');
    console.log('GUI-SCREENSHOT '+${JSON.stringify(screenshot)});
    app.exit(0);return;
  }
  await wait(()=>click('DALL·E 3'),'Select DALL·E 3');
  await wait(()=>window.webContents.executeJavaScript('[...document.querySelectorAll("button[aria-haspopup=menu]")].some(button=>button.title.includes("DALL·E 3"))'),'Selected model display');
  const selectedOnServer=()=>window.webContents.executeJavaScript('fetch("/api/dsh-imagegen/settings/describe",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}).then(r=>r.json()).then(r=>r.value?.namespaces?.some(n=>n.value?.desktopImageModelId==="dall-e-3"))');
  console.log('GUI-SELECTED-SETTINGS '+await window.webContents.executeJavaScript('fetch("/api/dsh-imagegen/settings/describe",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}).then(r=>r.json()).then(r=>JSON.stringify(r.value?.namespaces?.map(n=>({ns:n.ns,model:n.value?.desktopImageModelId,user:n.user?.desktopImageModelId,host:n.host?.image&&{active:n.host.image.active,id:n.host.image.id,models:n.host.image.models}}))??r))'));
  try{await wait(selectedOnServer,'Managed image selection persistence')}catch(error){console.log('GUI-SELECTION-FAILURE '+await window.webContents.executeJavaScript('JSON.stringify({triggers:[...document.querySelectorAll("button[aria-haspopup=menu]")].map(e=>({label:e.getAttribute("aria-label"),title:e.title})),alerts:[...document.querySelectorAll("[role=alert]")].map(e=>e.innerText)})'));throw error};
  await window.loadURL(window.webContents.getURL());
  await wait(()=>window.webContents.executeJavaScript('document.querySelectorAll("button").length>0'),'Reloaded shell controls');
  // Re-enter the workspace even if navigation restored the general chat shell.
  await wait(()=>click('Image').then(async ok=>ok||await click('生图')),'Image studio navigation');
  await wait(()=>window.webContents.executeJavaScript('[...document.querySelectorAll("button[aria-haspopup=menu]")].some(button=>button.title.includes("DALL·E 3"))'),'Reloaded managed image selection');
  assert.equal(await selectedOnServer(),true);
  await checkLogo();
  console.log('GUI-PERSISTENCE dall-e-3 after full page reload');
  const editControl=await window.webContents.executeJavaScript('(()=>{const e=[...document.querySelectorAll("[role=tablist] button")].find(e=>["Image to image","Image-to-image","图生图"].includes(e.innerText.trim()));return e?{disabled:e.disabled,title:e.title}:null})()');
  assert.equal(editControl?.disabled,true,'Managed image-to-image tab must be disabled');
  assert.ok(editControl.title,'Disabled edit mode should explain the unsupported operation');
  await window.webContents.executeJavaScript('(()=>{const e=[...document.querySelectorAll("[role=tablist] button")].find(e=>["Image to image","Image-to-image","图生图"].includes(e.innerText.trim()));e.click()})()');
  assert.equal(await window.webContents.executeJavaScript('[...document.querySelectorAll("[data-edit-references]")].some(e=>e.getClientRects().length>0)'),false,'Disabled edit tab must not expose reference upload');
  console.log('GUI-UNSUPPORTED-EDIT '+JSON.stringify(editControl));
  await wait(()=>click('E-commerceBeta').then(async ok=>ok||await click('电商模式预览')),'Ecommerce workspace navigation');
  await wait(()=>window.webContents.executeJavaScript('[...document.querySelectorAll("[data-ecommerce-upload]")].some(e=>e.getClientRects().length>0)'),'Ecommerce reference controls');
  const referenceControls=await window.webContents.executeJavaScript('[...document.querySelectorAll("[data-ecommerce-upload]")].filter(e=>e.getClientRects().length>0).map(e=>({disabled:e.disabled,description:e.getAttribute("aria-description")}))');
  assert.ok(referenceControls.length>0&&referenceControls.every(e=>e.disabled&&e.description),'Managed reference image uploads must be disabled with an explanation');
  console.log('GUI-UNSUPPORTED-REFERENCES '+JSON.stringify(referenceControls));
  await wait(()=>click('Standard').then(async ok=>ok||await click('普通生图')),'Return to standard workspace');
  const parameter = id => window.webContents.executeJavaScript('(()=>{const e=[...document.querySelectorAll("[data-testid='+id+']")].find(e=>e.getClientRects().length>0);if(!e||e.disabled)return false;e.click();return true})()');
  await wait(()=>parameter('imagegen-quality-high'),'Select declared provider quality');
  await wait(()=>parameter('imagegen-count-2'),'Select declared batch count');
  await wait(()=>parameter('imagegen-detail-standard'),'Select declared generation detail');
  await window.webContents.executeJavaScript('(()=>{const e=[...document.querySelectorAll("textarea")].find(e=>e.getClientRects().length>0);Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(e,"A blue flower");e.dispatchEvent(new Event("input",{bubbles:true}))})()');
  await wait(()=>click('Enhance').then(async ok=>ok||await click('增强')),'Prompt enhance action');
  await wait(()=>window.webContents.executeJavaScript('[...document.querySelectorAll("textarea")].some(e=>e.value==="A blue flower in soft light")'),'Enhanced prompt response');
  await wait(()=>click('Generate').then(async ok=>ok||await click('开始生成')),'Generate action');
  await wait(()=>window.webContents.executeJavaScript('[...document.querySelectorAll("[data-result-preview-grid] img")].filter(e=>e.getClientRects().length>0&&e.complete&&e.naturalWidth===16&&e.naturalHeight===12).length===2&&[...document.querySelectorAll("button")].some(e=>!e.disabled&&["Generate","开始生成"].includes(e.innerText.trim()))'),'Two generated previews loaded and generate action available');
  await window.webContents.executeJavaScript('(()=>{const links=[...document.querySelectorAll("a[download]")].filter(e=>e.getClientRects().length>0&&e.download.startsWith("dsh-image-"));if(links.length!==2)throw Error("Expected two independently savable images");links.forEach(e=>e.click())})()');
  await wait(async()=>downloads.length===2,'Save both generated images into temporary profile');
  for(const target of downloads)assert.equal(require('node:fs').readFileSync(target).toString('base64'),${JSON.stringify(expectedPngBase64)});
  console.log('GUI-BATCH-SAVED '+downloads.length);
  await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await new Promise(resolve=>setTimeout(resolve,500));
  console.log('GUI-RESULT '+await window.webContents.executeJavaScript('JSON.stringify({text:document.body.innerText.slice(-1200),images:[...document.querySelectorAll("[data-result-preview-grid] img")].map(e=>({src:e.src.slice(0,60),width:e.naturalWidth,height:e.naturalHeight,rect:e.getBoundingClientRect().toJSON()}))})'));
  const image=await window.webContents.capturePage();require('fs').writeFileSync(${JSON.stringify(screenshot)},image.toPNG());
  console.log('GUI-SCREENSHOT '+${JSON.stringify(screenshot)});
  await window.webContents.executeJavaScript('document.querySelector("[data-result-preview-grid] img").click()');
  await wait(()=>window.webContents.executeJavaScript('[...document.querySelectorAll("button")].some(e=>e.getClientRects().length>0&&["Add to image to image","添加到图生图"].includes(e.innerText.trim())&&e.disabled&&!!e.title)'),'Disabled result edit control');
  console.log('GUI-UNSUPPORTED-RESULT-EDIT disabled');
  await wait(()=>click('Close').then(async ok=>ok||await click('关闭')),'Close generated image preview');
  await wait(()=>click('Settings').then(async ok=>ok||await click('设置')),'Open settings');
  await wait(()=>click('Image settings').then(async ok=>ok||await click('生图配置')),'Open image settings');
  await wait(()=>window.webContents.executeJavaScript('[...document.querySelectorAll("[data-dsh-imagegen-settings-panel]")].some(e=>e.getClientRects().length>0&&e.innerText.includes("Fixture Chat Beta"))'),'Friendly prompt model display');
  await wait(()=>window.webContents.executeJavaScript('(()=>{const root=document.querySelector("[data-dsh-imagegen-settings-panel]");const e=[...(root||document).querySelectorAll("button[aria-expanded]")].find(e=>e.getClientRects().length>0&&/^(Prompt enhancement model|提示词增强模型)/.test(e.innerText.trim()));if(!e)return false;if(e.getAttribute("aria-expanded")!=="true")e.click();return true})()'),'Expand prompt enhancement settings');
  await wait(()=>click('Fetch available models').then(async ok=>ok||await click('获取可用模型')),'Fetch managed prompt models');
  await wait(()=>window.webContents.executeJavaScript('(()=>{const root=[...document.querySelectorAll("[role=radiogroup]")].find(e=>e.getClientRects().length>0&&["Detected chat model candidates","检测到的候选对话模型"].includes(e.getAttribute("aria-label")));if(!root)return false;const candidates=[...root.querySelectorAll("button[role=radio]")];return candidates.length===2&&candidates.some(e=>e.innerText==="chat-a")&&candidates.some(e=>e.innerText==="chat-b")})()'),'Managed prompt model candidates');
  assert.equal(await window.webContents.executeJavaScript('[...document.querySelectorAll("button[role=radio]")].filter(e=>e.getClientRects().length>0&&["chat-a","chat-b"].includes(e.innerText)).every(e=>e.disabled)'),true,'Managed prompt candidates must not write a standalone model without endpoint credentials');
  assert.equal(await window.webContents.executeJavaScript('(()=>{const e=[...document.querySelectorAll("button[role=radio]")].find(e=>e.innerText==="chat-a");e.click();return [...document.querySelectorAll("button")].filter(e=>["Save","保存"].includes(e.innerText.trim())).every(e=>e.disabled)})()'),true,'Clicking a managed candidate must not create unsaved standalone configuration');
  await window.webContents.executeJavaScript('(()=>{const e=document.querySelector("[data-dsh-imagegen-host-service=prompt] select");e.value="custom";e.dispatchEvent(new Event("change",{bubbles:true}))})()');
  await wait(()=>window.webContents.executeJavaScript('[...document.querySelectorAll("button[role=radio]")].filter(e=>["chat-a","chat-b"].includes(e.innerText)).length===0'),'Staged custom mode clears managed candidates');
  assert.equal(await window.webContents.executeJavaScript('(()=>{const buttons=[...document.querySelectorAll("button")].filter(e=>["+ Add manually","+ 手动添加"].includes(e.innerText.trim()));return buttons.length===1&&!buttons[0].disabled})()'),true,'Explicit custom draft permits manual model configuration');
  assert.equal(await window.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(e=>["Fetch available models","获取可用模型"].includes(e.innerText.trim())).disabled'),true,'Unsaved provider changes must not fetch candidates from the saved provider');
  await window.webContents.executeJavaScript('(()=>{const e=document.querySelector("[data-dsh-imagegen-host-service=prompt] select");e.value="inherit";e.dispatchEvent(new Event("change",{bubbles:true}))})()');
  await wait(()=>click('Fetch available models').then(async ok=>ok||await click('获取可用模型')),'Refresh restored managed candidates');
  await window.webContents.executeJavaScript('document.querySelector("[role=radiogroup]")?.scrollIntoView({block:"center"})');
  console.log('GUI-PROMPT-MODELS chat-a,chat-b; managed selection remains read-only');
  const modelScreenshot=${JSON.stringify(screenshot.replace('.png', '-models.png'))};
  require('fs').writeFileSync(modelScreenshot,(await window.webContents.capturePage()).toPNG());
  console.log('GUI-MODELS-SCREENSHOT '+modelScreenshot);
  await wait(()=>click('Manage model foundation').then(async ok=>ok||await click('管理模型底座')),'Open image settings foundation shortcut');
  await wait(()=>window.webContents.executeJavaScript('!!document.querySelector("[data-testid=desktop-model-service-settings]")'),'Foundation shortcut navigates to the same settings component');
  console.log('GUI-FOUNDATION-SHORTCUT primary settings component opened');
  console.log('GUI-FRIENDLY-MODEL Fixture Chat Beta');
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
setTimeout(()=>app.exit(2),65000);
` },
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: script
  })
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: home }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [script], { cwd: home, env, signal: AbortSignal.timeout(70_000), stdio: 'pipe' })
  let output = ''
  child.stdout.on('data', part => { output += String(part) })
  child.stderr.on('data', part => { output += String(part) })
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  console.log(output)
  expect(code, output).toBe(0)
  const evidenceLines = catalogOnly
    ? ['GUI-LOGO ', 'GUI-MODEL-PICKER '+JSON.stringify(selectableImageModelIds), 'GUI-CATALOG-PERSISTENCE all five selections saved; last selection survives reload', 'GUI-SCREENSHOT ']
    : ['GUI-LOGO ', 'GUI-MODEL-PICKER '+JSON.stringify(selectableImageModelIds), 'GUI-PERSISTENCE dall-e-3 after full page reload', 'GUI-UNSUPPORTED-EDIT ', 'GUI-UNSUPPORTED-REFERENCES ', 'GUI-UNSUPPORTED-RESULT-EDIT disabled', 'GUI-FRIENDLY-MODEL Fixture Chat Beta', 'GUI-SCREENSHOT ']
  for (const evidence of evidenceLines) {
    expect(output).toContain(evidence)
  }
}
