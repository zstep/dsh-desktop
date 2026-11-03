import { ImageError, MAX_IMAGE_BYTES, readBounded, safeError } from './provider.js'

export const PENGBAO_SERVICE_URL = 'https://pengbao.ecombus.net'
const REASONS = new Set(['available', 'disabled', 'forbidden', 'unauthenticated', 'unavailable'])
const FAILURES = {
  IMAGE_DISABLED: ['Pengbao image generation is disabled. Ask your administrator to enable it.', 403],
  IMAGE_FORBIDDEN: ['Your Pengbao account cannot generate images. Contact your administrator.', 403],
  IMAGE_AUTH: ['Sign in to Pengbao again to generate images.', 401],
  IMAGE_NETWORK: ['Pengbao image generation is temporarily unavailable.', 503],
  IMAGE_TIMEOUT: ['Pengbao image generation timed out. The server may still have generated and charged for the image.', 504],
  IMAGE_RESPONSE: ['Pengbao returned an invalid image response.', 502],
  IMAGE_TOO_LARGE: ['The generated image exceeds 20 MiB.', 502],
  IMAGE_INVALID_REQUEST: ['The image description is invalid.', 400],
  IMAGE_BUSY: ['Pengbao image generation is busy. Try again later.', 429],
  IMAGE_REVOKED: ['The image session has ended. Reconnect and try again.', 401],
  IMAGE_MODEL_UNSUPPORTED: ['Pengbao does not support choosing an image model per request.', 400],
  IMAGE_MODEL_UNAVAILABLE: ['The selected image model is no longer available. Refresh the model list and try again.', 400],
}
let bridge

function validModelId(value) {
  return typeof value === 'string' && value.length <= 256 && Boolean(value.trim()) && value.trim() !== 'desktop-managed' && !/[\p{C}\p{Zl}\p{Zp}]/u.test(value)
}

function catalogResult(result) {
  if (!result || !['request-local', 'server-only'].includes(result.selection) || !Array.isArray(result.models) || result.models.length > 256) {
    throw new ImageError('IMAGE_RESPONSE', ...FAILURES.IMAGE_RESPONSE)
  }
  const seen = new Set()
  const models = result.models.map(model => {
    if (!model || !validModelId(model.id) || model.id !== model.id.trim() || seen.has(model.id)
      || typeof model.name !== 'string' || !model.name.trim() || model.name.length > 256 || /[\p{C}\p{Zl}\p{Zp}]/u.test(model.name)) {
      throw new ImageError('IMAGE_RESPONSE', ...FAILURES.IMAGE_RESPONSE)
    }
    seen.add(model.id)
    return { id: model.id, name: model.name }
  })
  let defaultModel
  if (result.defaultModel !== undefined) {
    if (result.defaultModel === null) defaultModel = null
    else {
      const model = result.defaultModel
      if (!validModelId(model.id) || model.id !== model.id.trim() || typeof model.name !== 'string' || !model.name.trim()
        || model.name !== model.name.trim() || model.name.length > 256 || /[\p{C}\p{Zl}\p{Zp}]/u.test(model.name)) {
        throw new ImageError('IMAGE_RESPONSE', ...FAILURES.IMAGE_RESPONSE)
      }
      defaultModel = { id: model.id, name: model.name }
    }
  }
  if (result.catalogStatus !== undefined && !['available', 'default-only'].includes(result.catalogStatus)) throw new ImageError('IMAGE_RESPONSE', ...FAILURES.IMAGE_RESPONSE)
  return { models, selection: result.selection,
    ...(defaultModel === undefined ? {} : { defaultModel }),
    ...(result.catalogStatus === undefined ? {} : { catalogStatus: result.catalogStatus }) }
}

/**
 * Return only bound operations, never the private gateway URL or capability.
 * @returns {undefined | Readonly<{
 *   status: (options?: {signal?: AbortSignal}) => Promise<{available: boolean, reason: string, serviceUrl: string, modelSelection: 'server-managed'}>,
 *   models: (options?: {signal?: AbortSignal}) => Promise<{models: {id: string, name: string}[], selection: 'request-local' | 'server-only', defaultModel?: {id: string, name: string}|null, catalogStatus?: 'available'|'default-only'}>,
 *   generate: (prompt: string, options?: {size?: string, model?: string, signal?: AbortSignal}) => Promise<Buffer>
 * }>}
 */
export function getDesktopImageBridge() { return bridge }

/**
 * Private, one-shot handoff from the desktop runtime. The capability lives only
 * in these closures for this process; this is not a sandbox for other plugins.
 * @param {{gatewayUrl: string, capabilityToken: string}} registration
 */
