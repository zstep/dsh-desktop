export interface DefaultPluginIntent {
  version: 1
  imagegen: {
    status: 'pending' | 'completed' | 'adopted' | 'skipped'
    reason?: string
    version?: string
    application?: string
  }
}
type ProfileManifest = Record<string, unknown>
export const DEFAULT_IMAGE_PLUGIN: '@dickpy/dsh-imagegen' = '@dickpy/dsh-imagegen'
export const LEGACY_IMAGE_PLUGIN: 'dsh-desktop-imagegen' = 'dsh-desktop-imagegen'
export function readDefaultPluginIntent(directory: string): Promise<DefaultPluginIntent | undefined>
export function prepareDefaultPluginIntent(home: string, manifest: ProfileManifest, options?: { fresh?: boolean }): Promise<DefaultPluginIntent>
export function retireLegacyImagePlugin<T extends ProfileManifest>(home: string, manifest: T): Promise<T>
export function provisionDefaultPlugins(options: {
  home: string
  pluginMarket: {
    listIndexes(): { url: string; error?: string }[]
    entry(url: string, name: string): Promise<unknown>
  }
  pluginManager: {
    listBundles(): Promise<{ name: string; installed: boolean }[]>
    installBundle(spec: string, options: Record<string, unknown>): Promise<{ application: string; error?: { code?: string } }>
    cancelInstall(requestId: string): Promise<unknown>
  }
  signal?: AbortSignal
  report?: (error: unknown) => void
}): Promise<DefaultPluginIntent | undefined>
