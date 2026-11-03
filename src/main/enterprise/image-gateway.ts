import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { PENGBAO_PRODUCT } from './config'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_JSON_BYTES = 1024 * 1024
export const IMAGE_GATEWAY_TIMEOUT_MS = 230_000

export interface PengbaoImageLease {
  capabilityToken: string
  revoke: () => void
}

type ImageReason = 'available' | 'disabled' | 'forbidden' | 'unauthenticated' | 'unavailable'
type ImageErrorCode = 'IMAGE_DISABLED' | 'IMAGE_FORBIDDEN' | 'IMAGE_AUTH' | 'IMAGE_NETWORK' | 'IMAGE_TIMEOUT' |
  'IMAGE_RESPONSE' | 'IMAGE_TOO_LARGE' | 'IMAGE_INVALID_REQUEST' | 'IMAGE_BUSY' | 'IMAGE_REVOKED' |
  'IMAGE_MODEL_UNSUPPORTED' | 'IMAGE_MODEL_UNAVAILABLE'

export interface PengbaoImageFailure {
  requestId: string
  stage: 'status' | 'catalog' | 'generation' | 'descriptor' | 'download' | 'bitmap'
  code: ImageErrorCode
  elapsedMs: number
  upstreamStatus?: number
}

type ImageCatalog = {
  models: { id: string; name: string }[]
  selection: 'request-local' | 'server-only'
  defaultModel?: { id: string; name: string } | null
  catalogStatus?: 'available' | 'default-only'
}

class ImageFailure extends Error {
  constructor(readonly status: number, readonly code: ImageErrorCode, readonly upstreamStatus?: number) { super(code) }
}

const MESSAGES: Record<ImageErrorCode, string> = {
  IMAGE_DISABLED: 'Image generation is disabled by the service.',
  IMAGE_FORBIDDEN: 'Image generation is not permitted for this account.',
  IMAGE_AUTH: 'Image generation authentication is required.',
  IMAGE_NETWORK: 'Image generation service is unavailable. Try again later.',
  IMAGE_TIMEOUT: 'Image generation timed out. The server may still complete and charge for the request.',
  IMAGE_RESPONSE: 'Image generation returned an unsupported response.',
  IMAGE_TOO_LARGE: 'The image generation request or response is too large.',
  IMAGE_INVALID_REQUEST: 'Image generation accepts only a non-empty prompt.',
  IMAGE_BUSY: 'Image generation is busy. Try again later.',
  IMAGE_REVOKED: 'Image generation access was revoked. The server may still complete and charge for the request.',
  IMAGE_MODEL_UNSUPPORTED: 'This service does not support choosing an image model per request.',
  IMAGE_MODEL_UNAVAILABLE: 'The selected image model is no longer available. Refresh the model list and try again.'
}

function fail(res: ServerResponse, failure: ImageFailure): void {
  if (res.destroyed) return
  if (res.headersSent) { res.destroy(); return }
  res.writeHead(failure.status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'connection': 'close' })
  res.end(JSON.stringify({ error: { message: MESSAGES[failure.code], type: 'image_gateway_error', code: failure.code } }))
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

async function bytes(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
  const reader = response.body?.getReader()
  const cancel = () => { void reader?.cancel().catch(() => { /* The transport may already be closed. */ }) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    const length = response.headers.get('content-length')
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new ImageFailure(413, 'IMAGE_TOO_LARGE')
    if (!reader) throw new ImageFailure(502, 'IMAGE_RESPONSE')
    const chunks: Buffer[] = []
    let size = 0
    while (true) {
      const part = await abortable(reader.read(), signal)
      signal.throwIfAborted()
      if (part.done) break
      size += part.value.byteLength
      if (size > limit) throw new ImageFailure(413, 'IMAGE_TOO_LARGE')
      chunks.push(Buffer.from(part.value))
    }
    return Buffer.concat(chunks, size)
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
  }
}

async function json(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    void response.body?.cancel().catch(() => { /* Rejected responses are never forwarded. */ })
    throw new ImageFailure(502, 'IMAGE_RESPONSE')
  }
  const body = await bytes(response, MAX_JSON_BYTES, signal)
  try { return JSON.parse(body.toString('utf8')) as unknown }
  catch { throw new ImageFailure(502, 'IMAGE_RESPONSE') }
}

function modelId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 256 || /[\p{C}\p{Zl}\p{Zp}]/u.test(value)) return undefined
  const id = value.trim()
  return id && id.length <= 256 && id !== 'desktop-managed' ? id : undefined
}

