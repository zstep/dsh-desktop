import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { composeEntries, evaluatePluginCompatibility, resolveBundleDir } from '@deepseek-ai/dsh-app-boot'
import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml'
import { parsePluginConfigurationPolicy, type PluginConfigurationPolicy } from '../../shared/private-plugin-configuration'
import { SAFE_MODE_PROFILE } from '../state/safe-mode-profile'

const MAX_BYTES = 262_144
const MAX_BINDINGS = 512
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i
const DIGEST = /^[a-f0-9]{64}$/
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const digest = (value: unknown): value is string => typeof value === 'string' && DIGEST.test(value)
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).sort().join(',') === keys.sort().join(',')
const inside = (root: string, path: string) => { const name = relative(root, path); return name !== '' && name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name) }
const dynamic = (value: unknown): boolean => Array.isArray(value) ? value.some(dynamic) : !!record(value) && (Object.hasOwn(value as object, '__jsExpr') || Object.values(value as object).some(dynamic))

/** Package roots may be pnpm/local links; files below a resolved root may not be links. */
async function read(root: string, name: string, limit = MAX_BYTES): Promise<Buffer> {
  const path = resolve(root, name)
  if (!inside(root, path)) throw new Error('Invalid policy source path')
  let current = root
  for (const part of relative(root, path).split(sep)) {
    current = join(current, part)
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Linked policy source file')
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > limit) throw new Error('Policy source too large')
    const buffer = Buffer.alloc(limit + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const after = await lstat(path)
    if (bytesRead !== before.size || bytesRead > limit || before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || await realpath(path) !== path) throw new Error('Policy source changed')
    return buffer.subarray(0, bytesRead)
  } finally { await handle.close() }
}
async function json(root: string, name: string): Promise<Record<string, unknown>> {
  const value = record(JSON.parse((await read(root, name)).toString('utf8')))
  if (!value) throw new Error('Invalid policy source')
  return value
}
async function optional(root: string, name: string): Promise<Buffer | undefined> {
  try { return await read(root, name) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}

/** Preserve Loader expressions as data for the raw config digest, never evaluate them. */
function patches(buffer: Buffer, file: string): Record<string, unknown>[] {
  const document = parseDocument(buffer.toString('utf8'), { logLevel: 'silent' })
  if (document.errors.length || !isSeq(document.contents)) throw new Error('Invalid policy patch')
  let nodes = 0
  const data = (node: unknown, depth = 0): unknown => {
    if (++nodes > 20_000 || depth > 64 || isAlias(node)) throw new Error('Unsupported policy patch')
    if (node == null) return null
    if (isScalar(node)) {
      if (node.tag === 'tag:yaml.org,2002:js') return { __jsExpr: String(node.value) }
      if (node.tag && !['tag:yaml.org,2002:str', 'tag:yaml.org,2002:int', 'tag:yaml.org,2002:float', 'tag:yaml.org,2002:bool', 'tag:yaml.org,2002:null'].includes(node.tag)) throw new Error('Unsupported policy tag')
      if (typeof node.value === 'number' && !Number.isFinite(node.value)) throw new Error('Invalid policy number')
      return node.value
    }
    if (isSeq(node)) return node.items.map(child => data(child, depth + 1))
    if (!isMap(node) || node.tag) throw new Error('Unsupported policy node')
    const result: Record<string, unknown> = {}
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(pair.key.value) || Object.hasOwn(result, pair.key.value)) throw new Error('Invalid policy key')
      result[pair.key.value] = data(pair.value, depth + 1)
    }
    return result
  }
  const rows = data(document.contents)
  if (!Array.isArray(rows) || !rows.every(record)) throw new Error('Invalid policy rows')
  const anchor = (row: Record<string, unknown>) => {
    if (typeof row.name === 'string' && (isAbsolute(row.name) || row.name.startsWith('./') || row.name.startsWith('../'))) row.name = pathToFileURL(resolve(dirname(file), row.name)).href
    if (row.group === true && Array.isArray(row.config)) for (const child of row.config) { const entry = record(child); if (!entry) throw new Error('Invalid policy group'); anchor(entry) }
  }
  for (const row of rows as Record<string, unknown>[]) {
    if (row.insert !== undefined) {
      if (!Array.isArray(row.insert) || !row.insert.every(record)) throw new Error('Invalid policy insertion')
      for (const entry of row.insert as Record<string, unknown>[]) anchor(entry)
    }
  }
  return rows as Record<string, unknown>[]
}

