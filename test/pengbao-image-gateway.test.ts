import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startPengbaoGateway, type PengbaoGateway, type PengbaoGatewayOptions } from '../src/main/enterprise/gateway'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=', 'base64')
const ORIGIN = 'https://pengbao.ecombus.net'
const FILE = '/api/v1/files/image-1/content'
const GENERATE = '/api/v1/images/generations'
const STATUS = '/v1/image-generation/status'
const BATCH = '/v1/image-generation/generate-many'
const IMAGE = '/v1/image-generation/generate'
const MODELS = '/v1/image-generation/models'
const UPSTREAM_MODELS = '/api/v1/images/models'
const METADATA = '/api/v1/images/metadata'
const gateways: PengbaoGateway[] = []
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.stop()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve())
    server.closeAllConnections()
  })))
})

type Seen = { path: string; headers: IncomingMessage['headers']; body: string }
function sendJson(res: ServerResponse, value: unknown) {
  res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'token=private-fixture-jwt', 'x-secret': 'private-fixture-jwt' })
  res.end(JSON.stringify(value))
}
function defaults(req: IncomingMessage, res: ServerResponse) {
  if (req.url === '/api/config') return sendJson(res, { features: { enable_image_generation: true }, secret: 'secret-config' })
  if (req.url === '/api/v1/auths/') return sendJson(res, { role: 'user', permissions: { features: { image_generation: true } }, token: 'private-fixture-jwt', email: 'private@example.invalid' })
  if (req.url === GENERATE) return sendJson(res, [{ id: 'image-1', url: FILE, content_type: 'image/png', name: 'secret-file-name' }])
  if (req.url === FILE) {
    res.writeHead(200, { 'content-type': 'image/png', 'x-secret': 'private-fixture-jwt', 'set-cookie': 'token=private-fixture-jwt' })
    res.end(PNG)
    return
  }
  res.writeHead(404)
  res.end('private-fixture-jwt')
}
async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void = defaults, options: Partial<PengbaoGatewayOptions> = {}) {
  const seen: Seen[] = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    seen.push({ path: req.url ?? '', headers: req.headers, body })
    handler(req, res)
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind')
  const base = `http://127.0.0.1:${address.port}`
  const gateway = await startPengbaoGateway({ jwt: 'private-fixture-jwt', fetch: (input, init) => {
    const url = input.toString()
    if (!url.startsWith(`${ORIGIN}/`)) throw new Error('Unexpected upstream origin')
    return fetch(url.replace(ORIGIN, base), init)
  }, ...options })
  gateways.push(gateway)
  return { gateway, seen, lease: gateway.createImageLease() }
}
async function request(gateway: PengbaoGateway, token: string, path = IMAGE, body: unknown = { prompt: 'A red bird' }) {
  return fetch(`${gateway.url}${path}`, {
    method: path === IMAGE || path === BATCH ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Cookie: 'local-secret=never-forwarded' },
    ...(path === IMAGE || path === BATCH ? { body: JSON.stringify(body) } : {})
  })
}
async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status)
  const body = await response.text()
  const parsed = JSON.parse(body)
  expect(parsed).toEqual({ error: { message: expect.any(String), type: 'image_gateway_error', code,
    ...(parsed.error.diagnostic ? { diagnostic: { requestId: expect.stringMatching(/^pb-[a-f0-9]{32}$/), stage: expect.stringMatching(/^(status|catalog|generation|descriptor|download|bitmap)$/), code, elapsedMs: expect.any(Number),
      ...(parsed.error.diagnostic.upstreamStatus === undefined ? {} : { upstreamStatus: expect.any(Number) }) } } : {}) } })
  expect(body).not.toMatch(/private-fixture-jwt|secret-config|secret-file-name|private@example|INTERNAL|evil\.invalid/)
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(response.headers.get('location')).toBeNull()
}

