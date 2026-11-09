import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink, chmod } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const CONTRACT_VERSION = 1
const DEFAULT_TTL_MS = 10 * 60 * 1000
const MAX_RECORDS = 512
const MAX_WRITES = 64
const MAX_PATH = 24
const MAX_REASON = 128
const MAX_PROPOSAL_BYTES = 256 * 1024
const MAX_PROPOSAL_NODES = 8192
const SHA256 = /^[a-f0-9]{64}$/u
const SEMVER = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/u
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu
const KEY = /^[A-Za-z0-9_@.-]{1,128}$/u
const CONTROL = /[\p{C}\p{Zl}\p{Zp}]/u
const URL = /(?:[a-z][a-z0-9+.-]*:\/\/|(?:https?|ftp|file|data|javascript|mailto|blob):|\/\/)/iu
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor', '__jsExpr'])
const SEMANTICS = new Set(['endpoint', 'credential', 'chat-model', 'image-model', 'binding-id', 'label'])
const MAX_APPEND_INDEX = 256
const EXPRESSION = /\$\{/u
const CAPABILITIES = new Set(['chat.completions', 'image.generate'])
const STATUSES = new Set(['saved-active', 'saved-awaiting-restart', 'verification-failed', 'unsupported'])
const MODEL_REFS = Object.freeze({
  'chat.completions': 'pengbao-default-chat',
  'image.generate': 'pengbao-default-image'
})
const PERSISTED_REFS = Object.freeze({ endpoint: 'pengbao-endpoint', credential: 'pengbao-credential' })

class ConfigurationBindingError extends Error {
  constructor(code, message = code) {
    super(message)
    this.name = 'ConfigurationBindingError'
    this.code = code
  }
}

const fail = (code, message = code) => { throw new ConfigurationBindingError(code, message) }

function plain(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value, required, optional = []) {
  if (!plain(value)) return false
  const allowed = new Set([...required, ...optional])
  const names = Reflect.ownKeys(value)
  return required.every(name => Object.hasOwn(value, name)) && names.every(name => {
    if (typeof name !== 'string' || !allowed.has(name)) return false
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value')
  })
}

function text(value, max = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !CONTROL.test(value) && !URL.test(value)
}

function key(value) { return text(value, 128) && KEY.test(value) && !FORBIDDEN_KEYS.has(value) }

function semver(value) { return text(value, 128) && SEMVER.test(value) }

function clone(value) {
  try { return structuredClone(value) } catch { fail('INVALID_REQUEST') }
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function at(value, path) {
  let current = value
  for (const segment of path) {
    if (!plain(current) && !Array.isArray(current)) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(current, segment)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return undefined
    current = descriptor.value
  }
  return current
}

function denseArray(value) {
  return Array.isArray(value) && Reflect.ownKeys(value).length === value.length + 1 &&
    Object.keys(value).length === value.length && Object.keys(value).every((name, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name)
      return name === String(index) && Object.hasOwn(descriptor, 'value')
    })
}

function validTemplate(value, depth = 0, seen = new Set(), budget = { nodes: 0, bytes: 0 }) {
  if (++budget.nodes > MAX_PROPOSAL_NODES || depth > 32) return false
  if (typeof value === 'string') {
    budget.bytes += Buffer.byteLength(value)
    return budget.bytes <= MAX_PROPOSAL_BYTES && !URL.test(value) && !CONTROL.test(value) && !EXPRESSION.test(value)
  }
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || seen.has(value)) return false
  if (!Array.isArray(value) && !plain(value)) return false
  if (Object.hasOwn(value, '$semantic')) return exactKeys(value, ['$semantic']) && SEMANTICS.has(value.$semantic) && (budget.bytes += 16) <= MAX_PROPOSAL_BYTES
  seen.add(value)
  const names = Reflect.ownKeys(value)
  const result = Array.isArray(value)
    ? value.length <= 256 && denseArray(value) && value.every(child => validTemplate(child, depth + 1, seen, budget))
    : names.length <= 256 && names.every(name => {
      if (typeof name !== 'string' || !(key(name) || name === '$binding-id')) return false
      budget.bytes += Buffer.byteLength(name)
      if (budget.bytes > MAX_PROPOSAL_BYTES) return false
      const descriptor = Object.getOwnPropertyDescriptor(value, name)
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value') && validTemplate(descriptor.value, depth + 1, seen, budget)
    })
  seen.delete(value)
  return result
}

