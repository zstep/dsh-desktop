import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { PENGBAO_PRODUCT } from './config'
import { createImageGateway, IMAGE_GATEWAY_TIMEOUT_MS, type PengbaoImageLease, type PengbaoImageFailure } from './image-gateway'

const TOP_LEVEL = ['model', 'messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'stream', 'stream_options', 'temperature', 'max_tokens', 'max_completion_tokens', 'top_p', 'stop', 'frequency_penalty', 'presence_penalty', 'seed', 'response_format', 'reasoning_effort'] as const
const FORBIDDEN = new Set(['chat_id', 'id', 'session_id', 'parent_id', 'tool_ids', 'metadata', 'features', 'files', 'filter_ids', 'function_call', 'functions'])

export interface PengbaoGatewayFailure {
  kind: 'upstream-http' | 'transport' | 'timeout'
  upstreamStatus?: number
  elapsedMs: number
}

export interface PengbaoGatewayOptions {
  jwt: string
  fetch?: typeof fetch
  maxBodyBytes?: number
  maxConcurrent?: number
  timeoutMs?: number
  imageTimeoutMs?: number
  imageMaxConcurrent?: number
  onFailure?: (failure: PengbaoGatewayFailure) => void
  onImageFailure?: (failure: PengbaoImageFailure) => void
}

export interface PengbaoGateway {
  url: string
  port: number
  capabilityToken: string
  createImageLease: () => PengbaoImageLease
  stop: () => Promise<void>
}

class RequestFailure extends Error {
  constructor(readonly status: number, readonly upstreamStatus?: number) { super('Gateway request failed') }
}

function fail(res: ServerResponse, status: number, upstreamStatus?: number): void {
  if (res.destroyed) return
  if (res.headersSent) { res.destroy(); return }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'connection': 'close' })
  const message = upstreamStatus === 504 ? 'Pengbao model service timed out before responding. Try again later or select another model.' :
    upstreamStatus === 429 ? 'Pengbao model service is rate limited. Try again later.' :
      upstreamStatus === undefined ? 'Gateway request failed' : `Pengbao model service returned HTTP ${upstreamStatus}`
  res.end(JSON.stringify({ error: { message, type: upstreamStatus === undefined ? 'gateway_error' : 'upstream_error',
    ...(upstreamStatus === undefined ? {} : { upstream_status: upstreamStatus }) } }))
}

async function readBody(req: IncomingMessage, limit: number, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const cleanup = () => {
      req.off('data', data)
      req.off('end', end)
      req.off('error', error)
      signal.removeEventListener('abort', abort)
    }
    const error = (reason: unknown) => { cleanup(); reject(reason) }
    const abort = () => error(new RequestFailure(504))
    const data = (part: Buffer) => {
      size += part.length
      if (size > limit) { req.pause(); error(new RequestFailure(413)); return }
      chunks.push(part)
    }
    const end = () => {
      cleanup()
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) }
      catch { reject(new RequestFailure(400)) }
    }
    req.on('data', data)
    req.once('end', end)
    req.once('error', error)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

function chatBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestFailure(400)
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => FORBIDDEN.has(key))) throw new RequestFailure(400)
  if (typeof input.model !== 'string' || !input.model.trim() || !Array.isArray(input.messages)) throw new RequestFailure(400)
  if (input.messages.some(message => !message || typeof message !== 'object' || Array.isArray(message))) throw new RequestFailure(400)
  if ('tools' in input && !Array.isArray(input.tools)) throw new RequestFailure(400)
  const output: Record<string, unknown> = { tools: [] }
  // Only inference fields cross the boundary. Message-level tool IDs stay intact.
  for (const key of TOP_LEVEL) if (Object.hasOwn(input, key)) output[key] = input[key]
  return output
}

