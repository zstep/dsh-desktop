import type { Capability, PluginEvidence, ConfigurationProposal, MaterializationValues, MaterializedWrite } from './plugin-config-analysis'

export interface PluginConfigurationPublicWrite { readonly path: readonly string[]; readonly value: unknown }
export interface PluginConfigurationPublicPlan {
  readonly planId: string
  readonly entryId: string
  readonly packageName: string
  readonly packageVersion: string
  readonly expiresAt: number
  readonly capabilities: readonly Capability[]
  readonly writes: readonly PluginConfigurationPublicWrite[]
}
export interface PluginConfigurationController {
  inventory(): Promise<{ readonly plugins: readonly unknown[]; readonly available: boolean }>
  analyze(input: { readonly entryId: string }, options?: { signal?: AbortSignal }): Promise<PluginConfigurationPublicPlan>
  cancel(input: Record<string, never>): { readonly status: 'cancelled' }
  apply(input: { readonly planId: string }): Promise<{ readonly status: 'saved-active'; readonly receiptId: string }>
  rollback(input: { readonly receiptId: string }): Promise<{ readonly status: 'rolled-back' | 'verification-failed' }>
  dispose(): void
}
export function createPluginConfigurationController(ctx: unknown, service: unknown): PluginConfigurationController
export function setupPluginConfiguration(ctx: unknown, service: unknown): PluginConfigurationController