function boundedData(value, depth = 0, seen = new Set(), budget = { nodes: 0, bytes: 0 }) {
  if (++budget.nodes > MAX_PROPOSAL_NODES || depth > 32) return false
  if (typeof value === 'string') {
    budget.bytes += Buffer.byteLength(value)
    return value.length <= 8192 && budget.bytes <= MAX_PROPOSAL_BYTES && !CONTROL.test(value)
  }
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || seen.has(value) || (!Array.isArray(value) && !plain(value))) return false
  seen.add(value)
  const names = Reflect.ownKeys(value)
  if (names.length > MAX_PROPOSAL_NODES) { seen.delete(value); return false }
  const result = Array.isArray(value)
    ? value.length <= MAX_PROPOSAL_NODES && denseArray(value) && value.every(child => boundedData(child, depth + 1, seen, budget))
    : names.length <= 256 && names.every(name => {
      if (typeof name !== 'string' || !(key(name) || ['$binding-id', '$append', '$semantic'].includes(name))) return false
      budget.bytes += Buffer.byteLength(name)
      const descriptor = Object.getOwnPropertyDescriptor(value, name)
      return budget.bytes <= MAX_PROPOSAL_BYTES && descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value') && boundedData(descriptor.value, depth + 1, seen, budget)
    })
  seen.delete(value)
  return result
}

function loopbackEndpoint(value) {
  // Require an explicit canonical loopback authority, not URL parser aliases such
  // as 127.1, integer IPv4, credentials, backslashes or encoded hostnames.
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[1-9][0-9]{0,4})?(?:\/[^\\\s#]*)?$/u.test(value)) return false
  try {
    const parsed = new globalThis.URL(value)
    return parsed.protocol === 'http:' && !parsed.username && !parsed.password && !parsed.hash
  } catch { return false }
}

function matchesTemplate(template, value, identity, capabilities, semantics) {
  if (plain(template) && Object.hasOwn(template, '$semantic')) {
    const semantic = template.$semantic
    if (typeof value !== 'string' || value.length === 0 || value.length > 8192 || CONTROL.test(value) || EXPRESSION.test(value)) return false
    if (semantic === 'endpoint' ? !loopbackEndpoint(value) : URL.test(value)) return false
    if (semantic === 'binding-id' && value !== identity.bindingId) return false
    if (semantic === 'chat-model' && !capabilities.includes('chat.completions') || semantic === 'image-model' && !capabilities.includes('image.generate')) return false
    if (semantics.has(semantic) && semantics.get(semantic) !== value) return false
    semantics.set(semantic, value)
    return true
  }
  if (Array.isArray(template)) return denseArray(value) && value.length === template.length && template.every((child, index) => matchesTemplate(child, value[index], identity, capabilities, semantics))
  if (plain(template)) {
    if (!plain(value)) return false
    const entries = Object.entries(template)
    const names = entries.map(([name]) => name === '$binding-id' ? identity.bindingId : name)
    if (new Set(names).size !== names.length || Reflect.ownKeys(value).length !== names.length || Object.keys(value).length !== names.length) return false
    return entries.every(([, child], index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, names[index])
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value') && matchesTemplate(child, descriptor.value, identity, capabilities, semantics)
    })
  }
  return Object.is(template, value)
}

function parseIdentity(value, { namespace } = {}) {
  if (!exactKeys(value, ['bindingId', 'entryId', 'packageName', 'packageVersion', 'namespace', 'schemaDigest', 'evidenceDigest']) ||
    !key(value.bindingId) || !key(value.entryId) || !PACKAGE.test(value.packageName) || !semver(value.packageVersion) ||
    !key(value.namespace) || !SHA256.test(value.schemaDigest) || !SHA256.test(value.evidenceDigest)) fail('INVALID_IDENTITY')
  if (namespace !== undefined && value.namespace !== namespace) fail('INVALID_IDENTITY')
  return {
    bindingId: value.bindingId,
    entryId: value.entryId,
    packageName: value.packageName,
    packageVersion: value.packageVersion,
    namespace: value.namespace,
    schemaDigest: value.schemaDigest,
    evidenceDigest: value.evidenceDigest
  }
}