function normalizeModels(value: unknown): { id: string; name: string }[] {
  if (!Array.isArray(value)) throw new ImageFailure(502, 'IMAGE_RESPONSE')
  const models: { id: string; name: string }[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const row = record(item)
    const id = modelId(row?.id)
    const name = row?.name
    if (!id || seen.has(id) || typeof name !== 'string' || !name.trim() || name.length > 256 || /[\p{C}\p{Zl}\p{Zp}]/u.test(name)) continue
    seen.add(id)
    models.push({ id, name: name.trim() })
    if (models.length === 256) break
  }
  return models
}

async function promptBody(req: IncomingMessage, limit: number, signal: AbortSignal): Promise<{ prompt: string; size?: string; model?: string }> {
  if (req.headers['content-encoding']) throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST')
  if (Number(req.headers['content-length'] ?? 0) > limit) throw new ImageFailure(413, 'IMAGE_TOO_LARGE')
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
    const abort = () => error(signal.reason)
    const data = (part: Buffer) => {
      size += part.length
      if (size > limit) { req.pause(); error(new ImageFailure(413, 'IMAGE_TOO_LARGE')); return }
      chunks.push(part)
    }
    const end = () => {
      cleanup()
      try {
        const input = record(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
        if (!input || Object.keys(input).some(key => !['prompt', 'size', 'model'].includes(key)) || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 16_000) {
          throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST')
        }
        if (input.size !== undefined) {
          if (typeof input.size !== 'string' || !/^[1-9]\d{0,3}x[1-9]\d{0,3}$/.test(input.size)) throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST')
          const dimensions = input.size.split('x').map(Number)
          const width = dimensions[0] ?? 0
          const height = dimensions[1] ?? 0
          if (width > 8192 || height > 8192 || width * height > 64_000_000) throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST')
        }
        const model = input.model === undefined ? undefined : modelId(input.model)
        if (input.model !== undefined && !model) throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST')
        resolve({ prompt: input.prompt, ...(typeof input.size === 'string' ? { size: input.size } : {}), ...(model === undefined ? {} : { model }) })
      } catch { reject(new ImageFailure(400, 'IMAGE_INVALID_REQUEST')) }
    }
    req.on('data', data)
    req.once('end', end)
    req.once('error', error)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

function downloadPath(value: unknown): string {
  if (!Array.isArray(value) || value.length !== 1) throw new ImageFailure(502, 'IMAGE_RESPONSE')
  const descriptor = record(value[0])
  if (!descriptor || typeof descriptor.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(descriptor.id) ||
    descriptor.url !== `/api/v1/files/${descriptor.id}/content`) throw new ImageFailure(502, 'IMAGE_RESPONSE')
  return descriptor.url as string
}

function bitmapMatches(body: Buffer, type: string): boolean {
  return type === 'image/png' ? body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) :
    type === 'image/jpeg' ? body.length >= 3 && body[0] === 255 && body[1] === 216 && body[2] === 255 :
      type === 'image/webp' && body.length >= 12 && body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP'
}

/** Image capabilities belong to a runtime lease, not to the account's longer-lived chat capability. */
export function createImageGateway(options: {
  getJwt: () => string
  fetch: typeof fetch
  maxBodyBytes: number
  timeoutMs: number
  maxConcurrent: number
  onFailure?: (failure: PengbaoImageFailure) => void
}): { createLease: () => PengbaoImageLease; handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>; stop: () => void } {
  type Lease = { credential: Buffer; active: Set<AbortController>; revoked: boolean }
  const leases = new Set<Lease>()
  let activeCount = 0
  let stopped = false

  function revoke(lease: Lease): void {
    lease.revoked = true
    lease.credential.fill(0)
    leases.delete(lease)
    for (const controller of lease.active) controller.abort(new ImageFailure(401, 'IMAGE_REVOKED'))
  }

  async function upstream(path: string, signal: AbortSignal, body?: { prompt: string; n: 1; size?: string; model?: string }, allowMissing = false): Promise<Response> {
    signal.throwIfAborted()
    const operation = options.fetch(`${PENGBAO_PRODUCT.serverUrl}${path}`, {
      method: body ? 'POST' : 'GET', redirect: 'manual', credentials: 'omit', signal,
      headers: { Authorization: `Bearer ${options.getJwt()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    })
    // A transport that completes after revocation must not leave its body open.
    void operation.then(response => {
      if (signal.aborted) void response.body?.cancel().catch(() => { /* Already closed. */ })
    }, () => { /* The awaited operation reports transport failures. */ })
    const response = await abortable(operation, signal)
    signal.throwIfAborted()
    if (allowMissing && !response.redirected && response.type !== 'opaqueredirect' && [404, 405].includes(response.status)) return response
    if (response.redirected || response.type === 'opaqueredirect' || !response.ok) {
      void response.body?.cancel().catch(() => { /* Never expose upstream errors or redirect bodies. */ })
      if (response.status === 401) throw new ImageFailure(401, 'IMAGE_AUTH', response.status)
      if (response.status === 403) throw new ImageFailure(403, 'IMAGE_FORBIDDEN', response.status)
      if (response.status === 429) throw new ImageFailure(429, 'IMAGE_BUSY', response.status)
      if (response.status === 504) throw new ImageFailure(504, 'IMAGE_TIMEOUT', response.status)
      throw new ImageFailure(502, response.status >= 500 ? 'IMAGE_NETWORK' : 'IMAGE_RESPONSE', response.status)
    }
    return response
  }

  async function status(signal: AbortSignal): Promise<ImageReason> {
    // Read only ordinary-user endpoints; /images/config contains administrator secrets.
    const session = record(await json(await upstream('/api/v1/auths/', signal), signal))
    if (!session) return 'unavailable'
    const config = record(await json(await upstream('/api/config', signal), signal))
    const enabled = record(config?.features)?.enable_image_generation
    if (enabled === false) return 'disabled'
    if (enabled !== true) return 'unavailable'
    if (session.role === 'admin') return 'available'
    if (session.role !== 'user') return 'forbidden'
    const permission = record(record(session.permissions)?.features)?.image_generation
    return permission === true ? 'available' : permission === false ? 'forbidden' : 'unavailable'
  }

  async function models(signal: AbortSignal): Promise<ImageCatalog> {
    // Metadata and legacy fallback share the same deadline; never retry discovery failures.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new ImageFailure(504, 'IMAGE_TIMEOUT')), Math.min(options.timeoutMs, 10_000))
    const discoverySignal = AbortSignal.any([signal, controller.signal])
    try {
      const response = await upstream('/api/v1/images/metadata', discoverySignal, undefined, true)
      if ([404, 405].includes(response.status)) {
        void response.body?.cancel().catch(() => { /* Discard the unsupported endpoint response. */ })
        const legacy = await upstream('/api/v1/images/models', discoverySignal)
        const selection = legacy.headers.get('x-image-model-selection') === 'request-local-v1' ? 'request-local' : 'server-only'
        return { models: normalizeModels(await json(legacy, discoverySignal)), selection }
      }
      const value = record(await json(response, discoverySignal))
      if (!value || typeof value.selection !== 'string' || !['request-local', 'server-only'].includes(value.selection) ||
        typeof value.catalogStatus !== 'string' || (value.catalogStatus !== 'available' && value.catalogStatus !== 'default-only')) throw new ImageFailure(502, 'IMAGE_RESPONSE')
      let defaultModel: { id: string; name: string } | null = null
      if (value.defaultModel !== null) {
        const row = record(value.defaultModel)
        const normalized = normalizeModels([row])
        if (normalized.length !== 1 || normalized[0]?.id !== row?.id || normalized[0]?.name !== row?.name) throw new ImageFailure(502, 'IMAGE_RESPONSE')
        defaultModel = normalized[0]!
      }
      // A body alone cannot assert that the worker honors request-local overrides.
      const selection = value.selection === 'request-local' && response.headers.get('x-image-model-selection') === 'request-local-v1' ? 'request-local' : 'server-only'
      return { models: normalizeModels(value.models), defaultModel, selection, catalogStatus: value.catalogStatus }
    } finally { clearTimeout(timer) }
  }

  return {
    createLease: () => {
      if (stopped) throw new Error('Image gateway is stopped')
      const capabilityToken = randomBytes(32).toString('base64url')
      const lease: Lease = { credential: Buffer.from(`Bearer ${capabilityToken}`), active: new Set(), revoked: false }
      leases.add(lease)
      return { capabilityToken, revoke: () => revoke(lease) }
    },
    handle: async (req, res) => {
      const supplied = Buffer.from(req.headers.authorization ?? '')
      const lease = [...leases].find(item => supplied.length === item.credential.length && timingSafeEqual(supplied, item.credential))
      if (!lease || stopped) return fail(res, new ImageFailure(401, 'IMAGE_AUTH'))
      const isStatus = req.method === 'GET' && req.url === '/v1/image-generation/status'
      const isModels = req.method === 'GET' && req.url === '/v1/image-generation/models'
      const isGenerate = req.method === 'POST' && req.url === '/v1/image-generation/generate'
      if (!isStatus && !isModels && !isGenerate) return fail(res, new ImageFailure(404, 'IMAGE_INVALID_REQUEST'))
      if (activeCount >= options.maxConcurrent) return fail(res, new ImageFailure(429, 'IMAGE_BUSY'))
      const started = Date.now()
      const requestId = `pb-${randomBytes(16).toString('hex')}`
      let stage: PengbaoImageFailure['stage'] = isModels ? 'catalog' : isGenerate ? 'generation' : 'status'
      const report = (failure: ImageFailure) => {
        try {
          options.onFailure?.({ requestId, stage, code: failure.code, elapsedMs: Date.now() - started,
            ...(failure.upstreamStatus === undefined ? {} : { upstreamStatus: failure.upstreamStatus }) })
        } catch { /* Diagnostics never change request handling. */ }
      }
      const controller = new AbortController()
      lease.active.add(controller)
      activeCount += 1
      const timer = setTimeout(() => controller.abort(new ImageFailure(504, 'IMAGE_TIMEOUT')), isStatus || isModels ? Math.min(options.timeoutMs, 10_000) : options.timeoutMs)
      const close = () => controller.abort(new ImageFailure(401, 'IMAGE_REVOKED'))
      req.once('aborted', close)
      res.once('close', close)
      try {
        if (isStatus) {
          let reason: ImageReason
          try { reason = await status(controller.signal) }
          catch (error) {
            const failure = controller.signal.aborted ? controller.signal.reason : error
            report(failure instanceof ImageFailure ? failure : new ImageFailure(502, 'IMAGE_NETWORK'))
            reason = error instanceof ImageFailure && error.code === 'IMAGE_AUTH' ? 'unauthenticated' :
              error instanceof ImageFailure && error.code === 'IMAGE_FORBIDDEN' ? 'forbidden' : 'unavailable'
            if (lease.revoked || res.destroyed || stopped) return
          }
          if (lease.revoked || stopped || res.destroyed) return
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ available: reason === 'available', reason, serviceUrl: PENGBAO_PRODUCT.serverUrl, modelSelection: 'server-managed' }))
          return
        }
        const input = isModels ? undefined : await promptBody(req, Math.min(options.maxBodyBytes, 65_536), controller.signal)
        stage = 'status'
        const reason = await status(controller.signal)
        if (reason !== 'available') throw new ImageFailure(reason === 'unauthenticated' ? 401 : reason === 'unavailable' ? 502 : 403,
          reason === 'disabled' ? 'IMAGE_DISABLED' : reason === 'forbidden' ? 'IMAGE_FORBIDDEN' : reason === 'unauthenticated' ? 'IMAGE_AUTH' : 'IMAGE_NETWORK')
        if (isModels) {
          stage = 'catalog'
          const catalog = await models(controller.signal)
          controller.signal.throwIfAborted()
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify(catalog))
          return
        }
        if (!input) throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST')
        if (input.model !== undefined) {
          // Validate against a fresh catalog so revoked or stale selections never generate.
          stage = 'catalog'
          const catalog = await models(controller.signal)
          if (catalog.selection !== 'request-local') throw new ImageFailure(400, 'IMAGE_MODEL_UNSUPPORTED')
          if (!catalog.models.some(model => model.id === input.model)) throw new ImageFailure(400, 'IMAGE_MODEL_UNAVAILABLE')
        }
        // Never retry a generation, including after a download failure: it may already have been billed.
        stage = 'generation'
        const generated = await json(await upstream('/api/v1/images/generations', controller.signal, { ...input, n: 1 }), controller.signal)
        stage = 'descriptor'
        const path = downloadPath(generated)
        stage = 'download'
        const response = await upstream(path, controller.signal)
        const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) {
          void response.body?.cancel().catch(() => { /* Unsupported bytes never cross the boundary. */ })
          throw new ImageFailure(502, 'IMAGE_RESPONSE')
        }
        const body = await bytes(response, MAX_IMAGE_BYTES, controller.signal)
        stage = 'bitmap'
        if (!bitmapMatches(body, type)) throw new ImageFailure(502, 'IMAGE_RESPONSE')
        controller.signal.throwIfAborted()
        if (lease.revoked || stopped || res.destroyed) return
        res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        res.end(body)
      } catch (error) {
        const failure: unknown = controller.signal.aborted ? controller.signal.reason : error
        const safe = failure instanceof ImageFailure ? failure : new ImageFailure(502, 'IMAGE_NETWORK')
        report(safe)
        fail(res, safe)
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
