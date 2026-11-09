import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isMap, isSeq, parseDocument } from 'yaml'
import { readMarketState } from './plugin-state.mjs'

export const DEFAULT_IMAGE_PLUGIN = '@dickpy/dsh-imagegen'
export const LEGACY_IMAGE_PLUGIN = 'dsh-desktop-imagegen'
const STATE_FILE = 'desktop-default-plugins.json'
const ALIASES = [DEFAULT_IMAGE_PLUGIN, LEGACY_IMAGE_PLUGIN, 'imagegen']
const TERMINAL = new Set(['completed', 'adopted', 'skipped'])

async function optional(path) {
  try { return await readFile(path, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}
async function save(directory, value) {
  await mkdir(directory, { recursive: true })
  const target = join(directory, STATE_FILE)
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, target)
  } finally { await rm(temporary, { force: true }) }
}
export async function readDefaultPluginIntent(directory) {
  const source = await optional(join(directory, STATE_FILE))
  if (source === undefined) return undefined
  const state = JSON.parse(source)
  if (state?.version !== 1 || !state.imagegen || !['pending', ...TERMINAL].includes(state.imagegen.status)) {
    throw new Error('Unsupported default plugin intent; preserving it for recovery')
  }
  return state
}
function patch(text) {
  const document = parseDocument(text ?? '[]\n', { logLevel: 'silent' })
  if (document.errors.length || !isSeq(document.contents)) throw new Error('Default plugins require a valid Profile patch list')
  return document
}
function rows(document) {
  const all = []
  const visit = list => {
    for (const row of list) {
      if (!isMap(row)) continue
      all.push(row)
      const insert = row.get('insert')
      if (isSeq(insert)) visit(insert.items)
    }
  }
  visit(document.contents.items)
  return all
}
async function choices(home, directory) {
  const hostSource = await optional(join(home, 'desktop-host-plugins.json'))
  const host = hostSource === undefined ? { version: 1, disabled: [] } : JSON.parse(hostSource)
  if (host?.version !== 1 || !Array.isArray(host.disabled) || !host.disabled.every(name => typeof name === 'string')) {
    throw new Error('Invalid host plugin preferences; refusing default install')
  }
  const market = await readMarketState(directory)
  const documents = await Promise.all([join(directory, 'cordis.patch.yml'), join(home, 'cordis.patch.yml')].map(async path => patch(await optional(path))))
  const all = documents.flatMap(rows)
  return {
    disabled: [...host.disabled, ...market.disabled].some(name => ALIASES.includes(name)) || all.some(row =>
      ALIASES.includes(row.get('id')) && row.has('disabled') && row.get('disabled') !== false),
    legacy: all.some(row => row.get('name') === LEGACY_IMAGE_PLUGIN),
    legacyDisabled: all.some(row => row.get('name') === LEGACY_IMAGE_PLUGIN && row.has('disabled') && row.get('disabled') !== false)
  }
}

/** Persist the once-only intent before discovery creates its first manifest.
 * Existing absent profiles are deliberately not evidence of a fresh profile.
 * This file is not generation desired state: completed/adopted survives uninstall.
 */
export async function prepareDefaultPluginIntent(home, manifest, { fresh = false } = {}) {
  const directory = join(home, 'profiles', 'web')
  const previous = await readDefaultPluginIntent(directory)
  if (previous) return previous
  const decision = await choices(home, directory)
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const installed = bundles.includes(DEFAULT_IMAGE_PLUGIN) || Object.hasOwn(manifest.dependencies ?? {}, DEFAULT_IMAGE_PLUGIN)
  const legacy = bundles.includes(LEGACY_IMAGE_PLUGIN) || decision.legacy
  const legacyEnabled = legacy && !decision.disabled && !decision.legacyDisabled
  const imagegen = decision.disabled || decision.legacyDisabled ? { status: 'skipped', reason: 'disabled' }
    : installed ? { status: 'adopted' }
      : fresh || legacyEnabled ? { status: 'pending', reason: legacy ? 'legacy-wrapper' : 'fresh-profile' }
        : { status: 'skipped', reason: 'existing-profile-without-install-evidence' }
  const state = { version: 1, imagegen }
  await save(directory, state)
  return state
}