describe('Pengbao image gateway parameter batches', () => {
  const revision = 'a'.repeat(64)
  const parameters = { contractVersion: 1, revision, models: [{ id: 'chosen', maxImages: 4, qualities: ['auto', 'high'], details: [''] }] }
  const input = { prompt: 'PRIVATE_PROMPT', model: 'chosen', n: 2, quality: 'high', parameterContractVersion: 1, parameterRevision: revision }
  function metadata(res: ServerResponse, generationParameters: unknown = parameters) {
    res.setHeader('X-Image-Model-Selection', 'request-local-v1')
    sendJson(res, { models: [{ id: 'chosen', name: 'Chosen' }], defaultModel: { id: 'chosen', name: 'Chosen' }, selection: 'request-local', catalogStatus: 'available', generationParameters })
  }
  it('generates once, downloads two validated images and propagates a host-owned correlation id', async () => {
    const { gateway, lease, seen } = await fixture((req, res) => {
      if (req.url === METADATA) return metadata(res)
      if (req.url === GENERATE) return sendJson(res, [{ id: 'one', url: '/api/v1/files/one/content' }, { id: 'two', url: '/api/v1/files/two/content' }])
      if (req.url === '/api/v1/files/one/content' || req.url === '/api/v1/files/two/content') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); return }
      defaults(req, res)
    })
    const response = await request(gateway, lease.capabilityToken, BATCH, input)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ requested: 2, complete: true, failures: [], images: [0, 1].map(index => ({ index, b64: PNG.toString('base64'), mime: 'image/png' })) })
    const calls = seen.filter(row => row.path === GENERATE)
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0]!.body)).toEqual(input)
    expect(calls[0]!.headers['x-pengbao-request-id']).toMatch(/^pb-[a-f0-9]{32}$/)
    expect(new Set(seen.map(row => row.headers['x-pengbao-request-id'])).size).toBe(1)
  })
  it.each([
    { ...input, parameterRevision: 'b'.repeat(64) }, { ...input, n: 5 }, { ...input, quality: 'medium' }, { ...input, detail: 'high' }
  ])('rejects invalid or stale parameters before generation: %j', async body => {
    const { gateway, lease, seen } = await fixture((req, res) => req.url === METADATA ? metadata(res) : defaults(req, res))
    const response = await request(gateway, lease.capabilityToken, BATCH, body)
    expect(response.status).toBe(400)
    expect(seen.some(row => row.path === GENERATE)).toBe(false)
  })
  it('keeps completed images after a later download failure and never regenerates', async () => {
    const { gateway, lease, seen } = await fixture((req, res) => {
      if (req.url === METADATA) return metadata(res)
      if (req.url === GENERATE) return sendJson(res, [{ id: 'one', url: '/api/v1/files/one/content' }, { id: 'two', url: '/api/v1/files/two/content' }])
      if (req.url === '/api/v1/files/one/content') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); return }
      if (req.url === '/api/v1/files/two/content') { res.writeHead(504); res.end('PRIVATE_SECRET'); return }
      defaults(req, res)
    })
    const response = await request(gateway, lease.capabilityToken, BATCH, input)
    expect(await response.json()).toEqual({ requested: 2, complete: false, images: [{ index: 0, b64: PNG.toString('base64'), mime: 'image/png' }], failures: [{ index: 1, code: 'IMAGE_UPSTREAM_TIMEOUT', diagnostic: expect.objectContaining({ code: 'IMAGE_UPSTREAM_TIMEOUT', stage: 'download', upstreamStatus: 504 }) }] })
    expect(seen.filter(row => row.path === GENERATE)).toHaveLength(1)
  })
  it.each([
    { descriptors: [{ id: 'image-1', url: FILE }] },
    { descriptors: [{ id: 'image-1', url: FILE }, { id: 'image-1', url: FILE }] },
    { descriptors: [{ id: 'image-1', url: FILE }, { id: 'unsafe', url: 'https://evil.invalid/content' }] }
  ])('keeps a safe image and marks missing, duplicate or unsafe descriptors without following them', async ({ descriptors }) => {
    const { gateway, lease, seen } = await fixture((req, res) => {
      if (req.url === METADATA) return metadata(res)
      if (req.url === GENERATE) return sendJson(res, descriptors)
      defaults(req, res)
    })
    expect(await (await request(gateway, lease.capabilityToken, BATCH, input)).json()).toEqual({ requested: 2, complete: false, images: [{ index: 0, b64: PNG.toString('base64'), mime: 'image/png' }], failures: [{ index: 1, code: 'IMAGE_RESPONSE' }] })
    expect(seen.filter(row => row.path === GENERATE)).toHaveLength(1)
    expect(seen.filter(row => row.path === FILE)).toHaveLength(1)
    expect(seen.some(row => row.path.includes('unsafe'))).toBe(false)
  })
  it.each([400, 409])('maps safe backend contract rejection HTTP %i without forwarding raw text or retrying', async status => {
    const { gateway, lease, seen } = await fixture((req, res) => {
      if (req.url === METADATA) return metadata(res)
      if (req.url === GENERATE) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ detail: { code: 'IMAGE_PARAMETER_CONFIG_CONFLICT', message: 'INTERNAL secret-config' } })); return }
      defaults(req, res)
    })
    await expectError(await request(gateway, lease.capabilityToken, BATCH, input), 400, 'IMAGE_PARAMETERS_UNSUPPORTED')
    expect(seen.filter(row => row.path === GENERATE)).toHaveLength(1)
  })
  it('classifies a structured provider rejection without calling it an invalid image payload', async () => {
    const requestId = `pb-${'d'.repeat(32)}`
    const { gateway, lease, seen } = await fixture((req, res) => {
      if (req.url === GENERATE) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: {
          type: 'image_generation_error', contractVersion: 1, requestId,
          code: 'IMAGE_PROVIDER_REJECTED', phase: 'provider-response', elapsedMs: 42, providerStatus: 400
        } }))
        return
      }
      defaults(req, res)
    })
    await expectError(await request(gateway, lease.capabilityToken), 502, 'IMAGE_PROVIDER_REJECTED')
    expect(seen.filter(row => row.path === GENERATE)).toHaveLength(1)
  })
  it('surfaces a provider safety filter with its reason instead of a generic rejection', async () => {
    const requestId = `pb-${'e'.repeat(32)}`
    const { gateway, lease } = await fixture((req, res) => {
      if (req.url === GENERATE) {
        res.writeHead(422, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: {
          type: 'image_generation_error', contractVersion: 1, requestId,
          code: 'IMAGE_FILTERED', phase: 'provider-response', elapsedMs: 51, providerStatus: 451,
          reason: 'The generated image was filtered by the safety policy.'
        } }))
        return
      }
      defaults(req, res)
    })
    const response = await request(gateway, lease.capabilityToken)
    expect(response.status).toBe(422)
    const error = (await response.json()).error
    expect(error.code).toBe('IMAGE_FILTERED')
    expect(error.message).toContain('safety policy')
    expect(error.message).toContain('The generated image was filtered by the safety policy.')
  })
  it('never echoes a provider reason for authentication failures', async () => {
    const requestId = `pb-${'f'.repeat(32)}`
    const { gateway, lease } = await fixture((req, res) => {
      if (req.url === GENERATE) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: {
          type: 'image_generation_error', contractVersion: 1, requestId,
          code: 'IMAGE_PROVIDER_AUTH', phase: 'provider-response', elapsedMs: 12, providerStatus: 401,
          reason: 'Invalid key sk-secret-provider-value'
        } }))
        return
      }
      defaults(req, res)
    })
    const response = await request(gateway, lease.capabilityToken)
    expect(response.status).toBe(502)
    const error = (await response.json()).error
    expect(error.code).toBe('IMAGE_PROVIDER_AUTH')
    expect(error.message).not.toContain('sk-secret-provider-value')
  })
  it('maps an untyped generation 400 to a neutral provider rejection', async () => {
    const { gateway, lease } = await fixture((req, res) => {
      if (req.url === GENERATE) { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('secret provider body'); return }
      defaults(req, res)
    })
    const response = await request(gateway, lease.capabilityToken)
    expect(response.status).toBe(502)
    expect((await response.json()).error).toMatchObject({ code: 'IMAGE_PROVIDER_REJECTED', message: expect.stringContaining('rejected') })
  })
  it('refuses undeclared capabilities without breaking the legacy single-image path', async () => {
    const { gateway, lease, seen } = await fixture((req, res) => req.url === METADATA ? metadata(res, null) : defaults(req, res))
    // An explicit empty declaration authorizes no overrides.
    const empty = await fixture((req, res) => req.url === METADATA ? metadata(res, { ...parameters, models: [] }) : defaults(req, res))
    await expectError(await request(empty.gateway, empty.lease.capabilityToken, BATCH, input), 400, 'IMAGE_PARAMETERS_UNSUPPORTED')
    expect(empty.seen.some(row => row.path === GENERATE)).toBe(false)
    expect((await request(gateway, lease.capabilityToken)).status).toBe(200)
    expect(seen.filter(row => row.path === GENERATE)).toHaveLength(1)
  })
})

