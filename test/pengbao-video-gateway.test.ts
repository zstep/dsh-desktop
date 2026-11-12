import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVideoGateway, type PengbaoVideoFailure } from '../src/main/enterprise/video-gateway'

const MP4 = Buffer.from('00000018667479706d703432000000006d70343169736f6d', 'hex')
const ORIGIN = 'https://pengbao.ecombus.net'
const SUBMIT = '/api/v1/videos/generations'
const STATUS = (id: string) => `/api/v1/videos/generations/${id}`
const RELAY_CONTENT = (id: string) => `/api/v1/videos/videos/${id}/content`
const MODEL = 'happyhorse-1.1-t2v'
type VideoGateway = ReturnType<typeof createVideoGateway> & { url: string }
const gateways: VideoGateway[] = []
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.stop()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve())
    server.closeAllConnections()
  })))
})

type Seen = { method: string; path: string; headers: IncomingMessage['headers']; body: string }
function sendJson(res: ServerResponse, value: unknown) {
  res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'token=private-fixture-jwt', 'x-secret': 'private-fixture-jwt' })
  res.end(JSON.stringify(value))
}
function submit(res: ServerResponse, id = 'task_1') { sendJson(res, { task_id: id, status: 'pending', model: MODEL, prompt: 'PRIVATE_PROMPT' }) }
function status(res: ServerResponse, value: Record<string, unknown>) {
  sendJson(res, { code: 'success', data: { task_id: 'task_1', platform: 'alibaba', ...value } })
}
async function fixture(handler?: (req: IncomingMessage, res: ServerResponse, seen: Seen[]) => void,
  options: Partial<Parameters<typeof createVideoGateway>[0]> = {}) {
  const seen: Seen[] = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    seen.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body })
    if (handler) return handler(req, res, seen)
    if (req.url === SUBMIT) return submit(res)
    if (req.url === STATUS('task_1')) return status(res, { status: 'SUCCESS', result_url: 'https://cdn.example.invalid/clip.mp4' })
    if (req.url === RELAY_CONTENT('task_1')) {
      res.writeHead(200, { 'content-type': 'video/mp4', 'set-cookie': 'token=private-fixture-jwt', 'x-secret': 'private-fixture-jwt' })
      res.end(MP4)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain', 'x-secret': 'private-fixture-jwt' })
    res.end('private-fixture-jwt INTERNAL')
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind')
  const base = `http://127.0.0.1:${address.port}`
  // Exercise the standalone helper, not the production gateway: video leases
  // and plugin-configuration policies are not wired into the application yet.
  const video = createVideoGateway({ getJwt: () => 'private-fixture-jwt', maxConcurrent: 2, fetch: (input, init) => {
    const url = input.toString()
    if (!url.startsWith(`${ORIGIN}/`)) throw new Error('Unexpected upstream origin')
    return fetch(url.replace(ORIGIN, base), init)
  }, ...options })
  const local = createServer((req, res) => { void video.handle(req, res) })
  servers.push(local)
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve))
  const localAddress = local.address()
  if (!localAddress || typeof localAddress === 'string') throw new Error('Gateway fixture did not bind')
  const gateway = { ...video, url: `http://127.0.0.1:${localAddress.port}` }
  gateways.push(gateway)
  return { gateway, seen }
}
function issue(gateway: VideoGateway, models: readonly string[] = [MODEL]) {
  const child = gateway.createLease({ capabilityToken: randomBytes(32).toString('base64url'), models })
  return { child }
}
function call(gateway: VideoGateway, token: string, path: string, init: { method?: string; body?: unknown } = {}) {
  return fetch(`${gateway.url}${path}`, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) })
}
async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status)
  const body = await response.text()
  const parsed = JSON.parse(body)
  expect(parsed.error.code).toBe(code)
  expect(parsed.error.message).toEqual(expect.any(String))
  expect(parsed.error.type).toBe('video_gateway_error')
  expect(body).not.toMatch(/private-fixture-jwt|PRIVATE_PROMPT|INTERNAL|cdn\.example\.invalid|fail_reason|alibaba/)
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(response.headers.get('location')).toBeNull()
}

