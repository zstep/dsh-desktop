import { imageDiagnostic } from './image-contract.js'

export const LIMITS = Object.freeze({ metadataMs: 15_000, chatMs: 120_000, imageMs: 210_000,
  metadataBytes: 1024 * 1024, requestBytes: 1024 * 1024, responseBytes: 8 * 1024 * 1024,
  imageBytes: 20 * 1024 * 1024, models: 256, consumers: 512 })
export const SUPPORTED = Object.freeze(['chat.completions', 'image.generate'])
const MESSAGES = Object.freeze({
  INVALID_REQUEST: 'Invalid model service request.', INVALID_REGISTRATION: 'Invalid model service registration.',
  ALREADY_REGISTERED: 'Model service is already registered.', UNAVAILABLE: 'Model service is unavailable.',
  UNAUTHENTICATED: 'Sign in to use the model service.', FORBIDDEN: 'Model service access is not granted.',
  CONSUMER_UNAVAILABLE: 'This plugin has no declared model service access.',
  UNSUPPORTED: 'This model service operation is not supported.', MODEL_UNAVAILABLE: 'The selected model is unavailable.',
  INVALID_RESPONSE: 'Model service returned an invalid response.', TOO_LARGE: 'Model service size limit exceeded.',
  TIMEOUT: 'Model service deadline expired. The operation will not be retried automatically.',
  CANCELLED: 'Model service operation was cancelled.', DISPOSED: 'Model service scope has ended.',
  BUSY: 'Model service is busy. Try again later.', FAILED: 'Model service request failed.',
  IMAGE_TIMEOUT_UNKNOWN: 'Image generation returned HTTP 504. The timeout source is unknown. The server may still complete and charge for this request. This request will not be retried automatically.',
  IMAGE_PARAMETERS_UNSUPPORTED: 'Image parameters are unsupported or have changed. Refresh model capabilities.',
  IMAGE_TIMEOUT: 'The local image generation deadline expired. The server may still complete generation and you may be charged for the image. This request will not be retried automatically.',
  IMAGE_UPSTREAM_TIMEOUT: 'Image generation returned HTTP 504 (upstream timeout). The server may still complete generation and you may be charged for the image. This request will not be retried automatically.',
  IMAGE_CANCELLED: 'Image generation was cancelled. The server may still complete generation and you may be charged for the image. This request will not be retried automatically.',
  IMAGE_REVOKED: 'The image session has ended. The server may still complete generation and you may be charged for the image. This request will not be retried automatically.'
})
export class ModelServiceError extends Error {
  constructor(code = 'FAILED') {
    const safe = Object.hasOwn(MESSAGES, code) ? code : 'FAILED'
    super(MESSAGES[safe])
    this.name = 'ModelServiceError'
    this.code = safe
  }
}
export function fail(code) { throw new ModelServiceError(code) }
// Translate only known bridge codes; never reflect transport messages, causes or URLs.
const IMAGE_ERRORS = Object.freeze({
  IMAGE_DISABLED: 'FORBIDDEN', IMAGE_FORBIDDEN: 'FORBIDDEN', IMAGE_AUTH: 'UNAUTHENTICATED',
  IMAGE_NETWORK: 'UNAVAILABLE', IMAGE_TIMEOUT_UNKNOWN: 'IMAGE_TIMEOUT_UNKNOWN', IMAGE_PARAMETERS_UNSUPPORTED: 'IMAGE_PARAMETERS_UNSUPPORTED', IMAGE_TIMEOUT: 'IMAGE_TIMEOUT', IMAGE_UPSTREAM_TIMEOUT: 'IMAGE_UPSTREAM_TIMEOUT',
  IMAGE_RESPONSE: 'INVALID_RESPONSE', IMAGE_TOO_LARGE: 'TOO_LARGE', IMAGE_INVALID_REQUEST: 'INVALID_REQUEST',
  IMAGE_BUSY: 'BUSY', IMAGE_REVOKED: 'IMAGE_REVOKED', CANCELLED: 'IMAGE_CANCELLED', IMAGE_MODEL_UNSUPPORTED: 'UNSUPPORTED',
  IMAGE_MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE'
})
export function safeError(error, signal) {
  if (signal?.aborted) return signal.reason instanceof ModelServiceError ? signal.reason : new ModelServiceError('CANCELLED')
  if (error instanceof ModelServiceError) return error
  const result = new ModelServiceError(Object.hasOwn(IMAGE_ERRORS, error?.code) ? IMAGE_ERRORS[error.code] : 'FAILED')
  const diagnostic = imageDiagnostic(error?.diagnostic)
  if (diagnostic) result.diagnostic = diagnostic
  return result
}
export function safeImageGenerationError(error) {
  const code = error?.code
  if (code === 'TIMEOUT') return new ModelServiceError('IMAGE_TIMEOUT')
  if (code === 'CANCELLED') return new ModelServiceError('IMAGE_CANCELLED')
  if (code === 'DISPOSED') return new ModelServiceError('IMAGE_REVOKED')
  return safeError(error)
}
export function identifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim()
    && !/[\p{C}\p{Zl}\p{Zp}]/u.test(value) && !/https?:\/\//i.test(value)
}
export function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
export function optionsSignal(options = {}) {
  if (!record(options) || Object.keys(options).some(key => key !== 'signal')) fail('INVALID_REQUEST')
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) fail('INVALID_REQUEST')
  return options.signal
}
/** Validate size/depth before serialization, then detach all caller-owned data. */
export function boundedJson(value, limit = LIMITS.requestBytes) {
  let budget = limit
  const ancestors = new Set()
  function visit(item, depth) {
    if (depth > 32 || --budget < 0) fail('TOO_LARGE')
    if (typeof item === 'string') { budget -= Buffer.byteLength(item); if (budget < 0) fail('TOO_LARGE'); return }
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return
    if (typeof item !== 'object' || ancestors.has(item)) fail('INVALID_REQUEST')
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) fail('INVALID_REQUEST')
    ancestors.add(item)
    for (const key of Object.keys(item)) { budget -= key.length; visit(item[key], depth + 1) }
    ancestors.delete(item)
  }
  visit(value, 0)
  let text
  try { text = JSON.stringify(value) } catch { fail('INVALID_REQUEST') }
  if (Buffer.byteLength(text) > limit) fail('TOO_LARGE')
  return text
}
export function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}
/** One owner per plugin/scope. No process globals or retained abort listeners. */
export function createLifetime(parentSignal) {
  const controller = new AbortController()
  const pending = new Set()
  const abortParent = () => dispose()
  if (parentSignal?.aborted) controller.abort(new ModelServiceError('DISPOSED'))
  else parentSignal?.addEventListener('abort', abortParent, { once: true })
  function dispose() {
    if (!controller.signal.aborted) controller.abort(new ModelServiceError('DISPOSED'))
    for (const operation of pending) operation.abort('DISPOSED')
    parentSignal?.removeEventListener('abort', abortParent)
  }
  function operation(timeout, signal) {
    if (controller.signal.aborted) fail('DISPOSED')
    if (signal !== undefined && !(signal instanceof AbortSignal)) fail('INVALID_REQUEST')
    const local = new AbortController()
    let finished = false
    const abort = code => { if (!local.signal.aborted) local.abort(new ModelServiceError(code)) }
    const externalAbort = () => abort('CANCELLED')
    const ownerAbort = () => abort('DISPOSED')
    const timer = setTimeout(() => abort('TIMEOUT'), timeout)
    timer.unref?.()
    signal?.addEventListener('abort', externalAbort, { once: true })
    controller.signal.addEventListener('abort', ownerAbort, { once: true })
    if (signal?.aborted) externalAbort()
    const op = { signal: local.signal, abort,
      async wait(task) {
        if (local.signal.aborted) { Promise.resolve(task).catch(() => {}); throw safeError(undefined, local.signal) }
        let listener
        try {
          return await Promise.race([task, new Promise((_, reject) => {
            listener = () => reject(safeError(undefined, local.signal))
            local.signal.addEventListener('abort', listener, { once: true })
          })])
        } finally { local.signal.removeEventListener('abort', listener) }
      },
      finish() {
        if (finished) return
        finished = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', externalAbort)
        controller.signal.removeEventListener('abort', ownerAbort)
        pending.delete(op)
      }
    }
    pending.add(op)
    return op
  }
  return { signal: controller.signal, operation, dispose }
}
export async function readBounded(response, limit, operation) {
  const length = response.headers?.get('content-length')
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) {
    response.body?.cancel().catch(() => {})
    fail('TOO_LARGE')
  }
  if (!response.body) fail('INVALID_RESPONSE')
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const part = await operation.wait(reader.read())
      if (part.done) break
      total += part.value.byteLength
      if (total > limit) fail('TOO_LARGE')
      chunks.push(Buffer.from(part.value))
    }
    return Buffer.concat(chunks, total)
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}
export function parseModels(models) {
  if (!Array.isArray(models) || models.length > LIMITS.models) fail('INVALID_RESPONSE')
  const seen = new Set()
  return models.map(model => {
    if (!record(model) || !identifier(model.id) || seen.has(model.id)
      || (model.name !== undefined && !identifier(model.name))
      || (model.alias !== undefined && model.alias !== '' && !identifier(model.alias))) fail('INVALID_RESPONSE')
    seen.add(model.id)
    return { id: model.id, name: model.alias || model.name || model.id }
  })
}