/** Remove only retired wrapper declarations, retaining imagegen's Loader ID,
 * configuration and data directory. Disabled wrappers remain opted out via intent.
 * The caller publishes the returned manifest after persisting the intent.
 */
export async function retireLegacyImagePlugin(home, manifest) {
  const directory = join(home, 'profiles', 'web')
  for (const path of [join(directory, 'cordis.patch.yml'), join(home, 'cordis.patch.yml')]) {
    const source = await optional(path)
    if (source === undefined) continue
    const document = patch(source)
    let changed = false
    const visit = list => {
      for (let index = list.length - 1; index >= 0; index--) {
        const row = list[index]
        if (!isMap(row)) continue
        if (row.get('name') === LEGACY_IMAGE_PLUGIN) {
          list.splice(index, 1)
          changed = true
          continue
        }
        const insert = row.get('insert')
        if (isSeq(insert)) visit(insert.items)
      }
    }
    visit(document.contents.items)
    if (changed) {
      const temporary = `${path}.${randomUUID()}.tmp`
      try { await writeFile(temporary, String(document)); await rename(temporary, path) }
      finally { await rm(temporary, { force: true }) }
    }
  }
  if (!Object.hasOwn(manifest.dependencies ?? {}, LEGACY_IMAGE_PLUGIN) && !manifest.dsh?.profile?.bundles?.includes(LEGACY_IMAGE_PLUGIN)) return manifest
  const dependencies = { ...manifest.dependencies }
  delete dependencies[LEGACY_IMAGE_PLUGIN]
  return {
    ...manifest,
    dependencies,
    dsh: { ...manifest.dsh, profile: {
      ...manifest.dsh?.profile,
      bundles: (manifest.dsh?.profile?.bundles ?? []).filter(name => name !== LEGACY_IMAGE_PLUGIN)
    } }
  }
}

/** Consume pending intent through normal market + plugin-manager services.
 * Called in a background lifecycle effect, never awaited by desktop startup.
 * Failures stay pending for a later launch; no unpinned/latest installs occur.
 */
export async function provisionDefaultPlugins({ home, pluginMarket, pluginManager, signal, report = () => {} }) {
  const directory = join(home, 'profiles', 'web')
  const state = await readDefaultPluginIntent(directory)
  if (!state || TERMINAL.has(state.imagegen.status) || signal?.aborted) return state
  const persist = async imagegen => {
    const next = { ...state, imagegen }
    await save(directory, next)
    return next
  }
  const decision = await choices(home, directory)
  if (decision.disabled) return persist({ status: 'skipped', reason: 'disabled' })
  const bundles = await pluginManager.listBundles()
  if (bundles.some(bundle => bundle.name === DEFAULT_IMAGE_PLUGIN && bundle.installed)) return persist({ status: 'adopted' })
  const indexes = pluginMarket.listIndexes()
  for (const index of indexes) {
    if (signal?.aborted) return state
    if (index.error) continue
    try {
      const entry = await pluginMarket.entry(index.url, DEFAULT_IMAGE_PLUGIN)
      const selected = entry?.versions.find(version => version.version === entry.defaultVersion && version.compatibility.compatible)
      if (!selected) continue
      // Recheck preferences after the asynchronous market read, before mutation.
      if ((await choices(home, directory)).disabled) return persist({ status: 'skipped', reason: 'disabled' })
      if (signal?.aborted) return state
      const requestId = randomUUID()
      const cancel = () => { void Promise.resolve(pluginManager.cancelInstall(requestId)).catch(report) }
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        const result = await pluginManager.installBundle(selected.install.spec, {
          ...selected.install,
          expectedName: DEFAULT_IMAGE_PLUGIN,
          expectedVersion: selected.version,
          enabled: true,
          saveExact: true,
          requestId
        })
        if (result.application === 'failed' || result.application === 'cancelled') {
          report(new Error(`Default plugin install ${result.application}: ${result.error?.code ?? 'see plugin manager diagnostics'}`))
          return state
        }
        // A restart-required result means persisted install/publication, not live activation.
        return persist({ status: 'completed', version: selected.version, application: result.application })
      } finally { signal?.removeEventListener('abort', cancel) }
    } catch (error) { report(error) }
  }
  return state
}
