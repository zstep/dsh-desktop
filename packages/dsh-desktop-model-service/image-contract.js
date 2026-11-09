// Public, credential-free wire contract shared by image transports and consumers.
export const IMAGE_BATCH_BYTES = 64 * 1024 * 1024
export const IMAGE_MAX_COUNT = 4
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) => Object.keys(value).every(key => keys.includes(key))
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim() && !/[\p{C}\p{Zl}\p{Zp}]/u.test(value)
export function parseImageParameters(value) {
  if (value === undefined) return undefined
  if (!object(value) || !exact(value, ['contractVersion', 'revision', 'models']) || value.contractVersion !== 1 ||
    typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision) || !Array.isArray(value.models) || value.models.length > 256) throw new Error('Invalid image parameter contract')
  const seen = new Set()
  const models = value.models.map(model => {
    if (!object(model) || !exact(model, ['id', 'maxImages', 'qualities', 'details']) || !id(model.id) || seen.has(model.id) ||
      !Number.isSafeInteger(model.maxImages) || model.maxImages < 1 || model.maxImages > IMAGE_MAX_COUNT) throw new Error('Invalid image parameter contract')
    seen.add(model.id)
    for (const [key, choices, required] of [['qualities', ['auto', 'low', 'medium', 'high'], 'auto'], ['details', ['', 'standard', 'high'], '']]) {
      const values = model[key]
      if (!Array.isArray(values) || !values.includes(required) || values.length > choices.length || new Set(values).size !== values.length || values.some(item => !choices.includes(item))) throw new Error('Invalid image parameter contract')
    }
    return { id: model.id, maxImages: model.maxImages, qualities: [...model.qualities], details: [...model.details] }
  })
  return { contractVersion: 1, revision: value.revision, models }
}
export function validateImageParameters(contract, modelId, input) {
  const parsed = parseImageParameters(contract)
  const model = parsed?.models.find(item => item.id === modelId)
  if (!model || input.parameterContractVersion !== 1 || input.parameterRevision !== parsed.revision ||
    !Number.isSafeInteger(input.n) || input.n < 1 || input.n > model.maxImages ||
    !model.qualities.includes(input.quality ?? 'auto') || !model.details.includes(input.detail ?? '')) throw new Error('Unsupported image parameters')
  return model
}
const STAGES = ['status', 'catalog', 'generation', 'descriptor', 'download', 'bitmap']
const CODES = ['IMAGE_DISABLED', 'IMAGE_FORBIDDEN', 'IMAGE_AUTH', 'IMAGE_NETWORK', 'IMAGE_TIMEOUT', 'IMAGE_UPSTREAM_TIMEOUT', 'IMAGE_TIMEOUT_UNKNOWN', 'IMAGE_RESPONSE', 'IMAGE_TOO_LARGE', 'IMAGE_INVALID_REQUEST', 'IMAGE_BUSY', 'IMAGE_REVOKED', 'IMAGE_MODEL_UNSUPPORTED', 'IMAGE_MODEL_UNAVAILABLE', 'IMAGE_PARAMETERS_UNSUPPORTED']
export function imageDiagnostic(value) {
  if (!object(value) || typeof value.requestId !== 'string' || !/^pb-[a-f0-9]{32}$/.test(value.requestId) || !STAGES.includes(value.stage) || !CODES.includes(value.code) ||
    !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0 || value.elapsedMs > 86_400_000 ||
    (value.upstreamStatus !== undefined && (!Number.isSafeInteger(value.upstreamStatus) || value.upstreamStatus < 100 || value.upstreamStatus > 599))) return undefined
  return { requestId: value.requestId, stage: value.stage, code: value.code, elapsedMs: value.elapsedMs,
    ...(value.upstreamStatus === undefined ? {} : { upstreamStatus: value.upstreamStatus }) }
}