export function registerDesktopImageBridge({ gatewayUrl, capabilityToken } = {}) {
  if (bridge) throw new Error('Desktop image bridge is already registered.')
  let url
  try { url = new URL(gatewayUrl) } catch { throw new Error('Invalid desktop image gateway.') }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || typeof capabilityToken !== 'string' || !/^[A-Za-z0-9_-]{32,512}$/.test(capabilityToken)) throw new Error('Invalid desktop image bridge registration.')
  const base = `${url.origin}/v1/image-generation`
  async function request(operation, prompt, options = {}) {
    if (operation === 'generate' && (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000)) throw new ImageError('IMAGE_INVALID_REQUEST', ...FAILURES.IMAGE_INVALID_REQUEST)
    if (operation === 'generate' && options.size !== undefined) {
      const dimensions = typeof options.size === 'string' ? options.size.split('x').map(Number) : []
      const width = dimensions[0] ?? 0
      const height = dimensions[1] ?? 0
      if (typeof options.size !== 'string' || !/^[1-9]\d{0,3}x[1-9]\d{0,3}$/.test(options.size) || width > 8192 || height > 8192 || width * height > 64_000_000) throw new ImageError('IMAGE_INVALID_REQUEST', ...FAILURES.IMAGE_INVALID_REQUEST)
    }
    if (operation === 'generate' && options.model !== undefined && !validModelId(options.model)) throw new ImageError('IMAGE_INVALID_REQUEST', ...FAILURES.IMAGE_INVALID_REQUEST)
    // Keep the generation/download phase below the 240-second tool budget,
    // reserving time for status, PNG normalization and the sandbox commit.
    const signal = AbortSignal.any([AbortSignal.timeout(operation === 'generate' ? 210_000 : 15_000), ...(options.signal ? [options.signal] : [])])
    try {
      signal.throwIfAborted()
      const response = await fetch(`${base}/${operation}`, {
        method: operation === 'generate' ? 'POST' : 'GET', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${capabilityToken}`, ...(operation === 'generate' ? { 'Content-Type': 'application/json' } : {}) },
        ...(operation === 'generate' ? { body: JSON.stringify({ prompt, ...(options.size === undefined ? {} : { size: options.size }), ...(options.model === undefined ? {} : { model: options.model.trim() }) }) } : {}),
      })
      if (!response.ok) {
        let code
        try { code = JSON.parse((await readBounded(response, 16_384, signal)).toString('utf8'))?.error?.code }
        catch { signal.throwIfAborted() /* Ignore all free-form gateway error text. */ }
        const safeCode = Object.hasOwn(FAILURES, code) ? code : 'IMAGE_NETWORK'
        throw new ImageError(safeCode, ...FAILURES[safeCode])
      }
      if (operation === 'status') {
        const result = JSON.parse((await readBounded(response, 16_384, signal)).toString('utf8'))
        if (!REASONS.has(result?.reason) || result.available !== (result.reason === 'available') || result.serviceUrl !== PENGBAO_SERVICE_URL || result.modelSelection !== 'server-managed') {
          throw new ImageError('IMAGE_RESPONSE', ...FAILURES.IMAGE_RESPONSE)
        }
        return { available: result.available, reason: result.reason, serviceUrl: PENGBAO_SERVICE_URL, modelSelection: 'server-managed' }
      }
      if (operation === 'models') {
        if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ImageError('IMAGE_RESPONSE', ...FAILURES.IMAGE_RESPONSE)
        let result
        try { result = JSON.parse((await readBounded(response, 1024 * 1024, signal)).toString('utf8')) }
        catch (error) {
          if (error instanceof SyntaxError) throw new ImageError('IMAGE_RESPONSE', ...FAILURES.IMAGE_RESPONSE)
          throw error
        }
        return catalogResult(result)
      }
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) throw new ImageError('IMAGE_RESPONSE', ...FAILURES.IMAGE_RESPONSE)
      const data = await readBounded(response, MAX_IMAGE_BYTES, signal)
      signal.throwIfAborted()
      return data
    } catch (error) {
      if (error?.name === 'TimeoutError') throw new ImageError('IMAGE_TIMEOUT', ...FAILURES.IMAGE_TIMEOUT)
      if (error?.name === 'AbortError' && operation === 'generate') throw new ImageError('CANCELLED', 'Image operation cancelled. The server may still have generated and charged for the image.', 499)
      throw safeError(error)
    }
  }
  bridge = Object.freeze({ status: options => request('status', undefined, options), models: options => request('models', undefined, options), generate: (prompt, options) => request('generate', prompt, options) })
}
