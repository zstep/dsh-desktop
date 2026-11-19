import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { PENGBAO_PRODUCT } from './config'
import { parseImageParameters, validateImageParameters, IMAGE_BATCH_BYTES, type ImageParameterContract } from 'dsh-desktop-model-service/image-contract'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_JSON_BYTES = 1024 * 1024
// 4K image generation regularly needs more than three minutes upstream.
export const IMAGE_GATEWAY_TIMEOUT_MS = 320_000

export interface PengbaoImageLease {
  capabilityToken: string
  revoke: () => void
}

type ImageReason = 'available' | 'disabled' | 'forbidden' | 'unauthenticated' | 'unavailable'
type ImageErrorCode = 'IMAGE_DISABLED' | 'IMAGE_FORBIDDEN' | 'IMAGE_AUTH' | 'IMAGE_NETWORK' | 'IMAGE_TIMEOUT' | 'IMAGE_UPSTREAM_TIMEOUT' |
  'IMAGE_RESPONSE' | 'IMAGE_TOO_LARGE' | 'IMAGE_INVALID_REQUEST' | 'IMAGE_BUSY' | 'IMAGE_REVOKED' |
  'IMAGE_MODEL_UNSUPPORTED' | 'IMAGE_MODEL_UNAVAILABLE' | 'IMAGE_PARAMETERS_UNSUPPORTED' | 'IMAGE_PROVIDER_AUTH' | 'IMAGE_PROVIDER_REJECTED' | 'IMAGE_FILTERED' | 'IMAGE_FETCH' | 'IMAGE_STORE'

export interface PengbaoImageBackendDiagnostic {
  phase: 'provider-request' | 'provider-response' | 'image-fetch' | 'store'
  elapsedMs: number
  providerStatus?: number
}

export interface PengbaoImageFailure {
  requestId: string
  stage: 'status' | 'catalog' | 'generation' | 'descriptor' | 'download' | 'bitmap'
  code: ImageErrorCode
  elapsedMs: number
  upstreamStatus?: number
  backend?: PengbaoImageBackendDiagnostic
}

type ImageCatalog = {
  models: { id: string; name: string }[]
  selection: 'request-local' | 'server-only'
  defaultModel?: { id: string; name: string } | null
  catalogStatus?: 'available' | 'default-only'
  generationParameters?: ImageParameterContract
}
type ImageInput = { prompt: string; image?: string | string[]; size?: string; model?: string; n?: number; quality?: string; detail?: string; response_format?: string; parameterContractVersion?: number; parameterRevision?: string }

class ImageFailure extends Error {
  backend?: PengbaoImageBackendDiagnostic
  reason?: string
  constructor(readonly status: number, readonly code: ImageErrorCode, readonly upstreamStatus?: number) { super(code) }
}

const MESSAGES: Record<ImageErrorCode, string> = {
  IMAGE_DISABLED: 'Image generation is disabled by the service.',
  IMAGE_FORBIDDEN: 'Image generation is not permitted for this account.',
  IMAGE_AUTH: 'Image generation authentication is required.',
  IMAGE_NETWORK: 'Image generation service is unavailable. Try again later.',
  IMAGE_TIMEOUT: 'The local image generation deadline expired. The server may still complete and charge for the request. This request will not be retried automatically.',
  IMAGE_UPSTREAM_TIMEOUT: 'The image generation service returned HTTP 504 (upstream timeout). The server may still complete and charge for the request. This request will not be retried automatically.',
  IMAGE_RESPONSE: 'Image generation returned an unsupported response.',
  IMAGE_TOO_LARGE: 'The image generation request or response is too large.',
  IMAGE_INVALID_REQUEST: 'Image generation accepts only a non-empty prompt.',
  IMAGE_BUSY: 'Image generation is busy. Try again later.',
  IMAGE_REVOKED: 'Image generation access was revoked. The server may still complete and charge for the request.',
  IMAGE_MODEL_UNSUPPORTED: 'This service does not support choosing an image model per request.',
  IMAGE_MODEL_UNAVAILABLE: 'The selected image model is no longer available. Refresh the model list and try again.',
  IMAGE_PARAMETERS_UNSUPPORTED: 'The selected image parameters are unsupported or have changed. Refresh model capabilities.',
  IMAGE_PROVIDER_AUTH: 'The image provider rejected authentication; this is an administrator configuration issue.',
  IMAGE_PROVIDER_REJECTED: 'The image generation service rejected the request.',
  IMAGE_FILTERED: 'The provider blocked this result with its safety policy. Adjust the prompt (avoid violent or well-known character imagery) and try again.',
  IMAGE_FETCH: 'The image was generated but could not be retrieved. The request may still have been charged.',
  IMAGE_STORE: 'The image was generated but could not be saved. The request may still have been charged.',
}

