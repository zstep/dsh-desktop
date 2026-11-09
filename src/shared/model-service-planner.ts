import {
  parseModelServiceCatalog,
  type ModelServiceCapability,
  type ModelServiceCatalog,
  type ModelServiceConsumerDeclaration,
  type ModelServiceModel
} from './model-service'

export interface ModelServiceConnectionRequest {
  consumer: ModelServiceConsumerDeclaration
  capability: ModelServiceCapability
  selectedModel?: string
}

export interface ModelServiceConnectionPlan {
  contractVersion: 1
  capability: ModelServiceCapability
  model: ModelServiceModel
  source: 'selected' | 'default'
}

export type ModelServicePlanResult =
  | { ok: true; plan: ModelServiceConnectionPlan }
  | { ok: false; reason: 'unsupported-contract' | 'capability-not-declared' | 'no-compatible-model' | 'invalid-catalog' }

/** Pure, deterministic selection. It never guesses a field mapping or carries credentials. */
export function planModelServiceConnection(
  rawCatalog: unknown,
  request: ModelServiceConnectionRequest
): ModelServicePlanResult {
  let catalog: ModelServiceCatalog
  try {
    catalog = parseModelServiceCatalog(rawCatalog)
  } catch {
    return { ok: false, reason: 'invalid-catalog' }
  }
  if (request.consumer.contractVersion !== catalog.contractVersion) return { ok: false, reason: 'unsupported-contract' }
  if (!request.consumer.capabilities.includes(request.capability)) return { ok: false, reason: 'capability-not-declared' }
  if (catalog.availability?.[request.capability === 'chat.completions' ? 'chat' : 'image'].available === false ||
    (request.capability === 'image.generate' && (catalog.imageSelection === 'server-only' || catalog.imageCatalogStatus === 'models-unavailable'))) {
    return { ok: false, reason: 'no-compatible-model' }
  }
  const compatible = catalog.models.filter(model => model.capabilities.includes(request.capability))
  if (request.selectedModel !== undefined) {
    const model = compatible.find(candidate => candidate.id === request.selectedModel)
    return model ? { ok: true, plan: { contractVersion: 1, capability: request.capability, model, source: 'selected' } } : { ok: false, reason: 'no-compatible-model' }
  }
  const defaultId = catalog.defaults[request.capability]
  const defaultModel = typeof defaultId === 'string' ? compatible.find(model => model.id === defaultId) : undefined
  // List order is not a default selection; only the caller or host may choose.
  return defaultModel
    ? { ok: true, plan: { contractVersion: 1, capability: request.capability, model: defaultModel, source: 'default' } }
    : { ok: false, reason: 'no-compatible-model' }
}
