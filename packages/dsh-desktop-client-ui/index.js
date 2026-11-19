import { registerDesktopBootRoute } from './boot.js'
import { repairPresetDefinition } from './repair-preset.js'
import { registerPengbaoIdentity } from './identity.js'

/** The registry and tools belong to the existing Harness runtime. */
export const inject = ['agentPresets', 'systemPrompt']
export async function apply(ctx) {
  registerPengbaoIdentity(ctx)
  registerDesktopBootRoute(ctx)
  const dispose = await ctx.agentPresets.register(repairPresetDefinition())
  ctx.effect(() => dispose)
}
