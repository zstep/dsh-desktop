import type { ImageParameterContract, ImageDiagnostic } from './image-contract.js'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

export type ModelCapability = 'chat.completions' | 'image.generate'
export type ConsumerStatus = 'declared' | 'needs-adapter' | 'invalid-declaration'
export interface ConsumerRecord {
  readonly id: string
  readonly version?: string
  readonly status: ConsumerStatus
  readonly capabilities: readonly ModelCapability[]
  readonly adapter?: 'llm-pi-ai' | 'desktop-imagegen' | 'image-generation'
}
export interface ModelInfo {
  readonly id: string
  readonly name: string
  readonly capabilities?: readonly ModelCapability[]
}
export interface ImageCatalog {
  readonly generationParameters?: ImageParameterContract
  readonly models: readonly ModelInfo[]
  readonly selection: 'request-local' | 'server-only'
  readonly defaultModel: ModelInfo | null
  readonly catalogStatus?: 'available' | 'default-only' | 'models-unavailable'
}
export interface Availability { readonly available: boolean; readonly reason: string }
export interface ModelCatalog {
  readonly imageParameters?: ImageParameterContract
  readonly imageDefaultModel?: ModelInfo | null
  readonly contractVersion: 1
  readonly models: readonly ModelInfo[]
  readonly defaults: Readonly<Partial<Record<ModelCapability, string | null>>>
  readonly imageSelection: 'request-local' | 'server-only'
  readonly imageCatalogStatus: 'available' | 'default-only' | 'models-unavailable'
  readonly availability: Readonly<{ chat: Availability; image: Availability }>
}
export interface ServiceStatus {
  readonly contractVersion: 1
  readonly availability: Readonly<{ chat: Availability; image: Availability }>
  readonly capabilities: readonly ModelCapability[]
}
export interface OperationOptions { readonly signal?: AbortSignal }
export interface ImageGenerateOptions extends OperationOptions { readonly model?: string; readonly size?: string }
export interface ImageGenerateManyOptions extends ImageGenerateOptions {
  readonly n: number
  readonly quality?: 'auto' | 'low' | 'medium' | 'high'
  readonly detail?: '' | 'standard' | 'high'
  readonly parameterContractVersion: 1
  readonly parameterRevision: string
}
export interface ImageBatchResult {
  readonly requested: number
  readonly images: readonly { index: number; data: Uint8Array; mime: 'image/png' | 'image/jpeg' | 'image/webp' }[]
  readonly failures: readonly { index: number; code: string; diagnostic?: ImageDiagnostic }[]
  readonly complete: boolean
}
export interface ChatRequest {
  readonly model?: string
  readonly messages: readonly Record<string, unknown>[]
  readonly system?: string
  readonly tools?: readonly Record<string, unknown>[]
  readonly temperature?: number
  readonly maxTokens?: number
  readonly stop?: readonly string[]
  readonly reasoningEffort?: string
}
export interface ImageOperations {
  status(options?: OperationOptions): Promise<Availability>
  models(options?: OperationOptions): Promise<ImageCatalog>
  generateMany(prompt: string, options: ImageGenerateManyOptions): Promise<ImageBatchResult>
  generate(prompt: string, options?: ImageGenerateOptions): Promise<Uint8Array>
}

export interface ImageService extends ImageOperations {}

export interface ConsumerScope {
  readonly id: string
  readonly contractVersion: 1
  readonly capabilities: readonly ModelCapability[]
  catalog(options?: OperationOptions): Promise<ModelCatalog>
  status(options?: OperationOptions): Promise<ServiceStatus>
  readonly chat?: { stream(request: ChatRequest, options?: OperationOptions): AsyncIterable<StreamChunk> }
  readonly image?: ImageService
  dispose(): void
}
export interface ModelService {
  readonly contractVersion: 1
  catalog(options?: OperationOptions): Promise<ModelCatalog>
  status(options?: OperationOptions): Promise<ServiceStatus>
  imageStatus(options?: OperationOptions): Promise<Availability>
  consumers(): readonly ConsumerRecord[]
  forConsumer(id: string): ConsumerScope
  dispose(): void
}
export interface ModelServiceConfig {
  readonly bindings: Readonly<Record<string, { enabled: boolean; chatModel?: string; imageModel?: string }>>
}
export interface SettingsDescriptor {
  readonly ns: string
  readonly value: unknown
  readonly user?: unknown
  readonly base?: unknown
  readonly secrets?: readonly { readonly path: readonly string[]; readonly set: boolean; readonly nonempty?: boolean }[]
}
export interface SettingsAccess {
  describe(options?: { redactSecrets?: boolean }): readonly SettingsDescriptor[]
}
export { createPluginConfigurationController, setupPluginConfiguration } from './plugin-configuration.js'
export type { PluginConfigurationController, PluginConfigurationPublicPlan, PluginConfigurationPublicWrite } from './plugin-configuration.js'
export declare const Config: unknown
export declare const name: 'dsh-desktop-model-service'
export declare const inject: readonly ['llm', 'settings']
export declare function apply(ctx: { readonly llm: unknown; readonly settings: SettingsAccess }, config: ModelServiceConfig): void