function parseCapabilities(value) {
  if (!denseArray(value) || value.length === 0 || value.length > 2 ||
    value.some(item => typeof item !== 'string' || !CAPABILITIES.has(item)) || new Set(value).size !== value.length) fail('UNSUPPORTED')
  return [...value]
}

function modelRefsFor(capabilities) {
  return capabilities.map(capability => MODEL_REFS[capability])
}

function pathSegment(value) {
  return key(value) || value === '$binding-id' || value === '$append'
}

function parsePaths(value, field = 'writePaths') {
  if (!Array.isArray(value) || value.length > MAX_WRITES) fail('INVALID_RECORD')
  return value.map(path => {
    if (!Array.isArray(path) || path.length === 0 || path.length > MAX_PATH ||
      path.some((item, index) => !pathSegment(item) || item === '$append' && index !== path.length - 1)) fail('INVALID_RECORD')
    return [...path]
  })
}

function parsePersistedRecord(value) {
  if (!exactKeys(value, ['contractVersion', 'identity', 'capabilities', 'modelRefs', 'refs', 'status', 'writePaths', 'revision'], ['reason'])) fail('INVALID_RECORD')
  if (value.contractVersion !== CONTRACT_VERSION || !STATUSES.has(value.status) ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    !plain(value.refs) || !exactKeys(value.refs, ['endpoint', 'credential']) ||
    value.refs.endpoint !== PERSISTED_REFS.endpoint || value.refs.credential !== PERSISTED_REFS.credential) fail('INVALID_RECORD')
  const identity = parseIdentity(value.identity)
  const capabilities = parseCapabilities(value.capabilities)
  const modelRefs = Array.isArray(value.modelRefs) ? [...value.modelRefs] : fail('INVALID_RECORD')
  const expected = modelRefsFor(capabilities)
  if (modelRefs.length !== expected.length || modelRefs.some((item, index) => item !== expected[index])) fail('INVALID_RECORD')
  const writePaths = parsePaths(value.writePaths)
  if (value.reason !== undefined && (!text(value.reason, MAX_REASON) || URL.test(value.reason))) fail('INVALID_RECORD')
  const normalized = {
    contractVersion: CONTRACT_VERSION,
    identity,
    capabilities,
    modelRefs,
    refs: { ...PERSISTED_REFS },
    status: value.status,
    writePaths,
    revision: value.revision,
    ...(value.reason === undefined ? {} : { reason: value.reason })
  }
  return freeze(normalized)
}

/** Parse and detach one persisted, non-secret binding record. Throws on any contract violation. */
export function parseConfigurationBindingRecord(value) {
  return parsePersistedRecord(value)
}

/** Validate and normalize one persisted binding record. Throws instead of accepting partial identity. */
export function validateConfigurationBindingRecord(value) {
  return parsePersistedRecord(value)
}

/** Return the host-owned logical model alias for a chat or image capability. */
export function bindingAlias(capability) {
  const normalized = capability === 'chat' ? 'chat.completions' : capability === 'image' ? 'image.generate' : capability
  if (typeof normalized !== 'string' || !Object.hasOwn(MODEL_REFS, normalized)) fail('UNSUPPORTED')
  return MODEL_REFS[normalized]
}

function parseProposal(value) {
  if (!exactKeys(value, ['contractVersion', 'protocol', 'capabilities', 'writes']) || value.contractVersion !== CONTRACT_VERSION || value.protocol !== 'openai') fail('UNSUPPORTED')
  const capabilities = parseCapabilities(value.capabilities)
  if (!denseArray(value.writes) || value.writes.length === 0 || value.writes.length > MAX_WRITES || !boundedData(value)) fail('UNSUPPORTED')
  const paths = []
  const writes = value.writes.map(write => {
    if (!exactKeys(write, ['path', 'value', 'evidenceIds']) || !denseArray(write.path) || write.path.length === 0 || write.path.length > MAX_PATH ||
      write.path.some((item, index) => !pathSegment(item) || item === '$append' && index !== write.path.length - 1) || !denseArray(write.evidenceIds) || write.evidenceIds.length === 0 || write.evidenceIds.length > 12 ||
      write.evidenceIds.some(item => !/^e[1-9][0-9]*$/u.test(item)) || new Set(write.evidenceIds).size !== write.evidenceIds.length ||
      paths.some(previous => previous.length <= write.path.length && previous.every((item, index) => item === write.path[index]) ||
        write.path.length <= previous.length && write.path.every((item, index) => item === previous[index])) || !validTemplate(write.value)) fail('UNSUPPORTED')
    paths.push([...write.path])
    return { path: [...write.path], value: clone(write.value), evidenceIds: [...write.evidenceIds] }
  })
  return { contractVersion: CONTRACT_VERSION, protocol: 'openai', capabilities, writes }
}