interface Source { root: string; manifest: Record<string, unknown> }
interface Entry { row: Record<string, unknown>; enabled: boolean }

/** Multiple physical candidates are unsupported: never guess across runtime resolution scopes. */
async function packageSource(name: string, anchors: string[]): Promise<Source | undefined> {
  const roots = new Set<string>()
  for (const anchor of anchors) {
    for (const search of createRequire(anchor).resolve.paths(name) ?? []) {
      const candidate = join(search, name)
      try {
        const root = await realpath(candidate)
        await read(root, 'package.json')
        roots.add(root)
        break
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      }
    }
  }
  if (roots.size !== 1) return undefined
  const root = [...roots][0]
  if (!root) return undefined
  const manifest = await json(root, 'package.json')
  return manifest.name === name ? { root, manifest } : undefined
}

function configuredPackageName(value: unknown, name: string, anchors: string[]): boolean {
  if (value === name) return true
  if (typeof value !== 'string' || !value.startsWith('file:')) return false
  for (const anchor of anchors) {
    try {
      if (value === pathToFileURL(createRequire(anchor).resolve(name)).href) return true
    } catch { /* Try the next authoritative resolution anchor. */ }
  }
  return false
}

async function composition(home: string, directory: string, anchor: string, overlays: readonly string[]) {
  const manifest = await json(directory, 'package.json')
  const selected = record(record(manifest.dsh)?.profile)?.bundles ?? []
  if (!Array.isArray(selected) || selected.length > MAX_BINDINGS || selected.some(name => typeof name !== 'string' || !PACKAGE.test(name)) || new Set(selected).size !== selected.length) throw new Error('Invalid profile bundles')
  const state = await optional(directory, '.dsh-market/state.json')
  const disabledState = state === undefined ? undefined : record(JSON.parse(state.toString('utf8')))
  const disabled = disabledState?.disabled ?? disabledState?.disabledSkins ?? []
  if (!Array.isArray(disabled) || disabled.length > MAX_BINDINGS || disabled.some(name => typeof name !== 'string')) throw new Error('Invalid disabled bundles')
  const layers: Record<string, unknown>[][] = []
  const anchors = [anchor, join(directory, 'package.json')]
  let totalBytes = 0
  const layer = async (root: string, name: string, required: boolean) => {
    const content = required ? await read(root, name) : await optional(root, name)
    if (!content) return []
    totalBytes += content.length
    if (totalBytes > 4 * 1024 * 1024) throw new Error('Profile composition too large')
    return patches(content, join(root, name))
  }
  for (const name of selected as string[]) {
    if (disabled.includes(name)) continue
    // The retired bundle is removed by app-boot before composition.
    if (name === '@deepseek-ai/dsh-experimental-schedule-bundle') continue
    const root = await realpath(resolveBundleDir('desktop', name, anchor, directory))
    const pkg = await json(root, 'package.json')
    if (pkg.name !== name || evaluatePluginCompatibility(pkg)) throw new Error('Unsupported profile bundle')
    const declared = record(record(pkg.dsh)?.bundle)?.patch
    const files = typeof declared === 'string' ? [declared] : declared
    if (!Array.isArray(files) || files.length > 64 || files.some(file => typeof file !== 'string' || !file)) throw new Error('Invalid bundle patches')
    anchors.push(join(root, 'package.json'))
    const rows = []
    for (const file of files as string[]) rows.push(...await layer(root, file, true))
    layers.push(rows)
  }
  const defaults: Record<string, unknown>[] = []
  const final: Record<string, unknown>[] = []
  const editable = new Map<string, string>()
  for (const [id, name] of [['imagegen', 'dsh-desktop-imagegen'], ['dsh-desktop-model-service', 'dsh-desktop-model-service']] as const) {
    try { editable.set(id, pathToFileURL(createRequire(anchor).resolve(name)).href) } catch { /* Missing installation defaults cannot grant a policy. */ }
  }
  for (const path of overlays) {
    if (!isAbsolute(path)) throw new Error('Invalid overlay path')
    const root = await realpath(dirname(path))
    for (const row of await layer(root, relative(dirname(path), path), true)) {
      if (row.id !== undefined || !Array.isArray(row.insert)) { final.push(row); continue }
      const keep = []
      for (const value of row.insert) {
        const entry = record(value)
        if (!entry) throw new Error('Invalid overlay entry')
        if (typeof entry.id === 'string' && editable.get(entry.id) === entry.name && entry.config === undefined && !entry.group) defaults.push({ insert: [entry] })
        else keep.push(entry)
      }
      final.push({ ...row, insert: keep })
    }
  }
  const user = await layer(directory, 'cordis.patch.yml', false)
  const global = await layer(home, 'cordis.patch.yml', false)
  const rows = composeEntries([...layers, defaults, user, global, final] as Parameters<typeof composeEntries>[0])
  const entries = new Map<string, Entry[]>()
  let count = 0
  const visit = (items: unknown[], parentEnabled: boolean, depth = 0) => {
    if (depth > 64) throw new Error('Profile tree too deep')
    for (const item of items) {
      const row = record(item)
      if (!row || ++count > 4096) throw new Error('Invalid profile tree')
      const enabled = parentEnabled && (row.disabled === undefined || row.disabled === false)
      if (typeof row.id === 'string') entries.set(row.id, [...entries.get(row.id) ?? [], { row, enabled }])
      if (row.group === true && Array.isArray(row.config)) visit(row.config, enabled, depth + 1)
    }
  }
  visit(rows, true)
  return { entries, anchors }
}