function fail(res: ServerResponse, failure: ImageFailure, diagnostic?: PengbaoImageFailure): void {
  if (res.destroyed) return
  if (res.headersSent) { res.destroy(); return }
  res.writeHead(failure.status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'connection': 'close' })
  const reason = failure.reason && failure.code !== 'IMAGE_AUTH' && failure.code !== 'IMAGE_PROVIDER_AUTH' ? failure.reason : undefined
  res.end(JSON.stringify({ error: { message: reason ? `${MESSAGES[failure.code]} Provider said: ${reason}` : MESSAGES[failure.code], type: 'image_gateway_error', code: failure.code, ...(diagnostic ? { diagnostic } : {}) } }))
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

// `redirect: 'error'` is deliberately used for every upstream request. Node's
// fetch surfaces a rejected redirect as a generic TypeError, but that is an
// invalid upstream response rather than a transport outage. Keep this narrow:
// ordinary DNS/socket failures must still be reported as IMAGE_NETWORK.
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

async function json(response: Response, signal: AbortSignal, limit = MAX_JSON_BYTES): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    void response.body?.cancel().catch(() => { /* Rejected responses are never forwarded. */ })
    throw new ImageFailure(502, 'IMAGE_RESPONSE')
  }
  const body = await bytes(response, limit, signal)
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

interface ImageLeaseScope { capabilityToken?: string; models: readonly string[]; capabilities: readonly ('image.generate' | 'image.edit')[]; compatibilityOnly?: boolean }

async function promptBody(req: IncomingMessage, limit: number, signal: AbortSignal, batch = false, compatibility = false, edit = false): Promise<ImageInput> {
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
        const allowed = edit ? ['prompt', 'image', 'size'] : compatibility ? ['prompt', 'size', 'model', 'n', 'quality', 'detail', 'response_format'] : batch ? ['prompt', 'size', 'model', 'n', 'quality', 'detail', 'parameterContractVersion', 'parameterRevision'] : ['prompt', 'size', 'model', 'n', 'quality', 'detail', 'response_format']
        if (!input || Object.keys(input).some(key => !allowed.includes(key)) || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 8000) {
          throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST')
        }
        // Compatibility requests are proxied to the configured OpenWebUI image
        // API. Keep routing, credentials and endpoint selection host-owned while
        // allowing that API to define its current image parameter vocabulary.
        if (compatibility && input.size === 'auto') delete input.size
        if (compatibility && ((input.response_format !== undefined && input.response_format !== 'b64_json') ||
          (input.n !== undefined && (!Number.isSafeInteger(input.n) || (input.n as number) < 1 || (input.n as number) > 4)) ||
          (input.quality !== undefined && (typeof input.quality !== 'string' || input.quality.length > 64 || /[\p{C}\p{Zl}\p{Zp}]/u.test(input.quality))) ||
          (input.detail !== undefined && (typeof input.detail !== 'string' || input.detail.length > 64 || /[\p{C}\p{Zl}\p{Zp}]/u.test(input.detail))))) throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST')
        if (input.size !== undefined) {
          if (typeof input.size !== 'string' || input.size.length > 64 || /[\p{C}\p{Zl}\p{Zp}]/u.test(input.size)) throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST')
          if (!compatibility && !/^[1-9]\d{0,3}x[1-9]\d{0,3}$/.test(input.size)) throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST')
          if (/^[1-9]\d{0,3}x[1-9]\d{0,3}$/.test(input.size)) {
            const dimensions = input.size.split('x').map(Number)
            const width = dimensions[0] ?? 0
            const height = dimensions[1] ?? 0
            if (width > 8192 || height > 8192 || width * height > 64_000_000) throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST')
          }
        }
        let sourceImage: string | undefined
        if (edit) {
          const encoded = input.image
          if (typeof encoded !== 'string' || !encoded.length || encoded.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3) || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST')
          const data = Buffer.from(encoded, 'base64')
          if (!data.length || data.length > MAX_IMAGE_BYTES || data.toString('base64') !== encoded || !bitmapMatches(data, 'image/png')) throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST')
          sourceImage = `data:image/png;base64,${encoded}`
        }
        const model = input.model === undefined ? undefined : modelId(input.model)
        if (input.model !== undefined && !model) throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST')
        if (batch && (input.parameterContractVersion !== undefined && input.parameterContractVersion !== 1 ||
          input.parameterRevision !== undefined && (typeof input.parameterRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.parameterRevision)) ||
          !Number.isSafeInteger(input.n) || (input.n as number) < 1 || (input.n as number) > 4)) throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST')
        resolve({ prompt: input.prompt, ...(sourceImage ? { image: sourceImage } : {}), ...(typeof input.size === 'string' ? { size: input.size } : {}), ...(model === undefined ? {} : { model }),
          ...(compatibility ? { n: (input.n as number | undefined) ?? 1, ...(input.quality === undefined ? {} : { quality: input.quality as string }), ...(input.detail === undefined ? {} : { detail: input.detail as string }), ...(input.response_format === undefined ? {} : { response_format: input.response_format as string }) } : {}),
          ...(batch ? { n: input.n as number, parameterContractVersion: 1, parameterRevision: input.parameterRevision as string,
            ...(input.quality === undefined ? {} : { quality: input.quality as string }), ...(input.detail === undefined ? {} : { detail: input.detail as string }) } : {}) })
      } catch { reject(new ImageFailure(400, 'IMAGE_INVALID_REQUEST')) }
    }
    req.on('data', data)
    req.once('end', end)
    req.once('error', error)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