export async function startPengbaoGateway(options: PengbaoGatewayOptions): Promise<PengbaoGateway> {
  let jwt = options.jwt
  if (!jwt || /[\r\n]/.test(jwt)) throw new Error('Invalid gateway credential')
  const maxBody = options.maxBodyBytes ?? 1_048_576
  const maxConcurrent = options.maxConcurrent ?? 4
  const timeout = options.timeoutMs ?? 120_000
  const imageTimeout = options.imageTimeoutMs ?? IMAGE_GATEWAY_TIMEOUT_MS
  const imageMaxConcurrent = options.imageMaxConcurrent ?? 2
  for (const limit of [maxBody, maxConcurrent, timeout, imageTimeout, imageMaxConcurrent]) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid gateway limit')
  }
  const upstreamFetch = options.fetch ?? fetch
  const capabilityToken = randomBytes(32).toString('base64url')
  let credential = Buffer.from(`Bearer ${capabilityToken}`)
  const active = new Set<AbortController>()
  let stopping = false
  let authority = ''
  let stopPromise: Promise<void> | undefined

  const images = createImageGateway({ getJwt: () => jwt, fetch: upstreamFetch, maxBodyBytes: maxBody,
    timeoutMs: Math.min(imageTimeout, IMAGE_GATEWAY_TIMEOUT_MS), maxConcurrent: imageMaxConcurrent, onFailure: options.onImageFailure })
  const serverTimeout = Math.max(timeout, Math.min(imageTimeout, IMAGE_GATEWAY_TIMEOUT_MS))
  const server = createServer((req, res) => { void handle(req, res) })
  server.headersTimeout = 10_000
  server.requestTimeout = serverTimeout
  server.maxHeadersCount = 32
  server.on('connection', socket => { socket.setTimeout(serverTimeout, () => socket.destroy()) })
  server.on('upgrade', (_req, socket) => socket.destroy())
  server.on('connect', (_req, socket) => socket.destroy())

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (stopping) return fail(res, 503)
    const hostCount = req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index]?.toLowerCase() === 'host').length
    // Node's fetch sends Sec-Fetch-Mode: cors without Origin or Sec-Fetch-Site.
    // Browser-initiated requests carry a site or origin; never accept those.
    const fetchMode = req.headers['sec-fetch-mode']
    if (hostCount !== 1 || req.headers.host !== authority || 'origin' in req.headers ||
      'sec-fetch-site' in req.headers || (fetchMode !== undefined && fetchMode !== 'cors')) return fail(res, 403)
    // Image routes authenticate only against runtime-scoped image leases, never the chat credential.
    if (req.url?.startsWith('/v1/image-generation/')) return images.handle(req, res)
    const supplied = Buffer.from(req.headers.authorization ?? '')
    if (supplied.length !== credential.length || !timingSafeEqual(supplied, credential)) return fail(res, 401)
    const isModels = req.method === 'GET' && req.url === '/v1/models'
    const isChat = req.method === 'POST' && req.url === '/v1/chat/completions'
    if (!isModels && !isChat) return fail(res, 404)
    if (active.size >= maxConcurrent) return fail(res, 429)
    const started = Date.now()
    let forwarded = false
    let upstreamStatus: number | undefined
    const controller = new AbortController()
    active.add(controller)
    const timer = setTimeout(() => controller.abort(), timeout)
    const close = () => controller.abort()
    req.once('aborted', close)
    res.once('close', close)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const cancel = () => { void reader?.cancel().catch(() => { /* Transport may already be closed. */ }) }
    controller.signal.addEventListener('abort', cancel, { once: true })
    try {
      if (req.headers['content-encoding']) throw new RequestFailure(415)
      if (Number(req.headers['content-length'] ?? 0) > maxBody) throw new RequestFailure(413)
      const body = isChat ? chatBody(await readBody(req, maxBody, controller.signal)) : undefined
      controller.signal.throwIfAborted()
      forwarded = true
      const upstream = await upstreamFetch(`${PENGBAO_PRODUCT.serverUrl}/api/v1${isModels ? '/models' : '/chat/completions'}`, {
        method: isModels ? 'GET' : 'POST',
        redirect: 'manual',
        credentials: 'omit',
        signal: controller.signal,
        headers: isModels ? { Authorization: `Bearer ${jwt}` } : { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
      })
      upstreamStatus = upstream.status
      reader = upstream.body?.getReader()
      controller.signal.throwIfAborted()
      // Preserve inference failures without reflecting bodies, cookies, redirects, or internal headers.
      if (upstream.redirected || upstream.type === 'opaqueredirect' || (upstream.status < 400 && !upstream.ok)) {
        throw new RequestFailure(502, upstream.status)
      }
      if (!upstream.ok) throw new RequestFailure(upstream.status, upstream.status)
      const sse = upstream.headers.get('content-type')?.split(';')[0]?.trim() === 'text/event-stream'
      res.writeHead(200, { 'content-type': sse ? 'text/event-stream' : 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.flushHeaders()
      while (reader) {
        const { done, value } = await reader.read()
        controller.signal.throwIfAborted()
        if (done) break
        // Forward bytes, including sources/error events, without buffering SSE.
        if (!res.write(value)) await once(res, 'drain', { signal: controller.signal })
      }
      res.end()
    } catch (error) {
      if (forwarded && !stopping && !res.destroyed) {
        try {
          options.onFailure?.({ kind: error instanceof RequestFailure ? 'upstream-http' : controller.signal.aborted ? 'timeout' : 'transport',
            ...(upstreamStatus === undefined ? {} : { upstreamStatus }), elapsedMs: Date.now() - started })
        } catch { /* Diagnostics must not change request handling. */ }
      }
      fail(res, error instanceof RequestFailure ? error.status : controller.signal.aborted ? 504 : 502,
        error instanceof RequestFailure ? error.upstreamStatus : undefined)
    } finally {
      cancel()
      clearTimeout(timer)
      req.off('aborted', close)
      res.off('close', close)
      controller.signal.removeEventListener('abort', cancel)
      active.delete(controller)
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Gateway did not bind')
  authority = `127.0.0.1:${address.port}`
  return {
    port: address.port,
    url: `http://${authority}`,
    capabilityToken,
    createImageLease: images.createLease,
    stop: () => {
      if (stopPromise) return stopPromise
      stopping = true
      images.stop()
      credential = Buffer.alloc(0)
      jwt = ''
      for (const controller of active) controller.abort()
      stopPromise = new Promise<void>(resolve => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      return stopPromise
    }
  }
}

export const createPengbaoGateway = startPengbaoGateway