function pathsOverlap(left, right) {
  return left.slice(0, Math.min(left.length, right.length)).every((segment, index) => segment === right[index])
}

function appendMatches(path, current) {
  const index = path.at(-1)
  let parent = current
  for (const segment of path.slice(0, -1)) {
    if (!plain(parent) && !Array.isArray(parent)) return false
    const descriptor = Object.getOwnPropertyDescriptor(parent, segment)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false
    parent = descriptor.value
  }
  return /^(?:0|[1-9][0-9]*)$/u.test(index) && Number(index) <= MAX_APPEND_INDEX && Array.isArray(parent) && Number(index) === parent.length
}

function parseMaterializedWrites(value, proposal, identity, current, hasCurrent) {
  const hasAppend = proposal.writes.some(write => write.path.at(-1) === '$append')
  if (hasAppend && !hasCurrent) fail('UNSUPPORTED')
  if (!denseArray(value) || value.length !== proposal.writes.length) fail('UNSUPPORTED')
  const semantics = new Map()
  const paths = []
  return value.map((write, index) => {
    const expected = proposal.writes[index]
    if (!exactKeys(write, ['path', 'value']) || !denseArray(write.path) || write.path.length !== expected.path.length ||
      write.path.some((item, position) => !key(item) || (expected.path[position] === '$binding-id' ? item !== identity.bindingId
        : expected.path[position] === '$append' ? !appendMatches(write.path, current) : item !== expected.path[position])) ||
      paths.some(previous => pathsOverlap(previous, write.path)) ||
      !matchesTemplate(expected.value, write.value, identity, proposal.capabilities, semantics)) fail('UNSUPPORTED')
    paths.push([...write.path])
    return { path: [...write.path], value: clone(write.value) }
  })
}

function planIdentity(value, namespace) {
  const identity = parseIdentity(value, { namespace })
  if (!text(namespace, 256) || !key(namespace)) fail('INVALID_IDENTITY')
  return identity
}

function publicPlan(data) {
  return freeze({
    contractVersion: CONTRACT_VERSION,
    id: data.id,
    identity: clone(data.identity),
    namespace: data.namespace,
    revision: data.revision,
    capabilities: [...data.proposal.capabilities],
    modelRefs: modelRefsFor(data.proposal.capabilities),
    writePaths: data.proposal.writes.map(write => [...write.path]),
    expiresAt: data.expiresAt
  })
}

function descriptorFor(descriptors, namespace) {
  if (!Array.isArray(descriptors)) fail('UNSUPPORTED')
  return descriptors.find(item => plain(item) && item.ns === namespace)
}

function userLayer(descriptor) {
  return Object.hasOwn(descriptor ?? {}, 'user') && plain(descriptor.user) ? descriptor.user : undefined
}

function matchesReadback(actual, expected, descriptor, path, allowRedacted) {
  if (Object.is(actual, expected)) return true
  if (allowRedacted && actual === undefined && (expected === null || typeof expected !== 'object') && Array.isArray(descriptor?.secrets)) {
    const markers = descriptor.secrets.filter(secret => Array.isArray(secret?.path) && secret.path.length === path.length && secret.path.every((segment, index) => segment === path[index]))
    if (markers.length === 1) {
      const secret = markers[0]
      const nonempty = typeof expected === 'string' ? expected.trim() !== '' : expected !== undefined && expected !== null
      if (secret.set === true && (secret.nonempty === undefined || secret.nonempty === nonempty)) return true
    }
  }
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length &&
    expected.every((child, index) => matchesReadback(actual[index], child, descriptor, [...path, String(index)], allowRedacted))
  if (!plain(expected) || !plain(actual) || Object.keys(actual).some(name => !Object.hasOwn(expected, name))) return false
  return Object.entries(expected).every(([name, child]) => matchesReadback(Object.hasOwn(actual, name) ? actual[name] : undefined, child, descriptor, [...path, name], allowRedacted))
}

