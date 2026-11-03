import { join } from 'node:path'
import { readDisabledProfileBundles } from '@deepseek-ai/dsh-app-boot'
import { BUILTIN_IMAGE_GENERATION, BUILTIN_IMAGEGEN, MARKET_IMAGEGEN, hostPluginTargetPackage, profileContainsBundle, readDisabledHostPlugins } from './host-plugin-state'
import { isProfilePluginDisabledByPatch } from './plugin-disable'

export interface ResolvedHostPluginState {
  /** The persisted Desktop switch preference, not the selected source. */
  enabled: boolean
  effectiveSource: 'host' | 'profile' | 'disabled'
  effectiveEnabled: boolean
  reason?: string
}

async function profileImageOwner(dshHome: string, name: string): Promise<string | undefined> {
  // Reuse Harness's exact package skip semantics, including legacy disabledSkins
  // and unreadable market state. A disabled patch row still occupies its Loader ID.
  const skipped = readDisabledProfileBundles(join(dshHome, 'profiles', 'web'))
  const candidates = name === BUILTIN_IMAGEGEN ? [MARKET_IMAGEGEN, BUILTIN_IMAGEGEN] : [name]
  for (const candidate of candidates) {
    if (!skipped.has(candidate) && await profileContainsBundle(dshHome, candidate)) return candidate
  }
  return undefined
}

/** Read-only selection: never disable or replace a user's market package. Other
 * host packages retain the normal duplicate-bundle startup protection.
 */
export async function resolveHostPluginState(dshHome: string, name: string): Promise<ResolvedHostPluginState> {
  const disabled = await readDisabledHostPlugins(dshHome)
  const enabled = !disabled.includes(name) && !disabled.includes(hostPluginTargetPackage(name))
  const owner = name === BUILTIN_IMAGE_GENERATION || name === BUILTIN_IMAGEGEN
    ? await profileImageOwner(dshHome, name)
    : undefined
  if (owner) {
    const effectiveEnabled = !(await isProfilePluginDisabledByPatch(dshHome, owner))
    return {
      enabled,
      effectiveSource: 'profile',
      effectiveEnabled,
      reason: effectiveEnabled ? 'market-active' : 'market-row-disabled'
    }
  }
  return enabled
    ? { enabled, effectiveSource: 'host', effectiveEnabled: true }
    : { enabled, effectiveSource: 'disabled', effectiveEnabled: false, reason: 'host-disabled' }
}

/** Names omitted from host insertions, retaining their original package identity
 * until all source selection and legacy disabled-row restoration is complete.
 */
export async function readEffectiveDisabledHostPlugins(dshHome: string): Promise<string[]> {
  const disabled = new Set(await readDisabledHostPlugins(dshHome))
  if (await profileImageOwner(dshHome, BUILTIN_IMAGE_GENERATION)) disabled.add(BUILTIN_IMAGE_GENERATION)
  if (disabled.has(MARKET_IMAGEGEN) || await profileImageOwner(dshHome, BUILTIN_IMAGEGEN)) disabled.add(BUILTIN_IMAGEGEN)
  return [...disabled]
}
