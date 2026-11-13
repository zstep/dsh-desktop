import z from '@deepseek-ai/schemastery'
import { createModelService } from './service.js'
import { initializeDefaultModel } from './default-model-runtime.js'
import { setupModelServiceConnections } from './connections.js'
import { setupPluginConfiguration } from './plugin-configuration.js'

const SAFE_MODE_PROFILE = 'desktop-safe-mode'

const bindingsSchema = z.dict(z.object({
  enabled: z.boolean().required(),
  chatModel: z.string().required(false),
  imageModel: z.string().required(false)
})).default({}).volatile()

/** Per-consumer opt-in and selected models; tokens remain bootstrap-private. */
export const Config = z.object({ bindings: bindingsSchema })

export const name = 'dsh-desktop-model-service'
export const inject = ['llm', 'settings']

/** Host integration hook; desktop bootstrap registers private capabilities first. */
export function apply(ctx, config) {
  const service = createModelService({ llm: ctx.llm,
    getBindings: () => {
      const descriptor = ctx.settings.describe({ redactSecrets: true }).find(item => item.ns === 'dsh-desktop-model-service')
      if (!descriptor) throw new Error('Model bindings unavailable')
      return descriptor.value?.bindings ?? {}
    } })
  ctx.provide('modelService', service)
  // The base composition pins a default model from a provider this account has no
  // credential for. Point it at the account's first usable server default once, but
  // only from a dependency-scoped fiber: ConfigEditor persists through the profile
  // patch and waits on the Loader, so awaiting that from `apply` would deadlock on
  // this plugin's own initialization.
  ctx.inject(['loader', 'llm', 'agentDefaultModel', 'configEditor', 'profileContext'], child => {
    if (child.profileContext?.name === SAFE_MODE_PROFILE) return
    void (async () => {
      // Provider adapters and profile entries must be live before a selection can
      // be judged routable; this fiber is not a Loader entry, so waiting here
      // cannot stall the settle it is waiting for.
      await child.loader.await()
      let defaults
      try { defaults = (await service.chatDefaults()).defaultModels }
      catch (error) {
        console.warn(`[model-service] default model lookup skipped: ${error?.code ?? 'UNAVAILABLE'}`)
        return
      }
      try { await initializeDefaultModel({ llm: child.llm, agentDefaultModel: child.agentDefaultModel }, defaults) }
      catch (error) {
        console.warn(`[model-service] default model initialization skipped: ${error?.code ?? 'FAILED'}`)
      }
    })()
  })
  ctx.inject(['connection', 'settings', 'webServer'], child => { setupModelServiceConnections(child, service) })
  ctx.inject(['connection', 'settings', 'webServer', 'configEditor', 'pluginPackages', 'profileContext'], child => {
    setupPluginConfiguration(child, service)
  })
  ctx.effect(() => () => service.dispose(), 'desktop model service')
}