/** Persisted confirmation is necessary, never sufficient: recheck the current inert profile on every issue. */
export async function readPluginConfigurationPolicies(options: {
  dshHome: string
  profile: string
  hostModuleAnchor: string
  overlayPaths?: readonly string[]
  /** Fixed-vocabulary diagnostics only; never receives paths, values or user data. */
  onReject?: (reason: string, bindingId?: string) => void
}): Promise<PluginConfigurationPolicy[]> {
  // Diagnostics must never change a policy decision.
  const reject = (reason: string, bindingId?: string) => {
    try { options.onReject?.(reason, bindingId) } catch { /* Ignore diagnostic callbacks. */ }
  }
  if (options.profile === SAFE_MODE_PROFILE) return []
  let home: string
  let directory: string
  let hostModuleAnchor: string
  try {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.profile) || options.profile === 'node_modules' || !isAbsolute(options.dshHome) || !isAbsolute(options.hostModuleAnchor) || (options.overlayPaths?.length ?? 0) > 64) { reject('invalid-options'); return [] }
    home = await realpath(options.dshHome)
    hostModuleAnchor = await realpath(options.hostModuleAnchor)
    if (!(await lstat(hostModuleAnchor)).isFile()) { reject('invalid-options'); return [] }
    const profilePath = join(home, 'profiles', options.profile)
    // Never follow a redirected profile or a redirected approval store.
    if ((await lstat(join(home, 'profiles'))).isSymbolicLink() || (await lstat(profilePath)).isSymbolicLink()) { reject('unsafe-profile'); return [] }
    directory = await realpath(profilePath)
  } catch { reject('profile'); return [] }
  let stored: Record<string, unknown>
  try { stored = await json(directory, '.pengbao-plugin-configurations.json') } catch { reject('store'); return [] }
  if (!exact(stored, ['contractVersion', 'bindings']) || stored.contractVersion !== 1 || !Array.isArray(stored.bindings) || stored.bindings.length > MAX_BINDINGS) { reject('store-shape'); return [] }
  if (!stored.bindings.length) { reject('store-empty'); return [] }
  let composed: Awaited<ReturnType<typeof composition>>
  try { composed = await composition(home, directory, hostModuleAnchor, options.overlayPaths ?? []) } catch { reject('composition'); return [] }
  const { entries, anchors } = composed
  const seen = new Set<string>()
  const policies: PluginConfigurationPolicy[] = []
  const inspect = async (candidate: unknown): Promise<{ policy?: PluginConfigurationPolicy; reason?: string; duplicate?: boolean }> => {
    const binding = record(candidate)
    const identity = record(binding?.identity)
    if (!binding || !exact(binding, ['identity', 'policy', 'files', 'configDigest']) || !identity || !exact(identity, ['bindingId', 'entryId', 'namespace', 'packageName', 'packageVersion', 'revision', 'schemaDigest', 'evidenceDigest']) || typeof identity.revision !== 'number' || !Number.isSafeInteger(identity.revision) || identity.revision < 0 || !digest(identity.schemaDigest) || !digest(identity.evidenceDigest) || !digest(binding.configDigest)) return { reason: 'binding-shape' }
    let policy: PluginConfigurationPolicy
    try { policy = parsePluginConfigurationPolicy(binding.policy) } catch { return { reason: 'binding-policy' } }
    if (seen.has(policy.bindingId)) return { duplicate: true }
    seen.add(policy.bindingId)
    if (identity.bindingId !== policy.bindingId || identity.entryId !== policy.entryId || identity.namespace !== policy.entryId || identity.packageName !== policy.packageName || identity.packageVersion !== policy.packageVersion) return { reason: 'binding-identity' }
    const matches = entries.get(policy.entryId)
    if (!matches?.length) return { reason: 'entry-missing' }
    if (matches.length !== 1) return { reason: 'entry-multiple' }
    const entry = matches[0]
    if (!entry) return { reason: 'entry-missing' }
    // The runtime exposes an entry with no config layer as `{}`; binding
    // creation normalizes the same way, so compare the normalized value.
    const config = entry.row.config ?? {}
    if (!entry.enabled) return { reason: 'entry-disabled' }
    if (entry.row.group) return { reason: 'entry-group' }
    if (!configuredPackageName(entry.row.name, policy.packageName, anchors)) return { reason: 'entry-package' }
    if (dynamic(config)) return { reason: 'config-dynamic' }
    if (hash(JSON.stringify(config)) !== binding.configDigest) return { reason: 'config-digest' }
    let source: Source | undefined
    try { source = await packageSource(policy.packageName, anchors) } catch { return { reason: 'package-source' } }
    if (!source) return { reason: 'package-source' }
    if (source.manifest.version !== policy.packageVersion) return { reason: 'package-version' }
    if (evaluatePluginCompatibility(source.manifest)) return { reason: 'package-compatibility' }
    if (!Array.isArray(binding.files) || binding.files.length < 1 || binding.files.length > 12) return { reason: 'evidence-shape' }
    const files: { path: string; digest: string }[] = []
    let bytes = 0
    for (const candidateFile of binding.files) {
      const file = record(candidateFile)
      if (!file || !exact(file, ['path', 'digest']) || typeof file.path !== 'string' || !file.path || file.path.length > 512 || file.path.includes('\\') || file.path.split('/').some(part => !part || part === '.' || part === '..') || isAbsolute(file.path) || !digest(file.digest) || files.some(item => item.path === file.path) || /(^|\/)(?:node_modules|\.git|\.env[^/]*|userdata|user-data|history|sessions?|secrets?|credentials?)(\/|$)/i.test(file.path) || file.path.endsWith('.map')) return { reason: 'evidence-shape' }
      let content: Buffer
      try { content = await read(source.root, file.path, MAX_BYTES - bytes) } catch { return { reason: 'evidence-file' } }
      bytes += content.length
      if (hash(content) !== file.digest) return { reason: 'evidence-digest' }
      files.push({ path: file.path, digest: file.digest })
    }
    if (!files.some(file => file.path === 'package.json')) return { reason: 'evidence-shape' }
    if (hash(JSON.stringify({ schemaDigest: identity.schemaDigest, files })) !== identity.evidenceDigest) return { reason: 'evidence-digest' }
    return { policy }
  }
  try {
    for (const candidate of stored.bindings) {
      const binding = record(candidate)
      const identity = record(binding?.identity)
      const bindingId = typeof identity?.bindingId === 'string' ? identity.bindingId : undefined
      let outcome: Awaited<ReturnType<typeof inspect>>
      try { outcome = await inspect(candidate) } catch { reject('binding', bindingId); continue }
      if (outcome.duplicate) { reject('binding-duplicate'); return [] }
      if (outcome.reason || !outcome.policy) { reject(outcome.reason ?? 'binding', bindingId); continue }
      policies.push(outcome.policy)
    }
    return policies
  } catch { reject('reader'); return [] } // Missing, malformed or unreadable composition must never authorize inference.
}