describe('Pengbao video gateway', () => {
  it('submits a text-to-video task with only the relayed fields and normalizes task status', async () => {
    let polls = 0
    const { gateway, seen } = await fixture((req, res) => {
      if (req.url === SUBMIT) return submit(res)
      if (req.url === STATUS('task_1')) {
        polls += 1
        if (polls === 1) return status(res, { status: 'QUEUED' })
        if (polls === 2) return status(res, { status: 'IN_PROGRESS', progress: '30%' })
        return status(res, { status: 'SUCCESS', result_url: 'https://cdn.example.invalid/clip.mp4' })
      }
      res.writeHead(404); res.end()
    })
    const { child } = issue(gateway)
    const submitted = await call(gateway, child.capabilityToken, '/v1/videos',
      { body: { model: MODEL, prompt: 'a red bird', seconds: '5', size: '720P', aspect_ratio: '16:9' } })
    expect(submitted.status).toBe(200)
    expect(await submitted.json()).toEqual({ id: 'task_1', task_id: 'task_1', status: 'queued' })
    const forwarded = seen.filter(row => row.path === SUBMIT)
    expect(forwarded).toHaveLength(1)
    expect(JSON.parse(forwarded[0]!.body)).toEqual({ model: MODEL, prompt: 'a red bird', size: '720P' })
    expect(forwarded[0]!.headers.authorization).toBe('Bearer private-fixture-jwt')
    expect(forwarded[0]!.headers['x-pengbao-request-id']).toMatch(/^pb-[a-f0-9]{32}$/)

    expect(await (await call(gateway, child.capabilityToken, '/v1/videos/task_1')).json()).toEqual({ id: 'task_1', object: 'video', status: 'queued' })
    expect(await (await call(gateway, child.capabilityToken, '/v1/videos/task_1')).json()).toEqual({ id: 'task_1', object: 'video', status: 'in_progress' })
    expect(await (await call(gateway, child.capabilityToken, '/v1/videos/task_1')).json()).toEqual({
      id: 'task_1', status: 'completed', url: '/v1/videos/task_1/content' })
    expect(seen.every(row => /^pb-[a-f0-9]{32}$/.test(String(row.headers['x-pengbao-request-id'])))).toBe(true)
  })

  it('gives submissions their full 30-second budget rather than the shorter status deadline', async () => {
    const { gateway } = await fixture()
    const { child } = issue(gateway)
    const timers = vi.spyOn(globalThis, 'setTimeout')
    try {
      const response = await call(gateway, child.capabilityToken, '/v1/videos', { body: { model: MODEL, prompt: 'bird' } })
      expect(response.status).toBe(200)
      const delays = timers.mock.calls.map(([, delay]) => delay)
      expect(delays).toContain(30_000)
      expect(delays).not.toContain(15_000)
    } finally { timers.mockRestore() }
  })

  it('reports a failed task without reflecting upstream failure text', async () => {
    const { gateway } = await fixture((req, res) => {
      if (req.url === STATUS('task_1')) return status(res, { status: 'FAILURE', fail_reason: 'upstream exploded: INTERNAL key sk-secret' })
      res.writeHead(404); res.end()
    })
    const { child } = issue(gateway)
    const response = await call(gateway, child.capabilityToken, '/v1/videos/task_1')
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(JSON.parse(body)).toEqual({ id: 'task_1', status: 'failed', error: { message: expect.any(String) } })
    expect(body).not.toMatch(/exploded|sk-secret|INTERNAL/)
  })

  it('streams a finished clip through the relay and strips upstream headers', async () => {
    const { gateway } = await fixture()
    const { child } = issue(gateway)
    const response = await call(gateway, child.capabilityToken, '/v1/videos/task_1/content')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('x-secret')).toBeNull()
    expect(Buffer.from(await response.arrayBuffer())).toEqual(MP4)
  })

  it('cancels the content reader when streaming fails before completion', async () => {
    const body = new ReadableStream<Uint8Array>({ pull() { throw new Error('fixture transport failure') } })
    const response = new Response(body, { headers: { 'content-type': 'video/mp4' } })
    const reader = body.getReader()
    const cancel = vi.spyOn(reader, 'cancel')
    vi.spyOn(body, 'getReader').mockReturnValue(reader)
    const { gateway } = await fixture(undefined, { fetch: async () => response })
    const { child } = issue(gateway)
    await expect(call(gateway, child.capabilityToken, '/v1/videos/task_1/content').then(response => response.arrayBuffer())).rejects.toThrow()
    expect(cancel).toHaveBeenCalled()
  })

  it.each(['http://127.0.0.1/clip.mp4', 'https://127.0.0.1/clip.mp4',
    'https://[::ffff:127.0.0.1]/clip.mp4', 'https://[::ffff:a00:1]/clip.mp4'])(
    'rejects non-public provider URL %s before downloading', async remote => {
    const { gateway, seen } = await fixture((req, res) => {
      if (req.url === RELAY_CONTENT('task_1')) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"detail":"private"}'); return }
      if (req.url === STATUS('task_1')) return status(res, { status: 'SUCCESS', result_url: remote })
      res.writeHead(404); res.end()
    })
    const { child } = issue(gateway)
    const response = await call(gateway, child.capabilityToken, '/v1/videos/task_1/content')
    await expectError(response, 502, 'VIDEO_RESPONSE')
    expect(seen.some(row => row.path === '/clip.mp4')).toBe(false)
  })

  it('never sends the local service credential to a provider URL', async () => {
    const provider: Seen[] = []
    const providerServer = createServer((req, res) => {
      provider.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: '' })
      res.writeHead(200, { 'content-type': 'video/mp4' })
      res.end(MP4)
    })
    servers.push(providerServer)
    await new Promise<void>(resolve => providerServer.listen(0, '127.0.0.1', resolve))
    const address = providerServer.address()
    if (!address || typeof address === 'string') throw new Error('Provider did not bind')
    const { gateway } = await fixture((req, res) => {
      if (req.url === RELAY_CONTENT('task_1')) { res.writeHead(400); res.end(); return }
      if (req.url === STATUS('task_1')) return status(res, { status: 'SUCCESS', result_url: `http://127.0.0.1:${address.port}/clip.mp4` })
      res.writeHead(404); res.end()
    })
    const { child } = issue(gateway)
    // The private address is refused before any provider request is made.
    await expectError(await call(gateway, child.capabilityToken, '/v1/videos/task_1/content'), 502, 'VIDEO_RESPONSE')
    expect(provider).toHaveLength(0)
  })

  it('rejects models, reference input and malformed requests before touching the upstream', async () => {
    const { gateway, seen } = await fixture()
    const { child } = issue(gateway)
    await expectError(await call(gateway, child.capabilityToken, '/v1/videos', { body: { model: 'other', prompt: 'bird' } }), 403, 'VIDEO_MODEL_UNAVAILABLE')
    await expectError(await call(gateway, child.capabilityToken, '/v1/videos',
      { body: { model: MODEL, prompt: 'bird', image: 'data:image/png;base64,AAAA' } }), 400, 'VIDEO_REFERENCE_UNSUPPORTED')
    for (const body of [{ model: MODEL }, { model: MODEL, prompt: '' }, { model: MODEL, prompt: 'bird', size: '2K' },
      { model: MODEL, prompt: 'bird', seconds: '45' }, { model: MODEL, prompt: 'bird', extra: true }]) {
      await expectError(await call(gateway, child.capabilityToken, '/v1/videos', { body }), 400, 'VIDEO_INVALID_REQUEST')
    }
    expect(seen.filter(row => row.path === SUBMIT)).toHaveLength(0)
  })

  it('denies credentials without a video lease and revoked video leases', async () => {
    const { gateway, seen } = await fixture()
    // Tokens minted by other gateways have no authority at this module boundary.
    for (const token of ['chat-only-token', 'broker-only-token', 'unissued-token']) {
      await expectError(await call(gateway, token, '/v1/videos', { body: { model: MODEL, prompt: 'bird' } }), 401, 'VIDEO_AUTH')
    }
    const { child } = issue(gateway)
    child.revoke()
    await expectError(await call(gateway, child.capabilityToken, '/v1/videos', { body: { model: MODEL, prompt: 'bird' } }), 401, 'VIDEO_AUTH')
    expect(seen).toHaveLength(0)
  })

  it.each([
    { status: 401, code: 'VIDEO_AUTH', expected: 401 },
    { status: 403, code: 'VIDEO_FORBIDDEN', expected: 403 },
    { status: 429, code: 'VIDEO_BUSY', expected: 429 },
    { status: 504, code: 'VIDEO_UPSTREAM_TIMEOUT', expected: 504 },
    { status: 500, code: 'VIDEO_NETWORK', expected: 502 }
  ])('maps upstream HTTP $status on submit to $code', async ({ status, code, expected }) => {
    const { gateway } = await fixture((req, res) => {
      res.writeHead(status, { 'content-type': 'application/json', 'x-secret': 'private-fixture-jwt' })
      res.end(JSON.stringify({ detail: 'upstream key sk-secret INTERNAL' }))
    })
    const { child } = issue(gateway)
    await expectError(await call(gateway, child.capabilityToken, '/v1/videos', { body: { model: MODEL, prompt: 'bird' } }), expected, code)
  })

  it('reports upstream error text to local diagnostics without reflecting it to the plugin', async () => {
    const failures: PengbaoVideoFailure[] = []
    const { gateway } = await fixture((req, res) => {
      res.writeHead(500, { 'content-type': 'application/json', 'x-secret': 'private-fixture-jwt' })
      res.end(JSON.stringify({ detail: 'provider said: INTERNAL upstream key sk-secret' }))
    }, { onFailure: failure => failures.push(failure) })
    const { child } = issue(gateway)
    await expectError(await call(gateway, child.capabilityToken, '/v1/videos', { body: { model: MODEL, prompt: 'bird' } }), 502, 'VIDEO_NETWORK')
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ stage: 'submit', code: 'VIDEO_NETWORK', upstreamStatus: 500 })
    expect(failures[0]!.upstreamDetail).toContain('sk-secret')
  })

  it('rejects unknown routes and query strings without an upstream request', async () => {
    const { gateway, seen } = await fixture()
    const { child } = issue(gateway)
    for (const path of ['/v1/video-generation', '/v1/videosx', '/v1/videos/task_1/content?x=1', '/v1/videos/task_1/extra', '/v1/videos/bad%2Fid']) {
      expect((await call(gateway, child.capabilityToken, path)).status).toBe(404)
    }
    expect(seen).toHaveLength(0)
  })
})