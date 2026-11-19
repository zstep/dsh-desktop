import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { clientVisibleModels, type PengbaoModel } from './client'

const OVERLAY_NAME = 'pengbao-provider.patch.yml'

/**
 * The Pengbao model route the desktop pins into the locked Harness's llm-pi-ai
 * adapter. The endpoint is the account's own loopback gateway and the key is
 * the gateway's capability token, so `apiKeyEnv` is deliberately absent: the
 * route resolves through the adapter's memory-only credential seam, and any
 * other credential plane fails closed instead of borrowing this route.
 */
export interface PengbaoProviderRoute {
  gatewayUrl: string
  models: readonly PengbaoModel[]
}

function providerProfile(route: PengbaoProviderRoute): Record<string, unknown> {
  return {
    api: 'openai-completions',
    displayName: 'Pengbao',
    baseURL: `${route.gatewayUrl.replace(/\/$/, '')}/v1`,
    defaultInput: ['text'],
    models: clientVisibleModels(route.models, 'text').map((model) => ({
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      input: model.input?.includes('image') ? ['text', 'image'] : ['text']
    }))
  }
}

/**
 * Read the llm-pi-ai row's config from one user patch layer, following the
 * loader's patch semantics: a later layer replaces the whole config, so the
 * caller decides which layer's config wins.
 */
function llmPiAiConfig(patchText: string | undefined): Record<string, unknown> | undefined {
  if (patchText === undefined) return undefined
  let patches: unknown
  try {
    patches = parse(patchText, { logLevel: 'silent' })
  } catch {
    // The composition itself fails on an unparseable user patch; the overlay
    // must not silently paper over it with an empty config.
    throw new Error('The profile patch layer could not be read for the Pengbao provider route')
  }
  if (!Array.isArray(patches)) {
    throw new Error('The profile patch layer could not be read for the Pengbao provider route')
  }
  for (const patch of patches) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) continue
    const row = patch as { id?: unknown; config?: unknown }
    if (row.id !== 'llm-pi-ai') continue
    if (row.config === undefined) return undefined
    if (row.config === null || typeof row.config !== 'object' || Array.isArray(row.config)) {
      throw new Error('The llm-pi-ai patch row does not carry a config object')
    }
    return row.config as Record<string, unknown>
  }
  return undefined
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Compose the overlay text: the user layer's own llm-pi-ai config (other
 * providers stay served) with the Pengbao route pinned on top, because the
 * loader replaces an entry's config wholesale — the overlay must carry the
 * whole document it wants the composition to see.
 */
export function pengbaoProviderOverlayText(
  route: PengbaoProviderRoute,
  userConfig: Record<string, unknown> | undefined
): string {
  const config = {
    ...(userConfig ?? {}),
    providers: {
      ...(userConfig?.providers && typeof userConfig.providers === 'object' && !Array.isArray(userConfig.providers)
        ? userConfig.providers
        : {}),
      pengbao: providerProfile(route)
    }
  }
  return `# Managed by Pengbao Desktop. Do not edit.\n${stringify([{ id: 'llm-pi-ai', config }])}`
}

/**
 * Write the managed provider overlay for the given profile and return its
 * path, to be appended as the last `--patch` layer so the Pengbao route wins
 * over whatever the user layer set for it (the desktop owns that route; its
 * gateway port is per-launch anyway).
 */
export async function preparePengbaoProviderOverlay(
  dshHome: string,
  profile: string,
  route: PengbaoProviderRoute
): Promise<string> {
  const homePatch = join(dshHome, 'cordis.patch.yml')
  const profilePatch = join(dshHome, 'profiles', profile, 'cordis.patch.yml')
  // Layer order: the profile's user patch, then the home-level patch on top.
  const userConfig = llmPiAiConfig(await readIfPresent(profilePatch))
  const homeConfig = llmPiAiConfig(await readIfPresent(homePatch))
  const effective = homeConfig ?? userConfig
  const overlayPath = join(dshHome, OVERLAY_NAME)
  const text = pengbaoProviderOverlayText(route, effective)
  if (await readIfPresent(overlayPath) === text) return overlayPath
  const temporary = `${overlayPath}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, text, 'utf8')
    await rename(temporary, overlayPath)
  } finally {
    await rm(temporary, { force: true })
  }
  return overlayPath
}

/** Withdraw the managed overlay; the composition no longer references it. */
export async function removePengbaoProviderOverlay(dshHome: string): Promise<void> {
  await rm(join(dshHome, OVERLAY_NAME), { force: true })
}

/**
 * The models the overlay pins, validated the way the locked adapter resolves
 * them: a route must serve at least one model.
 */
export function assertServableModels(models: readonly PengbaoModel[]): void {
  if (clientVisibleModels(models, 'text').length === 0) throw new Error('The Pengbao account serves no models')
}
