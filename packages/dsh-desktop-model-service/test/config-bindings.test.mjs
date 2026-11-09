import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConfigurationBindingRegistry, parseConfigurationBindingRecord } from '../config-bindings.js'

const identity = {
  bindingId: 'host-binding', entryId: 'provider', packageName: 'fixture-provider', packageVersion: '1.2.3',
  namespace: 'provider', schemaDigest: 'a'.repeat(64), evidenceDigest: 'b'.repeat(64)
}
const semantic = name => ({ $semantic: name })
const write = (path, value) => ({ path, value, evidenceIds: ['e1'] })
const proposal = writes => ({ contractVersion: 1, protocol: 'openai', capabilities: ['chat.completions'], writes })
const input = (writes, materializedWrites, extra = {}) => ({ identity, namespace: 'provider', revision: 1, proposal: proposal(writes), materializedWrites, ...extra })
const unsupported = action => assert.throws(action, { code: 'UNSUPPORTED' })

async function fixture(t) {
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-config-bindings-'))
  const registry = createConfigurationBindingRegistry({ profileDir })
  t.after(async () => { registry.dispose(); await rm(profileDir, { recursive: true, force: true }) })
  return { registry, profileDir }
}

function settingsFixture(initial = {}) {
  let user = structuredClone(initial)
  let revision = 1
  let mutations = 0
  let rewrite = value => value
  const descriptions = () => {
    const secrets = []
    const redact = (value, path = []) => {
      if (path.at(-1) === 'token') {
        secrets.push({ path, set: value !== undefined, nonempty: typeof value === 'string' && value.trim() !== '' })
        return undefined
      }
      if (Array.isArray(value)) return value.map((child, index) => redact(child, [...path, String(index)]))
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).flatMap(([name, child]) => {
        const redacted = redact(child, [...path, name])
        return redacted === undefined ? [] : [[name, redacted]]
      }))
      return value
    }
    const redacted = redact(user)
    return [rewrite({ ns: 'provider', revision, user: structuredClone(redacted), value: redacted, secrets })]
  }
  const settings = {
    describe: descriptions,
    mutate(namespace, operations, expectedRevision) {
      assert.equal(namespace, 'provider')
      assert.equal(expectedRevision, revision)
      mutations++
      for (const operation of operations) {
        let parent = user
        for (const name of operation.path.slice(0, -1)) parent = parent[name] ??= {}
        if (operation.op === 'unset') delete parent[operation.path.at(-1)]
        else parent[operation.path.at(-1)] = structuredClone(operation.value)
      }
      revision++
    }
  }
  return { settings, get mutations() { return mutations }, get user() { return user }, rewrite(fn) { rewrite = fn } }
}

test('accepts exact semantics, nested binding keys and literal structures; persists no host values', async t => {
  const { registry, profileDir } = await fixture(t)
  const template = { '$binding-id': { endpoint: semantic('endpoint'), token: semantic('credential'), model: semantic('chat-model'), id: semantic('binding-id'), label: semantic('label'), enabled: true, options: [null, 7, 'openai'] } }
  const value = { 'host-binding': { endpoint: 'http://127.0.0.1:8123/v1', token: 'host-secret', model: 'host-chat', id: 'host-binding', label: 'Pengbao', enabled: true, options: [null, 7, 'openai'] } }
  const plan = registry.plan(input([write(['providers'], template)], [{ path: ['providers'], value }]))
  const host = settingsFixture()
  const result = await registry.apply(plan, { settings: host.settings })
  assert.equal(result.status, 'saved-awaiting-restart')
  assert.ok(result.receiptId)
  assert.deepEqual(parseConfigurationBindingRecord(result.record), result.record)
  const persisted = await readFile(join(profileDir, '.pengbao-model-bindings.json'), 'utf8')
  for (const sensitive of ['host-secret', 'host-chat', '127.0.0.1', '$semantic']) assert.equal(persisted.includes(sensitive), false)
  assert.equal((await registry.rollback({ receiptId: result.receiptId }, { settings: host.settings })).status, 'rolled-back')
  assert.deepEqual(host.user, {})
})

test('rejects malformed semantics, expression/prototype keys and executable strings', async t => {
  const { registry } = await fixture(t)
  const bad = [
    { $semantic: 'unknown' }, { $semantic: 'credential', extra: true }, { $semantic: 42 },
    { __jsExpr: 'process.exit()' }, { nested: { __jsExpr: 'secret' } },
    JSON.parse('{"__proto__":{"polluted":true}}'), { constructor: {} }, { prototype: {} },
    { '$append': 'not-an-object-key' }, '${process.env.TOKEN}', { nested: '${unsafe}' },
    'https://remote.invalid/v1', 'ftp://remote.invalid/file'
  ]
  for (const value of bad) unsupported(() => registry.plan(input([write(['config'], value)], [{ path: ['config'], value }])))
  for (const path of [['__jsExpr'], ['config', 'constructor'], ['config', '$append', 'tail']]) {
    unsupported(() => registry.plan(input([write(path, true)], [{ path, value: true }])))
  }
})

