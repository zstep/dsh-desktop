import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startPengbaoGateway, type PengbaoGateway, type PengbaoModelDenial, type PluginConfigurationPolicy } from '../src/main/enterprise/gateway'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=', 'base64')
const revision = 'a'.repeat(64)
const policy: PluginConfigurationPolicy = { bindingId: 'fixture-binding', entryId: 'fixture-entry', packageName: '@fixture/imagegen', packageVersion: '1.0.0', capabilities: ['image.generate'], models: ['chosen'] }
const gateways: PengbaoGateway[] = []
afterEach(async () => { await Promise.all(gateways.splice(0).map(gateway => gateway.stop())) })

function json(body: unknown, headers?: HeadersInit) { return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...headers } }) }
async function fixture(options: { generation?: () => Response | Promise<Response>; bitmap?: () => Response; timeout?: number; declared?: boolean; serverOnly?: boolean; overIncluded?: string[]; onModelDenial?: (denial: PengbaoModelDenial) => void } = {}) {
  let defaultChat = 'chat-one'
  let defaultImage = 'chosen'
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    expect(url.origin).toBe('https://pengbao.ecombus.net')
    expect(init?.redirect).toBe('error')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-main-jwt')
    if (url.pathname === '/api/v1/auths/') return json({ role: 'user', permissions: { features: { image_generation: true } } })
    if (url.pathname === '/api/config') return json({ features: { enable_image_generation: true }, default_models: ` ${defaultChat},unavailable `, private: 'MAIN_SECRET' })
    if (url.pathname === '/api/v1/models') return json({ data: [
      { id: 'chat-one', alias: 'Chat One Alias', name: 'Chat One Name' },
      { id: 'chat-two', alias: 'Bad\nalias', name: 'Chat Two Name' },
      { id: 'chat-three', alias: { private: 'metadata' }, name: 'Bad\nname' },
      { id: ' bad-id ', alias: 'Invalid ID Alias', name: 'Invalid ID Name' },
      { id: 'chosen', alias: 'Image Alias', name: 'Image Name' }
    ] })
    if (url.pathname === '/api/v1/chat/completions') return json({ model: JSON.parse(String(init?.body)).model, choices: [] })
    if (url.pathname === '/api/v1/images/metadata') return json({ models: [{ id: 'chosen', name: 'Chosen' }, { id: 'second', name: 'Second' }, ...(options.overIncluded ?? []).map(id => ({ id, name: id }))], defaultModel: { id: defaultImage, name: 'Default' }, selection: options.serverOnly ? 'server-only' : 'request-local', catalogStatus: 'available',
      ...(options.declared === false ? {} : { generationParameters: { contractVersion: 1, revision, models: ['chosen', 'second'].map(id => ({ id, maxImages: 4, qualities: ['auto', 'high'], details: ['', 'high'] })) } }) }, { 'x-image-model-selection': 'request-local-v1' })
    if (url.pathname === '/api/v1/images/generations') return options.generation?.() ?? json([{ id: 'one', url: '/api/v1/files/one/content' }])
    if (url.pathname === '/api/v1/files/one/content' || url.pathname === '/api/v1/files/two/content') return options.bitmap?.() ?? new Response(PNG, { headers: { 'content-type': 'image/png' } })
    throw new Error('Unexpected upstream path')
  })
  const gateway = await startPengbaoGateway({ jwt: 'fixture-main-jwt', fetch: fetcher, imageTimeoutMs: options.timeout ?? 1000, onModelDenial: options.onModelDenial })
  gateways.push(gateway)
  return { gateway, fetcher, changeDefaults: (chat: string, image: string) => { defaultChat = chat; defaultImage = image } }
}
function post(gateway: PengbaoGateway, token: string, route: string, body: unknown, signal?: AbortSignal) {
  return fetch(`${gateway.url}${route}`, { method: 'POST', signal, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
}
async function issue(gateway: PengbaoGateway, candidate = policy) {
  const broker = gateway.createPluginConfigurationLease()
  const response = await post(gateway, broker.capabilityToken, '/v1/plugin-configuration/issue', candidate)
  expect(response.status).toBe(200)
  const child = await response.json() as { leaseId: string; gatewayUrl: string; capabilityToken: string }
  return { broker, child }
}
const generation = '/v1/images/generations'
const countGenerations = (fetcher: ReturnType<typeof vi.fn>) => fetcher.mock.calls.filter(([input]) => String(input).endsWith('/api/v1/images/generations')).length

describe('private per-plugin configuration gateway', () => {
  it('issues video access only through an approved broker policy and revokes it with the broker', async () => {
    let submissions = 0
    const gateway = await startPengbaoGateway({ jwt: 'fixture-jwt', fetch: async (input) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/v1/videos/proxy/models') return json({ data: [{ id: 'seedance', name: 'Seedance', provider: 'volcengine', protocol: 'ark' }] })
      if (path === '/api/v1/videos/proxy/submit/ark') { submissions++; return json({ id: 'a'.repeat(32), status: 'queued' }) }
      throw new Error('unexpected fixture path')
    } })
    gateways.push(gateway)
    const { broker, child } = await issue(gateway, { ...policy, capabilities: ['video.generate'], models: ['seedance'] })
    const route = '/v1/contents/generations/tasks'
    const input = { model: 'seedance', content: [{ type: 'text', text: 'fixture' }] }
    expect((await post(gateway, child.capabilityToken, route, input)).status).toBe(200)
    expect((await post(gateway, child.capabilityToken, route, { ...input, model: 'other' })).status).toBe(403)
    broker.revoke()
    expect((await post(gateway, child.capabilityToken, route, input)).status).toBe(401)
    expect(submissions).toBe(1)
  })
  it('returns only image models to an image plugin asking for its own catalog', async () => {
    const { gateway } = await fixture()
    const { child } = await issue(gateway, { ...policy, capabilities: ['image.generate', 'chat.completions'], models: ['chosen', 'chat-one'] })
    const response = await fetch(`${gateway.url}/v1/models?kind=image`, { headers: { authorization: `Bearer ${child.capabilityToken}` } })
    expect(response.status).toBe(200)
    const body = await response.json() as { data: { id: string }[] }
    expect(body.data.map(row => row.id)).toEqual(['chosen'])
  })

  it('keeps broker/chat/image credentials separate, validates exact routes/models and denies browser origins', async () => {
    const { gateway, fetcher } = await fixture()
    const { broker, child } = await issue(gateway)
    for (const token of [broker.capabilityToken, gateway.capabilityToken]) expect((await post(gateway, token, generation, { prompt: 'bird', model: 'chosen' })).status).toBe(401)
    expect((await post(gateway, child.capabilityToken, '/v1/chat/completions', { model: 'chosen', messages: [] })).status).toBe(404)
    expect((await post(gateway, child.capabilityToken, '/v1/chat/completions', { model: 'chosen', messages: [] })).status).toBe(404)
    for (const route of ['/v1/images/edits', `${generation}?x=1`, `${generation}/`, '/v1/image-generation/generate']) {
      expect((await post(gateway, child.capabilityToken, route, { prompt: 'bird', model: 'chosen' })).status).toBe(404)
    }
    expect((await post(gateway, child.capabilityToken, generation, { prompt: 'bird', model: 'other' })).status).toBe(403)
    expect((await post(gateway, child.capabilityToken, '/v1/plugin-configuration/issue', policy)).status).toBe(401)
    const browser = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${gateway.url}${generation}`, { method: 'POST', headers: { authorization: `Bearer ${child.capabilityToken}`, origin: 'null' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) })
      req.on('error', reject); req.end()
    })
    expect(browser).toBe(403)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('mints scoped leases for well-formed requests without re-approving the profile, and revokes stale plugin tokens', async () => {
    const { gateway, fetcher } = await fixture()
    const broker = gateway.createPluginConfigurationLease()
    for (const input of [{ ...policy, capabilities: [] }, { ...policy, models: [] }, { ...policy, url: 'https://evil.invalid' }]) {
      expect((await post(gateway, broker.capabilityToken, '/v1/plugin-configuration/issue', input)).status).toBe(403)
    }
    // The controller may change the requested scopes as long as the request stays well-formed.
    const chat = await post(gateway, broker.capabilityToken, '/v1/plugin-configuration/issue', { ...policy, capabilities: ['chat.completions'], models: ['chat-one'] })
    expect(chat.status).toBe(200)
    const changed = await chat.json() as { leaseId: string; capabilityToken: string }
    const response = await post(gateway, broker.capabilityToken, '/v1/plugin-configuration/issue', policy)
    const child = await response.json()
    expect((await post(gateway, broker.capabilityToken, '/v1/plugin-configuration/revoke', { leaseId: changed.leaseId })).status).toBe(200)
    expect((await post(gateway, broker.capabilityToken, '/v1/plugin-configuration/revoke', { leaseId: child.leaseId })).status).toBe(200)
    expect((await post(gateway, child.capabilityToken, generation, { prompt: 'bird', model: 'chosen' })).status).toBe(401)
    broker.revoke()
    expect((await post(gateway, broker.capabilityToken, '/v1/plugin-configuration/issue', policy)).status).toBe(401)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('explicitly revokes a still-approved child, cancels its pending generation and permits repeated release', async () => {
    const { gateway, fetcher } = await fixture({ generation: () => new Promise<Response>(() => {}) })
    const { broker, child } = await issue(gateway)
    const pending = post(gateway, child.capabilityToken, generation, { prompt: 'bird', model: 'chosen' })
    await vi.waitFor(() => expect(countGenerations(fetcher)).toBe(1))
    const release = await post(gateway, broker.capabilityToken, '/v1/plugin-configuration/revoke', { leaseId: child.leaseId })
    expect(release.status).toBe(200)
    expect(await release.json()).toEqual({ revoked: true })
    expect((await pending).status).toBe(401)
    expect((await post(gateway, child.capabilityToken, generation, { prompt: 'bird', model: 'chosen' })).status).toBe(401)
    expect((await post(gateway, broker.capabilityToken, '/v1/plugin-configuration/revoke', { leaseId: child.leaseId })).status).toBe(200)
    expect(countGenerations(fetcher)).toBe(1)
  })

  it('forwards current OpenWebUI image parameters through the configured API', async () => {
    const { gateway, fetcher } = await fixture({ generation: () => json([{ id: 'one', url: '/api/v1/files/one/content' }, { id: 'two', url: '/api/v1/files/two/content' }]) })
    const { child } = await issue(gateway)
    const response = await post(gateway, child.capabilityToken, generation, {
      prompt: 'bird', model: 'chosen', size: '2K', n: 2, quality: 'ultra', detail: 'cinematic', response_format: 'b64_json'
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: [{ b64_json: PNG.toString('base64') }, { b64_json: PNG.toString('base64') }] })
    const call = fetcher.mock.calls.find(([input]) => String(input).endsWith('/api/v1/images/generations'))
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      prompt: 'bird', model: 'chosen', size: '2K', n: 2, quality: 'ultra', detail: 'cinematic', response_format: 'b64_json'
    })
  })


  it('returns validated b64 only and never leaks supplier paths', async () => {
    const { gateway, fetcher } = await fixture()
    const { child } = await issue(gateway)
    const response = await post(gateway, child.capabilityToken, generation, { prompt: 'bird', model: 'chosen', quality: 'high', detail: 'high', response_format: 'b64_json' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: [{ b64_json: PNG.toString('base64') }] })
    const calls = fetcher.mock.calls.filter(([input]) => String(input).endsWith('/api/v1/images/generations'))
    expect(calls).toHaveLength(1)
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({ prompt: 'bird', model: 'chosen', n: 1, quality: 'high', detail: 'high', response_format: 'b64_json' })
  })

  it('accepts an OpenAI-compatible inline base64 response from the configured image service', async () => {
    const { gateway } = await fixture({ generation: () => json({ data: [{ b64_json: PNG.toString('base64') }] }) })
    const { child } = await issue(gateway)
    const response = await post(gateway, child.capabilityToken, generation, { prompt: 'bird', model: 'chosen' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: [{ b64_json: PNG.toString('base64') }] })
  })


  it.each([
    () => new Response('not a bitmap', { headers: { 'content-type': 'image/png' } }),
    () => new Response(PNG, { headers: { 'content-type': 'image/png', 'content-length': String(20 * 1024 * 1024 + 1) } })
  ])('rejects invalid or oversized images without regenerating', async bitmap => {
    const { gateway, fetcher } = await fixture({ bitmap })
    const { child } = await issue(gateway)
    expect((await post(gateway, child.capabilityToken, generation, { prompt: 'bird', model: 'chosen' })).ok).toBe(false)
    expect(countGenerations(fetcher)).toBe(1)
  })

  it('cancels deadlines and revocation even when transport ignores signal; never retries', async () => {
    const timed = await fixture({ generation: () => new Promise<Response>(() => {}), timeout: 80 })
    const timedChild = await issue(timed.gateway)
    expect((await post(timed.gateway, timedChild.child.capabilityToken, generation, { prompt: 'bird', model: 'chosen' })).status).toBe(504)
    expect(countGenerations(timed.fetcher)).toBe(1)
    const revocable = await fixture({ generation: () => new Promise<Response>(() => {}) })
    const { broker, child } = await issue(revocable.gateway)
    const pending = post(revocable.gateway, child.capabilityToken, generation, { prompt: 'bird', model: 'chosen' })
    await vi.waitFor(() => expect(countGenerations(revocable.fetcher)).toBe(1))
    broker.revoke()
    expect((await pending).status).toBe(401)
    expect(countGenerations(revocable.fetcher)).toBe(1)
  })

  it('stop aborts pending generation and closes the old endpoint without retry', async () => {
    const { gateway, fetcher } = await fixture({ generation: () => new Promise<Response>(() => {}) })
    const { child } = await issue(gateway)
    const pending = post(gateway, child.capabilityToken, generation, { prompt: 'bird', model: 'chosen' }).then(response => response.status, () => 0)
    await vi.waitFor(() => expect(countGenerations(fetcher)).toBe(1))
    await gateway.stop()
    expect(await pending).not.toBe(200)
    expect(countGenerations(fetcher)).toBe(1)
    expect(() => gateway.createPluginConfigurationLease()).toThrow()
  })

  it('lists only chat models for chat-only grants and preserves sanitized alias display metadata', async () => {
    const { gateway } = await fixture()
    const chatPolicy: PluginConfigurationPolicy = { ...policy, capabilities: ['chat.completions'], models: ['chat-one', 'chat-two', 'chat-three', 'chosen'] }
    const { child } = await issue(gateway, chatPolicy)
    const response = await fetch(`${gateway.url}/v1/models`, { headers: { authorization: `Bearer ${child.capabilityToken}` } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ object: 'list', data: [
      { id: 'chat-one', object: 'model', name: 'Chat One Alias' },
      { id: 'chat-two', object: 'model', name: 'Chat Two Name' },
      { id: 'chat-three', object: 'model', name: 'chat-three' }
    ] })
  })

  it('reports an ungranted chat model before making an upstream request', async () => {
    const denials: PengbaoModelDenial[] = []
    const { gateway, fetcher } = await fixture({ onModelDenial: denial => denials.push(denial) })
    const { child } = await issue(gateway, { ...policy, capabilities: ['chat.completions'], models: ['chat-one'] })
    expect((await post(gateway, child.capabilityToken, '/v1/chat/completions', { model: 'chat-two', messages: [] })).status).toBe(403)
    expect(denials).toEqual([{ kind: 'model-denial', requestId: expect.any(String), route: 'chat', model: 'chat-two', reason: 'not-granted' }])
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['https://user:private-secret@provider.invalid/v1', 'secret\nmodel', 'x'.repeat(256 * 1024)])('redacts unsafe rejected model identifiers in diagnostics', async model => {
    const denials: PengbaoModelDenial[] = []
    const { gateway, fetcher } = await fixture({ onModelDenial: denial => denials.push(denial) })
    const { child } = await issue(gateway, { ...policy, capabilities: ['chat.completions'], models: ['chat-one'] })
    expect((await post(gateway, child.capabilityToken, '/v1/chat/completions', { model, messages: [] })).status).toBe(403)
    expect(denials).toEqual([{ kind: 'model-denial', requestId: expect.any(String), route: 'chat', model: '[invalid-model]', reason: 'not-granted' }])
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('reports the precise reason a plugin chat model is denied', async () => {
    const denials: PengbaoModelDenial[] = []
    const { gateway } = await fixture({ onModelDenial: denial => denials.push(denial) })
    const chatPolicy: PluginConfigurationPolicy = { ...policy, capabilities: ['chat.completions'], models: ['chat-one', 'chosen', 'unavailable'] }
    const { child } = await issue(gateway, chatPolicy)
    expect((await post(gateway, child.capabilityToken, '/v1/chat/completions', { model: 'chosen', messages: [{ role: 'user', content: 'hello' }] })).status).toBe(403)
    expect((await post(gateway, child.capabilityToken, '/v1/chat/completions', { model: 'unavailable', messages: [{ role: 'user', content: 'hello' }] })).status).toBe(403)
    expect(denials).toEqual([
      { kind: 'model-denial', requestId: expect.any(String), route: 'chat', model: 'chosen', reason: 'image-classified' },
      { kind: 'model-denial', requestId: expect.any(String), route: 'chat', model: 'unavailable', reason: 'not-in-catalog' }
    ])
  })

  it('reports each model excluded from the chat listing', async () => {
    const denials: PengbaoModelDenial[] = []
    const { gateway } = await fixture({ onModelDenial: denial => denials.push(denial) })
    const chatPolicy: PluginConfigurationPolicy = { ...policy, capabilities: ['chat.completions'], models: ['chat-one', 'chosen', 'unavailable'] }
    const { child } = await issue(gateway, chatPolicy)
    const response = await fetch(`${gateway.url}/v1/models`, { headers: { authorization: `Bearer ${child.capabilityToken}` } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ object: 'list', data: [{ id: 'chat-one', object: 'model', name: 'Chat One Alias' }] })
    expect(denials).toEqual([
      { kind: 'model-denial', requestId: expect.any(String), route: 'models', model: 'chosen', reason: 'image-classified' },
      { kind: 'model-denial', requestId: expect.any(String), route: 'models', model: 'unavailable', reason: 'not-in-catalog' }
    ])
  })

  it('does not classify a text model over-included in the image catalog as image-only', async () => {
    const { gateway } = await fixture({ overIncluded: ['chat-one'] })
    const chatPolicy: PluginConfigurationPolicy = { ...policy, capabilities: ['chat.completions'], models: ['chat-one'] }
    const { child } = await issue(gateway, chatPolicy)
    expect((await post(gateway, child.capabilityToken, '/v1/chat/completions', { model: 'chat-one', messages: [{ role: 'user', content: 'hello' }] })).status).toBe(200)
    const listing = await fetch(`${gateway.url}/v1/models`, { headers: { authorization: `Bearer ${child.capabilityToken}` } })
    expect(await listing.json()).toEqual({ object: 'list', data: [{ id: 'chat-one', object: 'model', name: 'Chat One Alias' }] })
  })

  it('pins the shared-user memory feature on for every plugin chat', async () => {
    const { gateway, fetcher } = await fixture()
    const chatPolicy: PluginConfigurationPolicy = { ...policy, capabilities: ['chat.completions'], models: ['chat-one'] }
    const { child } = await issue(gateway, chatPolicy)
    const response = await post(gateway, child.capabilityToken, '/v1/chat/completions', {
      model: 'chat-one', messages: [{ role: 'user', content: 'hi' }]
    })
    expect(response.status).toBe(200)
    const call = fetcher.mock.calls.find(([input]) => String(input).endsWith('/api/v1/chat/completions'))!
    expect(JSON.parse(String(call[1]?.body)).features).toEqual({ memory: true })
  })

  it('drops non-memory feature flags and rejects a malformed features payload', async () => {
    const { gateway, fetcher } = await fixture()
    const chatPolicy: PluginConfigurationPolicy = { ...policy, capabilities: ['chat.completions'], models: ['chat-one'] }
    const { child } = await issue(gateway, chatPolicy)
    const ok = await post(gateway, child.capabilityToken, '/v1/chat/completions', {
      model: 'chat-one', messages: [{ role: 'user', content: 'hi' }], features: { web_search: true, image_generation: true, code_interpreter: true, voice: true }
    })
    expect(ok.status).toBe(200)
    const call = fetcher.mock.calls.find(([input]) => String(input).endsWith('/api/v1/chat/completions'))!
    expect(JSON.parse(String(call[1]?.body)).features).toEqual({ memory: true })
    expect((await post(gateway, child.capabilityToken, '/v1/chat/completions', {
      model: 'chat-one', messages: [{ role: 'user', content: 'hi' }], features: 'memory'
    })).status).toBe(400)
  })

  it('serves authenticated server defaults without internal config, and resolves aliases afresh without pin fallback', async () => {
    const { gateway, changeDefaults, fetcher } = await fixture()
    const chatPolicy: PluginConfigurationPolicy = { ...policy, capabilities: ['chat.completions'], models: ['pengbao-default-chat'] }
    const { child } = await issue(gateway, chatPolicy)
    const grant = gateway.createModelServiceGrant(['chat.completions'])
    const defaults = await fetch(`${gateway.url}/v1/model-service/defaults`, { headers: { authorization: `Bearer ${grant.capabilityToken}` } })
    expect(await defaults.json()).toEqual({ defaultModels: ['chat-one', 'unavailable'] })
    expect((await fetch(`${gateway.url}/v1/model-service/defaults`, { headers: { authorization: `Bearer ${child.capabilityToken}` } })).status).toBe(404)
    const complete = () => post(gateway, child.capabilityToken, '/v1/chat/completions', { model: 'pengbao-default-chat', messages: [{ role: 'user', content: 'hello' }] })
    expect(await (await complete()).json()).toEqual({ model: 'chat-one', choices: [] })
    changeDefaults('chat-two', 'second')
    expect(await (await complete()).json()).toEqual({ model: 'chat-two', choices: [] })
    changeDefaults('absent', 'second')
    expect((await complete()).status).toBe(403)
    expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith('/api/v1/chat/completions'))).toHaveLength(2)
    expect((await post(gateway, child.capabilityToken, '/v1/chat/completions', { model: 'pengbao-default-chat', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://evil.invalid' } }] }] })).status).toBe(400)
  })

  it.each([false, true])('resolves image default without pinning or forcing server-only model override: %s', async serverOnly => {
    const { gateway, changeDefaults, fetcher } = await fixture({ serverOnly })
    const { child } = await issue(gateway, { ...policy, models: ['pengbao-default-image'] })
    const generate = () => post(gateway, child.capabilityToken, generation, { prompt: 'bird', model: 'pengbao-default-image' })
    expect((await generate()).status).toBe(200)
    changeDefaults('chat-one', 'second')
    expect((await generate()).status).toBe(200)
    const calls = fetcher.mock.calls.filter(([input]) => String(input).endsWith('/api/v1/images/generations')).map(([, init]) => JSON.parse(String(init?.body)))
    expect(calls.map(body => body.model)).toEqual(serverOnly ? [undefined, undefined] : ['chosen', 'second'])
  })
})
