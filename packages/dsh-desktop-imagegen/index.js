import { Config, applyWithHost } from '@dickpy/dsh-imagegen'
import { createManagedOperations } from './managed.js'

export { Config }
export const name = 'dsh-desktop-imagegen'
export const inject = ['webServer', 'systemPrompt', 'commands', 'llm', 'agentDefaultModel', 'modelService']

/** The trusted host wrapper supplies operations, never authentication material. */
export function apply(ctx, config) {
  let scope
  try { scope = ctx.modelService.forConsumer(name) }
  catch (error) {
    // An offline/unregistered workspace still needs settings and its custom
    // channels. Absence of a grant must disable managed operations, not boot.
    if (error?.code !== 'CONSUMER_UNAVAILABLE') throw error
  }
  if (scope && !scope.image) { scope?.dispose(); scope = undefined }
  let active = true
  try {
    ctx.effect(() => () => {
      if (!active) return
      active = false
      scope?.dispose()
    }, 'desktop image model-service scope')
    return applyWithHost(ctx, config, createManagedOperations({
      getBridge: () => scope?.image,
      getSelection: () => ctx.agentDefaultModel.currentSelection(),
      stream: options => ctx.llm.stream(options),
      listModels: provider => ctx.llm.listModels(provider)
    }))
  } catch (error) {
    if (active) scope?.dispose()
    throw error
  }
}
