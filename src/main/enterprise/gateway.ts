import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { PENGBAO_PRODUCT } from './config'
import { type ModelServiceCapability } from '../../shared/model-service'
import { createImageGateway, IMAGE_GATEWAY_TIMEOUT_MS, type PengbaoImageLease, type PengbaoImageFailure } from './image-gateway'
import { createPluginConfigurationGateway, type PluginConfigurationLease } from './plugin-configuration-gateway'
export type { PluginConfigurationLease, PluginConfigurationPolicy } from './plugin-configuration-gateway'

const TOP_LEVEL = ['model', 'messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'stream', 'stream_options', 'temperature', 'max_tokens', 'max_completion_tokens', 'top_p', 'stop', 'frequency_penalty', 'presence_penalty', 'seed', 'response_format', 'reasoning_effort'] as const
const FORBIDDEN = new Set(['chat_id', 'id', 'session_id', 'parent_id', 'tool_ids', 'metadata', 'features', 'files', 'filter_ids', 'function_call', 'functions'])

export interface PengbaoGatewayFailure {
  requestId: string
  kind: 'upstream-http' | 'transport' | 'timeout' | 'cancelled'
  upstreamStatus?: number
  elapsedMs: number
  phase: 'request' | 'headers' | 'body'
  bytesReceived: number
  upstreamHeadersMs?: number
  firstByteMs?: number
  lastByteMs?: number
  abortReason?: 'deadline' | 'downstream' | 'revoked'
  transportCode?: 'UND_ERR_SOCKET' | 'UND_ERR_CONNECT_TIMEOUT' | 'UND_ERR_HEADERS_TIMEOUT' | 'UND_ERR_BODY_TIMEOUT' | 'ECONNRESET' | 'ECONNREFUSED' | 'EPIPE' | 'ENOTFOUND' | 'EAI_AGAIN'
}

function transportCode(error: unknown): PengbaoGatewayFailure['transportCode'] {
  if (!error || typeof error !== 'object') return undefined
  const cause = 'cause' in error ? error.cause : undefined
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : 'code' in error ? error.code : undefined
  switch (code) {
    case 'UND_ERR_SOCKET': case 'UND_ERR_CONNECT_TIMEOUT': case 'UND_ERR_HEADERS_TIMEOUT': case 'UND_ERR_BODY_TIMEOUT':
    case 'ECONNRESET': case 'ECONNREFUSED': case 'EPIPE': case 'ENOTFOUND': case 'EAI_AGAIN': return code
    default: return undefined
  }
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
  /** Legacy account-level chat credential; migrate consumers to runtime grants. */
  capabilityToken: string
  /** Issue a private capability limited to the requested model-service scopes. */
  createModelServiceGrant: (capabilities: readonly ModelServiceCapability[]) => PengbaoModelServiceGrant
  /** Issue a runtime-scoped image-generation lease. */
  createImageLease: () => PengbaoImageLease
  /** Bootstrap-only broker. Child tokens authorize only approved plugin routes/models. */
  createPluginConfigurationLease: () => PluginConfigurationLease
  stop: () => Promise<void>
}

export interface PengbaoModelServiceGrant {
  contractVersion: 1
  gatewayUrl: string
  capabilityToken: string
  capabilities: readonly ModelServiceCapability[]
  revoke: () => void
}

class RequestFailure extends Error {
  constructor(readonly status: number, readonly upstreamStatus?: number) { super('Gateway request failed') }
}

function displayText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\p{C}\p{Zl}\p{Zp}]/u.test(value)
}

function catalogModels(value: unknown): Map<string, { alias?: string; name?: string }> {
  if (!Array.isArray(value)) throw new RequestFailure(502)
  const models = new Map<string, { alias?: string; name?: string }>()
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !('id' in item) || !displayText(item.id)) continue
    const metadata: { alias?: string; name?: string } = {}
    if ('alias' in item && displayText(item.alias)) metadata.alias = item.alias
    if ('name' in item && displayText(item.name)) metadata.name = item.name
    models.set(item.id, metadata)
  }
  return models
}