describe('Pengbao image gateway runtime leases', () => {
  it('keeps image and chat capabilities separate and guards fixed paths and browser origins', async () => {
    const { gateway, lease, seen } = await fixture()
    expect(lease.capabilityToken).not.toBe(gateway.capabilityToken)
    await expectError(await request(gateway, gateway.capabilityToken), 401, 'IMAGE_AUTH')
    await expectError(await request(gateway, gateway.capabilityToken, STATUS), 401, 'IMAGE_AUTH')
    await expectError(await request(gateway, gateway.capabilityToken, MODELS), 401, 'IMAGE_AUTH')
    for (const path of ['/v1/models', '/v1/chat/completions']) expect((await request(gateway, lease.capabilityToken, path)).status).toBe(401)
    for (const path of [`${STATUS}?x=1`, `${STATUS}/`, `${MODELS}?x=1`, `${MODELS}/`, '/v1/image-generation/files/image-1']) {
      await expectError(await request(gateway, lease.capabilityToken, path), 404, 'IMAGE_INVALID_REQUEST')
    }
    for (const headers of [{ Origin: 'null' }, { 'Sec-Fetch-Site': 'same-origin' }, { Host: 'evil.invalid' }]) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(`${gateway.url}${STATUS}`, { headers: { Authorization: `Bearer ${lease.capabilityToken}`, ...headers } }, res => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        })
        req.on('error', reject)
        req.end()
      })
      expect(status).toBe(403)
    }
    expect(seen).toEqual([])
  })

  it('returns only allowlisted status fields and no account/config credentials', async () => {
    const { gateway, lease, seen } = await fixture()
    const response = await request(gateway, lease.capabilityToken, STATUS)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ available: true, reason: 'available', serviceUrl: ORIGIN, modelSelection: 'server-managed' })
    expect(seen.map(row => row.path)).toEqual(['/api/v1/auths/', '/api/config'])
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('x-secret')).toBeNull()
    expect(response.headers.get('cache-control')).toBe('no-store')
    for (const row of seen) {
      expect(row.headers.authorization).toBe('Bearer private-fixture-jwt')
      expect(row.headers.cookie).toBeUndefined()
    }
  })

  it.each([
    { enabled: false, role: 'user', permission: true, reason: 'disabled' },
    { enabled: true, role: 'user', permission: false, reason: 'forbidden' },
    { enabled: true, role: 'admin', permission: false, reason: 'available' },
    { enabled: true, role: 'pending', permission: true, reason: 'forbidden' },
    { enabled: undefined, role: 'user', permission: true, reason: 'unavailable' },
    { enabled: true, role: 'user', permission: undefined, reason: 'unavailable' }
  ])('status derives $reason from global flag and effective permissions', async ({ enabled, role, permission, reason }) => {
    const { gateway, lease } = await fixture((req, res) => {
      if (req.url === '/api/config') return sendJson(res, { features: { enable_image_generation: enabled } })
      sendJson(res, { role, permissions: { features: { image_generation: permission } }, token: 'private-fixture-jwt' })
    })
    const response = await request(gateway, lease.capabilityToken, STATUS)
    expect(await response.json()).toMatchObject({ available: reason === 'available', reason })
  })

  it.each([401, 403, 500])('status sanitizes upstream HTTP %s', async status => {
    const { gateway, lease } = await fixture((_req, res) => { res.writeHead(status); res.end('private-fixture-jwt INTERNAL') })
    const response = await request(gateway, lease.capabilityToken, STATUS)
    expect(await response.json()).toEqual({ available: false, reason: status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : 'unavailable', serviceUrl: ORIGIN, modelSelection: 'server-managed' })
  })

  it.each([undefined, 'request-local-v1', 'request-local', 'REQUEST-LOCAL-V1', 'request-local-v1, other'])('gates selection on the exact worker header %s and strips catalog extras', async header => {
    const { gateway, lease, seen } = await fixture((req, res) => {
      if (req.url !== UPSTREAM_MODELS) return defaults(req, res)
      if (header !== undefined) res.setHeader('X-Image-Model-Selection', header)
      sendJson(res, [{ id: ' first ', name: ' First model ', token: 'private-fixture-jwt' }, { id: 'first', name: 'Duplicate' }, { id: '模型', name: '中文模型' }])
    })
    const response = await request(gateway, lease.capabilityToken, MODELS)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ models: [{ id: 'first', name: 'First model' }, { id: '模型', name: '中文模型' }], selection: header === 'request-local-v1' ? 'request-local' : 'server-only' })
    expect(seen.map(row => row.path)).toEqual(['/api/v1/auths/', '/api/config', METADATA, UPSTREAM_MODELS])
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('x-secret')).toBeNull()
    expect(response.headers.get('x-image-model-selection')).toBeNull()
    for (const row of seen) {
      expect(row.headers.authorization).toBe('Bearer private-fixture-jwt')
      expect(row.headers.cookie).toBeUndefined()
      expect(JSON.stringify(row)).not.toContain(lease.capabilityToken)
    }
  })

  it.each([null, { id: 'gpt-image-2-5-custom', name: 'Studio Image' }])('projects safe actual default metadata %j without leaking provider fields', async defaultModel => {
    const { gateway, lease, seen } = await fixture((req, res) => {
      if (req.url !== METADATA) return defaults(req, res)
      res.setHeader('X-Image-Model-Selection', 'request-local-v1')
      sendJson(res, { models: [{ id: 'gpt-image-2-5-custom', name: 'Studio Image', key: 'private-fixture-jwt' }], defaultModel,
        selection: 'request-local', catalogStatus: 'available', engine: 'openai', url: 'https://evil.invalid', key: 'private-fixture-jwt' })
    })
    const response = await request(gateway, lease.capabilityToken, MODELS)
    expect(await response.json()).toEqual({ models: [{ id: 'gpt-image-2-5-custom', name: 'Studio Image' }], defaultModel, selection: 'request-local', catalogStatus: 'available' })
    expect(seen.map(row => row.path)).toEqual(['/api/v1/auths/', '/api/config', METADATA])
  })

  it.each(['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2', 'gemini-3-pro-image', 'gemini-3.1-flash-image'])('preserves configured model %s through metadata and explicit generation', async model => {
    const ids = ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2', 'gemini-3-pro-image', 'gemini-3.1-flash-image']
    const models = ids.map(id => ({ id, name: id }))
    const { gateway, lease, seen } = await fixture((req, res) => {
      if (req.url !== METADATA) return defaults(req, res)
      res.setHeader('X-Image-Model-Selection', 'request-local-v1')
      sendJson(res, { models, defaultModel: models[0], selection: 'request-local', catalogStatus: 'available' })
    })
    expect(await (await request(gateway, lease.capabilityToken, MODELS)).json()).toEqual({ models, defaultModel: models[0], selection: 'request-local', catalogStatus: 'available' })
    const generated = await request(gateway, lease.capabilityToken, IMAGE, { prompt: 'A red bird', model })
    expect(generated.status).toBe(200)
    expect(Buffer.from(await generated.arrayBuffer())).toEqual(PNG)
    const calls = seen.filter(row => row.path === GENERATE)
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0]!.body)).toEqual({ prompt: 'A red bird', model, n: 1 })
  })

  it('does not trust metadata selection without the exact capability header', async () => {
    const { gateway, lease } = await fixture((req, res) => req.url === METADATA
      ? sendJson(res, { models: [{ id: 'image-b', name: 'B' }], defaultModel: null, selection: 'request-local', catalogStatus: 'default-only' }) : defaults(req, res))
    expect(await (await request(gateway, lease.capabilityToken, MODELS)).json()).toMatchObject({ selection: 'server-only' })
  })

  it.each([404, 405])('uses the legacy array only for metadata endpoint HTTP %s', async missingStatus => {
    const { gateway, lease, seen } = await fixture((req, res) => {
      if (req.url === METADATA) { res.writeHead(missingStatus); res.end('private-fixture-jwt'); return }
      if (req.url === UPSTREAM_MODELS) return sendJson(res, [{ id: 'Pengbao / Server default', name: 'A valid explicit ID' }])
      defaults(req, res)
    })
    expect(await (await request(gateway, lease.capabilityToken, MODELS)).json()).toEqual({ models: [{ id: 'Pengbao / Server default', name: 'A valid explicit ID' }], selection: 'server-only' })
    expect(seen.map(row => row.path)).toEqual(['/api/v1/auths/', '/api/config', METADATA, UPSTREAM_MODELS])
  })

  it.each([401, 403, 500, 307])('does not fall back to the legacy catalog after metadata HTTP %s', async status => {
    const { gateway, lease, seen } = await fixture((req, res) => {
      if (req.url !== METADATA) return defaults(req, res)
      res.writeHead(status, { location: 'https://evil.invalid' }); res.end('private-fixture-jwt')
    })
    expect((await request(gateway, lease.capabilityToken, MODELS)).ok).toBe(false)
    expect(seen.some(row => row.path === UPSTREAM_MODELS || row.path === GENERATE)).toBe(false)
  })

  it.each([
    { selection: ['request-local'], catalogStatus: 'available' },
    { selection: 'request-local', catalogStatus: ['available'] },
    { selection: 'unknown', catalogStatus: 'available' },
    { selection: 'server-only', catalogStatus: 'unknown' }
  ])('requires strict metadata enums %# without fallback', async extra => {
    const { gateway, lease, seen } = await fixture((req, res) => req.url === METADATA
      ? sendJson(res, { models: [], defaultModel: null, ...extra }) : defaults(req, res))
    await expectError(await request(gateway, lease.capabilityToken, MODELS), 502, 'IMAGE_RESPONSE')
    expect(seen.some(row => row.path === UPSTREAM_MODELS)).toBe(false)
  })

  it.each([undefined, {}, { id: ' padded ', name: 'Name' }, { id: 'ok', name: 'bad\nname' }])('rejects invalid default metadata %j without legacy fallback', async defaultModel => {
    const { gateway, lease, seen } = await fixture((req, res) => req.url === METADATA
      ? sendJson(res, { models: [], defaultModel, selection: 'server-only', catalogStatus: 'available' }) : defaults(req, res))
    await expectError(await request(gateway, lease.capabilityToken, MODELS), 502, 'IMAGE_RESPONSE')
    expect(seen.some(row => row.path === UPSTREAM_MODELS)).toBe(false)
  })

  it('filters invalid catalog rows and bounds the output to 256 distinct models', async () => {
    const invalid = [{ id: 'desktop-managed', name: 'Collision' }, null, [], 'invalid', {}, { id: 1, name: 'Bad' }, { id: '', name: 'Bad' }, { id: ' ', name: 'Bad' },
      { id: 'x'.repeat(257), name: 'Bad' }, { id: 'bad\n', name: 'Bad' }, { id: 'bad\u007f', name: 'Bad' }, { id: 'bad\u0085', name: 'Bad' },
      { id: 'bad' + String.fromCodePoint(0x202e), name: 'Bad' }, { id: 'bad-name', name: '' }, { id: 'bad-name', name: 1 }, { id: 'bad-name', name: 'x'.repeat(257) }, { id: 'bad-name', name: 'Bad\n' },
      { id: 'bad-name', name: 'Bad' + String.fromCodePoint(0x202e) }, { id: 'bad-name', name: 'Bad' + String.fromCodePoint(0x2028) }]
    const rows = [{ id: 'x'.repeat(256), name: 'n'.repeat(256) }, ...Array.from({ length: 256 }, (_, i) => ({ id: `id-${i}`, name: `Model ${i}` }))]
    const { gateway, lease } = await fixture((req, res) => req.url === UPSTREAM_MODELS ? sendJson(res, [...invalid, ...rows, rows[0]]) : defaults(req, res))
    const response = await request(gateway, lease.capabilityToken, MODELS)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ models: rows.slice(0, 256), selection: 'server-only' })
  })

  it.each([{}, { models: [] }, null, 'invalid'])('rejects invalid upstream catalog shapes without generating', async value => {
    const { gateway, lease, seen } = await fixture((req, res) => req.url === UPSTREAM_MODELS ? sendJson(res, value) : defaults(req, res))
    await expectError(await request(gateway, lease.capabilityToken, MODELS), 502, 'IMAGE_RESPONSE')
    expect(seen.some(row => row.path === GENERATE)).toBe(false)
  })

  it.each(['desktop-managed', ' desktop-managed '])('rejects reserved explicit model %s before any upstream request', async model => {
    const { gateway, lease, seen } = await fixture()
    await expectError(await request(gateway, lease.capabilityToken, IMAGE, { prompt: 'Bird', model }), 400, 'IMAGE_INVALID_REQUEST')
    expect(seen).toHaveLength(0)
  })

  it('omits model and discovery entirely when using the unchanged server default', async () => {
    const { gateway, lease, seen } = await fixture()
    const response = await request(gateway, lease.capabilityToken)
    expect(response.status).toBe(200)
    await response.arrayBuffer()
    expect(seen.map(row => row.path)).toEqual(['/api/v1/auths/', '/api/config', GENERATE, FILE])
    expect(JSON.parse(seen.find(row => row.path === GENERATE)?.body ?? '')).toEqual({ prompt: 'A red bird', n: 1 })
  })

  it('freshly discovers an explicit supported model and passes it only to that generation', async () => {
    const { gateway, lease, seen } = await fixture((req, res) => {
      if (req.url !== UPSTREAM_MODELS) return defaults(req, res)
      res.setHeader('X-Image-Model-Selection', 'request-local-v1')
      sendJson(res, [{ id: 'chosen', name: 'Chosen' }])
    })
    expect((await request(gateway, lease.capabilityToken, MODELS)).status).toBe(200)
    const explicit = await request(gateway, lease.capabilityToken, IMAGE, { prompt: 'A bird', size: '1024x1024', model: ' chosen ' })
    expect(explicit.status).toBe(200)
    await explicit.arrayBuffer()
    expect(seen.map(row => row.path)).toEqual(['/api/v1/auths/', '/api/config', METADATA, UPSTREAM_MODELS, '/api/v1/auths/', '/api/config', METADATA, UPSTREAM_MODELS, GENERATE, FILE])
    const defaultResponse = await request(gateway, lease.capabilityToken)
    expect(defaultResponse.status).toBe(200)
    await defaultResponse.arrayBuffer()
    expect(seen.filter(row => row.path === GENERATE).map(row => JSON.parse(row.body))).toEqual([
      { prompt: 'A bird', size: '1024x1024', model: 'chosen', n: 1 }, { prompt: 'A red bird', n: 1 }
    ])
    expect(seen.filter(row => row.path === UPSTREAM_MODELS)).toHaveLength(2)
  })

  it.each(['missing', 'stale', 'invalid-row', 'header-revoked', 'server-only'])('refuses %s selections after fresh discovery with zero paid generations', async scenario => {
    let discovered = false
    const { gateway, lease, seen } = await fixture((req, res) => {
      if (req.url !== UPSTREAM_MODELS) return defaults(req, res)
      if (scenario !== 'server-only' && !(scenario === 'header-revoked' && discovered)) res.setHeader('X-Image-Model-Selection', 'request-local-v1')
      sendJson(res, scenario === 'missing' || (scenario === 'stale' && discovered) ? [] : [{ id: 'chosen', name: scenario === 'invalid-row' ? 'Bad\n' : 'Chosen' }])
      discovered = true
    })
    expect((await request(gateway, lease.capabilityToken, MODELS)).status).toBe(200)
    await expectError(await request(gateway, lease.capabilityToken, IMAGE, { prompt: 'Bird', model: 'chosen' }), 400,
      ['server-only', 'header-revoked'].includes(scenario) ? 'IMAGE_MODEL_UNSUPPORTED' : 'IMAGE_MODEL_UNAVAILABLE')
    expect(seen.filter(row => row.path === UPSTREAM_MODELS)).toHaveLength(2)
    expect(seen.some(row => row.path === GENERATE)).toBe(false)
  })

  it.each([false, true])('checks permissions before discovery for explicit=%s', async explicit => {
    const { gateway, lease, seen } = await fixture((req, res) => req.url === '/api/v1/auths/'
      ? sendJson(res, { role: 'user', permissions: { features: { image_generation: false } } }) : defaults(req, res))
    await expectError(await request(gateway, lease.capabilityToken, explicit ? IMAGE : MODELS, { prompt: 'Bird', model: 'chosen' }), 403, 'IMAGE_FORBIDDEN')
    expect(seen.map(row => row.path)).toEqual(['/api/v1/auths/', '/api/config'])
  })

  it('rejects discovery redirects with zero paid generations', async () => {
    const { gateway, lease, seen } = await fixture((req, res) => {
      if (req.url !== UPSTREAM_MODELS) return defaults(req, res)
      res.writeHead(307, { location: 'https://evil.invalid/private-fixture-jwt' })
      res.end('private-fixture-jwt')
    })
    await expectError(await request(gateway, lease.capabilityToken, MODELS), 502, 'IMAGE_RESPONSE')
    await expectError(await request(gateway, lease.capabilityToken, IMAGE, { prompt: 'Bird', model: 'chosen' }), 502, 'IMAGE_RESPONSE')
    expect(seen.some(row => row.path === GENERATE || row.path.includes('evil.invalid'))).toBe(false)
  })

  it('revokes only the discovering lease and guards late catalogs from abort-ignoring transports', async () => {
    let signal: AbortSignal | undefined
    let resolveCatalog: (response: Response) => void = () => { throw new Error('Not started') }
    const cancel = vi.fn()
    const { gateway, lease } = await fixture(defaults, { fetch: async (input, init) => {
      const path = new URL(input.toString()).pathname
      if (path === METADATA || path === UPSTREAM_MODELS) {
        signal = init?.signal ?? undefined
        return new Promise<Response>(resolve => { resolveCatalog = resolve })
      }
      return Response.json(path === '/api/config' ? { features: { enable_image_generation: true } } : { role: 'admin' })
    } })
    const other = gateway.createImageLease()
    const pending = request(gateway, lease.capabilityToken, MODELS)
    await vi.waitFor(() => expect(signal).toBeDefined())
    lease.revoke()
    await expectError(await pending, 401, 'IMAGE_REVOKED')
    expect(signal?.aborted).toBe(true)
    resolveCatalog(new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { 'content-type': 'application/json' } }))
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    await expectError(await request(gateway, lease.capabilityToken, MODELS), 401, 'IMAGE_AUTH')
    expect((await request(gateway, other.capabilityToken, STATUS)).status).toBe(200)
  })

  it.each([false, true])('caps discovery at the status deadline, not the generation deadline (explicit=%s)', async explicit => {
    let signal: AbortSignal | undefined
    const { gateway, lease } = await fixture(defaults, { imageTimeoutMs: 230_000, fetch: async (input, init) => {
      const path = new URL(input.toString()).pathname
      if (path === METADATA || path === UPSTREAM_MODELS) {
        signal = init?.signal ?? undefined
        return new Promise<Response>(() => {})
      }
      return Response.json(path === '/api/config' ? { features: { enable_image_generation: true } } : { role: 'admin' })
    } })
    // Shorten only the status deadline so no production-length wait is needed.
    const setTimeoutOriginal = globalThis.setTimeout
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, ms, ...args) => setTimeoutOriginal(handler, ms === 10_000 ? 100 : ms, ...args))
    try {
      await expectError(await request(gateway, lease.capabilityToken, explicit ? IMAGE : MODELS, { prompt: 'Bird', model: 'chosen' }), 504, 'IMAGE_TIMEOUT')
      expect(signal?.aborted).toBe(true)
      expect(spy.mock.calls.some(([, ms]) => ms === 10_000)).toBe(true)
    } finally { spy.mockRestore() }
  })

  it.each([
    { failed: '/api/v1/auths/', stage: 'status', code: 'IMAGE_NETWORK' },
    { failed: METADATA, stage: 'catalog', code: 'IMAGE_NETWORK' },
    { failed: GENERATE, stage: 'generation', code: 'IMAGE_NETWORK' },
    { failed: FILE, stage: 'download', code: 'IMAGE_NETWORK' },
    { failed: 'descriptor', stage: 'descriptor', code: 'IMAGE_RESPONSE' },
    { failed: 'bitmap', stage: 'bitmap', code: 'IMAGE_RESPONSE' }
  ])('emits one safe terminal $stage failure without request content', async ({ failed, stage, code }) => {
    const failures: unknown[] = []
    const chatFailures = vi.fn()
    const { gateway, lease, seen } = await fixture((req, res) => {
      if (req.url === failed) { res.writeHead(500); res.end('private-fixture-jwt INTERNAL https://evil.invalid'); return }
      if (failed === 'descriptor' && req.url === GENERATE) return sendJson(res, [])
      if (failed === 'bitmap' && req.url === FILE) { res.writeHead(200, { 'content-type': 'image/png' }); res.end('PRIVATE_PROMPT'); return }
      defaults(req, res)
    }, { onImageFailure: value => failures.push(value), onFailure: chatFailures })
    const response = await request(gateway, lease.capabilityToken, failed === METADATA ? MODELS : IMAGE, { prompt: 'PRIVATE_PROMPT' })
    expect(response.ok).toBe(false)
    await response.text()
    expect(failures).toEqual([{ requestId: expect.stringMatching(/^pb-[a-f0-9]{32}$/), stage, code,
      elapsedMs: expect.any(Number), ...(['descriptor', 'bitmap'].includes(failed) ? {} : { upstreamStatus: 500 }) }])
    expect(JSON.stringify(failures)).not.toMatch(/PRIVATE_PROMPT|private-fixture-jwt|INTERNAL|evil|image-1|https|Bearer/)
    expect(chatFailures).not.toHaveBeenCalled()
    expect(seen.filter(row => row.path === GENERATE).length).toBeLessThanOrEqual(1)
  })

  it('isolates failure callback exceptions and reports status failure only once', async () => {
    const callback = vi.fn(() => { throw new Error('PRIVATE_PROMPT') })
    const { gateway, lease } = await fixture((_req, res) => { res.writeHead(401); res.end('private-fixture-jwt') }, { onImageFailure: callback })
    expect(await (await request(gateway, lease.capabilityToken, STATUS)).json()).toMatchObject({ available: false, reason: 'unauthenticated' })
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ stage: 'status', code: 'IMAGE_AUTH', upstreamStatus: 401 }))
  })


  it.each([{}, { prompt: '' }, { prompt: '   ' }, { prompt: 1 }, { prompt: 'x', size: '8193x1' }, { prompt: 'x', size: '8001x8000' }, { prompt: 'x', model: 1 }, { prompt: 'x', model: '' }, { prompt: 'x', model: ' ' }, { prompt: 'x', model: 'x'.repeat(257) }, { prompt: 'x', model: 'bad\nmodel' }, { prompt: 'x', model: null }, { prompt: 'x', url: ORIGIN }, { prompt: 'x', chat_id: 'cloud-chat' }, { prompt: 'x'.repeat(16_001) }])('rejects invalid or extra input fields before any upstream request', async input => {
    const { gateway, lease, seen } = await fixture()
    await expectError(await request(gateway, lease.capabilityToken, IMAGE, input), 400, 'IMAGE_INVALID_REQUEST')
    expect(seen).toHaveLength(0)
  })
  it('rejects malformed JSON, oversized bodies and compressed input', async () => {
    const { gateway, lease, seen } = await fixture()
    for (const [body, extra, status, code] of [
      ['{', {}, 400, 'IMAGE_INVALID_REQUEST'],
      [JSON.stringify({ prompt: 'x'.repeat(70_000) }), {}, 413, 'IMAGE_TOO_LARGE'],
      ['{}', { 'content-encoding': 'gzip' }, 400, 'IMAGE_INVALID_REQUEST']
    ] as const) {
      const response = await fetch(`${gateway.url}${IMAGE}`, { method: 'POST', headers: { Authorization: `Bearer ${lease.capabilityToken}`, ...extra }, body })
      await expectError(response, status, code)
    }
    expect(seen).toHaveLength(0)
  })

  it.each([
    { enabled: false, permitted: true, code: 'IMAGE_DISABLED' },
    { enabled: true, permitted: false, code: 'IMAGE_FORBIDDEN' }
  ])('refuses generation when current status is $code without paid requests', async ({ enabled, permitted, code }) => {
    const { gateway, lease, seen } = await fixture((req, res) => {
      if (req.url === '/api/config') return sendJson(res, { features: { enable_image_generation: enabled } })
      sendJson(res, { role: 'user', permissions: { features: { image_generation: permitted } } })
    })
    await expectError(await request(gateway, lease.capabilityToken), 403, code)
    expect(seen.some(row => row.path === GENERATE)).toBe(false)
  })

  it.each([
    [401, 401, 'IMAGE_AUTH'], [403, 403, 'IMAGE_FORBIDDEN'], [429, 429, 'IMAGE_BUSY'],
    [500, 502, 'IMAGE_NETWORK'], [504, 504, 'IMAGE_UPSTREAM_TIMEOUT']
  ])('uses generation HTTP %s as final authority, sanitizes errors and never retries', async (upstreamStatus, resultStatus, code) => {
    const { gateway, lease, seen } = await fixture((req, res) => {
      if (req.url !== GENERATE) return defaults(req, res)
      res.writeHead(Number(upstreamStatus), { 'set-cookie': 'token=private-fixture-jwt', 'x-secret': 'private-fixture-jwt' })
      res.end('private-fixture-jwt INTERNAL https://evil.invalid')
    })
    const response = await request(gateway, lease.capabilityToken)
    const body = await response.clone().text()
    await expectError(response, Number(resultStatus), String(code))
    if (upstreamStatus === 504) expect(body).toMatch(/complete|charge|automatically/i)
    expect(seen.filter(row => row.path === GENERATE)).toHaveLength(1)
    expect(seen.filter(row => row.path === FILE)).toHaveLength(0)
  })

  it.each([
    [], [{ id: 'image-1', url: FILE }, { id: 'image-2', url: '/api/v1/files/image-2/content' }],
    [{ id: 'image-1', url: `${ORIGIN}${FILE}` }], [{ id: 'image-1', url: `//evil.invalid${FILE}` }],
    [{ id: 'image-1', url: `${FILE}?token=secret` }], [{ id: 'image-1', url: `${FILE}#fragment` }],
    [{ id: 'image-1', url: '/api/v1/files/image-2/content' }], [{ id: '../image-1', url: '/api/v1/files/../image-1/content' }],
    [{ id: '%2e%2e', url: '/api/v1/files/%2e%2e/content' }], [{ id: 'image-1', url: '/api/v1/files/%69mage-1/content' }],
    [{ id: 'image-1', url: '/api/v1/files/image-1/../content' }], [{ id: 'image-1', url: '/api/v1/files/image-1/content/' }],
    { data: [{ id: 'image-1', url: FILE }] }
  ].map(descriptor => ({ descriptor })))('rejects unsafe or non-unique image descriptors without downloading', async ({ descriptor }) => {
    const { gateway, lease, seen } = await fixture((req, res) => req.url === GENERATE ? sendJson(res, descriptor) : defaults(req, res))
    await expectError(await request(gateway, lease.capabilityToken), 502, 'IMAGE_RESPONSE')
    expect(seen.filter(row => row.path === GENERATE)).toHaveLength(1)
    expect(seen.some(row => row.path.startsWith('/api/v1/files/'))).toBe(false)
  })

  it.each([GENERATE, FILE])('refuses %s redirects and does not replay generation after download failure', async redirectedPath => {
    const { gateway, lease, seen } = await fixture((req, res) => {
      if (req.url !== redirectedPath) return defaults(req, res)
      res.writeHead(302, { location: 'https://evil.invalid/private-fixture-jwt' })
      res.end('private-fixture-jwt')
    })
    await expectError(await request(gateway, lease.capabilityToken), 502, 'IMAGE_RESPONSE')
    expect(seen.filter(row => row.path === GENERATE)).toHaveLength(1)
    expect(seen.some(row => row.path.includes('evil.invalid'))).toBe(false)
  })

  it.each(['image/svg+xml', 'text/html', 'application/octet-stream', 'image/gif'])('rejects unsupported image type %s', async type => {
    const { gateway, lease } = await fixture((req, res) => {
      if (req.url !== FILE) return defaults(req, res)
      res.writeHead(200, { 'content-type': type })
      res.end(PNG)
    })
    await expectError(await request(gateway, lease.capabilityToken), 502, 'IMAGE_RESPONSE')
  })

  it('rejects claimed PNG without PNG signature', async () => {
    const { gateway, lease } = await fixture((req, res) => {
      if (req.url !== FILE) return defaults(req, res)
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end('private-fixture-jwt')
    })
    await expectError(await request(gateway, lease.capabilityToken), 502, 'IMAGE_RESPONSE')
  })

  it.each([true, false])('limits image cumulative bytes with content-length=%s', async contentLength => {
    const { gateway, lease, seen } = await fixture((req, res) => {
      if (req.url !== FILE) return defaults(req, res)
      res.writeHead(200, { 'content-type': 'image/png', ...(contentLength ? { 'content-length': 20 * 1024 * 1024 + 1 } : {}) })
      res.end(Buffer.alloc(20 * 1024 * 1024 + 1))
    })
    await expectError(await request(gateway, lease.capabilityToken), 413, 'IMAGE_TOO_LARGE')
    expect(seen.filter(row => row.path === GENERATE)).toHaveLength(1)
  })

  it.each(['/api/config', '/api/v1/auths/', GENERATE, UPSTREAM_MODELS])('limits upstream JSON cumulative bytes at %s', async oversizedPath => {
    const { gateway, lease } = await fixture((req, res) => {
      if (req.url !== oversizedPath) return defaults(req, res)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ secret: 'x'.repeat(1024 * 1024) }))
    })
    await expectError(await request(gateway, lease.capabilityToken, oversizedPath === UPSTREAM_MODELS ? MODELS : IMAGE), 413, 'IMAGE_TOO_LARGE')
  })

  it('has an independent image slot quota and aborts timed-out downloads without retries', async () => {
    const { gateway, lease, seen } = await fixture((req, res) => {
      if (req.url === FILE) { res.writeHead(200, { 'content-type': 'image/png' }); res.write(PNG.subarray(0, 8)); return }
      if (req.url === '/api/v1/models') return sendJson(res, { data: [] })
      defaults(req, res)
    }, { imageMaxConcurrent: 1, maxConcurrent: 1, imageTimeoutMs: 350 })
    const pending = request(gateway, lease.capabilityToken)
    await vi.waitFor(() => expect(seen.some(row => row.path === FILE)).toBe(true))
    await expectError(await request(gateway, lease.capabilityToken), 429, 'IMAGE_BUSY')
    expect((await request(gateway, gateway.capabilityToken, '/v1/models')).status).toBe(200)
    const timeout = await pending
    expect(await timeout.clone().text()).toMatch(/deadline|complete|charge|automatically/i)
    await expectError(timeout, 504, 'IMAGE_TIMEOUT')
    expect(seen.filter(row => row.path === GENERATE)).toHaveLength(1)
  })

  it('aborts on downstream disconnect, then frees the image quota', async () => {
    let downloadClosed = false
    const { gateway, lease, seen } = await fixture((req, res) => {
      if (req.url !== FILE) return defaults(req, res)
      res.on('close', () => { downloadClosed = true })
      res.writeHead(200, { 'content-type': 'image/png' })
      res.write(PNG.subarray(0, 8))
    }, { imageMaxConcurrent: 1 })
    const controller = new AbortController()
    const pending = fetch(`${gateway.url}${IMAGE}`, { method: 'POST', headers: { Authorization: `Bearer ${lease.capabilityToken}` }, body: JSON.stringify({ prompt: 'bird' }), signal: controller.signal }).catch(() => undefined)
    await vi.waitFor(() => expect(seen.some(row => row.path === FILE)).toBe(true))
    controller.abort()
    await pending
    await vi.waitFor(() => expect(downloadClosed).toBe(true))
    expect((await request(gateway, lease.capabilityToken, STATUS)).status).toBe(200)
    expect(seen.filter(row => row.path === GENERATE)).toHaveLength(1)
  })

  it('revokes only its own lease and aborts in-flight requests while keeping chat and other runtimes alive', async () => {
    let downloadClosed = false
    const { gateway, lease, seen } = await fixture((req, res) => {
      if (req.url !== FILE) return defaults(req, res)
      res.on('close', () => { downloadClosed = true })
      res.writeHead(200, { 'content-type': 'image/png' })
      res.write(PNG.subarray(0, 8))
    })
    const other = gateway.createImageLease()
    const pending = request(gateway, lease.capabilityToken)
    await vi.waitFor(() => expect(seen.some(row => row.path === FILE)).toBe(true))
    lease.revoke()
    lease.revoke()
    await expectError(await pending, 401, 'IMAGE_REVOKED')
    await vi.waitFor(() => expect(downloadClosed).toBe(true))
    await expectError(await request(gateway, lease.capabilityToken, STATUS), 401, 'IMAGE_AUTH')
    expect((await request(gateway, other.capabilityToken, STATUS)).status).toBe(200)
    expect((await request(gateway, gateway.capabilityToken, '/v1/models')).status).toBe(404)
  })

  it('guards late transport results after revocation and does not wait for an abort-ignoring upstream', async () => {
    let resolveGeneration: (response: Response) => void = () => { throw new Error('Not started') }
    let generationSignal: AbortSignal | undefined
    const cancel = vi.fn()
    const calls: string[] = []
    const { gateway, lease } = await fixture(defaults, { fetch: async (input, init) => {
      const path = new URL(input.toString()).pathname
      calls.push(path)
      if (path === GENERATE) {
        generationSignal = init?.signal ?? undefined
        return new Promise<Response>(resolve => { resolveGeneration = resolve })
      }
      return Response.json(path === '/api/config' ? { features: { enable_image_generation: true } } : { role: 'admin' })
    } })
    const pending = request(gateway, lease.capabilityToken)
    await vi.waitFor(() => expect(generationSignal).toBeDefined())
    lease.revoke()
    await expectError(await pending, 401, 'IMAGE_REVOKED')
    expect(generationSignal?.aborted).toBe(true)
    resolveGeneration(new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { 'content-type': 'application/json' } }))
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    expect(calls.filter(path => path === GENERATE)).toHaveLength(1)
    expect(calls).not.toContain(FILE)
  })

  it.each([
    ['image/jpeg', Buffer.from([255, 216, 255, 224])],
    ['image/webp', Buffer.from('RIFF0000WEBP', 'ascii')]
  ])('permits supported %s bytes for downstream full normalization', async (type, body) => {
    const { gateway, lease } = await fixture((req, res) => {
      if (req.url !== FILE) return defaults(req, res)
      res.writeHead(200, { 'content-type': type })
      res.end(body)
    })
    const response = await request(gateway, lease.capabilityToken)
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(body)
  })

  it.each(['application/json', 'text/plain'])('rejects malformed generation JSON with type %s', async type => {
    const { gateway, lease, seen } = await fixture((req, res) => {
      if (req.url !== GENERATE) return defaults(req, res)
      res.writeHead(200, { 'content-type': type })
      res.end('private-fixture-jwt INTERNAL not-json')
    })
    await expectError(await request(gateway, lease.capabilityToken), 502, 'IMAGE_RESPONSE')
    expect(seen.filter(row => row.path === GENERATE)).toHaveLength(1)
    expect(seen.some(row => row.path === FILE)).toBe(false)
  })

  it('sanitizes transport failures without retrying generation', async () => {
    let generations = 0
    const { gateway, lease } = await fixture(defaults, { fetch: async input => {
      const path = new URL(input.toString()).pathname
      if (path === GENERATE) {
        generations += 1
        throw new Error('private-fixture-jwt INTERNAL https://evil.invalid')
      }
      return Response.json(path === '/api/config' ? { features: { enable_image_generation: true } } : { role: 'admin' })
    } })
    await expectError(await request(gateway, lease.capabilityToken), 502, 'IMAGE_NETWORK')
    expect(generations).toBe(1)
  })

  it('uses one deadline across generation and download, including abort-ignoring transports', async () => {
    let generationStarted = false
    let downloadSignal: AbortSignal | undefined
    const { gateway, lease } = await fixture(defaults, { imageTimeoutMs: 250, fetch: async (input, init) => {
      const path = new URL(input.toString()).pathname
      if (path === GENERATE) {
        generationStarted = true
        await new Promise(resolve => setTimeout(resolve, 150))
        return Response.json([{ id: 'image-1', url: FILE }])
      }
      if (path === FILE) {
        downloadSignal = init?.signal ?? undefined
        // A hung injected transport must not keep the lease/quota pending after its total deadline.
        return new Promise<Response>(() => {})
      }
      return Response.json(path === '/api/config' ? { features: { enable_image_generation: true } } : { role: 'admin' })
    } })
    await expectError(await request(gateway, lease.capabilityToken), 504, 'IMAGE_TIMEOUT')
    expect(generationStarted).toBe(true)
    expect(downloadSignal?.aborted).toBe(true)
  })

  it('stop revokes every lease, cancels work, and forbids new lease creation', async () => {
    let signal: AbortSignal | undefined
    const { gateway, lease } = await fixture(defaults, { fetch: async (_input, init) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('private-fixture-jwt'))))
    } })
    const pending = request(gateway, lease.capabilityToken).catch(() => undefined)
    await vi.waitFor(() => expect(signal).toBeDefined())
    await Promise.all([gateway.stop(), gateway.stop(), pending])
    expect(signal?.aborted).toBe(true)
    expect(() => gateway.createImageLease()).toThrow('stopped')
  })
})
