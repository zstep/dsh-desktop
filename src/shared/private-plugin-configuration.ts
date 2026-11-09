import type { ModelServiceCapability } from './model-service'

/** Bootstrap-only capability. Never persist or expose on a renderer service. */
export interface PrivatePluginConfigurationPacket {
  contractVersion: 1
  gatewayUrl: string
  capabilityToken: string
}

/** Identity is resolved and approved by the host, never supplied as a path by a plugin. */
export interface PluginConfigurationPolicy {
  bindingId: string
  entryId: string
  packageName: string
  packageVersion: string
  capabilities: readonly ModelServiceCapability[]
  models: readonly string[]
}

export function parsePluginConfigurationPolicy(value: unknown): PluginConfigurationPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid plugin configuration policy')
  const item = value as Record<string, unknown>
  const text = (input: unknown, max = 256): input is string => typeof input === 'string' && input.length > 0 && input.length <= max &&
    input.trim() === input && !/[\p{C}\p{Zl}\p{Zp}]/u.test(input)
  if (Object.keys(item).some(key => !['bindingId', 'entryId', 'packageName', 'packageVersion', 'capabilities', 'models'].includes(key)) ||
    !text(item.bindingId) || !text(item.entryId) || !text(item.packageName) || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(item.packageName) ||
    !text(item.packageVersion, 128) || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(item.packageVersion) ||
    !Array.isArray(item.capabilities) || item.capabilities.length === 0 || item.capabilities.length > 2 ||
    item.capabilities.some(scope => scope !== 'chat.completions' && scope !== 'image.generate') || new Set(item.capabilities).size !== item.capabilities.length ||
    !Array.isArray(item.models) || item.models.length === 0 || item.models.length > 256 || item.models.some(model => !text(model) && !(model === 'pengbao-default-chat' || model === 'pengbao-default-image')) || new Set(item.models).size !== item.models.length) {
    throw new Error('Invalid plugin configuration policy')
  }
  return { bindingId: item.bindingId, entryId: item.entryId, packageName: item.packageName, packageVersion: item.packageVersion,
    capabilities: item.capabilities as ModelServiceCapability[], models: [...item.models] as string[] }
}

export function parsePrivatePluginConfigurationPacket(value: unknown): PrivatePluginConfigurationPacket {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid private plugin configuration packet')
  const item = value as Record<string, unknown>
  if (Object.keys(item).sort().join(',') !== 'capabilityToken,contractVersion,gatewayUrl' || item.contractVersion !== 1 ||
    typeof item.gatewayUrl !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(item.gatewayUrl) ||
    Number(item.gatewayUrl.slice(item.gatewayUrl.lastIndexOf(':') + 1)) < 1 || Number(item.gatewayUrl.slice(item.gatewayUrl.lastIndexOf(':') + 1)) > 65535 ||
    typeof item.capabilityToken !== 'string' || !/^[A-Za-z0-9_-]{32,512}$/.test(item.capabilityToken)) throw new Error('Invalid private plugin configuration packet')
  return { contractVersion: 1, gatewayUrl: item.gatewayUrl, capabilityToken: item.capabilityToken }
}
