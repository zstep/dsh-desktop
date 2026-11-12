import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { once } from 'node:events'
import { PENGBAO_PRODUCT } from './config'

const MAX_JSON_BYTES = 262_144
// Reference-image bodies must reach the parser to be rejected with a useful
// message; text-only submissions are far smaller.
const MAX_SUBMIT_BYTES = 16 * 1024 * 1024
const MAX_VIDEO_BYTES = 512 * 1024 * 1024
const SUBMIT_TIMEOUT_MS = 30_000
const STATUS_TIMEOUT_MS = 15_000
const CONTENT_HEADERS_TIMEOUT_MS = 30_000
/** Longest time a finished clip may take to stream through the local gateway. */
export const VIDEO_GATEWAY_TIMEOUT_MS = 300_000

export interface PengbaoVideoLease {
  capabilityToken: string
  revoke: () => void
}

export interface PengbaoVideoFailure {
  requestId: string
  stage: 'submit' | 'status' | 'content' | 'download'
  code: VideoErrorCode
  elapsedMs: number
  upstreamStatus?: number
  /** Bounded, sanitized upstream error text. Local diagnostics only; never returned to the plugin. */
  upstreamDetail?: string
}

type VideoErrorCode = 'VIDEO_AUTH' | 'VIDEO_FORBIDDEN' | 'VIDEO_BUSY' | 'VIDEO_NETWORK' | 'VIDEO_TIMEOUT' |
  'VIDEO_UPSTREAM_TIMEOUT' | 'VIDEO_RESPONSE' | 'VIDEO_TOO_LARGE' | 'VIDEO_INVALID_REQUEST' |
  'VIDEO_REFERENCE_UNSUPPORTED' | 'VIDEO_MODEL_UNAVAILABLE' | 'VIDEO_NOT_FOUND' |
  'VIDEO_CONTENT_UNAVAILABLE' | 'VIDEO_REJECTED' | 'VIDEO_REVOKED'

class VideoFailure extends Error {
  constructor(readonly status: number, readonly code: VideoErrorCode, readonly upstreamStatus?: number,
    readonly upstreamDetail?: string) { super(code) }
}

const MESSAGES: Record<VideoErrorCode, string> = {
  VIDEO_AUTH: 'Video generation authentication is required.',
  VIDEO_FORBIDDEN: 'Video generation is not enabled for this account.',
  VIDEO_BUSY: 'Video generation is busy. Try again later.',
  VIDEO_NETWORK: 'Video generation service is unavailable. Try again later.',
  VIDEO_TIMEOUT: 'The local video generation deadline expired. The server may still complete and charge for the request. This request will not be retried automatically.',
  VIDEO_UPSTREAM_TIMEOUT: 'The video generation service returned HTTP 504 (upstream timeout). The server may still complete and charge for the request. This request will not be retried automatically.',
  VIDEO_RESPONSE: 'Video generation returned an unsupported response.',
  VIDEO_TOO_LARGE: 'The video generation request or response is too large.',
  VIDEO_INVALID_REQUEST: 'Video generation accepts a prompt, a model and an optional size.',
  VIDEO_REFERENCE_UNSUPPORTED: 'This service supports text-to-video only; reference images and keyframes are not supported.',
  VIDEO_MODEL_UNAVAILABLE: 'The selected video model is no longer available. Refresh the model list and try again.',
  VIDEO_NOT_FOUND: 'The video task was not found or is no longer available.',
  VIDEO_CONTENT_UNAVAILABLE: 'The generated video is not available for download.',
  VIDEO_REJECTED: 'The video service rejected the request. Check the selected model and prompt.',
  VIDEO_REVOKED: 'Video generation access was revoked. The server may still complete and charge for the request.'
}

