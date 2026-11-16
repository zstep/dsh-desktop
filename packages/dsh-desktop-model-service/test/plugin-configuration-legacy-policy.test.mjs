import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerPrivatePluginConfiguration } from '../private.js'
import { configurationDigest, installPluginConfigurationRuntime, pluginConfigurationReference, readPluginConfigurations } from '../plugin-configuration-runtime.js'

function fixture() {
  const bindingId = 'legacy-binding'
  const raw = { endpoint: pluginConfigurationReference(bindingId, 'endpoint'), apiKey: pluginConfigurationReference(bindingId, 'credential'), model: 'fixture-chat' }
  const policy = { bindingId, entryId: 'fixture-plugin', packageName: 'fixture-plugin', packageVersion: '1.0.0', capabilities: ['chat.completions'], models: ['fixture-chat'] }
  return { raw, policy, record: {
    identity: { bindingId, entryId: 'fixture-plugin', namespace: 'fixture-plugin', packageName: 'fixture-plugin', packageVersion: '1.0.0', revision: 0, schemaDigest: 'a'.repeat(64), evidenceDigest: 'b'.repeat(64) },
    policy: { ...policy, videoModels: ['fixture-video'] },
    files: [{ path: 'package.json', digest: 'c'.repeat(64) }], configDigest: configurationDigest(raw)
  } }
}

test('loads legacy videoModels metadata without expanding authority or modifying the approval file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pengbao-legacy-policy-'))
  const file = join(root, '.pengbao-plugin-configurations.json')
  const { raw, policy, record } = fixture()
  const bytes = JSON.stringify({ contractVersion: 1, bindings: [record] })
  const requests = []
  const originalFetch = globalThis.fetch
  const listeners = new Map()
  const warnings = []
  let runtime
  await writeFile(file, bytes)
  registerPrivatePluginConfiguration({ contractVersion: 1, gatewayUrl: 'http://127.0.0.1:43127', capabilityToken: 'h'.repeat(32) })
  globalThis.fetch = async (url, options) => {
    requests.push({ path: new URL(url).pathname, body: JSON.parse(options.body) })
    return Response.json(url.endsWith('/revoke') ? {} : { contractVersion: 1, gatewayUrl: 'http://127.0.0.1:43127', leaseId: 'fixture-lease', capabilityToken: 'l'.repeat(32) })
  }
  try {
    const [loaded] = await readPluginConfigurations(root)
    assert.deepEqual(loaded.policy, policy)
    const ctx = { get: () => ({ dir: root, name: 'web' }),
      on: (name, hook) => { listeners.set(name, hook); return () => listeners.delete(name) }, effect() {}, logger: { warn: message => warnings.push(message) } }
    runtime = await installPluginConfigurationRuntime(ctx)
    assert.ok(runtime)
    assert.deepEqual(requests, [{ path: '/v1/plugin-configuration/issue', body: policy }])
    assert.deepEqual(runtime.resolve('fixture-plugin', raw, raw), { endpoint: 'http://127.0.0.1:43127/v1', apiKey: 'l'.repeat(32), model: 'fixture-chat' })
    assert.deepEqual(warnings, [])
    assert.equal(await readFile(file, 'utf8'), bytes)
  } finally {
    await runtime?.dispose()
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})

test('still refuses unknown fields, malformed legacy metadata and unsupported capabilities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pengbao-legacy-policy-'))
  const { record } = fixture()
  try {
    for (const policy of [
      { ...record.policy, arbitrary: true },
      { ...record.policy, videoModels: 'fixture-video' },
      { ...record.policy, videoModels: ['https://untrusted.invalid/model'] },
      { ...record.policy, videoModels: Array(257).fill('fixture-video') },
      { ...record.policy, capabilities: ['chat.completions', 'arbitrary.generate'] }
    ]) {
      await writeFile(join(root, '.pengbao-plugin-configurations.json'), JSON.stringify({ contractVersion: 1, bindings: [{ ...record, policy }] }))
      await assert.rejects(readPluginConfigurations(root), { code: 'BINDINGS_UNAVAILABLE' })
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
