import { mkdir, readFile, readdir } from 'node:fs/promises'
import { prepareDefaultPluginIntent, retireLegacyImagePlugin } from 'dsh-desktop-market-installer/default-plugins'
import { prepareDefaultMarketIntent } from 'dsh-desktop-market-installer/default-market'
import { dirname, join } from 'node:path'
import { loadOverlayPatches, resolveBundleDir } from '@deepseek-ai/dsh-app-boot'
import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-official-bundles'
import { isMap, isSeq, parseDocument } from 'yaml'
import { writeTextAtomically } from './persona-prefix-migration'

export const PLUGIN_MARKET_BUNDLE = '@deepseek-ai/dsh-experimental-plugin-market-bundle'
export const DEFAULT_PLUGIN_MARKET_INDEX = 'https://dshmarket.com/index.json'

function record(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Plugin market initialization requires object metadata')
  }
  return value as Record<string, unknown>
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function patchDocument(text: string) {
  const document = parseDocument(text, { logLevel: 'silent' })
  if (document.errors.length || !isSeq(document.contents)) {
    throw new Error('Plugin market initialization requires a valid Profile patch list')
  }
  return document
}

function hasMarketConfig(document: ReturnType<typeof patchDocument>): boolean {
  const visit = (items: unknown[]): boolean => items.some(item => {
    if (!isMap(item)) return false
    if (item.get('id') === 'plugin-market' && item.has('config')) return true
    const inserted = item.get('insert')
    return isSeq(inserted) && visit(inserted.items)
  })
  return isSeq(document.contents) && visit(document.contents.items)
}

/**
 * Seed only the normal Profile, while Harness is stopped and maintenance has
 * allowed writes. The Profile owns subsequent Settings edits and bundle switches;
 * this is not a per-launch overlay that can silently re-enable a disabled market.
 */
export async function ensurePluginMarketDefaults(dshHome: string, dshEntryPath: string): Promise<boolean> {
  const directory = join(dshHome, 'profiles', 'web')
  const manifestPath = join(directory, 'package.json')
  const source = await readIfPresent(manifestPath)
  // Capture evidence before the discovery initializer creates any files.
  const profileEntries = source === undefined ? await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  }) : undefined
  const manifest = source === undefined
    ? { name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: PROFILE_TEMPLATES.web?.bundles } } }
    : record(JSON.parse(source))
  const dsh = record(manifest.dsh)
  const desktop = record(dsh.pengbao)
  const fresh = source === undefined && profileEntries?.length === 0
  await prepareDefaultMarketIntent(dshHome, { fresh })
  if (desktop.pluginMarketInitialized === true) {
    // Intent initialization also covers profiles whose discovery was seeded by
    // an earlier Desktop build; absence alone is not permission to install.
    await prepareDefaultPluginIntent(dshHome, manifest)
    const retired = await retireLegacyImagePlugin(dshHome, manifest)
    if (JSON.stringify(retired) !== JSON.stringify(manifest)) {
      await writeTextAtomically(manifestPath, `${JSON.stringify(retired, null, 2)}\n`)
    }
    return false
  }
  const profile = record(dsh.profile)
  const bundles = profile.bundles
  if (!Array.isArray(bundles) || !bundles.every(name => typeof name === 'string')) {
    throw new Error('Plugin market initialization requires a valid Profile bundle list')
  }

  const bundleDirectory = resolveBundleDir('pengbao', PLUGIN_MARKET_BUNDLE, join(dirname(dshEntryPath), '..', 'package.json'), directory)
  loadOverlayPatches('pengbao', join(bundleDirectory, 'cordis.patch.yml'))
  const patchPath = join(directory, 'cordis.patch.yml')
  const patch = patchDocument(await readIfPresent(patchPath) ?? '[]\n')
  const homeText = await readIfPresent(join(dshHome, 'cordis.patch.yml'))
  const home = homeText === undefined ? undefined : patchDocument(homeText)
  // Any user-supplied config wins, including an explicit empty indexes array.
  const seedIndex = !hasMarketConfig(patch) && !(home && hasMarketConfig(home))
  if (seedIndex) {
    patch.add({ id: 'plugin-market', config: { indexes: [DEFAULT_PLUGIN_MARKET_INDEX] } })
    if (isSeq(patch.contents)) patch.contents.flow = false
  }
  const updated = {
    ...manifest,
    dsh: {
      ...dsh,
      pengbao: { ...desktop, pluginMarketInitialized: true },
      profile: { ...profile, bundles: bundles.includes(PLUGIN_MARKET_BUNDLE) ? bundles : [...bundles, PLUGIN_MARKET_BUNDLE] }
    }
  }
  await prepareDefaultPluginIntent(dshHome, manifest, { fresh: source === undefined && profileEntries?.length === 0 })
  if (seedIndex) await writeTextAtomically(patchPath, String(patch))
  const retired = await retireLegacyImagePlugin(dshHome, updated)
  await mkdir(directory, { recursive: true })
  // Publish the marker last. A crash after the patch write is retryable without
  // overwriting it; each replacement preserves the previous complete file.
  await writeTextAtomically(manifestPath, `${JSON.stringify(retired, null, 2)}\n`)
  return true
}