function verifyWrites(descriptor, writes) {
  const user = userLayer(descriptor)
  const userAvailable = user !== undefined
  const readback = userAvailable ? user : descriptor?.value
  const userMatches = writes.every(write => matchesReadback(at(readback, write.path), write.value, descriptor, write.path, userAvailable))
  // Effective redaction cannot prove that a newly written secret is active.
  const effectiveMatches = writes.every(write => matchesReadback(at(descriptor?.value, write.path), write.value, descriptor, write.path, false))
  return { userAvailable, userMatches, effectiveMatches }
}

function previousUserState(descriptor, writes) {
  const user = userLayer(descriptor)
  const undo = []
  for (const write of writes) {
    // Composite writes replace every nested leaf. A redacted prior secret cannot
    // be reconstructed, including an explicitly set empty secret or a secret
    // ancestor of the write. Never manufacture an incomplete rollback receipt.
    if (Array.isArray(descriptor?.secrets) && descriptor.secrets.some(secret =>
      Array.isArray(secret?.path) && (secret.set === true || secret.nonempty === true) && pathsOverlap(secret.path, write.path) && at(user, secret.path) === undefined)) fail('ROLLBACK_UNAVAILABLE')
    const before = user ? at(user, write.path) : undefined
    undo.push(before === undefined ? { op: 'unset', path: [...write.path] } : { op: 'set', path: [...write.path], value: clone(before) })
  }
  return undo
}

function verifyUndo(descriptor, undo) {
  const user = userLayer(descriptor)
  const layer = user === undefined ? descriptor.value : user
  return undo.every(item => {
    if (Array.isArray(descriptor?.secrets) && descriptor.secrets.some(secret => secret?.set === true && Array.isArray(secret.path) &&
      pathsOverlap(secret.path, item.path) && (item.op === 'unset' || at(item.value, secret.path.slice(item.path.length)) === undefined))) return false
    return item.op === 'unset' ? at(layer, item.path) === undefined : matchesReadback(at(layer, item.path), item.value, descriptor, item.path, true)
  })
}

function safeReason(code) {
  return code === 'settings-not-writable' || code === 'proposal-unsupported' || code === 'binding-conflict' ? code : undefined
}

function persistedRecord(data, status, revision, reason) {
  const record = {
    contractVersion: CONTRACT_VERSION,
    identity: clone(data.identity),
    capabilities: [...data.proposal.capabilities],
    modelRefs: modelRefsFor(data.proposal.capabilities),
    refs: { ...PERSISTED_REFS },
    status,
    writePaths: data.proposal.writes.map(write => [...write.path]),
    revision
  }
  const safe = safeReason(reason)
  if (safe) record.reason = safe
  return parsePersistedRecord(record)
}

function validatePlanInput(input) {
  if (!exactKeys(input, ['identity', 'namespace', 'revision', 'proposal', 'materializedWrites'], ['current']) ||
    !Number.isSafeInteger(input.revision) || input.revision < 0 || !text(input.namespace)) fail('INVALID_REQUEST')
  const identity = planIdentity(input.identity, input.namespace)
  const proposal = parseProposal(input.proposal)
  if (proposal.capabilities.length !== identityCapabilities(proposal, input.identity).length) fail('UNSUPPORTED')
  if (proposal.capabilities.some(capability => !identityCapabilities(proposal, input.identity).includes(capability))) fail('UNSUPPORTED')
  const materializedWrites = parseMaterializedWrites(input.materializedWrites, proposal, identity, input.current, Object.hasOwn(input, 'current'))
  return { identity, namespace: input.namespace, revision: input.revision, proposal, materializedWrites }
}

function identityCapabilities(proposal, identity) {
  // The identity is deliberately not allowed to carry a second, mutable capability list.
  // Proposal capabilities are the sole source used to derive persisted model refs.
  return proposal.capabilities
}