test('bounds JSON templates and rejects accessor-backed input before cloning', async t => {
  const { registry } = await fixture(t)
  const oversized = 'x'.repeat(256 * 1024 + 1)
  unsupported(() => registry.plan(input([write(['config'], { label: oversized })], [{ path: ['config'], value: { label: oversized } }])))

  const accessorTemplate = {}
  Object.defineProperty(accessorTemplate, 'label', { enumerable: true, get() { throw new Error('must not run') } })
  unsupported(() => registry.plan(input([write(['config'], accessorTemplate)], [{ path: ['config'], value: {} }])))
})

test('materialized data must match every proposal literal, structure and host semantic string', async t => {
  const { registry } = await fixture(t)
  const template = { enabled: true, mode: 'openai', count: 2, list: [semantic('label')], nested: { token: semantic('credential') } }
  const valid = { enabled: true, mode: 'openai', count: 2, list: ['Pengbao'], nested: { token: 'host-secret' } }
  registry.plan(input([write(['config'], template)], [{ path: ['config'], value: valid }]))
  const invalid = [
    { ...valid, enabled: false }, { ...valid, mode: 'other' }, { ...valid, count: 3 },
    { ...valid, extra: true }, { ...valid, nested: {} }, { ...valid, list: ['Pengbao', 'extra'] },
    { ...valid, nested: { token: 123 } }, { ...valid, nested: { token: { __jsExpr: 'x' } } },
    { ...valid, nested: { token: 'https://remote.invalid' } }, { ...valid, nested: { token: '${secret}' } }
  ]
  for (const value of invalid) unsupported(() => registry.plan(input([write(['config'], template)], [{ path: ['config'], value }])))
  unsupported(() => registry.plan(input([write(['id'], semantic('binding-id'))], [{ path: ['id'], value: 'another-binding' }])))
  unsupported(() => registry.plan(input([write(['image'], semantic('image-model'))], [{ path: ['image'], value: 'image-model' }])))
  unsupported(() => registry.plan(input([write(['a'], semantic('label')), write(['b'], semantic('label'))], [{ path: ['a'], value: 'one' }, { path: ['b'], value: 'two' }])))
  unsupported(() => registry.plan(input([write(['providers'], { '$binding-id': true })], [{ path: ['providers'], value: { 'another-binding': true } }])))
})

test('only endpoint semantics accept canonical HTTP loopback URLs', async t => {
  const { registry } = await fixture(t)
  for (const value of ['http://127.0.0.1/v1', 'http://localhost:8123/v1', 'http://[::1]:8123/v1']) {
    registry.plan(input([write(['endpoint'], semantic('endpoint'))], [{ path: ['endpoint'], value }]))
  }
  registry.plan(input([write(['model'], semantic('chat-model'))], [{ path: ['model'], value: 'provider:model' }]))
  for (const value of [
    'https://127.0.0.1/v1', 'http://remote.invalid/v1', 'http://127.0.0.1.evil/v1',
    'http://127.1/v1', 'http://2130706433/v1', 'http://0x7f000001/v1', 'http://%31%32%37.0.0.1/v1',
    'http://user@127.0.0.1/v1', 'http://127.0.0.1:99999/v1', 'http://127.0.0.1\\@remote.invalid/v1',
    'http://127.0.0.1/v1#fragment', 'file:///tmp/file', 'data:text/plain,x', 'not-a-url', 'http://127.0.0.1/v1\n'
  ]) unsupported(() => registry.plan(input([write(['endpoint'], semantic('endpoint'))], [{ path: ['endpoint'], value }])))
  for (const name of ['credential', 'chat-model', 'binding-id', 'label']) {
    unsupported(() => registry.plan(input([write(['value'], semantic(name))], [{ path: ['value'], value: 'http://127.0.0.1/v1' }])))
  }
})

test('dynamic paths keep exact static segments, length and binding identity', async t => {
  const { registry } = await fixture(t)
  const writes = [write(['credentials', '$binding-id', 'token'], semantic('credential'))]
  registry.plan(input(writes, [{ path: ['credentials', 'host-binding', 'token'], value: 'secret' }]))
  for (const path of [
    ['other', 'host-binding', 'token'], ['credentials', 'other-binding', 'token'],
    ['credentials', 'host-binding', 'other'], ['credentials', 'token'],
    ['credentials', 'host-binding', 'extra', 'token'], ['credentials', 'constructor', 'token']
  ]) unsupported(() => registry.plan(input(writes, [{ path, value: 'secret' }])))
  unsupported(() => registry.plan(input([write(['providers', '$binding-id'], true), write(['providers', 'host-binding'], false)], [
    { path: ['providers', 'host-binding'], value: true }, { path: ['providers', 'host-binding'], value: false }
  ])))
})

