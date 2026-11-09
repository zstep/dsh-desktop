import z from '@deepseek-ai/schemastery'
import { createModelService } from './service.js'
import { setupModelServiceConnections } from './connections.js'
import { setupPluginConfiguration } from './plugin-configuration.js'

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
  ctx.inject(['connection', 'settings', 'webServer'], child => { setupModelServiceConnections(child, service) })
  ctx.inject(['connection', 'settings', 'webServer', 'configEditor', 'pluginPackages', 'profileContext'], child => {
    setupPluginConfiguration(child, service)
  })
  ctx.effect(() => () => service.dispose(), 'desktop model service')
}
