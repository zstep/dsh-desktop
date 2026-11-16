export type Semantic = 'endpoint' | 'credential' | 'chat-model' | 'image-model' | 'video-model' | 'binding-id' | 'label'
export type Capability = 'chat.completions' | 'image.generate' | 'video.generate'
export interface ConfigurablePlugin { entryId: string; namespace: string; packageName: string; packageVersion: string; supported: boolean; reason: string }
export interface EvidenceFile {
  id: string
  path: string
  /** SHA-256 of the entire original file, including bytes outside ranges. */
  digest: string
  /** Original file size, not the selected text size. */
  bytes: number
  /** UTF-8 excerpts joined with a single newline; manifest text is complete. */
  text: string
  /** Half-open byte offsets in the original file, sorted and non-overlapping. */
  ranges: { start: number; end: number }[]
  truncated: boolean
  stat?: { size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number }
}
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
export interface MaterializationValues { endpoint: string; credential: string; chatModel?: string; imageModel?: string; chatModels?: string[]; imageModels?: string[]; videoModel?: string; videoModels?: string[]; bindingId?: string; label?: string; current?: unknown }
export interface MaterializedWrite { path: string[]; value: unknown; append?: true }
export function configurationSchemaDigest(schema: unknown): string
export function listConfigurablePlugins(ctx: unknown): Promise<ConfigurablePlugin[]>
export function collectPluginEvidence(ctx: unknown, entryId: string): Promise<PluginEvidence>
export function validateConfigurationProposal(proposal: unknown, schema: unknown, evidenceIds: string[]): ConfigurationProposal
export function materializeProposal(proposal: ConfigurationProposal, values: MaterializationValues): MaterializedWrite[]
/** Model-semantic substitutions for the exact operations array returned by materializeProposal; excluded from its JSON shape. */
export function materializedProposalModels(writes: MaterializedWrite[]): Readonly<Record<Capability, readonly string[]>>
export function analyzePluginConfiguration(ctx: unknown, evidence: PluginEvidence, options?: { signal?: AbortSignal; selection?: { provider: 'pengbao'; model: string } }): Promise<ConfigurationProposal>
