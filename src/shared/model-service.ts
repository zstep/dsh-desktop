import { parseImageParameters, type ImageParameterContract } from 'dsh-desktop-model-service/image-contract'

export const MODEL_SERVICE_CONTRACT_VERSION = 1 as const

export const MODEL_SERVICE_CAPABILITIES = [
  'chat.completions',
  'image.generate'
] as const

export type ModelServiceCapability = typeof MODEL_SERVICE_CAPABILITIES[number]

const CONTROL_CHARACTERS = /[\p{C}\p{Zl}\p{Zp}]/u

/** A public model description; credentials and upstream URLs are never part of the directory. */
export interface ModelServiceModel {
  id: string
  name: string
  capabilities: readonly ModelServiceCapability[]
  parameters?: readonly string[]
}

export interface ModelServiceCatalog {
  contractVersion: typeof MODEL_SERVICE_CONTRACT_VERSION
  models: readonly ModelServiceModel[]
  defaults: Partial<Record<ModelServiceCapability, string | null>>
  imageParameters?: ImageParameterContract
  imageSelection?: 'request-local' | 'server-only'
  imageCatalogStatus?: 'available' | 'default-only' | 'models-unavailable'
  availability?: Readonly<Record<'chat' | 'image', { available: boolean; reason: string }>>
}

/** Declare this at `package.json#dsh.modelService` to opt into the host service API. */
export interface ModelServiceConsumerDeclaration {
  contractVersion: typeof MODEL_SERVICE_CONTRACT_VERSION
  capabilities: readonly ModelServiceCapability[]
}

/** Private runtime packet. It is transported only over the parent/child IPC channel. */
export interface PrivateModelServicePacket {
  contractVersion: typeof MODEL_SERVICE_CONTRACT_VERSION
  gatewayUrl: string
  capabilityToken: string
  capabilities: readonly ModelServiceCapability[]
}

const CAPABILITY_SET: ReadonlySet<string> = new Set(MODEL_SERVICE_CAPABILITIES)
const PARAMETER_NAME = /^[a-z][a-z0-9_]{0,63}$/u

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function validAvailability(value: unknown): value is ModelServiceCatalog['availability'] {
  const root = record(value)
  if (!root || !exactKeys(root, ['chat', 'image']) || !Object.hasOwn(root, 'chat') || !Object.hasOwn(root, 'image')) return false
  for (const key of ['chat', 'image'] as const) {
    const item = record(root[key])
    if (!item || !exactKeys(item, ['available', 'reason']) ||
      typeof item.available !== 'boolean' || typeof item.reason !== 'string' ||
      item.reason.length === 0 || item.reason.length > 64 || CONTROL_CHARACTERS.test(item.reason) ||
      (item.reason === 'available') !== item.available) return false
  }
  return true
}

function modelId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    value.trim() === value && !CONTROL_CHARACTERS.test(value)
}

function capabilityList(value: unknown): ModelServiceCapability[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const capabilities: ModelServiceCapability[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string' || !CAPABILITY_SET.has(item) || seen.has(item)) return undefined
    seen.add(item)
    capabilities.push(item as ModelServiceCapability)
  }
  return capabilities
}

function parameters(value: unknown): string[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string' || !PARAMETER_NAME.test(item) || seen.has(item)) return undefined
    seen.add(item)
    result.push(item)
  }
  return result
}

/** Validate and copy a catalog crossing a process or plugin boundary. */
export function parseModelServiceCatalog(value: unknown): ModelServiceCatalog {
  const input = record(value)
  const imageSelection = input?.imageSelection
  const imageCatalogStatus = input?.imageCatalogStatus
  if (!input || !exactKeys(input, ['contractVersion', 'models', 'defaults', 'imageSelection', 'imageCatalogStatus', 'availability', 'imageParameters']) ||
    input.contractVersion !== MODEL_SERVICE_CONTRACT_VERSION || !Array.isArray(input.models) ||
    (imageSelection !== undefined && imageSelection !== 'request-local' && imageSelection !== 'server-only') ||
    (imageCatalogStatus !== undefined && imageCatalogStatus !== 'available' && imageCatalogStatus !== 'default-only' && imageCatalogStatus !== 'models-unavailable') ||
    (input.availability !== undefined && !validAvailability(input.availability))) {
    throw new Error('Invalid model service catalog')
  }

  const models: ModelServiceModel[] = []
  const byId = new Map<string, ModelServiceModel>()
  for (const item of input.models) {
    const row = record(item)
    if (!row || !exactKeys(row, ['id', 'name', 'capabilities', 'parameters']) || !modelId(row.id) ||
      typeof row.name !== 'string' || !row.name.trim() || row.name.length > 256 || CONTROL_CHARACTERS.test(row.name)) {
      throw new Error('Invalid model service catalog')
    }
    const capabilities = capabilityList(row.capabilities)
    const supportedParameters = parameters(row.parameters)
    if (!capabilities || !supportedParameters || byId.has(row.id)) throw new Error('Invalid model service catalog')
    const model: ModelServiceModel = {
      id: row.id,
      name: row.name,
      capabilities,
      ...(supportedParameters.length ? { parameters: supportedParameters } : {})
    }
    models.push(model)
    byId.set(model.id, model)
  }

  const rawDefaults = record(input.defaults)
  if (!rawDefaults || !exactKeys(rawDefaults, MODEL_SERVICE_CAPABILITIES)) throw new Error('Invalid model service catalog')
  const defaults: Partial<Record<ModelServiceCapability, string>> = {}
  for (const capability of MODEL_SERVICE_CAPABILITIES) {
    const selected = rawDefaults[capability]
    if (selected === undefined || selected === null) continue
    if (typeof selected !== 'string' || !modelId(selected) || !byId.get(selected)?.capabilities.includes(capability)) {
      throw new Error('Invalid model service catalog')
    }
    defaults[capability] = selected
  }

  const availability = input.availability
  return {
    contractVersion: MODEL_SERVICE_CONTRACT_VERSION,
    ...(input.imageParameters === undefined ? {} : { imageParameters: parseImageParameters(input.imageParameters) }),
    models,
    defaults,
    ...(imageSelection === undefined ? {} : { imageSelection }),
    ...(imageCatalogStatus === undefined ? {} : { imageCatalogStatus }),
    ...(availability === undefined ? {} : { availability: {
      chat: { ...availability.chat }, image: { ...availability.image }
    } })
  }
}

/** Read only the explicit service declaration; unrelated manifest fields are ignored. */
export function readModelServiceConsumerDeclaration(manifest: unknown): ModelServiceConsumerDeclaration | undefined {
  const root = record(manifest)
  if (!root || !Object.hasOwn(root, 'dsh')) return undefined
  const dsh = record(root.dsh)
  if (!dsh || !Object.hasOwn(dsh, 'modelService')) return undefined
  const declaration = record(dsh.modelService)
  if (!declaration || !exactKeys(declaration, ['contractVersion', 'capabilities']) ||
    declaration.contractVersion !== MODEL_SERVICE_CONTRACT_VERSION) {
    throw new Error('Invalid model service consumer declaration')
  }
  const capabilities = capabilityList(declaration.capabilities)
  if (!capabilities) throw new Error('Invalid model service consumer declaration')
  return { contractVersion: MODEL_SERVICE_CONTRACT_VERSION, capabilities }
}