function fail(res: ServerResponse, failure: VideoFailure, diagnostic?: PengbaoVideoFailure): void {
  if (res.destroyed) return
  if (res.headersSent) { res.destroy(); return }
  res.writeHead(failure.status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'connection': 'close' })
  res.end(JSON.stringify({ error: { message: MESSAGES[failure.code], type: 'video_gateway_error', code: failure.code, ...(diagnostic ? { diagnostic } : {}) } }))
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

// Race the deadline even if an injected transport ignores AbortSignal. Never deliver late results.
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => {}
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })])
  } finally { signal.removeEventListener('abort', abort) }
}

// Bind a sub-operation to the request deadline; aborting the source wins.
async function bounded<T>(source: AbortSignal, timeoutMs: number, reason: VideoFailure, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(reason), timeoutMs)
  const abort = () => controller.abort(source.reason)
  source.addEventListener('abort', abort, { once: true })
  if (source.aborted) abort()
  try {
    return await work(controller.signal)
  } finally {
    clearTimeout(timer)
    source.removeEventListener('abort', abort)
  }
}

// `redirect: 'error'` is used for every upstream request. Node's fetch surfaces
// a rejected redirect as a generic TypeError; treat it as an invalid response
// rather than a transport outage so DNS/socket failures stay VIDEO_NETWORK.
function isRejectedRedirect(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const cause = 'cause' in error ? error.cause : undefined
  return cause !== null && typeof cause === 'object' && 'message' in cause && cause.message === 'unexpected redirect'
}

async function bytes(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
  const reader = response.body?.getReader()
  const cancel = () => { void reader?.cancel().catch(() => { /* The transport may already be closed. */ }) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    const length = response.headers.get('content-length')
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new VideoFailure(413, 'VIDEO_TOO_LARGE')
    if (!reader) throw new VideoFailure(502, 'VIDEO_RESPONSE')
    const chunks: Buffer[] = []
    let size = 0
    while (true) {
      const part = await abortable(reader.read(), signal)
      signal.throwIfAborted()
      if (part.done) break
      size += part.value.byteLength
      if (size > limit) throw new VideoFailure(413, 'VIDEO_TOO_LARGE')
      chunks.push(Buffer.from(part.value))
    }
    return Buffer.concat(chunks, size)
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
  }
}

async function json(response: Response, signal: AbortSignal, limit = MAX_JSON_BYTES): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    void response.body?.cancel().catch(() => { /* Rejected responses are never forwarded. */ })
    throw new VideoFailure(502, 'VIDEO_RESPONSE')
  }
  const body = await bytes(response, limit, signal)
  try { return JSON.parse(body.toString('utf8')) as unknown }
  catch { throw new VideoFailure(502, 'VIDEO_RESPONSE') }
}

/**
 * Reads a tiny, sanitized slice of an upstream failure body so the Desktop log
 * can explain a refusal. It is reported to local diagnostics only; the plugin
 * never receives upstream error text.
 */
async function errorDetail(response: Response, signal: AbortSignal): Promise<string | undefined> {
  const reader = response.body?.getReader()
  if (!reader) return undefined
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (size < 4096) {
      const part = await abortable(reader.read(), signal)
      if (part.done) break
      size += part.value.byteLength
      chunks.push(Buffer.from(part.value))
    }
  } catch { return undefined }
  finally { void reader.cancel().catch(() => { /* Rejected bodies are never forwarded. */ }) }
  const text = Buffer.concat(chunks).subarray(0, 4096).toString('utf8').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return text === '' ? undefined : text.slice(0, 1000)
}