test('append requires a canonical bounded index at the trusted current array length', async t => {
  const { registry } = await fixture(t)
  const writes = [write(['providers', '$append'], { enabled: true })]
  const materialized = index => [{ path: ['providers', index], value: { enabled: true } }]
  registry.plan(input(writes, materialized('1'), { current: { providers: [{}] } }))
  registry.plan(input(writes, materialized('256'), { current: { providers: Array.from({ length: 256 }, () => ({})) } }))
  for (const index of ['0', '2', '01', '-1', '1.0', '1e0', 'name', '4294967295']) {
    unsupported(() => registry.plan(input(writes, materialized(index), { current: { providers: [{}] } })))
  }
  unsupported(() => registry.plan(input(writes, materialized('0'))))
  unsupported(() => registry.plan(input(writes, materialized('0'), { current: { providers: {} } })))
  unsupported(() => registry.plan(input(writes, materialized('257'), { current: { providers: Array.from({ length: 257 }, () => ({})) } })))
  const host = settingsFixture({ providers: [{}] })
  const stale = registry.plan(input(writes, materialized('0'), { current: { providers: [] } }))
  await assert.rejects(() => registry.apply(stale, { settings: host.settings }), { code: 'CONFLICT' })
  assert.equal(host.mutations, 0)
  const plan = registry.plan(input(writes, materialized('1'), { current: { providers: [{}] } }))
  assert.equal((await registry.apply(plan, { settings: host.settings })).status, 'saved-active')
})

test('composite redacted leaves need exact secret sidecars and matching non-secret siblings', async t => {
  const { registry } = await fixture(t)
  const writes = [write(['config'], { token: semantic('credential'), label: semantic('label') })]
  const materialized = [{ path: ['config'], value: { token: 'new-secret', label: 'Pengbao' } }]
  for (const change of [
    descriptor => ({ ...descriptor, secrets: [] }),
    descriptor => ({ ...descriptor, secrets: [{ path: ['config'], set: true }] }),
    descriptor => ({ ...descriptor, secrets: [{ path: ['config', 'token'], set: false }] }),
    descriptor => ({ ...descriptor, secrets: [{ path: ['config', 'token'], set: true, nonempty: false }] }),
    descriptor => ({ ...descriptor, user: { config: { label: 'wrong' } } }),
    descriptor => ({ ...descriptor, user: { config: { label: 'Pengbao', extra: true } } })
  ]) {
    const host = settingsFixture()
    host.rewrite(descriptor => host.mutations ? change(descriptor) : descriptor)
    const result = await registry.apply(registry.plan(input(writes, materialized)), { settings: host.settings })
    assert.equal(result.status, 'verification-failed')
    assert.equal(result.receiptId, undefined)
  }
})

test('refuses composite replacement when any prior nested secret is redacted, including empty secrets', async t => {
  const { registry } = await fixture(t)
  const writes = [write(['config'], { token: semantic('credential'), label: semantic('label') })]
  const materialized = [{ path: ['config'], value: { token: 'new-secret', label: 'Pengbao' } }]
  for (const token of ['old-secret', '']) {
    const host = settingsFixture({ config: { token, label: 'previous' } })
    await assert.rejects(() => registry.apply(registry.plan(input(writes, materialized)), { settings: host.settings }), { code: 'ROLLBACK_UNAVAILABLE' })
    assert.equal(host.mutations, 0)
  }
  const host = settingsFixture({ config: { nested: { token: 'old-secret' }, label: 'previous' } })
  await assert.rejects(() => registry.apply(registry.plan(input(writes, materialized)), { settings: host.settings }), { code: 'ROLLBACK_UNAVAILABLE' })
  assert.equal(host.mutations, 0)
})

test('rollback guards nested public siblings and verifies removed secret markers', async t => {
  const { registry } = await fixture(t)
  const writes = [write(['config'], { token: semantic('credential'), label: semantic('label') })]
  const materialized = [{ path: ['config'], value: { token: 'new-secret', label: 'Pengbao' } }]
  const host = settingsFixture({ config: { label: 'previous' } })
  const applied = await registry.apply(registry.plan(input(writes, materialized)), { settings: host.settings })
  assert.equal(applied.status, 'saved-awaiting-restart')
  host.rewrite(descriptor => ({ ...descriptor, user: { config: { label: 'changed' } } }))
  await assert.rejects(() => registry.rollback({ receiptId: applied.receiptId }, { settings: host.settings }), { code: 'CONFLICT' })
  assert.equal(host.mutations, 1)
  host.rewrite(descriptor => host.mutations < 2 ? descriptor : ({ ...descriptor, secrets: [{ path: ['config', 'token'], set: true, nonempty: true }] }))
  assert.equal((await registry.rollback({ receiptId: applied.receiptId }, { settings: host.settings })).status, 'verification-failed')
})