async function callDescribe(settings) {
  if (!settings || typeof settings.describe !== 'function') fail('UNSUPPORTED')
  const result = await settings.describe({ redactSecrets: true })
  if (!Array.isArray(result)) fail('UNSUPPORTED')
  return result
}

function callMutate(settings, namespace, writes, revision) {
  if (!settings || typeof settings.mutate !== 'function' || settings.writable === false) fail('UNSUPPORTED')
  return settings.mutate(namespace, writes.map(write => ({ op: 'set', path: [...write.path], value: clone(write.value) })), revision)
}

/**
 * Create a host-owned registry. Plans and rollback receipts are process-local;
 * only redacted identity, aliases, markers, paths and status are persisted.
 */
export function createConfigurationBindingRegistry({ profileDir, ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!text(profileDir, 4096)) fail('INVALID_REQUEST')
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 24 * 60 * 60 * 1000) fail('INVALID_REQUEST')
  const filePath = resolve(profileDir, '.pengbao-model-bindings.json')
  const state = {
    loaded: false,
    records: new Map(),
    plans: new Map(),
    receipts: new Map(),
    queue: Promise.resolve(),
    disposed: false
  }

  async function ensureLoaded() {
    if (state.disposed) fail('UNAVAILABLE')
    if (state.loaded) return
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'))
      if (!exactKeys(parsed, ['contractVersion', 'bindings']) || parsed.contractVersion !== CONTRACT_VERSION || !Array.isArray(parsed.bindings) || parsed.bindings.length > MAX_RECORDS) fail('INVALID_RECORD')
      for (const item of parsed.bindings) {
        const record = parsePersistedRecord(item)
        if (state.records.has(record.identity.bindingId)) fail('INVALID_RECORD')
        state.records.set(record.identity.bindingId, record)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (error instanceof ConfigurationBindingError) throw error
        fail('INVALID_RECORD')
      }
    }
    state.loaded = true
  }

  async function persist() {
    const bindings = [...state.records.values()].map(item => parsePersistedRecord(item))
    const body = JSON.stringify({ contractVersion: CONTRACT_VERSION, bindings }, null, 2) + '\n'
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
    let handle
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(body, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(temporary, filePath)
      await chmod(filePath, 0o600)
    } catch (error) {
      if (handle) await handle.close().catch(() => {})
      await unlink(temporary).catch(() => {})
      throw error
    }
  }

  function serial(work) {
    const next = state.queue.then(work)
    state.queue = next.catch(() => {})
    return next
  }

  function expire(map) {
    const now = Date.now()
    for (const [id, value] of map) if (value.expiresAt <= now) map.delete(id)
  }

  function plan(input) {
    if (state.disposed) fail('UNAVAILABLE')
    const parsed = validatePlanInput(input)
    expire(state.plans)
    state.plans.clear()
    const id = randomUUID()
    const data = {
      ...parsed,
      id,
      expiresAt: Date.now() + ttlMs
    }
    state.plans.set(id, data)
    return publicPlan(data)
  }

  function getPlan(value) {
    const id = typeof value === 'string' ? value : value?.id
    if (typeof id !== 'string') fail('INVALID_REQUEST')
    const data = state.plans.get(id)
    if (!data || data.expiresAt <= Date.now()) {
      state.plans.delete(id)
      fail('PLAN_EXPIRED')
    }
    return data
  }

  async function apply(input, { settings } = {}) {
    return serial(async () => {
      if (state.disposed) fail('UNAVAILABLE')
      await ensureLoaded()
      const data = getPlan(input)
      state.plans.delete(data.id)
      const before = descriptorFor(await callDescribe(settings), data.namespace)
      if (!before || before.revision !== data.revision) fail('CONFLICT')
      if (data.proposal.writes.some((write, index) => write.path.at(-1) === '$append' && !appendMatches(data.materializedWrites[index].path, before.value))) fail('CONFLICT')
      let undo
      try { undo = previousUserState(before, data.materializedWrites) } catch (error) { if (error instanceof ConfigurationBindingError) throw error; throw error }

      if (!settings || typeof settings.mutate !== 'function' || settings.writable === false) {
        const record = persistedRecord(data, 'unsupported', data.revision, 'settings-not-writable')
        state.records.set(record.identity.bindingId, record)
        await persist()
        return { status: 'unsupported', record: clone(record) }
      }

      try {
        await callMutate(settings, data.namespace, data.materializedWrites, data.revision)
      } catch (error) {
        const code = error?.code === 'SETTINGS_CONFLICT' || error?.code === 'CONFLICT' ? 'CONFLICT' : 'FAILED'
        fail(code)
      }
      const after = descriptorFor(await callDescribe(settings), data.namespace)
      if (!after || !Number.isSafeInteger(after.revision)) {
        const record = persistedRecord(data, 'verification-failed', data.revision, 'verification-failed')
        state.records.set(record.identity.bindingId, record)
        await persist()
        return { status: 'verification-failed', record: clone(record) }
      }
      const verified = verifyWrites(after, data.materializedWrites)
      const status = !verified.userMatches ? 'verification-failed' : verified.effectiveMatches ? 'saved-active' : 'saved-awaiting-restart'
      const record = persistedRecord(data, status, after.revision, status === 'verification-failed' ? 'verification-failed' : undefined)
      state.records.set(record.identity.bindingId, record)
      await persist()
      if (status === 'verification-failed') return { status, record: clone(record) }
      const receiptId = randomUUID()
      state.receipts.set(receiptId, {
        receiptId,
        identity: data.identity,
        namespace: data.namespace,
        revision: after.revision,
        writes: data.materializedWrites.map(write => ({ path: [...write.path], value: clone(write.value) })),
        undo,
        expiresAt: Date.now() + ttlMs
      })
      return { status, record: clone(record), revision: after.revision, receiptId }
    })
  }

  function getReceipt(value) {
    const id = typeof value === 'string' ? value : value?.receiptId
    if (typeof id !== 'string') fail('INVALID_REQUEST')
    expire(state.receipts)
    const receipt = state.receipts.get(id)
    if (!receipt) fail('PLAN_EXPIRED')
    return receipt
  }

  async function rollback(input, { settings } = {}) {
    return serial(async () => {
      if (state.disposed) fail('UNAVAILABLE')
      await ensureLoaded()
      const receipt = getReceipt(input)
      const current = descriptorFor(await callDescribe(settings), receipt.namespace)
      if (!current || current.revision !== receipt.revision) fail('CONFLICT')
      const guarded = verifyWrites(current, receipt.writes)
      if (!guarded.userMatches && guarded.userAvailable) fail('CONFLICT')
      if (!guarded.userMatches && !guarded.effectiveMatches) fail('CONFLICT')
      if (!settings || typeof settings.mutate !== 'function' || settings.writable === false) fail('UNSUPPORTED')
      try {
        await settings.mutate(receipt.namespace, receipt.undo.map(operation => ({ ...operation, path: [...operation.path], ...(operation.value === undefined ? {} : { value: clone(operation.value) }) })), receipt.revision)
      } catch (error) {
        const code = error?.code === 'SETTINGS_CONFLICT' || error?.code === 'CONFLICT' ? 'CONFLICT' : 'FAILED'
        fail(code)
      }
      const after = descriptorFor(await callDescribe(settings), receipt.namespace)
      if (!after || !verifyUndo(after, receipt.undo)) return { status: 'verification-failed', receiptId: receipt.receiptId }
      state.receipts.delete(receipt.receiptId)
      if (state.records.get(receipt.identity.bindingId)?.identity.evidenceDigest === receipt.identity.evidenceDigest) {
        state.records.delete(receipt.identity.bindingId)
        await persist()
      }
      return { status: 'rolled-back', receiptId: receipt.receiptId }
    })
  }

  return Object.freeze({
    /** Read all persisted redacted records. */
    async describe() {
      await ensureLoaded()
      return freeze([...state.records.values()].map(record => clone(record)))
    },
    /** Read one persisted record by its strict host binding id. */
    async read(bindingId) {
      await ensureLoaded()
      if (!key(bindingId)) fail('INVALID_REQUEST')
      const record = state.records.get(bindingId)
      return record ? clone(record) : undefined
    },
    plan,
    apply,
    rollback,
    dispose() {
      state.disposed = true
      state.plans.clear()
      state.receipts.clear()
      state.records.clear()
    }
  })
}
