export type ConfigurationBindingCapability = 'chat.completions' | 'image.generate'
export type ConfigurationBindingStatus = 'saved-active' | 'saved-awaiting-restart' | 'verification-failed' | 'unsupported'
export type ConfigurationBindingModelRef = 'pengbao-default-chat' | 'pengbao-default-image'
export type ConfigurationBindingSemantic = 'endpoint' | 'credential' | 'chat-model' | 'image-model' | 'binding-id' | 'label'
/** Data-only JSON template; nested object keys may include the exact host binding id marker. */
export type ConfigurationBindingTemplate = null | string | number | boolean
  | Readonly<{ $semantic: ConfigurationBindingSemantic }>
  | readonly ConfigurationBindingTemplate[]
  | { readonly [key: string]: ConfigurationBindingTemplate }
export type ConfigurationBindingValue = null | string | number | boolean
  | readonly ConfigurationBindingValue[]
  | { readonly [key: string]: ConfigurationBindingValue }

export interface ConfigurationBindingIdentity {
  readonly bindingId: string
  readonly entryId: string
  readonly packageName: string
  readonly packageVersion: string
  readonly namespace: string
  readonly schemaDigest: string
  readonly evidenceDigest: string
}

export interface ConfigurationBindingRecord {
  readonly contractVersion: 1
  readonly identity: ConfigurationBindingIdentity
  readonly capabilities: readonly ConfigurationBindingCapability[]
  readonly modelRefs: readonly ConfigurationBindingModelRef[]
  readonly refs: Readonly<{ endpoint: 'pengbao-endpoint'; credential: 'pengbao-credential' }>
  readonly status: ConfigurationBindingStatus
  readonly writePaths: readonly (readonly string[])[]
  readonly revision: number
  readonly reason?: 'settings-not-writable' | 'proposal-unsupported' | 'binding-conflict' | 'verification-failed'
}

export interface ConfigurationWrite {
  /** Static keys, the exact host binding id via $binding-id, or a final $append. */
  readonly path: readonly string[]
  readonly value: ConfigurationBindingTemplate
  readonly evidenceIds: readonly string[]
}

export interface ConfigurationProposal {
  readonly contractVersion: 1
  readonly protocol: 'openai'
  readonly capabilities: readonly ConfigurationBindingCapability[]
  readonly writes: readonly ConfigurationWrite[]
}

export interface MaterializedWrite {
  /** Same length/static segments as the proposal; append is a canonical index <= 256. */
  readonly path: readonly string[]
  /** Exact proposal structure/literals; semantics become host strings (only endpoint may be a loopback HTTP URL). */
  readonly value: ConfigurationBindingValue
}

export interface ConfigurationBindingPlan {
  readonly contractVersion: 1
  readonly id: string
  readonly identity: ConfigurationBindingIdentity
  readonly namespace: string
  readonly revision: number
  readonly capabilities: readonly ConfigurationBindingCapability[]
  readonly modelRefs: readonly ConfigurationBindingModelRef[]
  readonly writePaths: readonly (readonly string[])[]
  readonly expiresAt: number
}

export interface ConfigurationSettingsDescriptor {
  readonly ns: string
  readonly revision: number
  readonly value?: unknown
  readonly user?: unknown
  readonly base?: unknown
  readonly secrets?: readonly { readonly path: readonly string[]; readonly set: boolean; readonly nonempty?: boolean }[]
}

export interface ConfigurationBindingSettings {
  readonly writable?: boolean
  describe(options: { readonly redactSecrets: true }): ConfigurationSettingsDescriptor[] | Promise<ConfigurationSettingsDescriptor[]>
  mutate(namespace: string, operations: readonly {
    readonly op: 'set' | 'unset'
    readonly path: readonly string[]
    readonly value?: unknown
  }[], expectedRevision: number): void | Promise<void>
}

export interface ConfigurationBindingApplyResult {
  readonly status: ConfigurationBindingStatus
  readonly record?: ConfigurationBindingRecord
  readonly revision?: number
  readonly receiptId?: string
}

export interface ConfigurationBindingRollbackResult {
  readonly status: 'rolled-back' | 'verification-failed'
  readonly receiptId: string
}

export interface ConfigurationBindingRegistry {
  /** Read every persisted redacted binding record. */
  describe(): Promise<readonly ConfigurationBindingRecord[]>
  /** Read one persisted redacted record by binding id. */
  read(bindingId: string): Promise<ConfigurationBindingRecord | undefined>
  /** Host-only: create a process-local plan from a schema-validated proposal and host materialization. Never expose directly to renderers. */
  plan(input: {
    readonly identity: ConfigurationBindingIdentity
    readonly namespace: string
    readonly revision: number
    readonly proposal: ConfigurationProposal
    readonly materializedWrites: readonly MaterializedWrite[]
    /** Required for $append: trusted current effective settings; append must equal the parent array length (rechecked at apply). */
    readonly current?: unknown
  }): ConfigurationBindingPlan
  /** Apply a plan with an expected settings revision and redacted readback. */
  apply(plan: ConfigurationBindingPlan, options: { readonly settings: ConfigurationBindingSettings }): Promise<ConfigurationBindingApplyResult>
  /** Roll back a still-current receipt after a revision and value guard. */
  rollback(input: { readonly receiptId: string }, options: { readonly settings: ConfigurationBindingSettings }): Promise<ConfigurationBindingRollbackResult>
  /** Drop process-local plans and receipts. Persisted records are left intact. */
  dispose(): void
}

/** Parse and detach one strict, non-secret persisted binding record. */
export function parseConfigurationBindingRecord(value: unknown): ConfigurationBindingRecord
/** Validate and normalize one strict, non-secret persisted binding record. */
export function validateConfigurationBindingRecord(value: unknown): ConfigurationBindingRecord
/** Return the server-owned logical model alias for a capability or its short name. */
export function bindingAlias(capability: ConfigurationBindingCapability | 'chat' | 'image'): ConfigurationBindingModelRef
/** Create a host-owned registry backed by profileDir/.pengbao-model-bindings.json. */
export function createConfigurationBindingRegistry(options: {
  readonly profileDir: string
  readonly ttlMs?: number
}): ConfigurationBindingRegistry
