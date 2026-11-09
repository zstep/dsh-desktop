import test from 'node:test'
import assert from 'node:assert/strict'
import { createPluginConfigurationBroker, registerPrivatePluginConfiguration } from '../private.js'

const gatewayUrl = 'http://127.0.0.1:43127'
registerPrivatePluginConfiguration({ contractVersion: 1, gatewayUrl, capabilityToken: 'h'.repeat(32) })

const policy = { bindingId: 'binding-one', entryId: 'fixture-plugin', packageName: 'fixture-plugin', packageVersion: '1.0.0',
  capabilities: ['chat.completions'], models: ['chosen'] }

test('preserves only a fixed-vocabulary host denial reason on FORBIDDEN', async () => {
  const originalFetch = globalThis.fetch
  const brokerFor = fetch => { globalThis.fetch = fetch; return createPluginConfigurationBroker() }
  try {
    const denied = brokerFor(async () => new Response(JSON.stringify({ error: { type: 'plugin_configuration_error', message: 'Plugin configuration request failed', reason: 'entry-multiple' } }),
      { status: 403, headers: { 'content-type': 'application/json' } }))
    await assert.rejects(denied.issue(policy), error => {
      assert.equal(error.code, 'FORBIDDEN')
      assert.equal(error.detail, 'entry-multiple')
      return true
    })
    const hostile = brokerFor(async () => new Response(JSON.stringify({ error: { type: 'plugin_configuration_error', message: 'Plugin configuration request failed', reason: '../private/path' } }),
      { status: 403, headers: { 'content-type': 'application/json' } }))
    await assert.rejects(hostile.issue(policy), error => {
      assert.equal(error.code, 'FORBIDDEN')
      assert.equal(error.detail, undefined)
      return true
    })
    const plain = brokerFor(async () => new Response('not json', { status: 403, headers: { 'content-type': 'text/plain' } }))
    await assert.rejects(plain.issue(policy), error => {
      assert.equal(error.code, 'FORBIDDEN')
      assert.equal(error.detail, undefined)
      return true
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})