const MAX_EDIT_IMAGES = 5

function rawBody(req: IncomingMessage, limit: number, signal: AbortSignal): Promise<Buffer> {
  if (Number(req.headers['content-length'] ?? 0) > limit) return Promise.reject(new ImageFailure(413, 'IMAGE_TOO_LARGE'))
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
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)) }
    req.on('data', data)
    req.once('end', end)
    req.once('error', error)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

/** Accept only inline raster data URLs. Compatibility edits never fetch caller URLs. */
function editDataUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(value)
  const type = match?.[1]
  const encoded = match?.[2]
  if (!type || encoded === undefined || encoded.length === 0 || encoded.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) || encoded.length % 4 !== 0) return undefined
  const bytes = Buffer.from(encoded, 'base64')
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== encoded || !bitmapMatches(bytes, type)) return undefined
  return `data:${type};base64,${encoded}`
}

async function fileDataUrl(value: unknown): Promise<string | undefined> {
  if (typeof value === 'string') return editDataUrl(value)
  if (!value || typeof value !== 'object') return undefined
  const file = value as { size?: unknown; type?: unknown; arrayBuffer?: unknown }
  if (typeof file.size !== 'number' || file.size <= 0 || file.size > MAX_IMAGE_BYTES || typeof file.arrayBuffer !== 'function') return undefined
  const type = file.type
  if (type !== 'image/png' && type !== 'image/jpeg' && type !== 'image/webp') return undefined
  const bytes = Buffer.from(await (file.arrayBuffer as () => Promise<ArrayBuffer>)())
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || !bitmapMatches(bytes, type)) return undefined
  return `data:${type};base64,${bytes.toString('base64')}`
}

/**
 * OpenAI-compatible image edits (`/v1/images/edits`). The image plugin posts
 * multipart reference images; JSON variants carry data URLs directly. Only
 * inline raster data crosses this boundary, and every field is bounded before
 * it is forwarded to the configured OpenWebUI edit engine.
 */
