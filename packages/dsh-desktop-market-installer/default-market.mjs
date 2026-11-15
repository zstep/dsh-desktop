import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isMap, isSeq, parseDocument } from 'yaml'

export const DEFAULT_MARKET_VERSION = '1.66.47'
export const MARKET_PACKAGE = 'dshmarket'
const STATE_FILE = 'desktop-default-market.json'
const MARKET_ID = 'plugin-market'

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

export async function readDefaultMarketIntent(directory) {
  const source = await optional(join(directory, STATE_FILE))
  if (source === undefined) return undefined
  const state = JSON.parse(source)
  if (state?.version !== 1 || !['pending', 'completed', 'adopted', 'skipped'].includes(state.status) ||
    state.versionSpec !== DEFAULT_MARKET_VERSION) throw new Error('Unsupported default market intent; preserving it for recovery')
  return state
}

function marketConfigState(text) {
  const document = parseDocument(text ?? '[]\n', { logLevel: 'silent' })
  if (document.errors.length || !isSeq(document.contents)) throw new Error('Default market requires a valid Profile patch list')
  let state = 'none'
  const visit = list => {
    for (const item of list) {
      if (!isMap(item)) continue
      if (item.get('id') === MARKET_ID && item.has('config')) {
        const config = item.get('config')
        const indexes = isMap(config) ? config.get('indexes') : undefined
        state = isSeq(indexes) && indexes.items.length === 0 ? 'empty' : 'custom'
      }
      const inserted = item.get('insert')
      if (isSeq(inserted)) visit(inserted.items)
    }
  }
  visit(document.contents.items)
  return state
}

async function marketDisabled(directory, home) {
  try {
    const state = JSON.parse(await optional(join(directory, '.dsh-market', 'state.json')) ?? '{}')
    if (Array.isArray(state.disabled) && state.disabled.includes(MARKET_PACKAGE)) return true
  } catch { /* An unreadable market state must not force a default install. */ }
  try {
    const host = JSON.parse(await optional(join(home, 'desktop-host-plugins.json')) ?? '{}')
    if (Array.isArray(host.disabled) && host.disabled.includes(MARKET_PACKAGE)) return true
  } catch { /* Leave the default pending instead of treating the file as consent. */ }
  return false
}

async function declaredManifest(directory) {
  const source = await optional(join(directory, 'package.json'))
  return source === undefined ? {} : JSON.parse(source)
}

export async function prepareDefaultMarketIntent(home, options = {}) {
  const directory = join(home, 'profiles', 'web')
  const previous = await readDefaultMarketIntent(directory)
  if (previous) return previous
  const manifest = await declaredManifest(directory)
  const patchState = marketConfigState(await optional(join(directory, 'cordis.patch.yml')))
  const homeState = marketConfigState(await optional(join(home, 'cordis.patch.yml')))
  const disabled = await marketDisabled(directory, home)
  const installed = manifest.dependencies?.[MARKET_PACKAGE] !== undefined || manifest.dsh?.profile?.bundles?.includes(MARKET_PACKAGE)
  const status = options.removed || disabled ? 'skipped' : installed ? 'adopted' : patchState === 'empty' || homeState === 'empty' ? 'skipped' : 'pending'
  const state = { version: 1, status, versionSpec: DEFAULT_MARKET_VERSION,
    ...(status === 'pending' ? { reason: options.fresh ? 'fresh-profile' : 'default-migration' } :
      status === 'skipped' ? { reason: options.removed ? 'user-removed' : disabled ? 'disabled' : 'user-configured-indexes' } : {}) }
  await save(directory, state)
  return state
}

export async function markDefaultMarketInstalled(directory, application = 'restart-required') {
  const previous = await readDefaultMarketIntent(directory)
  const state = { version: 1, status: 'completed', versionSpec: DEFAULT_MARKET_VERSION, application,
    ...(previous?.reason === undefined ? {} : { reason: previous.reason }) }
  await save(directory, state)
  return state
}

export async function markDefaultMarketRemoved(directory) {
  const state = { version: 1, status: 'skipped', versionSpec: DEFAULT_MARKET_VERSION, reason: 'user-removed' }
  await save(directory, state)
  return state
}
