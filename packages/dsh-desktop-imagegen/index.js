import { Config, applyWithHost } from '@dickpy/dsh-imagegen'
import { getDesktopImageBridge } from 'dsh-image-generation/desktop-bridge'
import { createManagedOperations } from './managed.js'

export { Config }
export const name = 'dsh-desktop-imagegen'
export const inject = ['webServer', 'systemPrompt', 'commands', 'llm', 'agentDefaultModel']

/** The trusted host wrapper supplies operations, never authentication material. */
export function apply(ctx, config) {
  return applyWithHost(ctx, config, createManagedOperations({
    getBridge: getDesktopImageBridge,
    getSelection: () => ctx.agentDefaultModel.currentSelection(),
    stream: options => ctx.llm.stream(options),
    listModels: provider => ctx.llm.listModels(provider)
  }))
}
