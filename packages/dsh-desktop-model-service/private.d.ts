import type { ImageOperations, OperationOptions, ModelInfo } from './index.js'

export interface ConsumerRecord {
  readonly id: string
  readonly version?: string
  readonly status: 'declared' | 'needs-adapter' | 'invalid-declaration'
  readonly capabilities: readonly ('chat.completions' | 'image.generate')[]
  readonly adapter?: 'llm-pi-ai' | 'desktop-imagegen' | 'image-generation'
}

/** Bootstrap-only registration packet. Never return this object to plugins. */
export interface ChatRegistration {
  readonly contractVersion: 1
  readonly gatewayUrl: string
  readonly capabilityToken: string
  readonly capabilities: readonly ['chat.completions']
}
export interface PluginConfigurationPolicy {
  readonly bindingId: string
  readonly entryId: string
  readonly packageName: string
  readonly packageVersion: string
  readonly capabilities: readonly ('chat.completions' | 'image.generate' | 'video.generate')[]
  readonly models: readonly string[]
}
export interface PluginConfigurationRegistration {
  readonly contractVersion: 1
  readonly gatewayUrl: string
  readonly capabilityToken: string
}
/** Host-only bootstrap; this broker is never put on a public service. */
export declare function registerPrivatePluginConfiguration(packet: PluginConfigurationRegistration): void
export declare function createPluginConfigurationBroker(options?: { fetch?: typeof fetch }): {
  videoModels(options?: { signal?: AbortSignal }): Promise<readonly { id: string; name: string; provider: string; protocol: string }[]>
  issue(policy: PluginConfigurationPolicy, options?: { signal?: AbortSignal }): Promise<{
    readonly gatewayUrl: string
    readonly apiKey: string
    readonly capabilities: readonly ('chat.completions' | 'image.generate' | 'video.generate')[]
    readonly models: readonly string[]
    release(): Promise<void>
  }>
  dispose(): Promise<void>
}

/** One-shot main-process private chat registration. */
export declare function registerModelService(packet: ChatRegistration): void
/** Legacy single-image bootstraps remain valid; batch operations are an additive capability. */
export type ImageRegistration = Omit<ImageOperations, 'generateMany'> & Partial<Pick<ImageOperations, 'generateMany'>>
/** Accept only already-bound image operations; credentials/URLs are not part of this API. */
export declare function registerModelServiceImage(operations: ImageRegistration): void
/** Seed immutable discovery records before plugin boot; undefined versions are omitted. */
export declare function registerModelServiceConsumers(records: readonly ConsumerRecord[]): void
export declare function getModelServiceConsumers(): readonly ConsumerRecord[]
export declare function getModelServiceImage(): ImageRegistration | undefined
export declare function hasChatRegistration(): boolean
export declare function createChatService(options?: { signal?: AbortSignal; fetch?: typeof fetch }): {
  readonly contractVersion: 1
  readonly capabilities: readonly string[]
  defaults(options?: OperationOptions): Promise<{ readonly defaultModels: readonly string[] }>
  models(options?: OperationOptions): Promise<readonly ModelInfo[]>
  complete(input: Record<string, unknown>, options?: OperationOptions): Promise<unknown> | Promise<ReadableStream<Uint8Array>>
  dispose(): void
}