async function editCompatibilityBody(req: IncomingMessage, limit: number, signal: AbortSignal): Promise<ImageInput> {
  if (req.headers['content-encoding']) throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST')
  const raw = await rawBody(req, limit, signal)
  const contentType = req.headers['content-type'] ?? ''
  const media = contentType.split(';')[0]?.trim().toLowerCase()
  let prompt: unknown
  let model: unknown
  let size: unknown
  let quality: unknown
  let detail: unknown
  let n: unknown
  const sources: unknown[] = []
  if (media === 'multipart/form-data') {
    let form: FormData
    try {
      form = await new Response(new Uint8Array(raw), { headers: { 'content-type': contentType } }).formData()
    } catch { throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST') }
    const field = (name: string) => {
      const value = form.get(name)
      return value === null ? undefined : value
    }
    prompt = field('prompt')
    model = field('model')
    size = field('size')
    quality = field('quality')
    detail = field('detail')
    n = field('n')
    sources.push(...form.getAll('image'), ...form.getAll('image[]'))
    if (sources.length === 0) {
      // Some clients send the reference image as a pre-encoded form field.
      sources.push(...form.getAll('image_url'))
    }
  } else if (media === 'application/json') {
    let input: Record<string, unknown> | undefined
    try { input = record(JSON.parse(raw.toString('utf8')) as unknown) } catch { throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST') }
    const allowed = ['prompt', 'model', 'image', 'images', 'size', 'quality', 'detail', 'n', 'response_format']
    if (!input || Object.keys(input).some(key => !allowed.includes(key))) throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST')
    if (input.response_format !== undefined && input.response_format !== 'b64_json') throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST')
    prompt = input.prompt
    model = input.model
    size = input.size
    quality = input.quality
    detail = input.detail
    n = input.n
    const push = (value: unknown) => {
      if (typeof value === 'string') sources.push(value)
      else if (record(value)?.url !== undefined) sources.push(record(value)?.url)
    }
    push(input.image)
    if (Array.isArray(input.images)) input.images.forEach(push)
  } else {
    throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST')
  }
  const images: string[] = []
  for (const source of sources) {
    const data = await fileDataUrl(source)
    if (!data) throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST')
    images.push(data)
    if (images.length > MAX_EDIT_IMAGES) throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST')
  }
  if (!images.length) throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST')
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000) throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST')
  const selectedModel = model === undefined ? undefined : modelId(model)
  if (model !== undefined && !selectedModel) throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST')
  if (size !== undefined) {
    if (typeof size !== 'string' || size.length > 64 || /[\p{C}\p{Zl}\p{Zp}]/u.test(size)) throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST')
    if (/^[1-9]\d{0,3}x[1-9]\d{0,3}$/.test(size) && size !== 'auto') {
      const [width = 0, height = 0] = size.split('x').map(Number)
      if (width > 8192 || height > 8192 || width * height > 64_000_000) throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST')
    }
  }
  if (n !== undefined && n !== '1' && n !== 1) throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST')
  for (const value of [quality, detail]) {
    if (value !== undefined && (typeof value !== 'string' || value.length > 64 || /[\p{C}\p{Zl}\p{Zp}]/u.test(value))) throw new ImageFailure(400, 'IMAGE_INVALID_REQUEST')
  }
  return {
    prompt,
    image: images.length === 1 ? images[0]! : images,
    n: 1,
    ...(selectedModel === undefined ? {} : { model: selectedModel }),
    ...(typeof size === 'string' && size !== 'auto' ? { size } : {}),
    ...(typeof quality === 'string' && quality !== 'auto' ? { quality } : {}),
    ...(typeof detail === 'string' && detail !== 'auto' ? { detail } : {})
  }
}

function downloadPath(value: unknown): string {
  if (!Array.isArray(value) || value.length !== 1) throw new ImageFailure(502, 'IMAGE_RESPONSE')
  const descriptor = record(value[0])
  if (!descriptor || typeof descriptor.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(descriptor.id) ||
    descriptor.url !== `/api/v1/files/${descriptor.id}/content`) throw new ImageFailure(502, 'IMAGE_RESPONSE')
  return descriptor.url as string
}

function imageBackendDiagnostic(value: unknown, requestId: string, code: ImageErrorCode): PengbaoImageBackendDiagnostic | undefined {
  const row = record(value)
  if (!row || row.type !== 'image_generation_error' || row.contractVersion !== 1 || row.requestId !== requestId ||
    !['provider-request', 'provider-response', 'image-fetch', 'store'].includes(row.phase as string) || row.code !== code ||
    typeof row.elapsedMs !== 'number' || !Number.isSafeInteger(row.elapsedMs) || row.elapsedMs < 0 || row.elapsedMs > 86_400_000 ||
    (row.providerStatus !== undefined && (typeof row.providerStatus !== 'number' || !Number.isSafeInteger(row.providerStatus) || row.providerStatus < 100 || row.providerStatus > 599))) return undefined
  return { phase: row.phase as PengbaoImageBackendDiagnostic['phase'], elapsedMs: row.elapsedMs as number,
    ...(row.providerStatus === undefined ? {} : { providerStatus: row.providerStatus as number }) }
}

function bitmapMatches(body: Buffer, type: string): boolean {
  return type === 'image/png' ? body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) :
    type === 'image/jpeg' ? body.length >= 3 && body[0] === 255 && body[1] === 216 && body[2] === 255 :
      type === 'image/webp' && body.length >= 12 && body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP'
}