function modelDisplayName(id: string, metadata: { alias?: string; name?: string } | undefined): string {
  return metadata?.alias ?? metadata?.name ?? id
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {}
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason instanceof RequestFailure ? signal.reason : new RequestFailure(504))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })])
  } finally { signal.removeEventListener('abort', abort) }
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
    const abort = () => error(signal.reason instanceof RequestFailure ? signal.reason : new RequestFailure(504))
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
  type ModelGrant = { credential: Buffer; capabilities: ReadonlySet<ModelServiceCapability>; models?: ReadonlySet<string>; active: Set<() => void>; revoked: boolean }
  const modelGrants = new Set<ModelGrant>()
  const defaultChatGrant: ModelGrant = {
    credential,
    capabilities: new Set(['chat.completions']),
    active: new Set(),
    revoked: false
  }
  modelGrants.add(defaultChatGrant)
  const active = new Set<AbortController>()
  let stopping = false
  let authority = ''
  let stopPromise: Promise<void> | undefined

  const images = createImageGateway({ getJwt: () => jwt, fetch: upstreamFetch, maxBodyBytes: maxBody,
    timeoutMs: Math.min(imageTimeout, IMAGE_GATEWAY_TIMEOUT_MS), maxConcurrent: imageMaxConcurrent, onFailure: options.onImageFailure })
  const pluginConfiguration = createPluginConfigurationGateway({ getGatewayUrl: () => `http://${authority}`, issue: policy => {
    if (stopping) throw new Error('Gateway is stopped')
    const token = randomBytes(32).toString('base64url')
    const grant: ModelGrant = { credential: Buffer.from(`Bearer ${token}`), capabilities: new Set(policy.capabilities), models: new Set(policy.models), active: new Set(), revoked: false }
    modelGrants.add(grant)
    const image = policy.capabilities.includes('image.generate') ? images.createLease({ capabilityToken: token, models: policy.models,
      capabilities: policy.capabilities.filter((capability): capability is 'image.generate' => capability === 'image.generate'), compatibilityOnly: true }) : undefined
    return { capabilityToken: token, revoke: () => {
      image?.revoke()
      if (grant.capabilities.has('chat.completions')) revokeModelGrant(grant)
      else { grant.revoked = true; grant.credential.fill(0); modelGrants.delete(grant); for (const abortOperation of grant.active) abortOperation() }
    } }
  } })
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
    // Image routes authenticate against runtime-scoped image leases, never chat-only credentials.
    if (req.url?.startsWith('/v1/image-generation/') || req.url?.startsWith('/v1/images/')) {
      const supplied = Buffer.from(req.headers.authorization ?? '')
      const modelGrant = [...modelGrants].find(item => supplied.length === item.credential.length && timingSafeEqual(supplied, item.credential))
      if (modelGrant?.models !== undefined && !modelGrant.revoked && !modelGrant.capabilities.has('image.generate')) return fail(res, 404)
      return images.handle(req, res)
    }
    if (req.url?.startsWith('/v1/plugin-configuration/')) return pluginConfiguration.handle(req, res)
    const supplied = Buffer.from(req.headers.authorization ?? '')
    const grant = [...modelGrants].find(item => supplied.length === item.credential.length && timingSafeEqual(supplied, item.credential))
    if (!grant || grant.revoked) return fail(res, 401)
    const isModels = req.method === 'GET' && req.url === '/v1/models' && grant.models === undefined
    const isPluginModels = req.method === 'GET' && req.url === '/v1/models' && grant.models !== undefined && grant.capabilities.has('chat.completions')
    const isPluginChat = req.method === 'POST' && req.url === '/v1/chat/completions' && grant.models !== undefined && grant.capabilities.has('chat.completions')
    const isChat = req.method === 'POST' && req.url === '/v1/chat/completions' && grant.capabilities.has('chat.completions')
    const isDefaults = req.method === 'GET' && req.url === '/v1/model-service/defaults' && grant.capabilities.has('chat.completions') && grant.models === undefined
    if (!isModels && !isPluginModels && !isPluginChat && !isChat && !isDefaults) return fail(res, 404)
    if (!grant.capabilities.has('chat.completions') && !isDefaults) return fail(res, 401)
    if (active.size >= maxConcurrent) return fail(res, 429)
    const started = Date.now()
    // One ID per network attempt, independent of user/session IDs and caller headers.
    const requestId = `pb-${randomBytes(16).toString('hex')}`
    let forwarded = false
    let upstreamStatus: number | undefined
    let upstreamHeadersMs: number | undefined
    let firstByteMs: number | undefined
    let lastByteMs: number | undefined
    let bytesReceived = 0
    let abortReason: PengbaoGatewayFailure['abortReason']
    const controller = new AbortController()
    const abort = (reason: NonNullable<PengbaoGatewayFailure['abortReason']>) => {
      if (controller.signal.aborted) return
      abortReason = reason
      controller.abort(reason === 'revoked' ? new RequestFailure(401) : undefined)
    }
    active.add(controller)
    const abortGrantOperation = () => abort('revoked')
    grant.active.add(abortGrantOperation)
    if (grant.revoked) abortGrantOperation()
    const timer = setTimeout(() => abort('deadline'), timeout)
    const close = () => { if (!res.writableFinished) abort('downstream') }
    req.once('aborted', close)
    res.once('close', close)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const cancel = () => { void reader?.cancel().catch(() => { /* Transport may already be closed. */ }) }
    controller.signal.addEventListener('abort', cancel, { once: true })
    try {
      const metadata = async (path: '/api/config' | '/api/v1/models' | '/api/v1/images/metadata'): Promise<Record<string, unknown>> => {
        const response = await abortable(upstreamFetch(`${PENGBAO_PRODUCT.serverUrl}${path}`, { method: 'GET', redirect: 'error', credentials: 'omit', signal: controller.signal,
          headers: { Authorization: `Bearer ${jwt}`, 'X-Pengbao-Request-Id': requestId } }), controller.signal)
        const reader = response.body?.getReader()
        const cancel = () => { void reader?.cancel().catch(() => { /* Metadata body may already be closed. */ }) }
        controller.signal.addEventListener('abort', cancel, { once: true })
        try {
          if (!response.ok || response.redirected || response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json' || !reader) throw new RequestFailure(502)
          const chunks: Buffer[] = []
          let size = 0
          while (true) {
            const part = await abortable(reader.read(), controller.signal)
            if (part.done) break
            size += part.value.byteLength
            if (size > maxBody) throw new RequestFailure(502)
            chunks.push(Buffer.from(part.value))
          }
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestFailure(502)
          return value as Record<string, unknown>
        } finally { controller.signal.removeEventListener('abort', cancel); cancel() }
      }
      const defaults = async (): Promise<string[]> => {
        const value = await metadata('/api/config')
        if (value.default_models !== undefined && value.default_models !== null && typeof value.default_models !== 'string') throw new RequestFailure(502)
        const ids = typeof value.default_models === 'string' ? value.default_models.split(',').map(id => id.trim()).filter(Boolean) : []
        if (ids.length > 256 || ids.some(id => id.length > 256 || /[\p{C}\p{Zl}\p{Zp}]/u.test(id) || /https?:\/\//i.test(id)) || new Set(ids).size !== ids.length) throw new RequestFailure(502)
        return [...new Set(ids)]
      }
      const imageModelIds = async (): Promise<Set<string>> => {
        const value = await metadata('/api/v1/images/metadata')
        if (!Array.isArray(value.models)) throw new RequestFailure(502)
        const ids = new Set(value.models.flatMap((item: unknown) => item && typeof item === 'object' && 'id' in item && typeof item.id === 'string' ? [item.id] : []))
        const defaultModel = value.defaultModel
        if (defaultModel && typeof defaultModel === 'object' && 'id' in defaultModel && typeof defaultModel.id === 'string') ids.add(defaultModel.id)
        return ids
      }
      if (isDefaults) {
        const defaultModels = await defaults()
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ defaultModels }))
        return
      }
      if (req.headers['content-encoding']) throw new RequestFailure(415)
      if (Number(req.headers['content-length'] ?? 0) > maxBody) throw new RequestFailure(413)
      const body = isChat || isPluginChat ? chatBody(await readBody(req, maxBody, controller.signal)) : undefined
      if (body && grant.models !== undefined) {
        if (grant.models !== undefined && !grant.models.has(body.model as string) && !(body.model === 'pengbao-default-chat' && grant.models.has('pengbao-default-chat'))) throw new RequestFailure(403)
        // Compatibility chat currently supports text/tool inference only, never arbitrary media URLs.
        if ((body.messages as Record<string, unknown>[]).some(message => {
          const content = message.content
          return content !== null && content !== undefined && typeof content !== 'string' &&
            (!Array.isArray(content) || content.some(part => !part || typeof part !== 'object' || part.type !== 'text' || typeof part.text !== 'string' || Object.keys(part).some(key => key !== 'type' && key !== 'text')))
        })) throw new RequestFailure(400)
        const catalog = await metadata('/api/v1/models')
        if (!Array.isArray(catalog.data)) throw new RequestFailure(502)
        const catalogIds = new Set(catalog.data.flatMap((item: unknown) => item && typeof item === 'object' && 'id' in item && typeof item.id === 'string' ? [item.id] : []))
        const explicitAllowed = grant.models === undefined || grant.models.has(body.model as string)
        const isDefaultAlias = body.model === 'pengbao-default-chat' && grant.models?.has('pengbao-default-chat')
        if (isDefaultAlias) {
          const current = (await defaults()).find(id => catalogIds.has(id))
          if (!current) throw new RequestFailure(403)
          body.model = current
        } else if (!explicitAllowed || !catalogIds.has(body.model as string) || grant.models !== undefined && (await imageModelIds()).has(body.model as string)) throw new RequestFailure(403)
      }
      if (isPluginModels) {
        const allowed = [...(grant.models ?? [])]
        const chatCatalog = await metadata('/api/v1/models')
        const catalog = catalogModels(chatCatalog.data)
        const imageIds = await imageModelIds()
        const defaultsForChat = allowed.includes('pengbao-default-chat') ? await defaults() : []
        const resolved = [...new Set([
          ...allowed.filter(model => model !== 'pengbao-default-chat' && model !== 'pengbao-default-image' && catalog.has(model) && !imageIds.has(model)),
          ...defaultsForChat.filter(model => catalog.has(model) && !imageIds.has(model))
        ])]
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ object: 'list', data: resolved.map(id => ({ id, object: 'model', name: modelDisplayName(id, catalog.get(id)) })) }))
        return
      }
      controller.signal.throwIfAborted()
      forwarded = true
      const upstreamOperation = upstreamFetch(`${PENGBAO_PRODUCT.serverUrl}/api/v1${isModels ? '/models' : '/chat/completions'}`, {
        method: isModels ? 'GET' : 'POST',
        redirect: 'error',
        credentials: 'omit',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${jwt}`, 'X-Pengbao-Request-Id': requestId, ...(isModels ? {} : { 'Content-Type': 'application/json' }) },
        body: body ? JSON.stringify(body) : undefined
      })
      // A transport that completes after cancellation must not leave its body open.
      void upstreamOperation.then(response => {
        if (controller.signal.aborted) void response.body?.cancel().catch(() => { /* Already closed. */ })
      }, () => { /* The awaited operation reports transport failures. */ })
      const upstream = await abortable(upstreamOperation, controller.signal)
      upstreamStatus = upstream.status
      upstreamHeadersMs = Date.now() - started
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
        const { done, value } = await abortable(reader.read(), controller.signal)
        controller.signal.throwIfAborted()
        if (done) break
        if (value.byteLength) {
          bytesReceived += value.byteLength
          lastByteMs = Date.now() - started
          firstByteMs ??= lastByteMs
        }
        // Forward bytes, including sources/error events, without buffering SSE.
        if (!res.write(value)) await once(res, 'drain', { signal: controller.signal })
      }
      res.end()
    } catch (error) {
      if (forwarded && !stopping) {
        try {
          const code = transportCode(error)
          options.onFailure?.({ requestId, kind: abortReason === 'downstream' ? 'cancelled' : abortReason === 'deadline' ? 'timeout' : abortReason === 'revoked' ? 'cancelled' : error instanceof RequestFailure ? 'upstream-http' : 'transport',
            ...(upstreamStatus === undefined ? {} : { upstreamStatus }), elapsedMs: Date.now() - started,
            phase: firstByteMs !== undefined ? 'body' : upstreamHeadersMs !== undefined ? 'headers' : 'request', bytesReceived,
            ...(upstreamHeadersMs === undefined ? {} : { upstreamHeadersMs }),
            ...(firstByteMs === undefined ? {} : { firstByteMs, lastByteMs }),
            ...(abortReason === undefined ? {} : { abortReason }),
            ...(code === undefined || abortReason !== undefined ? {} : { transportCode: code }) })
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
      grant.active.delete(abortGrantOperation)
    }
  }

  function revokeModelGrant(grant: ModelGrant): void {
    if (grant.revoked) return
    grant.revoked = true
    grant.credential.fill(0)
    modelGrants.delete(grant)
    for (const abortOperation of grant.active) abortOperation()
  }

  function createModelServiceGrant(capabilities: readonly ModelServiceCapability[]): PengbaoModelServiceGrant {
    const unique = new Set(capabilities)
    if (stopping || capabilities.length !== 1 || unique.size !== capabilities.length ||
      capabilities.some(capability => capability !== 'chat.completions')) {
      throw new Error('Unsupported model service grant')
    }
    const token = randomBytes(32).toString('base64url')
    const grant: ModelGrant = {
      credential: Buffer.from(`Bearer ${token}`),
      capabilities: new Set(capabilities),
      active: new Set(),
      revoked: false
    }
    modelGrants.add(grant)
    return {
      contractVersion: 1,
      gatewayUrl: `http://${authority}`,
      capabilityToken: token,
      capabilities: [...capabilities],
      revoke: () => revokeModelGrant(grant)
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
    createModelServiceGrant,
    createImageLease: () => images.createLease(),
    createPluginConfigurationLease: pluginConfiguration.createLease,
    stop: () => {
      if (stopPromise) return stopPromise
      stopping = true
      pluginConfiguration.stop()
      images.stop()
      for (const grant of modelGrants) revokeModelGrant(grant)
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