async function readBody(req: IncomingMessage, limit: number, signal: AbortSignal): Promise<Buffer> {
  if (req.headers['content-encoding']) throw new VideoFailure(400, 'VIDEO_INVALID_REQUEST')
  if (Number(req.headers['content-length'] ?? 0) > limit) throw new VideoFailure(413, 'VIDEO_TOO_LARGE')
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const cleanup = () => {
      req.off('data', data)
      req.off('end', end)
      req.off('error', error)
      signal.removeEventListener('abort', abort)
    }
    const failRead = (reason: unknown) => { cleanup(); reject(reason) }
    const abort = () => failRead(signal.reason)
    const data = (part: Buffer) => {
      size += part.length
      if (size > limit) { req.pause(); failRead(new VideoFailure(413, 'VIDEO_TOO_LARGE')); return }
      chunks.push(part)
    }
    const end = () => { cleanup(); resolve(Buffer.concat(chunks, size)) }
    const error = (reason: unknown) => failRead(reason)
    req.on('data', data)
    req.once('end', end)
    req.once('error', error)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

type SubmitInput = { model: string; prompt: string; size?: string }

const SUBMIT_FIELDS = new Set(['model', 'prompt', 'seconds', 'size', 'aspect_ratio', 'image'])

// The deployed video route forwards only `{model, prompt, size}`; anything the
// provider's own clients attach (reference images, keyframes, duration) would
// be silently dropped upstream. Reject reference input loudly instead of
// rendering a text-only clip the user did not ask for.
async function submitBody(req: IncomingMessage, limit: number, signal: AbortSignal): Promise<SubmitInput> {
  let input: Record<string, unknown> | undefined
  try {
    input = record(JSON.parse((await readBody(req, limit, signal)).toString('utf8')) as unknown)
  } catch (error) {
    if (error instanceof VideoFailure) throw error
    throw new VideoFailure(400, 'VIDEO_INVALID_REQUEST')
  }
  if (!input || Object.keys(input).some(key => !SUBMIT_FIELDS.has(key))) throw new VideoFailure(400, 'VIDEO_INVALID_REQUEST')
  if (Object.hasOwn(input, 'image')) throw new VideoFailure(400, 'VIDEO_REFERENCE_UNSUPPORTED')
  if (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 256 || /[\p{C}\p{Zl}\p{Zp}]/u.test(input.model) ||
    typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 8000) throw new VideoFailure(400, 'VIDEO_INVALID_REQUEST')
  if (input.seconds !== undefined) {
    const seconds = typeof input.seconds === 'number' ? input.seconds : typeof input.seconds === 'string' && /^\d{1,2}$/.test(input.seconds) ? Number(input.seconds) : NaN
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 30) throw new VideoFailure(400, 'VIDEO_INVALID_REQUEST')
  }
  if (input.aspect_ratio !== undefined && (typeof input.aspect_ratio !== 'string' || !/^\d{1,2}:\d{1,2}$/.test(input.aspect_ratio))) {
    throw new VideoFailure(400, 'VIDEO_INVALID_REQUEST')
  }
  let size: string | undefined
  if (input.size !== undefined) {
    if (typeof input.size !== 'string' || !/^(?:[1-9]\d{1,4}x[1-9]\d{1,4}|(?:480|720|1080)P)$/.test(input.size)) throw new VideoFailure(400, 'VIDEO_INVALID_REQUEST')
    size = input.size
  }
  return { model: input.model.trim(), prompt: input.prompt, ...(size === undefined ? {} : { size }) }
}

const TASK_ID = /^[A-Za-z0-9_.:-]{1,128}$/

function taskId(value: unknown): string | undefined {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value.trim() : ''
  return TASK_ID.test(id) ? id : undefined
}

type VideoState = 'queued' | 'in_progress' | 'completed' | 'failed'

// The backend relays New API verbatim: `{code:'success', data:{status,
// result_url, …}}` where `status` uses the task vocabulary (NOT_START,
// QUEUED, SUBMITTED, IN_PROGRESS, SUCCESS, FAILURE, UNKNOWN). Older relays use
// the lowercase OpenAI-ish vocabulary, so both spellings are accepted.
function videoState(status: unknown): VideoState | undefined {
  if (typeof status !== 'string') return undefined
  const value = status.trim().toLowerCase()
  if (['failure', 'failed', 'error', 'cancelled', 'canceled', 'expired'].includes(value)) return 'failed'
  if (['success', 'succeeded', 'completed', 'done', 'finished'].includes(value)) return 'completed'
  if (['in_progress', 'in-progress', 'processing', 'running'].includes(value)) return 'in_progress'
  if (['not_start', 'not-started', 'submitted', 'queued', 'pending', 'unknown'].includes(value)) return 'queued'
  return undefined
}

function privateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) || a >= 224
  }
  const value = address.toLowerCase()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value)?.[1]
  if (mapped) return privateAddress(mapped)
  // URL/Node normalize IPv4-mapped literals to hexadecimal IPv6 notation.
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value)
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1] ?? '', 16)
    const low = Number.parseInt(mappedHex[2] ?? '', 16)
    return privateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
  }
  return value === '::' || value === '::1' || /^f[cd][0-9a-f]{2}:/.test(value) || /^fe[89ab][0-9a-f]:/.test(value) ||
    /^ff[0-9a-f]{2}:/.test(value)
}

/**
 * Result URLs are provider CDN addresses chosen by the upstream, never by the
 * plugin. Still require HTTPS and refuse addresses on the local host or a
 * private network so a compromised upstream cannot turn the gateway into an
 * internal HTTP client.
 */
async function remoteURL(raw: string): Promise<URL> {
  let url: URL
  try { url = new URL(raw) } catch { throw new VideoFailure(502, 'VIDEO_RESPONSE') }
  if (url.protocol !== 'https:' || url.username || url.password) throw new VideoFailure(502, 'VIDEO_RESPONSE')
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new VideoFailure(502, 'VIDEO_RESPONSE')
  }
  let addresses: { address: string }[]
  try { addresses = await lookup(host, { all: true, verbatim: true }) } catch { throw new VideoFailure(502, 'VIDEO_CONTENT_UNAVAILABLE') }
  if (addresses.length === 0 || addresses.some(item => privateAddress(item.address))) throw new VideoFailure(502, 'VIDEO_RESPONSE')
  return url
}

/** Upstream JSON envelope: prefer `data` when New API wraps the task. */
function taskRecord(value: unknown): Record<string, unknown> | undefined {
  const outer = record(value)
  if (!outer) return undefined
  return record(outer.data) ?? outer
}

