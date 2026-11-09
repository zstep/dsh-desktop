export type Semantic = 'endpoint' | 'credential' | 'chat-model' | 'image-model' | 'binding-id' | 'label'
export type Capability = 'chat.completions' | 'image.generate'
export interface ConfigurablePlugin { entryId: string; namespace: string; packageName: string; packageVersion: string; supported: boolean; reason: string }
export interface EvidenceFile { id: string; path: string; digest: string; bytes: number; text: string; stat?: { size: number; mtimeMs: number; ino: number; dev: number } }
export interface PluginEvidence {
  identity: { entryId: string; namespace: string; packageName: string; packageVersion: string; root: string; schemaDigest: string; evidenceDigest: string; files: { path: string; digest: string }[] }
  /** Sanitized full runtime Config.toJSON() schema, without defaults or revived callbacks. */
  schema: unknown
  /** Legacy settings descriptor revision, or 0; not a snapshot of the current config. */
  revision: number
  manifestDigest: string
  files: EvidenceFile[]
}
/** Nested dictionary keys may use '$binding-id'; '$append' is reserved for final write-path segments. */
export type Template = null | string | number | boolean | { $semantic: Semantic } | Template[] | { [key: string]: Template }
export interface ConfigurationWrite { path: string[]; value: Template; evidenceIds: string[] }
export interface ConfigurationProposal { contractVersion: 1; protocol: 'openai'; capabilities: Capability[]; writes: ConfigurationWrite[] }
export interface MaterializationValues { endpoint: string; credential: string; chatModel?: string; imageModel?: string; bindingId?: string; label?: string; current?: unknown }
export interface MaterializedWrite { path: string[]; value: unknown; append?: true }
export function configurationSchemaDigest(schema: unknown): string
export function listConfigurablePlugins(ctx: unknown): Promise<ConfigurablePlugin[]>
export function collectPluginEvidence(ctx: unknown, entryId: string): Promise<PluginEvidence>
export function validateConfigurationProposal(proposal: unknown, schema: unknown, evidenceIds: string[]): ConfigurationProposal
export function materializeProposal(proposal: ConfigurationProposal, values: MaterializationValues): MaterializedWrite[]
export function analyzePluginConfiguration(ctx: unknown, evidence: PluginEvidence, options?: { signal?: AbortSignal; selection?: { provider: 'pengbao'; model: string } }): Promise<ConfigurationProposal>
