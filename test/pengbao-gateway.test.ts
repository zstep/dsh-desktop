import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startPengbaoGateway, type PengbaoGateway, type PengbaoGatewayOptions } from '../src/main/enterprise/gateway'

const servers: Server[] = []
const gateways: PengbaoGateway[] = []
afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.stop()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve())
    server.closeAllConnections()
  })))
})

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('not listening')
  return `http://127.0.0.1:${address.port}`
}

async function gatewayFor(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>, options: Partial<PengbaoGatewayOptions> = {}) {
  const upstream = await listen(handler)
  const gateway = await startPengbaoGateway({
    jwt: 'private-jwt',
    fetch: (input, init) => fetch(input.toString().replace('https://pengbao.ecombus.net', upstream), init),
    ...options
  })
  gateways.push(gateway)
  return gateway
}

function request(gateway: PengbaoGateway, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string; noAuth?: boolean; token?: string } = {}): Promise<{ status: number; body: string; headers: IncomingMessage['headers'] }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${gateway.url}${options.path ?? '/v1/models'}`, {
      method: options.method ?? 'GET',
      headers: { ...(options.noAuth ? {} : { Authorization: `Bearer ${options.token ?? gateway.capabilityToken}` }), ...options.headers }
    }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

const chat = (body: unknown) => ({ method: 'POST', path: '/v1/chat/completions', body: JSON.stringify(body) })

describe('Pengbao gateway', () => {
  it.each(['http', 'transport', 'invalid-json'] as const)('reports safe defaults metadata %s failures without exposing upstream bodies', async mode => {
    const failures: unknown[] = []
    const gateway = await gatewayFor((req, res) => {
      expect(req.url).toBe('/api/config')
      if (mode === 'transport') { req.socket.destroy(); return }
      res.writeHead(mode === 'http' ? 503 : 200, { 'content-type': 'application/json' })
      res.end('private-jwt INTERNAL invalid-json')
    }, { onFailure: failure => failures.push(failure) })
    const response = await request(gateway, { path: '/v1/model-service/defaults' })
    expect(response.status).toBe(502)
    expect(response.body).not.toMatch(/private-jwt|INTERNAL/)
    expect(failures).toEqual([expect.objectContaining({
      requestId: expect.stringMatching(/^pb-[a-f0-9]{32}$/),
      kind: mode === 'http' ? 'upstream-http' : mode === 'transport' ? 'transport' : 'upstream-response',
      upstreamRoute: 'config', phase: mode === 'transport' ? 'request' : mode === 'http' ? 'headers' : 'body',
      ...(mode === 'transport' ? {} : { upstreamStatus: mode === 'http' ? 503 : 200 })
    })])
    expect(JSON.stringify(failures)).not.toMatch(/private-jwt|INTERNAL|invalid-json/)
  })

  it('reports metadata timeout even when transport ignores cancellation', async () => {
    const failures: unknown[] = []
    const gateway = await gatewayFor(() => {}, { timeoutMs: 80, fetch: async () => new Promise<Response>(() => {}), onFailure: failure => failures.push(failure) })
    expect((await request(gateway, { path: '/v1/model-service/defaults' })).status).toBe(504)
    expect(failures).toEqual([expect.objectContaining({ kind: 'timeout', upstreamRoute: 'config', phase: 'request', abortReason: 'deadline' })])
  })

  it('requires exact Host including port, capability auth, exact paths, and no browser headers', async () => {
    const upstream = vi.fn((_req: IncomingMessage, res: ServerResponse) => { res.end('{}') })
    const gateway = await gatewayFor(upstream)
    expect((await request(gateway, { noAuth: true })).status).toBe(401)
    const rejectedHeaders: Record<string, string>[] = [{ Host: 'evil.test' }, { Host: '127.0.0.1:1' }, { Host: `localhost:${gateway.port}` }, { Origin: '' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'same-origin' }, { 'Sec-Fetch-Mode': 'no-cors' }]
    for (const headers of rejectedHeaders) {
      expect((await request(gateway, { headers })).status).toBe(403)
    }
    for (const path of ['/v1/models/extra', '/v1/models?x=1', '/api/v1/models', '/v1/%6dodels']) {
      expect((await request(gateway, { path })).status).toBe(404)
    }
    expect((await request(gateway, { method: 'OPTIONS' })).status).toBe(404)
    expect(upstream).not.toHaveBeenCalled()
    const result = await request(gateway)
    expect(result.status).toBe(200)
    expect(result.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('accepts Node fetch while still rejecting browser-originated requests', async () => {
    const upstream = vi.fn((_req: IncomingMessage, res: ServerResponse) => { res.end('{"data":[]}') })
    const gateway = await gatewayFor(upstream)
    const response = await fetch(`${gateway.url}/v1/models`, {
      headers: { Authorization: `Bearer ${gateway.capabilityToken}` }
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: [] })
    expect(upstream).toHaveBeenCalledOnce()
    expect((await request(gateway, { headers: { 'Sec-Fetch-Mode': 'navigate' } })).status).toBe(403)
    expect((await request(gateway, { headers: { 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(403)
  })

  it('maps fixed paths, preserves nested tool association and sources/error SSE, and strips headers', async () => {
    const messages = [{ role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'x', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call_1', content: 'ok' }]
    const seen: { url?: string; headers?: IncomingMessage['headers']; body?: unknown } = {}
    const sse = 'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1"}]}}]}\n\ndata: {"sources":["source"]}\n\ndata: {"error":{"message":"provider event"}}\n\ndata: [DONE]\n\n'
    const gateway = await gatewayFor(async (req, res) => {
      seen.url = req.url
      seen.headers = req.headers
      let text = ''
      for await (const chunk of req) text += chunk
      seen.body = text ? JSON.parse(text) : undefined
      res.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': 'secret=1', 'x-internal': 'private-jwt', 'access-control-allow-origin': '*' })
      res.end(sse)
    })
    const result = await request(gateway, { ...chat({ model: 'm', messages, custom_cloud_field: true }), headers: { 'x-secret': 'nope', Cookie: 'session=secret' } })
    expect(result.status).toBe(200)
    expect(result.body).toBe(sse)
    expect(seen.url).toBe('/api/v1/chat/completions')
    expect(seen.body).toEqual({ model: 'm', messages, tools: [], features: { memory: true } })
    expect(seen.headers?.authorization).toBe('Bearer private-jwt')
    expect(seen.headers?.['x-secret']).toBeUndefined()
    expect(seen.headers?.cookie).toBeUndefined()
    expect(result.headers['set-cookie']).toBeUndefined()
    expect(result.headers['x-internal']).toBeUndefined()
    expect(result.headers['access-control-allow-origin']).toBeUndefined()
    await request(gateway)
    expect(seen.url).toBe('/api/v1/models')
  })

  it('preserves image input inside messages without granting image-generation access', async () => {
    const messages = [{ role: 'user', content: [
      { type: 'text', text: 'Describe this fixture' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'low' } }
    ] }]
    let forwarded: unknown
    const gateway = await gatewayFor(async (req, res) => {
      let text = ''
      for await (const chunk of req) text += chunk
      forwarded = JSON.parse(text)
      res.end('{"choices":[]}')
    })
    expect((await request(gateway, chat({ model: 'vision', messages }))).status).toBe(200)
    expect(forwarded).toEqual({ model: 'vision', messages, tools: [], features: { memory: true } })
    expect((await request(gateway, { method: 'POST', path: '/v1/images/generations', body: '{}' })).status).toBe(401)
  })

  it.each(['chat_id', 'id', 'session_id', 'parent_id', 'tool_ids', 'metadata', 'features', 'files'])('rejects cloud orchestration %s before upstream', async key => {
    const upstream = vi.fn((_req: IncomingMessage, res: ServerResponse) => { res.end('{}') })
    const gateway = await gatewayFor(upstream)
    expect((await request(gateway, chat({ model: 'm', messages: [], [key]: 'bad' }))).status).toBe(400)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('refuses redirects and sanitizes upstream errors and exceptions', async () => {
    let calls = 0
    const gateway = await gatewayFor((_req, res) => {
      calls += 1
      res.writeHead(302, { location: '/stolen', 'set-cookie': 'token=private-jwt' })
      res.end('private-jwt')
    })
    const result = await request(gateway)
    expect(result.status).toBe(502)
    expect(result.body).not.toContain('private-jwt')
    expect(result.headers.location).toBeUndefined()
    expect(calls).toBe(1)
    const failed = await gatewayFor((_req, res) => { res.writeHead(500); res.end('private-jwt') })
    expect((await request(failed)).body).not.toContain('private-jwt')
    const throwing = await gatewayFor(() => {}, { fetch: async () => { throw new Error('private-jwt INTERNAL') } })
    expect((await request(throwing)).body).not.toMatch(/private-jwt|INTERNAL/)
  })

  it.each([400, 401, 403, 404, 413, 422, 429, 500, 502, 503, 504])('preserves upstream HTTP %s without exposing its body or headers', async status => {
    const onFailure = vi.fn()
    const gateway = await gatewayFor((_req, res) => {
      res.writeHead(status, { 'content-type': 'text/plain', 'set-cookie': 'secret=private-jwt', 'x-internal': 'private-jwt' })
      res.end('stream timeout private-jwt INTERNAL https://upstream.invalid')
    }, { onFailure })
    const result = await request(gateway, chat({ model: 'm', messages: [], tools: [] }))
    expect(result.status).toBe(status)
    expect(JSON.parse(result.body)).toMatchObject({ error: { type: 'upstream_error', upstream_status: status } })
    expect(result.body).not.toMatch(/private-jwt|INTERNAL|upstream\.invalid|stream timeout/)
    expect(result.headers['set-cookie']).toBeUndefined()
    expect(result.headers['x-internal']).toBeUndefined()
    expect(onFailure).toHaveBeenCalledOnce()
    expect(onFailure.mock.calls[0]).toEqual([{ requestId: expect.stringMatching(/^pb-[a-f0-9]{32}$/), kind: 'upstream-http', upstreamStatus: status, elapsedMs: expect.any(Number), phase: 'headers', bytesReceived: 0, upstreamHeadersMs: expect.any(Number) }])
    if (status === 504) expect(JSON.parse(result.body).error.message).toContain('timed out')
  })

  it('generates a fresh correlation ID per attempt and ignores caller-supplied IDs', async () => {
    const onFailure = vi.fn()
    const ids: string[] = []
    const gateway = await gatewayFor((req, res) => {
      ids.push(String(req.headers['x-pengbao-request-id']))
      res.writeHead(504)
      res.end('private-jwt')
    }, { onFailure })
    for (let i = 0; i < 2; i++) {
      const result = await request(gateway, { ...chat({ model: 'm', messages: [] }), headers: { 'X-Pengbao-Request-Id': 'private-jwt' } })
      expect(result.status).toBe(504)
      expect(result.headers['x-pengbao-request-id']).toBeUndefined()
      expect(result.body).not.toContain(ids[i])
      expect(onFailure.mock.calls[i]?.[0].requestId).toBe(ids[i])
    }
    expect(ids.every(id => /^pb-[a-f0-9]{32}$/.test(id))).toBe(true)
    expect(new Set(ids).size).toBe(2)
    expect(JSON.stringify(onFailure.mock.calls)).not.toContain('private-jwt')
  })

  it('does not replay timed-out requests or invalidate the account route', async () => {
    const onFailure = vi.fn()
    let calls = 0
    const gateway = await gatewayFor((_req, res) => {
      calls += 1
      if (calls === 1) { res.writeHead(504); res.end('stream timeout'); return }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: [DONE]\n\n')
    }, { onFailure })
    expect((await request(gateway, chat({ model: 'm', messages: [], tools: [] }))).status).toBe(504)
    expect(calls).toBe(1)
    const recovered = await request(gateway, chat({ model: 'm', messages: [], tools: [] }))
    expect(recovered.status).toBe(200)
    expect(recovered.body).toBe('data: [DONE]\n\n')
    expect(calls).toBe(2)
    expect(onFailure).toHaveBeenCalledOnce()
  })

  it('records only safe transport metadata and isolates diagnostic callback failures', async () => {
    const onFailure = vi.fn(() => { throw new Error('diagnostic sink failed') })
    const gateway = await gatewayFor(() => {}, { onFailure, fetch: async () => { throw new Error('private-jwt INTERNAL') } })
    const result = await request(gateway)
    expect(result.status).toBe(502)
    expect(result.body).not.toMatch(/private-jwt|INTERNAL|diagnostic/)
    expect(onFailure.mock.calls[0]).toEqual([{ requestId: expect.stringMatching(/^pb-[a-f0-9]{32}$/), kind: 'transport', elapsedMs: expect.any(Number), phase: 'request', bytesReceived: 0 }])
  })

  it.each([false, true])('distinguishes a post-header reset with body bytes=%s without replay or sensitive diagnostics', async withBody => {
    const onFailure = vi.fn()
    let upstreamStream: ReadableStreamDefaultController<Uint8Array> | undefined
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        upstreamStream = controller
        if (withBody) controller.enqueue(new TextEncoder().encode('data: private-jwt\n\n'))
      }
    }), { headers: { 'content-type': 'text/event-stream' } }))
    const gateway = await gatewayFor(() => {}, { fetch: fetcher, onFailure })
    const response = await fetch(`${gateway.url}/v1/models`, { headers: { Authorization: `Bearer ${gateway.capabilityToken}` } })
    expect(response.status).toBe(200)
    const reader = response.body?.getReader()
    if (!reader || !upstreamStream) throw new Error('missing stream')
    if (withBody) expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: private-jwt\n\n')
    const failedRead = reader.read()
    upstreamStream.error(new Error('private-jwt INTERNAL', { cause: { code: 'UND_ERR_SOCKET', message: 'private-jwt' } }))
    await expect(failedRead).rejects.toThrow()
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce())
    expect(onFailure.mock.calls[0]?.[0]).toEqual({
      requestId: expect.stringMatching(/^pb-[a-f0-9]{32}$/), kind: 'transport', upstreamStatus: 200, phase: withBody ? 'body' : 'headers',
      bytesReceived: withBody ? Buffer.byteLength('data: private-jwt\n\n') : 0,
      elapsedMs: expect.any(Number), upstreamHeadersMs: expect.any(Number), transportCode: 'UND_ERR_SOCKET',
      ...(withBody ? { firstByteMs: expect.any(Number), lastByteMs: expect.any(Number) } : {})
    })
    expect(JSON.stringify(onFailure.mock.calls)).not.toMatch(/private-jwt|INTERNAL|message/)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('does not include unknown transport codes in diagnostics', async () => {
    const onFailure = vi.fn()
    const gateway = await gatewayFor(() => {}, { onFailure, fetch: async () => {
      throw new Error('private-jwt', { cause: { code: 'private-jwt' } })
    } })
    expect((await request(gateway)).status).toBe(502)
    expect(onFailure.mock.calls[0]?.[0]).not.toHaveProperty('transportCode')
    expect(JSON.stringify(onFailure.mock.calls)).not.toContain('private-jwt')
  })

  it('classifies a silent upstream deadline separately from downstream cancellation', async () => {
    const onFailure = vi.fn()
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal
      if (!signal) throw new Error('missing signal')
      return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('private-jwt')), { once: true }))
    })
    const gateway = await gatewayFor(() => {}, { onFailure, timeoutMs: 100, fetch: fetcher })
    expect((await request(gateway)).status).toBe(504)
    expect(onFailure).toHaveBeenCalledOnce()
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({ kind: 'timeout', phase: 'request', bytesReceived: 0, abortReason: 'deadline' })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it.each([false, true])('attributes a post-header deadline with body bytes=%s to the local timer', async withBody => {
    const onFailure = vi.fn()
    const cancel = vi.fn()
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { if (withBody) controller.enqueue(new TextEncoder().encode('data: first\n\n')) },
      cancel
    }), { headers: { 'content-type': 'text/event-stream' } }))
    const gateway = await gatewayFor(() => {}, { onFailure, timeoutMs: 250, fetch: fetcher })
    const response = await fetch(`${gateway.url}/v1/models`, { headers: { Authorization: `Bearer ${gateway.capabilityToken}` } })
    expect(response.status).toBe(200)
    await expect(response.text()).rejects.toThrow()
    expect(onFailure).toHaveBeenCalledOnce()
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({ kind: 'timeout', phase: withBody ? 'body' : 'headers', abortReason: 'deadline', upstreamStatus: 200 })
    expect(onFailure.mock.calls[0]?.[0]).not.toHaveProperty('transportCode')
    expect(cancel).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('preserves a quiet interval and subsequent SSE bytes without inventing an idle deadline', async () => {
    const onFailure = vi.fn()
    let upstreamStream: ReadableStreamDefaultController<Uint8Array> | undefined
    const gateway = await gatewayFor(() => {}, { onFailure, timeoutMs: 2000, fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { upstreamStream = controller }
    }), { headers: { 'content-type': 'text/event-stream' } }) })
    const response = await fetch(`${gateway.url}/v1/models`, { headers: { Authorization: `Bearer ${gateway.capabilityToken}` } })
    await new Promise(resolve => setTimeout(resolve, 100))
    if (!upstreamStream) throw new Error('missing stream')
    upstreamStream.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
    upstreamStream.close()
    expect(await response.text()).toBe('data: [DONE]\n\n')
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('limits bodies, invalid JSON, concurrency, and request duration', async () => {
    let markStarted: () => void = () => { throw new Error('request gate not initialized') }
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const gateway = await gatewayFor(() => { markStarted() }, { maxBodyBytes: 64, maxConcurrent: 1, timeoutMs: 1000 })
    expect((await request(gateway, chat({ model: 'm', messages: [], padding: 'x'.repeat(100) }))).status).toBe(413)
    expect((await request(gateway, { method: 'POST', path: '/v1/chat/completions', body: '{' })).status).toBe(400)
    const pending = request(gateway)
    // Wait until the first request owns the slot instead of racing two connections.
    await started
    expect((await request(gateway)).status).toBe(429)
    expect((await pending).status).toBe(504)
  })

  it('streams before completion and cancels the upstream reader on downstream disconnect', async () => {
    let closed = false
    const onFailure = vi.fn()
    const gateway = await gatewayFor((_req, res) => {
      res.on('close', () => { closed = true })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: first\n\n')
    }, { onFailure })
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(`${gateway.url}/v1/models`, { headers: { Authorization: `Bearer ${gateway.capabilityToken}` } }, res => {
        res.once('data', chunk => {
          expect(chunk.toString()).toBe('data: first\n\n')
          res.destroy()
          resolve()
        })
      })
      req.on('error', reject)
      req.end()
    })
    await vi.waitFor(() => expect(closed).toBe(true))
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce())
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({ kind: 'cancelled', abortReason: 'downstream', phase: 'body', bytesReceived: Buffer.byteLength('data: first\n\n') })
  })

  it('applies downstream backpressure instead of reading the entire upstream stream', async () => {
    let pulls = 0
    const cancel = vi.fn()
    const gateway = await gatewayFor(() => {}, { fetch: async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(64 * 1024))
      },
      cancel
    }), { headers: { 'content-type': 'text/event-stream' } }) })
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = httpRequest(`${gateway.url}/v1/models`, { headers: { Authorization: `Bearer ${gateway.capabilityToken}` } }, res => {
        res.pause()
        resolve(res)
      })
      req.on('error', reject)
      req.end()
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    const boundedPulls = pulls
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(pulls).toBe(boundedPulls)
    expect(pulls).toBeLessThan(512)
    response.destroy()
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled())
  })

  it('revokes only its own grants and aborts only their active requests', async () => {
    const signals: AbortSignal[] = []
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal
      if (!signal) throw new Error('missing signal')
      signals.push(signal)
      return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    })
    const gateway = await gatewayFor(() => {}, { fetch: fetcher })
    const first = gateway.createModelServiceGrant(['chat.completions'])
    const second = gateway.createModelServiceGrant(['chat.completions'])
    expect(first).toMatchObject({ contractVersion: 1, gatewayUrl: gateway.url, capabilities: ['chat.completions'] })

    const firstRequest = request(gateway, { token: first.capabilityToken }).catch(() => undefined)
    await vi.waitFor(() => expect(signals).toHaveLength(1))
    const secondRequest = request(gateway, { token: second.capabilityToken }).catch(() => undefined)
    await vi.waitFor(() => expect(signals).toHaveLength(2))
    const legacyRequest = request(gateway).catch(() => undefined)
    await vi.waitFor(() => expect(signals).toHaveLength(3))

    first.revoke()
    await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true))
    expect(signals[1]?.aborted).toBe(false)
    expect(signals[2]?.aborted).toBe(false)
    expect((await request(gateway, { token: first.capabilityToken })).status).toBe(401)
    await Promise.all([firstRequest])
    second.revoke()
    expect((await request(gateway, { token: second.capabilityToken })).status).toBe(401)
    await secondRequest
    await gateway.stop()
    await legacyRequest
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('keeps sibling requests registered after one request completes', async () => {
    const signals: AbortSignal[] = []
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal
      if (!signal) throw new Error('missing signal')
      signals.push(signal)
      if (signals.length === 1) return Response.json({ data: [] })
      return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    })
    const gateway = await gatewayFor(() => {}, { fetch: fetcher })
    const grant = gateway.createModelServiceGrant(['chat.completions'])
    expect((await request(gateway, { token: grant.capabilityToken })).status).toBe(200)
    const pending = request(gateway, { token: grant.capabilityToken }).catch(() => undefined)
    await vi.waitFor(() => expect(signals).toHaveLength(2))

    grant.revoke()
    await vi.waitFor(() => expect(signals[1]?.aborted).toBe(true))
    expect(signals[0]?.aborted).toBe(false)
    await pending
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('rejects unsupported and duplicate model service scopes', async () => {
    const gateway = await gatewayFor(() => {})
    expect(() => gateway.createModelServiceGrant([])).toThrow('Unsupported model service grant')
    expect(() => gateway.createModelServiceGrant(['chat.completions', 'chat.completions'])).toThrow('Unsupported model service grant')
    expect(() => gateway.createModelServiceGrant(['video.generate'] as unknown as Parameters<typeof gateway.createModelServiceGrant>[0])).toThrow('Unsupported model service grant')
    expect(() => gateway.createModelServiceGrant(['image.generate'])).toThrow('Unsupported model service grant')
  })

  it('stop aborts every upstream request, closes clients, and is idempotent', async () => {
    const signals: AbortSignal[] = []
    const gateway = await gatewayFor(() => {}, { fetch: async (_input, init) => {
      const signal = init?.signal
      if (!signal) throw new Error('missing signal')
      signals.push(signal)
      return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('private-jwt')), { once: true }))
    } })
    const pending = [request(gateway).catch(() => undefined), request(gateway).catch(() => undefined)]
    await vi.waitFor(() => expect(signals).toHaveLength(2))
    await Promise.all([gateway.stop(), gateway.stop()])
    await Promise.all(pending)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    await expect(request(gateway)).rejects.toThrow()
  })
})