function resultURL(task: Record<string, unknown> | undefined): string | undefined {
  const value = task?.result_url ?? task?.url
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Image capabilities belong to a runtime lease, not to the account's chat capability. */
export function createVideoGateway(options: {
  getJwt: () => string
  fetch: typeof fetch
  maxConcurrent: number
  onFailure?: (failure: PengbaoVideoFailure) => void
}): { createLease: (scope: { capabilityToken: string; models: readonly string[] }) => PengbaoVideoLease; handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>; stop: () => void } {
  type Lease = { credential: Buffer; models: ReadonlySet<string>; active: Set<AbortController>; revoked: boolean }
  const leases = new Set<Lease>()
  let activeCount = 0
  let stopped = false

  function revoke(lease: Lease): void {
    if (lease.revoked) return
    lease.revoked = true
    lease.credential.fill(0)
    leases.delete(lease)
    for (const controller of lease.active) controller.abort(new VideoFailure(401, 'VIDEO_REVOKED'))
  }

  const correlation = new WeakMap<AbortSignal, string>()
  type UpstreamOptions = { method?: 'GET' | 'POST'; body?: Record<string, unknown>; authorization?: boolean; allowMissing?: boolean; absolute?: boolean }

  async function upstream(path: string, signal: AbortSignal, options_: UpstreamOptions = {}): Promise<Response> {
    signal.throwIfAborted()
    const method = options_.method ?? (options_.body ? 'POST' : 'GET')
    const target = options_.absolute ? path : `${PENGBAO_PRODUCT.serverUrl}${path}`
    const operation = options.fetch(target, {
      method, redirect: 'error', credentials: 'omit', signal,
      headers: {
        ...(options_.authorization === false ? {} : { Authorization: `Bearer ${options.getJwt()}` }),
        ...(correlation.has(signal) ? { 'X-Pengbao-Request-Id': correlation.get(signal)! } : {}),
        ...(options_.body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(options_.body ? { body: JSON.stringify(options_.body) } : {})
    })
    // A transport that completes after revocation must not leave its body open.
    void operation.then(response => {
      if (signal.aborted) void response.body?.cancel().catch(() => { /* Already closed. */ })
    }, () => { /* The awaited operation reports transport failures. */ })
    let response: Response
    try {
      response = await abortable(operation, signal)
    } catch (error) {
      if (isRejectedRedirect(error)) throw new VideoFailure(502, 'VIDEO_RESPONSE')
      throw error
    }
    signal.throwIfAborted()
    if (options_.allowMissing && !response.redirected && response.type !== 'opaqueredirect' && [404, 405].includes(response.status)) return response
    if (response.redirected || response.type === 'opaqueredirect' || !response.ok) {
      const detail = response.redirected || response.type === 'opaqueredirect' ? undefined : await errorDetail(response, signal)
      void response.body?.cancel().catch(() => { /* Never expose upstream errors or redirect bodies. */ })
      if (response.status === 401) throw new VideoFailure(401, 'VIDEO_AUTH', response.status, detail)
      if (response.status === 403) throw new VideoFailure(403, 'VIDEO_FORBIDDEN', response.status, detail)
      if (response.status === 429) throw new VideoFailure(429, 'VIDEO_BUSY', response.status, detail)
      if (response.status === 504) throw new VideoFailure(504, 'VIDEO_UPSTREAM_TIMEOUT', response.status, detail)
      throw new VideoFailure(response.status >= 500 ? 502 : options_.allowMissing ? 502 : 400,
        response.status >= 500 ? 'VIDEO_NETWORK' : 'VIDEO_REJECTED', response.status, detail)
    }
    return response
  }

  /** Parse the relayed task status object, or fail closed on an unexpected body. */
  async function pollTask(id: string, signal: AbortSignal): Promise<{ state: VideoState; task: Record<string, unknown> }> {
    let value: unknown
    try {
      value = await json(await upstream(`/api/v1/videos/generations/${encodeURIComponent(id)}`, signal), signal)
    } catch (error) {
      // The relay answers 400 for every upstream polling error, including a
      // task that no longer exists.
      if (error instanceof VideoFailure && error.upstreamStatus === 400) throw new VideoFailure(404, 'VIDEO_NOT_FOUND', 400)
      if (error instanceof VideoFailure && error.upstreamStatus === 404) throw new VideoFailure(404, 'VIDEO_NOT_FOUND', 404)
      throw error
    }
    const task = taskRecord(value)
    if (!task) throw new VideoFailure(404, 'VIDEO_NOT_FOUND')
    const state = videoState(task.status) ?? (resultURL(task) ? 'completed' : undefined)
    if (!state) throw new VideoFailure(502, 'VIDEO_RESPONSE')
    return { state, task }
  }

  async function streamVideo(response: Response, res: ServerResponse, signal: AbortSignal): Promise<void> {
    const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
    if (!/^video\/[a-z0-9.+-]+$/.test(type)) {
      void response.body?.cancel().catch(() => { /* Unsupported bytes never cross the boundary. */ })
      throw new VideoFailure(502, 'VIDEO_CONTENT_UNAVAILABLE')
    }
    const length = response.headers.get('content-length')
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_VIDEO_BYTES)) {
      void response.body?.cancel().catch(() => { /* Bounded response rejected. */ })
      throw new VideoFailure(413, 'VIDEO_TOO_LARGE')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new VideoFailure(502, 'VIDEO_CONTENT_UNAVAILABLE')
    const cancel = () => { void reader.cancel().catch(() => { /* The transport may already be closed. */ }) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      signal.throwIfAborted()
      res.writeHead(200, { 'content-type': type, ...(length === null ? {} : { 'content-length': length }),
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      let size = 0
      while (true) {
        const part = await abortable(reader.read(), signal)
        signal.throwIfAborted()
        if (part.done) break
        size += part.value.byteLength
        if (size > MAX_VIDEO_BYTES) throw new VideoFailure(413, 'VIDEO_TOO_LARGE')
        if (!res.write(part.value)) await once(res, 'drain', { signal })
      }
      res.end()
    } finally {
      signal.removeEventListener('abort', cancel)
      // Cancel unread bytes after size/transport/downstream failures as well.
      cancel()
    }
  }

  return {
    createLease: scope => {
      if (stopped) throw new Error('Video gateway is stopped')
      const lease: Lease = { credential: Buffer.from(`Bearer ${scope.capabilityToken}`), models: new Set(scope.models), active: new Set(), revoked: false }
      leases.add(lease)
      return { capabilityToken: scope.capabilityToken, revoke: () => revoke(lease) }
    },
    handle: async (req, res) => {
      const supplied = Buffer.from(req.headers.authorization ?? '')
      const lease = [...leases].find(item => supplied.length === item.credential.length && timingSafeEqual(supplied, item.credential))
      if (!lease || stopped) return fail(res, new VideoFailure(401, 'VIDEO_AUTH'))
      let parts: string[]
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.search || !url.pathname.startsWith('/v1/videos')) throw new Error('Unsupported route')
        parts = url.pathname.split('/').filter(Boolean)
        if (parts[0] !== 'v1' || parts[1] !== 'videos') throw new Error('Unsupported route')
      } catch { return fail(res, new VideoFailure(404, 'VIDEO_INVALID_REQUEST')) }
      const isSubmit = req.method === 'POST' && parts.length === 2
      const isStatus = req.method === 'GET' && parts.length === 3
      const isContent = req.method === 'GET' && parts.length === 4 && parts[3] === 'content'
      if (!isSubmit && !isStatus && !isContent) return fail(res, new VideoFailure(404, 'VIDEO_INVALID_REQUEST'))
      let id: string | undefined
      if (!isSubmit) {
        try { id = decodeURIComponent(parts[2] ?? '') } catch { return fail(res, new VideoFailure(404, 'VIDEO_INVALID_REQUEST')) }
        if (!id || !TASK_ID.test(id)) return fail(res, new VideoFailure(404, 'VIDEO_INVALID_REQUEST'))
      }
      if (activeCount >= options.maxConcurrent) return fail(res, new VideoFailure(429, 'VIDEO_BUSY'))
      const started = Date.now()
      const requestId = `pb-${randomBytes(16).toString('hex')}`
      let stage: PengbaoVideoFailure['stage'] = isSubmit ? 'submit' : isStatus ? 'status' : 'content'
      const diagnostic = (failure: VideoFailure): PengbaoVideoFailure => ({ requestId, stage, code: failure.code, elapsedMs: Date.now() - started,
        ...(failure.upstreamStatus === undefined ? {} : { upstreamStatus: failure.upstreamStatus }) })
      const report = (failure: VideoFailure) => {
        try {
          options.onFailure?.({ ...diagnostic(failure), ...(failure.upstreamDetail === undefined ? {} : { upstreamDetail: failure.upstreamDetail }) })
        } catch { /* Diagnostics never change request handling. */ }
      }
      const controller = new AbortController()
      correlation.set(controller.signal, requestId)
      lease.active.add(controller)
      activeCount += 1
      const timer = setTimeout(() => controller.abort(new VideoFailure(504, 'VIDEO_TIMEOUT')),
        isContent ? VIDEO_GATEWAY_TIMEOUT_MS : isSubmit ? SUBMIT_TIMEOUT_MS : STATUS_TIMEOUT_MS)
      const close = () => controller.abort(new VideoFailure(401, 'VIDEO_REVOKED'))
      req.once('aborted', close)
      res.once('close', close)
      const signal = controller.signal
      try {
        if (isSubmit) {
          const input = await submitBody(req, MAX_SUBMIT_BYTES, signal)
          if (!lease.models.has(input.model)) throw new VideoFailure(403, 'VIDEO_MODEL_UNAVAILABLE')
          let value: unknown
          try {
            value = await bounded(signal, SUBMIT_TIMEOUT_MS, new VideoFailure(504, 'VIDEO_TIMEOUT'), async budget => {
              correlation.set(budget, requestId)
              return await json(await upstream('/api/v1/videos/generations', budget, {
                method: 'POST', body: { model: input.model, prompt: input.prompt, ...(input.size === undefined ? {} : { size: input.size }) }
              }), budget)
            })
          } catch (error) {
            if (error instanceof VideoFailure && error.upstreamStatus === 400) throw new VideoFailure(400, 'VIDEO_REJECTED', 400)
            throw error
          }
          const created = taskRecord(value)
          const createdId = taskId(created?.task_id) ?? taskId(created?.id)
          if (!createdId) throw new VideoFailure(502, 'VIDEO_RESPONSE')
          signal.throwIfAborted()
          if (lease.revoked || stopped || res.destroyed) return
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
          res.end(JSON.stringify({ id: createdId, task_id: createdId, status: 'queued' }))
          return
        }
        if (isStatus) {
          const { state } = await pollTask(id!, signal)
          if (state === 'failed') {
            if (lease.revoked || stopped || res.destroyed) return
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
            res.end(JSON.stringify({ id, status: 'failed', error: { message: 'Video generation failed. Try again.' } }))
            return
          }
          const body = state === 'completed'
            ? { id, status: 'completed', url: `/v1/videos/${encodeURIComponent(id!)}/content` }
            : { id, object: 'video', status: state }
          if (lease.revoked || stopped || res.destroyed) return
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
          res.end(JSON.stringify(body))
          return
        }
        // Completed clips are served through the relay's authenticated content
        // proxy first. When the channel's task plugin has no content route, the
        // task's provider URL is proxied instead; it never reaches the plugin.
        stage = 'content'
        try {
          const relayed = await bounded(signal, CONTENT_HEADERS_TIMEOUT_MS, new VideoFailure(504, 'VIDEO_TIMEOUT'), async budget => {
            correlation.set(budget, requestId)
            return await upstream(`/api/v1/videos/videos/${encodeURIComponent(id!)}/content`, budget, { allowMissing: true })
          })
          if (![404, 405].includes(relayed.status)) return await streamVideo(relayed, res, signal)
          void relayed.body?.cancel().catch(() => { /* Unsupported content route. */ })
        } catch (error) {
          if (signal.aborted) throw signal.reason
          if (!(error instanceof VideoFailure)) throw error
          // A relay that cannot stream this task's clip is retried through the
          // provider URL below; every other failure is reported unchanged.
          if (![404, 405, 502].includes(error.status)) throw error
        }
        stage = 'download'
        const { state, task } = await bounded(signal, STATUS_TIMEOUT_MS, new VideoFailure(504, 'VIDEO_TIMEOUT'), budget => {
          correlation.set(budget, requestId)
          return pollTask(id!, budget)
        })
        const remote = resultURL(task)
        if (state !== 'completed' || !remote) throw new VideoFailure(502, 'VIDEO_CONTENT_UNAVAILABLE')
        const url = await remoteURL(remote)
        const downloaded = await upstream(url.href, signal, { authorization: false, absolute: true })
        await streamVideo(downloaded, res, signal)
      } catch (error) {
        const failure: unknown = signal.aborted ? signal.reason : error
        const safe = failure instanceof VideoFailure ? failure : new VideoFailure(502, 'VIDEO_NETWORK')
        report(safe)
        fail(res, safe, diagnostic(safe))
      } finally {
        clearTimeout(timer)
        req.off('aborted', close)
        res.off('close', close)
        lease.active.delete(controller)
        activeCount -= 1
      }
    },
    stop: () => {
      stopped = true
      for (const lease of leases) revoke(lease)
    }
  }
}