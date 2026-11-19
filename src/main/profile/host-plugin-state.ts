import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readDisabledProfileBundles } from '@deepseek-ai/dsh-app-boot'
import { disableProfilePlugin, isProfilePluginDisabledByPatch } from './plugin-disable'

const STATE_FILE = 'desktop-host-plugins.json'
export const BUILTIN_IMAGE_GENERATION = 'dsh-image-generation'
export const BUILTIN_IMAGEGEN = 'dsh-desktop-imagegen'
export const MARKET_IMAGEGEN = '@dickpy/dsh-imagegen'

/** The wrapper and market bundle occupy the same logical imagegen Loader ID. */
export function hostPluginTargetPackage(name: string): string {
  return name === BUILTIN_IMAGEGEN ? MARKET_IMAGEGEN : name
}
const DEFAULT_DISABLED_HOST_PLUGINS: readonly string[] = []

export async function readDisabledHostPlugins(dshHome: string): Promise<string[]> {
  let source: string
  try {
    source = await readFile(join(dshHome, STATE_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [...DEFAULT_DISABLED_HOST_PLUGINS]
    throw error
  }
  const state: unknown = JSON.parse(source)
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('Desktop host plugin state is not an object')
  }
  const { version, disabled } = state as { version?: unknown; disabled?: unknown }
  if (version !== 1 || !Array.isArray(disabled) || !disabled.every((name) => typeof name === 'string')) {
    throw new Error('Desktop host plugin state has an unsupported format')
  }
  return [...new Set(disabled)]
}

/** Enabling a host package while an active Profile bundle owns the same name
 * would make the next launch fail before the user could reach its settings.
 */
export async function profileContainsBundle(dshHome: string, name: string): Promise<boolean> {
  let source: string
  try {
    source = await readFile(join(dshHome, 'profiles', 'web', 'package.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  const manifest: unknown = JSON.parse(source)
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('The Profile manifest is not an object')
  }
  const profile = (manifest as { dsh?: { profile?: { bundles?: unknown } } }).dsh?.profile
  return Array.isArray(profile?.bundles) && profile.bundles.includes(name)
}

export async function profileHasEnabledBundle(dshHome: string, name: string): Promise<boolean> {
  if (!(await profileContainsBundle(dshHome, name))) return false
  if (readDisabledProfileBundles(join(dshHome, 'profiles', 'web')).has(name)) return false
  return !(await isProfilePluginDisabledByPatch(dshHome, name))
}

/** Persist a market-side disable before enabling the in-box copy. A patch-row
 * disable alone does not remove the Profile bundle's Loader ID at next boot.
 */
export async function prepareProfileBundleForHostEnable(dshHome: string, name: string): Promise<{ ok: boolean; reason?: string }> {
  if (name === BUILTIN_IMAGEGEN) {
    // This independent workbench must not take over or rewrite a Profile owner,
    // including one whose patch row the user has switched off.
    const skipped = readDisabledProfileBundles(join(dshHome, 'profiles', 'web'))
    for (const candidate of [MARKET_IMAGEGEN, BUILTIN_IMAGEGEN]) {
      if (!skipped.has(candidate) && await profileContainsBundle(dshHome, candidate)) {
        return { ok: false, reason: 'market-active' }
      }
    }
    return { ok: true }
  }
  if (!(await profileContainsBundle(dshHome, name))) return { ok: true }
  if (await profileHasEnabledBundle(dshHome, name)) return { ok: false, reason: 'market-active' }
  const result = await disableProfilePlugin(dshHome, name)
  return result.ok ? { ok: true } : { ok: false, reason: result.detail }
}

let pendingWrite: Promise<void> = Promise.resolve()

/** State is Desktop-owned, outside Profile bundles and market disable records. */
export function setHostPluginEnabled(dshHome: string, name: string, enabled: boolean): Promise<void> {
  const write = async (): Promise<void> => {
    const disabled = new Set(await readDisabledHostPlugins(dshHome))
    if (enabled) {
      disabled.delete(name)
      if (name === BUILTIN_IMAGEGEN) disabled.delete(MARKET_IMAGEGEN)
    } else disabled.add(name)
    await mkdir(dshHome, { recursive: true })
    const target = join(dshHome, STATE_FILE)
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 1, disabled: [...disabled].sort() }, null, 2)}\n`, 'utf8')
      await rename(temporary, target)
    } finally {
      await rm(temporary, { force: true })
    }
  }
  const operation = pendingWrite.then(write)
  pendingWrite = operation.catch(() => undefined)
  return operation
}