function inlineBitmap(value: unknown): { data: Buffer; type: 'image/png' | 'image/jpeg' | 'image/webp' } | undefined {
  const row = record(value)
  const encoded = row?.b64_json
  if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) ||
    encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return undefined
  const data = Buffer.from(encoded, 'base64')
  if (data.toString('base64') !== encoded || data.length === 0 || data.length > MAX_IMAGE_BYTES) return undefined
  const type = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png' :
    data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255 ? 'image/jpeg' :
      data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : undefined
  return type === undefined ? undefined : { data, type }
}

/** Image capabilities belong to a runtime lease, not to the account's longer-lived chat capability. */
export function createImageGateway(options: {
  getJwt: () => string
  fetch: typeof fetch
  maxBodyBytes: number
  timeoutMs: number
  maxConcurrent: number
  onFailure?: (failure: PengbaoImageFailure) => void
}): { createLease: (scope?: ImageLeaseScope) => PengbaoImageLease; handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>; stop: () => void } {
  type Lease = { credential: Buffer; models?: ReadonlySet<string>; capabilities?: ReadonlySet<'image.generate' | 'image.edit'>; compatibilityOnly: boolean; active: Set<AbortController>; revoked: boolean }
  const leases = new Set<Lease>()
  let activeCount = 0
  let stopped = false

  function revoke(lease: Lease): void {
    lease.revoked = true
    lease.credential.fill(0)
    leases.delete(lease)
    for (const controller of lease.active) controller.abort(new ImageFailure(401, 'IMAGE_REVOKED'))
  }

  const correlation = new WeakMap<AbortSignal, string>()
  async function upstream(path: string, signal: AbortSignal, body?: ImageInput & { n: number }, allowMissing = false): Promise<Response> {
    signal.throwIfAborted()
    const operation = options.fetch(`${PENGBAO_PRODUCT.serverUrl}${path}`, {
      method: body ? 'POST' : 'GET', redirect: 'error', credentials: 'omit', signal,
      headers: { Authorization: `Bearer ${options.getJwt()}`, ...(correlation.has(signal) ? { 'X-Pengbao-Request-Id': correlation.get(signal)! } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    })
    // A transport that completes after revocation must not leave its body open.
    void operation.then(response => {
      if (signal.aborted) void response.body?.cancel().catch(() => { /* Already closed. */ })
    }, () => { /* The awaited operation reports transport failures. */ })
    let response: Response
    try {
      response = await abortable(operation, signal)
    } catch (error) {
      if (isRejectedRedirect(error)) throw new ImageFailure(502, 'IMAGE_RESPONSE')
      throw error
    }
    signal.throwIfAborted()
    if (allowMissing && !response.redirected && response.type !== 'opaqueredirect' && [404, 405].includes(response.status)) return response
    if (response.redirected || response.type === 'opaqueredirect' || !response.ok) {
      let structured: ImageFailure | undefined
      if (body && !response.redirected && response.type !== 'opaqueredirect' && response.status >= 400 && response.status <= 599 && response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/json') {
        try {
          const payload = record(await json(response, signal, 16 * 1024))
          const detail = record(payload?.error) ?? record(payload?.detail)
          const code = detail?.code
          const allowed = ['IMAGE_PROVIDER_AUTH', 'IMAGE_PROVIDER_REJECTED', 'IMAGE_FILTERED', 'IMAGE_BUSY', 'IMAGE_UPSTREAM_TIMEOUT', 'IMAGE_NETWORK', 'IMAGE_FETCH', 'IMAGE_STORE', 'IMAGE_RESPONSE']
          if (typeof code === 'string' && allowed.includes(code)) {
            // The code comes from a fixed vocabulary; the backend diagnostic is
            // only attached when it belongs to this exact request.
            structured = new ImageFailure(response.status === 429 ? 429 : response.status === 504 ? 504 : response.status === 422 ? 422 : 502, code as ImageErrorCode, response.status)
            const shown = detail?.reason
            const UNSAFE = new RegExp('[\\u0000-\\u001f\\u007f]|://')
            if (typeof shown === 'string' && shown.length > 0 && shown.length <= 300 && !UNSAFE.test(shown)) structured.reason = shown
            const backend = imageBackendDiagnostic(detail, correlation.get(signal) ?? '', code as ImageErrorCode)
            if (backend) structured.backend = backend
          }
          const contractCode = record(payload?.detail)?.code
          if (body.parameterContractVersion === 1 && [400, 409].includes(response.status)) {
            if (contractCode === 'IMAGE_MODEL_UNAVAILABLE') throw new ImageFailure(400, 'IMAGE_MODEL_UNAVAILABLE', response.status)
            if (typeof contractCode === 'string' && ['IMAGE_PARAMETER_CONTRACT_UNSUPPORTED', 'IMAGE_PARAMETER_REVISION_STALE', 'IMAGE_PARAMETER_CAPABILITIES_UNAVAILABLE', 'IMAGE_PARAMETERS_INVALID', 'IMAGE_PARAMETER_CONFIG_CONFLICT'].includes(contractCode)) throw new ImageFailure(400, 'IMAGE_PARAMETERS_UNSUPPORTED', response.status)
          }
        } catch (error) {
          if (signal.aborted || error instanceof ImageFailure) throw error
        }
      }
      void response.body?.cancel().catch(() => { /* Never expose upstream errors or redirect bodies. */ })
      if (structured) throw structured
      if (response.status === 401) throw new ImageFailure(401, 'IMAGE_AUTH', response.status)
      if (response.status === 403) throw new ImageFailure(403, 'IMAGE_FORBIDDEN', response.status)
      if (response.status === 429) throw new ImageFailure(429, 'IMAGE_BUSY', response.status)
      if (response.status === 504) throw new ImageFailure(504, 'IMAGE_UPSTREAM_TIMEOUT', response.status)
      throw new ImageFailure(502, response.status >= 500 ? 'IMAGE_NETWORK' : response.status === 400 && body ? 'IMAGE_PROVIDER_REJECTED' : 'IMAGE_RESPONSE', response.status)
    }
    return response
  }

  async function status(signal: AbortSignal, edit = false): Promise<ImageReason> {
    // Read only ordinary-user endpoints; /images/config contains administrator secrets.
    const session = record(await json(await upstream('/api/v1/auths/', signal), signal))
    if (!session) return 'unavailable'
    const config = record(await json(await upstream('/api/config', signal), signal))
    const enabled = record(config?.features)?.[edit ? 'enable_image_edit' : 'enable_image_generation']
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
    const requestId = correlation.get(signal)
    if (requestId) correlation.set(discoverySignal, requestId)
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
      let generationParameters: ImageParameterContract | undefined
      try { generationParameters = parseImageParameters(value.generationParameters) }
      catch { /* Unknown or malformed advanced capabilities cannot authorize overrides. */ }
      return { models: normalizeModels(value.models), defaultModel, selection, catalogStatus: value.catalogStatus,
        ...(generationParameters ? { generationParameters } : {}) }
    } catch (error) {
      if (isRejectedRedirect(error)) throw new ImageFailure(502, 'IMAGE_RESPONSE')
      throw error
    } finally { clearTimeout(timer) }
  }

  return {
    createLease: (scope) => {
      if (stopped) throw new Error('Image gateway is stopped')
      const capabilityToken = scope?.capabilityToken ?? randomBytes(32).toString('base64url')
      const lease: Lease = { credential: Buffer.from(`Bearer ${capabilityToken}`), ...(scope ? { models: new Set(scope.models), capabilities: new Set(scope.capabilities) } : {}), compatibilityOnly: scope?.compatibilityOnly ?? false, active: new Set(), revoked: false }
      leases.add(lease)
      return { capabilityToken, revoke: () => revoke(lease) }
    },
    handle: async (req, res) => {
      const supplied = Buffer.from(req.headers.authorization ?? '')
      const lease = [...leases].find(item => supplied.length === item.credential.length && timingSafeEqual(supplied, item.credential))
      if (!lease || stopped) return fail(res, new ImageFailure(401, 'IMAGE_AUTH'))
      const isStatus = req.method === 'GET' && req.url === '/v1/image-generation/status'
      const isModels = req.method === 'GET' && req.url === '/v1/image-generation/models'
      const isBatch = req.method === 'POST' && req.url === '/v1/image-generation/generate-many'
      const isGenerate = req.method === 'POST' && req.url === '/v1/image-generation/generate'
      const isCompatibility = req.method === 'POST' && req.url === '/v1/images/generations'
      const isEditCompatibility = req.method === 'POST' && req.url === '/v1/images/edits'
      const imageCapability = lease.capabilities === undefined || lease.capabilities.has('image.generate')
      const isEdit = req.method === 'POST' && req.url === '/v1/image-generation/edit'
      // The built-in image lease has no explicit scopes; scoped model-service
      // leases must opt into image.edit instead of inheriting it from generate.
      const editCapability = lease.capabilities === undefined || lease.capabilities.has('image.edit')
      if (isEdit || isEditCompatibility ? (!editCapability || lease.compatibilityOnly) : !imageCapability) return fail(res, new ImageFailure(404, 'IMAGE_INVALID_REQUEST'))
      if (lease.compatibilityOnly ? !isCompatibility : isCompatibility || (!isStatus && !isModels && !isGenerate && !isBatch && !isEdit && !isEditCompatibility)) return fail(res, new ImageFailure(404, 'IMAGE_INVALID_REQUEST'))
      if (activeCount >= options.maxConcurrent) return fail(res, new ImageFailure(429, 'IMAGE_BUSY'))
      const started = Date.now()
      const requestId = `pb-${randomBytes(16).toString('hex')}`
      let stage: PengbaoImageFailure['stage'] = isModels ? 'catalog' : isGenerate || isBatch ? 'generation' : 'status'
      const diagnostic = (failure: ImageFailure): PengbaoImageFailure => ({ requestId, stage, code: failure.code, elapsedMs: Date.now() - started,
        ...(failure.upstreamStatus === undefined ? {} : { upstreamStatus: failure.upstreamStatus }),
        ...(failure.backend === undefined ? {} : { backend: failure.backend }) })
      const report = (failure: ImageFailure) => {
        try {
          options.onFailure?.(diagnostic(failure))
        } catch { /* Diagnostics never change request handling. */ }
      }
      const controller = new AbortController()
      correlation.set(controller.signal, requestId)
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
        const input = isModels ? undefined :
          isEditCompatibility ? await editCompatibilityBody(req, Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 2 * 1024 * 1024, controller.signal) :
            await promptBody(req, isEdit ? Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 65_536 : Math.min(options.maxBodyBytes, 65_536), controller.signal, isBatch, isCompatibility, isEdit)
        if (isCompatibility && input?.model !== 'pengbao-default-image' && (!input?.model || !lease.models?.has(input.model))) throw new ImageFailure(403, 'IMAGE_MODEL_UNAVAILABLE')
        if (isCompatibility && input?.model === 'pengbao-default-image' && !lease.models?.has('pengbao-default-image')) throw new ImageFailure(403, 'IMAGE_MODEL_UNAVAILABLE')
        stage = 'status'
        const reason = await status(controller.signal, isEdit || isEditCompatibility)
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
        if (!isEdit && !isEditCompatibility && (input.model !== undefined || isBatch)) {
          // Validate against a fresh catalog so revoked or stale selections never generate.
          stage = 'catalog'
          const catalog = await models(controller.signal)
          const serverDefault = isCompatibility && input.model === 'pengbao-default-image'
          const selectedModel = serverDefault ? catalog.defaultModel?.id : input.model
          if (serverDefault && !selectedModel) throw new ImageFailure(400, 'IMAGE_MODEL_UNAVAILABLE')
          if (input.model !== undefined && !serverDefault && catalog.selection !== 'request-local') throw new ImageFailure(400, 'IMAGE_MODEL_UNSUPPORTED')
          if (selectedModel !== undefined && !(serverDefault && catalog.defaultModel?.id === selectedModel) && !catalog.models.some(model => model.id === selectedModel)) throw new ImageFailure(400, 'IMAGE_MODEL_UNAVAILABLE')
          if (serverDefault) {
            if (catalog.selection === 'request-local') input.model = selectedModel
            else delete input.model
          }
          // Compatibility parameters are forwarded to the configured image API;
          // its current implementation is authoritative for supported values.
          if (isBatch) {
            if (input.parameterContractVersion !== undefined) {
              try { validateImageParameters(catalog.generationParameters, input.model ?? catalog.defaultModel?.id, input) }
              catch { throw new ImageFailure(400, 'IMAGE_PARAMETERS_UNSUPPORTED') }
            }
          }
        }
        // Never retry a generation, including after a download failure: it may already have been billed.
        stage = 'generation'
        const generated = await json(await upstream(isEdit || isEditCompatibility ? '/api/v1/images/edit' : '/api/v1/images/generations', controller.signal, { ...input, n: isEdit || isEditCompatibility ? 1 : isCompatibility ? input.n! : isBatch ? input.n! : 1 }), controller.signal,
          isCompatibility ? Math.ceil(Math.min(IMAGE_BATCH_BYTES, MAX_IMAGE_BYTES * input.n!) * 4 / 3) + 65_536 : MAX_JSON_BYTES)
        if (isCompatibility) {
          stage = 'descriptor'
          const data: { b64_json: string }[] = []
          const inline = record(generated)?.data
          if (Array.isArray(inline)) {
            if (inline.length !== input.n!) throw new ImageFailure(502, 'IMAGE_RESPONSE')
            for (const item of inline) {
              const image = inlineBitmap(item)
              if (!image) throw new ImageFailure(502, 'IMAGE_RESPONSE')
              data.push({ b64_json: image.data.toString('base64') })
            }
          } else if (Array.isArray(generated) && generated.length === input.n!) {
            for (const item of generated) {
              const path = downloadPath([item])
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
              data.push({ b64_json: body.toString('base64') })
            }
          } else {
            throw new ImageFailure(502, 'IMAGE_RESPONSE')
          }
          controller.signal.throwIfAborted()
          if (lease.revoked || stopped || res.destroyed) return
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
          res.end(JSON.stringify({ data }))
          return
        }
        if (isBatch) {
          if (!Array.isArray(generated) || !generated.length || generated.length > input.n!) throw new ImageFailure(502, 'IMAGE_RESPONSE')
          stage = 'descriptor'
          const seenPaths = new Set<string>()
          const paths = generated.map(item => {
            try {
              const path = downloadPath([item])
              if (seenPaths.has(path)) return undefined
              seenPaths.add(path)
              return path
            } catch { return undefined }
          })
          const images: { index: number; b64: string; mime: string }[] = []
          const failures: { index: number; code: ImageErrorCode; diagnostic?: PengbaoImageFailure }[] = []
          let total = 0
          // Sequential bounded downloads keep peak memory and provider concurrency predictable.
          for (let index = 0; index < input.n!; index++) {
            if (!paths[index]) { failures.push({ index, code: 'IMAGE_RESPONSE' }); continue }
            try {
              stage = 'download'
              const downloaded = await upstream(paths[index]!, controller.signal)
              const mime = downloaded.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
              if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) { void downloaded.body?.cancel().catch(() => {}); throw new ImageFailure(502, 'IMAGE_RESPONSE') }
              const image = await bytes(downloaded, Math.min(MAX_IMAGE_BYTES, IMAGE_BATCH_BYTES - total), controller.signal)
              total += image.length
              stage = 'bitmap'
              if (!bitmapMatches(image, mime)) throw new ImageFailure(502, 'IMAGE_RESPONSE')
              images.push({ index, b64: image.toString('base64'), mime })
            } catch (error) {
              const reason: unknown = controller.signal.aborted ? controller.signal.reason : error
              const failure = reason instanceof ImageFailure ? reason : new ImageFailure(502, 'IMAGE_NETWORK')
              report(failure)
              failures.push({ index, code: failure.code, diagnostic: diagnostic(failure) })
              if (controller.signal.aborted) {
                for (let rest = index + 1; rest < input.n!; rest++) failures.push({ index: rest, code: failure.code, diagnostic: diagnostic(failure) })
                break
              }
            }
          }
          if (lease.revoked || stopped || res.destroyed) return
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
          res.end(JSON.stringify({ requested: input.n, images, failures, complete: failures.length === 0 }))
          return
        }
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
        if (isCompatibility || isEditCompatibility) {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
          res.end(JSON.stringify({ data: [{ b64_json: body.toString('base64') }] }))
          return
        }
        res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        res.end(body)
      } catch (error) {
        const failure: unknown = controller.signal.aborted ? controller.signal.reason : error
        const safe = failure instanceof ImageFailure ? failure : new ImageFailure(502, 'IMAGE_NETWORK')
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
