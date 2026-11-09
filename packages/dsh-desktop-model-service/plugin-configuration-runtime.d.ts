import type { PluginConfigurationPolicy } from './private.js'

export interface ApprovedPluginConfiguration {
  readonly identity: {
    readonly bindingId: string
    readonly entryId: string
    readonly namespace: string
    readonly packageName: string
    readonly packageVersion: string
    /** Informational Settings.describe() revision; process-local, not a cross-restart fence. */
    readonly revision: number
    readonly schemaDigest: string
    readonly evidenceDigest: string
  }
  readonly policy: PluginConfigurationPolicy
  readonly files: readonly { readonly path: string; readonly digest: string }[]
  readonly configDigest: string
}
export interface PluginConfigurationRuntime {
  activate(record: ApprovedPluginConfiguration, candidateDigest?: string): Promise<void>
  deactivate(bindingId: string): Promise<void>
  resolve(entryId: string, raw: unknown, resolved: unknown): unknown
  guardUpdate(entryId: string, config: unknown, noSave: boolean): unknown
  dispose(): Promise<void>
}
export function installPluginConfigurationRuntime(ctx: unknown): Promise<PluginConfigurationRuntime | undefined>
export function getPluginConfigurationRuntime(ctx: unknown): PluginConfigurationRuntime | undefined
export function pluginConfigurationReference(bindingId: string, field: 'endpoint' | 'credential'): string
export function configurationDigest(value: unknown): string
export function readPluginConfigurations(profileDir: string): Promise<ApprovedPluginConfiguration[]>
export function writePluginConfigurations(profileDir: string, bindings: readonly ApprovedPluginConfiguration[]): Promise<void>
