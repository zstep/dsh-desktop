import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import z from '@deepseek-ai/schemastery'
import {
  analyzePluginConfiguration,
  collectPluginEvidence,
  listConfigurablePlugins,
  materializeProposal,
  validateConfigurationProposal
} from '../plugin-config-analysis.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-analysis-'))
  const packageRoot = join(root, 'profiles', 'web', 'node_modules', 'fixture-provider')
  await mkdir(join(packageRoot, 'src'), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'fixture-provider', version: '1.2.3', main: 'index.js' }))
  await writeFile(join(packageRoot, 'index.js'), 'export const endpoint = "https://untrusted.invalid/v1"\n')
  const schema = z.object({
    endpoint: z.string().role('endpoint'),
    credential: z.dict(z.object({ token: z.string().role('secret') })),
    defaultChannelId: z.string(),
    chatModel: z.string().role('model').extra('scope', 'chat')
  })
  const entry = {
    options: { id: 'fixture-provider', name: 'fixture-provider' },
    parent: { tree: { ctx: { baseUrl: `file://${packageRoot}/index.js` } } },
    fiber: { state: 2, runtime: {}, uid: 4 }
  }
  const ctx = {
    profileContext: { home: root },
    configEditor: { configuration: () => [{ entry, inherited: { credential: { old: { token: 'secret' } } }, override: {} }] },
    settings: { describe: () => [{ ns: 'fixture-provider', revision: 3, schema: schema.toJSON(), value: { credential: {} } }] },
    pluginPackages: { packageOf: () => ({ name: 'fixture-provider', version: '1.2.3', dir: packageRoot, manifestPath: join(packageRoot, 'package.json'), manifest: {} }) }
  }
  return { root, schema, ctx, entry }
}

test('lists and collects bounded package evidence without resolved values', async () => {
  const { ctx, root } = await fixture()
  const inventory = await listConfigurablePlugins(ctx)
  assert.deepEqual(inventory, [{ entryId: 'fixture-provider', namespace: 'fixture-provider', packageName: 'fixture-provider', packageVersion: '1.2.3', supported: true, reason: 'available' }])
  const evidence = await collectPluginEvidence(ctx, 'fixture-provider')
  assert.equal(evidence.identity.root, await realpath(join(root, 'profiles', 'web', 'node_modules', 'fixture-provider')))
  assert.deepEqual(evidence.identity.files, evidence.files.map(({ path, digest }) => ({ path, digest })))
  assert.equal(evidence.files.some(file => file.text.includes('secret')), false)
})

test('discovers nonvolatile full runtime Config without a settings descriptor', async () => {
  const { ctx, entry } = await fixture()
  entry.fiber.runtime.Config = z.object({
    endpoint: z.string().role('endpoint').default('private-default-endpoint'),
    credential: z.dict(z.object({ token: z.string().role('secret').default('private-default-token') })),
    chatModel: z.string().role('model').extra('scope', 'chat')
  })
  ctx.settings.describe = () => []
  const inventory = await listConfigurablePlugins(ctx)
  assert.equal(inventory.length, 1)
  assert.equal(inventory[0].supported, true)
  assert.equal(inventory[0].namespace, entry.options.id)
  const evidence = await collectPluginEvidence(ctx, entry.options.id)
  assert.equal(evidence.revision, 0)
  assert.deepEqual(Object.keys(evidence.schema.dict), ['endpoint', 'credential', 'chatModel'])
  assert.equal(JSON.stringify(evidence).includes('private-default-'), false)
  assert.equal(JSON.stringify(evidence).includes('"old"'), false)
  // Full Config discovery does not depend on the settings service being present.
  delete ctx.settings
  assert.equal((await listConfigurablePlugins(ctx))[0].supported, true)
})

test('prefers full runtime Config over volatile descriptor fields without reviving callbacks', async () => {
  const { ctx, entry, schema } = await fixture()
  const serialized = schema.toJSON()
  serialized.__jsExpr = 'throw new Error("must not execute")'
  entry.fiber.runtime.Config = { toJSON: () => serialized }
  ctx.settings.describe = () => [{ ns: entry.options.id, revision: 9, schema: z.object({ enabled: z.boolean() }).toJSON() }]
  const evidence = await collectPluginEvidence(ctx, entry.options.id)
  assert.equal(evidence.revision, 9)
  assert.ok(evidence.schema.dict.credential)
  assert.equal(Object.hasOwn(evidence.schema.dict, 'enabled'), false)
  assert.equal(JSON.stringify(evidence.schema).includes('__jsExpr'), false)
  // A present but invalid runtime schema must never fall back to the descriptor.
  entry.fiber.runtime.Config = { toJSON: () => { throw new Error('unavailable') } }
  assert.equal((await listConfigurablePlugins(ctx))[0].reason, 'unsupported-schema')
  await assert.rejects(() => collectPluginEvidence(ctx, entry.options.id), { code: 'PLUGIN_UNAVAILABLE' })
})

test('excludes the model service itself even when its entry is aliased', async () => {
  for (const identity of ['entryId', 'pluginName', 'runtimeName', 'packageName']) {
    const { ctx, entry, schema } = await fixture()
    entry.fiber.runtime.Config = schema
    if (identity === 'entryId') entry.options.id = 'dsh-desktop-model-service'
    if (identity === 'pluginName') entry.options.name = 'dsh-desktop-model-service'
    if (identity === 'runtimeName') entry.fiber.runtime.name = 'dsh-desktop-model-service'
    if (identity === 'packageName') {
      const pkg = ctx.pluginPackages.packageOf()
      ctx.pluginPackages.packageOf = () => ({ ...pkg, name: 'dsh-desktop-model-service' })
    }
    assert.deepEqual(await listConfigurablePlugins(ctx), [])
  }
})

test('validates dynamic binding paths and materializes only host values', async () => {
  const { ctx, schema } = await fixture()
  const evidence = await collectPluginEvidence(ctx, 'fixture-provider')
  const proposal = validateConfigurationProposal({
    contractVersion: 1,
    protocol: 'openai',
    capabilities: ['chat.completions'],
    writes: [
      { path: ['endpoint'], value: { $semantic: 'endpoint' }, evidenceIds: ['e1'] },
      { path: ['credential', '$binding-id'], value: { token: { $semantic: 'credential' } }, evidenceIds: ['e1'] },
      { path: ['defaultChannelId'], value: { $semantic: 'binding-id' }, evidenceIds: ['e1'] },
      { path: ['chatModel'], value: { $semantic: 'chat-model' }, evidenceIds: ['e1'] }
    ]
  }, schema.toJSON(), evidence.files.map(file => file.id))
  const ops = materializeProposal(proposal, {
    endpoint: 'http://127.0.0.1/v1', credential: 'secret-from-host', chatModel: 'chat-model', bindingId: 'host-uuid',
    current: { credential: { old: { token: 'redacted' } } }
  })
  assert.deepEqual(ops[1], { path: ['credential', 'host-uuid'], value: { token: 'secret-from-host' } })
  assert.equal(JSON.stringify(ops).includes('redacted'), false)
  assert.throws(() => validateConfigurationProposal({ ...proposal, writes: [{ path: ['defaultChannelId'], value: { $semantic: 'endpoint' }, evidenceIds: ['e1'] }, ...proposal.writes.slice(1)] }, schema.toJSON(), ['e1']))
  assert.throws(() => validateConfigurationProposal({ ...proposal, writes: [{ path: ['credential', 'picked-by-model'], value: { token: { $semantic: 'credential' } }, evidenceIds: ['e1'] }, ...proposal.writes.slice(1)] }, schema.toJSON(), ['e1']))
})

test('materializes binding-id keys in nested dictionary templates to the exact host id', () => {
  const schema = z.object({ providers: z.dict(z.object({
    endpoint: z.string().role('endpoint'),
    credential: z.dict(z.object({ token: z.string().role('secret') })),
    chatModel: z.string().role('model').extra('scope', 'chat')
  })) })
  const provider = {
    endpoint: { $semantic: 'endpoint' },
    credential: { '$binding-id': { token: { $semantic: 'credential' } } },
    chatModel: { $semantic: 'chat-model' }
  }
  const input = { contractVersion: 1, protocol: 'openai', capabilities: ['chat.completions'], writes: [
    { path: ['providers'], value: { '$binding-id': provider }, evidenceIds: ['e1'] }
  ] }
  const proposal = validateConfigurationProposal(input, schema.toJSON(), ['e1'])
  const values = { endpoint: 'http://127.0.0.1/v1', credential: 'host-secret', chatModel: 'host-model', bindingId: 'host-uuid' }
  assert.deepEqual(materializeProposal(proposal, values), [{ path: ['providers'], value: {
    'host-uuid': { endpoint: values.endpoint, credential: { 'host-uuid': { token: values.credential } }, chatModel: values.chatModel }
  } }])
  assert.equal(JSON.stringify(proposal).includes('host-secret'), false)
  assert.equal(Object.hasOwn(proposal.writes[0].value, '$binding-id'), true)

  // Dynamic keys must not overwrite static keys, regardless of their source order.
  for (const value of [{ '$binding-id': provider, 'host-uuid': provider }, { 'host-uuid': provider, '$binding-id': provider }]) {
    const collision = validateConfigurationProposal({ ...input, writes: [{ ...input.writes[0], value }] }, schema.toJSON(), ['e1'])
    assert.throws(() => materializeProposal(collision, values), { code: 'INVALID_HOST_VALUES' })
  }
  for (const bindingId of ['__proto__', 'prototype', 'constructor', '__jsExpr', '$binding-id', '$append', 'bad/key']) {
    assert.throws(() => materializeProposal(proposal, { ...values, bindingId }), { code: 'INVALID_HOST_VALUES' })
  }
  // These are object keys, not array append directives or data-bearing prototype properties.
  for (const key of ['$append', '__proto__', 'prototype', 'constructor', '__jsExpr']) {
    const value = { '$binding-id': provider, [key]: provider }
    assert.throws(() => validateConfigurationProposal({ ...input, writes: [{ ...input.writes[0], value }] }, schema.toJSON(), ['e1']), { code: 'INVALID_PROPOSAL' })
  }
  const pathCollision = validateConfigurationProposal({ ...input, writes: [
    { path: ['providers', '$binding-id'], value: provider, evidenceIds: ['e1'] },
    { path: ['providers', 'host-uuid'], value: provider, evidenceIds: ['e1'] }
  ] }, schema.toJSON(), ['e1'])
  assert.throws(() => materializeProposal(pathCollision, values), { code: 'INVALID_HOST_VALUES' })
})

test('rejects oversized or accessor-backed proposal JSON and ignores extra annotation keys', async () => {
  const { schema } = await fixture()
  const valid = { contractVersion: 1, protocol: 'openai', capabilities: ['chat.completions'], writes: [
    { path: ['endpoint'], value: { $semantic: 'endpoint' }, evidenceIds: ['e1'] },
    { path: ['credential', '$binding-id'], value: { token: { $semantic: 'credential' } }, evidenceIds: ['e1'] },
    { path: ['chatModel'], value: { $semantic: 'chat-model' }, evidenceIds: ['e1'] }
  ] }
  // Extra annotation keys carry no host meaning; boundedJson already proves
  // they are inert data, so they do not invalidate an otherwise valid mapping.
  assert.equal(validateConfigurationProposal({ ...valid, unexpected: true }, schema.toJSON(), ['e1']).writes.length, 3)
  assert.throws(() => validateConfigurationProposal({ ...valid, writes: [...valid.writes, { ...valid.writes[0], value: 'x'.repeat(256 * 1024) }] }, schema.toJSON(), ['e1']), { code: 'INVALID_PROPOSAL' })

  const accessor = { ...valid }
  Object.defineProperty(accessor, 'extra', { enumerable: true, get() { throw new Error('must not run') } })
  assert.throws(() => validateConfigurationProposal(accessor, schema.toJSON(), ['e1']), { code: 'INVALID_PROPOSAL' })
})

test('maps role-less market schemas by field name instead of role annotations', () => {
  // Market plugins annotate only secrets; everything else must be matched by
  // the field's own name (URL-shaped endpoint, model-shaped model slot).
  const schema = z.object({
    enabled: z.boolean().default(true),
    channels: z.array(z.object({
      id: z.string(),
      name: z.string().default(''),
      apiUrl: z.string().default(''),
      protocol: z.union([z.const('auto'), z.const('images'), z.const('chat-completions')]).default('auto'),
      models: z.array(z.object({ alias: z.string(), id: z.string() })).default([])
    })).default([]),
    channelSecrets: z.dict(z.string().role('secret')).default({}),
    defaultChannelId: z.string().default(''),
    defaultModel: z.string().default(''),
    promptApiUrl: z.string().default(''),
    promptApiKey: z.string().role('secret').default(''),
    promptModel: z.string().default(''),
    textModel: z.string().default(''),
    apiUrl: z.string().default(''),
    apiKey: z.string().role('secret').default(''),
    imageModels: z.array(z.string()).default([]),
    plainKey: z.string().default('')
  })
  const input = {
    contractVersion: 1,
    protocol: 'openai',
    capabilities: ['image.generate', 'chat.completions'],
    writes: [
      { path: ['channels', '$append'], value: { id: { $semantic: 'binding-id' }, name: { $semantic: 'label' },
        apiUrl: { $semantic: 'endpoint' }, protocol: 'chat-completions',
        models: [{ alias: { $semantic: 'label' }, id: { $semantic: 'image-model' } }] }, evidenceIds: ['e1'] },
      { path: ['channelSecrets', '$binding-id'], value: { $semantic: 'credential' }, evidenceIds: ['e1'] },
      { path: ['defaultChannelId'], value: { $semantic: 'binding-id' }, evidenceIds: ['e1'] },
      { path: ['defaultModel'], value: { $semantic: 'image-model' }, evidenceIds: ['e1'] },
      { path: ['imageModels'], value: [{ $semantic: 'image-model' }], evidenceIds: ['e1'] },
      { path: ['apiUrl'], value: { $semantic: 'endpoint' }, evidenceIds: ['e1'] },
      { path: ['apiKey'], value: { $semantic: 'credential' }, evidenceIds: ['e1'] },
      { path: ['promptApiUrl'], value: { $semantic: 'endpoint' }, evidenceIds: ['e1'] },
      { path: ['promptApiKey'], value: { $semantic: 'credential' }, evidenceIds: ['e1'] },
      { path: ['promptModel'], value: { $semantic: 'chat-model' }, evidenceIds: ['e1'] },
      { path: ['textModel'], value: { $semantic: 'chat-model' }, evidenceIds: ['e1'] }
    ]
  }
  const proposal = validateConfigurationProposal(input, schema.toJSON(), ['e1'])
  const values = { endpoint: 'http://127.0.0.1:43127/v1', credential: 'gateway-credential', chatModel: 'chat-default',
    imageModel: 'image-default', bindingId: 'host-binding', label: 'Pengbao', current: {} }
  const ops = materializeProposal(proposal, values)
  // A never-configured plugin has no stored channels array; the append
  // creates one at index 0 rather than failing host materialization.
  assert.deepEqual(ops[0].path, ['channels', '0'])
  assert.equal(ops[0].append, true)
  assert.deepEqual(ops[0].value, { id: 'host-binding', name: 'Pengbao', apiUrl: values.endpoint,
    protocol: 'chat-completions', models: [{ alias: 'Pengbao', id: 'image-default' }] })
  assert.deepEqual(ops[1], { path: ['channelSecrets', 'host-binding'], value: 'gateway-credential' })
  assert.deepEqual(ops[3], { path: ['defaultModel'], value: 'image-default' })
  assert.deepEqual(ops[9], { path: ['promptModel'], value: 'chat-default' })

  const without = name => input.writes.filter(write => write.path.join('.') !== name)
  const append = (path, value) => ({ ...input, writes: [...input.writes, { path, value, evidenceIds: ['e1'] }] })
  // Endpoint leaves must land on URL-shaped fields.
  assert.throws(() => validateConfigurationProposal({ ...input,
    writes: [...without('defaultChannelId'), { path: ['defaultChannelId'], value: { $semantic: 'endpoint' }, evidenceIds: ['e1'] }] },
  schema.toJSON(), ['e1']), { code: 'INVALID_PROPOSAL' })
  // Model leaves need a model-shaped field name; the opposite scope is rejected.
  assert.throws(() => validateConfigurationProposal({ ...input,
    writes: [...without('defaultChannelId'), { path: ['defaultChannelId'], value: { $semantic: 'chat-model' }, evidenceIds: ['e1'] }] },
  schema.toJSON(), ['e1']), { code: 'INVALID_PROPOSAL' })
  assert.throws(() => validateConfigurationProposal({ ...input,
    writes: [...without('imageModels'), { path: ['imageModels', '0'], value: { $semantic: 'chat-model' }, evidenceIds: ['e1'] }] },
  schema.toJSON(), ['e1']), { code: 'INVALID_PROPOSAL' })
  assert.throws(() => validateConfigurationProposal({ ...input,
    writes: [...without('promptModel'), { path: ['promptModel'], value: { $semantic: 'image-model' }, evidenceIds: ['e1'] }] },
  schema.toJSON(), ['e1']), { code: 'INVALID_PROPOSAL' })
  // Credentials remain restricted to schema-declared secret leaves.
  assert.throws(() => validateConfigurationProposal(append(['plainKey'], { $semantic: 'credential' }), schema.toJSON(), ['e1']),
    { code: 'INVALID_PROPOSAL' })
})

test('analyzes with server default and rejects tool or malformed output', async () => {
  const { ctx } = await fixture()
  const evidence = await collectPluginEvidence(ctx, 'fixture-provider')
  let request
  const valid = JSON.stringify({ contractVersion: 1, protocol: 'openai', capabilities: ['chat.completions'], writes: [
    { path: ['endpoint'], value: { $semantic: 'endpoint' }, evidenceIds: ['e1'] },
    { path: ['credential', '$binding-id'], value: { token: { $semantic: 'credential' } }, evidenceIds: ['e1'] },
    { path: ['chatModel'], value: { $semantic: 'chat-model' }, evidenceIds: ['e1'] }
  ] })
  const result = await analyzePluginConfiguration({ ...ctx,
    modelService: { catalog: async () => ({ defaults: { 'chat.completions': 'server-default' } }) },
    llm: { stream: options => { request = options; return (async function * () { yield { type: 'text-delta', text: valid }; yield { type: 'finish', reason: { kind: 'stop' } } })() } }
  }, evidence)
  assert.equal(request.provider, 'pengbao')
  assert.equal(request.model, 'server-default')
  assert.equal(request.tools.length, 0)
  assert.equal(Object.hasOwn(request, 'root'), false)
  assert.equal(result.protocol, 'openai')
  await assert.rejects(() => analyzePluginConfiguration({ ...ctx, llm: { stream: () => (async function * () { yield { type: 'tool-call-delta', id: 'x', argumentsDelta: '{}' } })() } }, evidence, { selection: { provider: 'pengbao', model: 'explicit' } }), { code: 'ANALYSIS_FAILED' })
})

test('retries one dropped upstream stream before failing the analysis', async () => {
  const { ctx } = await fixture()
  const evidence = await collectPluginEvidence(ctx, 'fixture-provider')
  const valid = JSON.stringify({ contractVersion: 1, protocol: 'openai', capabilities: ['chat.completions'], writes: [
    { path: ['endpoint'], value: { $semantic: 'endpoint' }, evidenceIds: ['e1'] },
    { path: ['credential', '$binding-id'], value: { token: { $semantic: 'credential' } }, evidenceIds: ['e1'] },
    { path: ['chatModel'], value: { $semantic: 'chat-model' }, evidenceIds: ['e1'] }
  ] })
  let calls = 0
  const llm = { stream: () => (++calls === 1
    ? (async function * () { throw new Error('upstream dropped') })()
    : (async function * () { yield { type: 'text-delta', text: valid }; yield { type: 'finish', reason: { kind: 'stop' } } })()) }
  const result = await analyzePluginConfiguration({ ...ctx, llm }, evidence, { selection: { provider: 'pengbao', model: 'explicit' } })
  assert.equal(calls, 2)
  assert.equal(result.protocol, 'openai')
  // A second drop is still reported as a failed analysis rather than looping.
  let drops = 0
  await assert.rejects(() => analyzePluginConfiguration({ ...ctx, llm: { stream: () => (async function * () { drops++; throw new Error('upstream dropped') })() } }, evidence, { selection: { provider: 'pengbao', model: 'explicit' } }), { code: 'ANALYSIS_FAILED' })
  assert.equal(drops, 2)
})

test('ignores harmless model annotations on the proposal and each write', async () => {
  const { ctx, schema } = await fixture()
  const evidence = await collectPluginEvidence(ctx, 'fixture-provider')
  const proposal = {
    contractVersion: 1, protocol: 'openai', capabilities: ['chat.completions'], rationale: 'evidence e1',
    writes: [
      { path: ['endpoint'], value: { $semantic: 'endpoint' }, evidenceIds: ['e1'], note: 'gateway endpoint' },
      { path: ['credential', '$binding-id'], value: { token: { $semantic: 'credential' } }, evidenceIds: ['e1'], note: 'secret' },
      { path: ['defaultChannelId'], value: { $semantic: 'binding-id' }, evidenceIds: ['e1'], note: 'channel' },
      { path: ['chatModel'], value: { $semantic: 'chat-model' }, evidenceIds: ['e1'], note: 'model' }
    ]
  }
  const result = validateConfigurationProposal(proposal, schema.toJSON(), evidence.files.map(file => file.id))
  assert.equal(result.writes.length, 4)
})

test('decodes a fenced proposal and repairs one rejected answer', async () => {
  const { ctx } = await fixture()
  const evidence = await collectPluginEvidence(ctx, 'fixture-provider')
  const valid = JSON.stringify({ contractVersion: 1, protocol: 'openai', capabilities: ['chat.completions'], writes: [
    { path: ['endpoint'], value: { $semantic: 'endpoint' }, evidenceIds: ['e1'] },
    { path: ['credential', '$binding-id'], value: { token: { $semantic: 'credential' } }, evidenceIds: ['e1'] },
    { path: ['defaultChannelId'], value: { $semantic: 'binding-id' }, evidenceIds: ['e1'] },
    { path: ['chatModel'], value: { $semantic: 'chat-model' }, evidenceIds: ['e1'] }
  ] })
  // A single surrounding fence must not turn a valid answer into a failure.
  const fenced = await analyzePluginConfiguration({ ...ctx,
    llm: { stream: () => (async function * () {
      yield { type: 'text-delta', text: `\`\`\`json\n${valid}\n\`\`\`` }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })() }
  }, evidence, { selection: { provider: 'pengbao', model: 'explicit' } })
  assert.equal(fenced.writes.length, 4)
  // An invalid first answer gets one bounded repair round with the reason and
  // the previous answer; the strict validator still decides the result.
  const calls = []
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    const invalid = JSON.stringify({ contractVersion: 1, protocol: 'openai', capabilities: ['chat.completions'], writes: [
      { path: ['endpoint'], value: 'https://literal.invalid', evidenceIds: ['e1'] }
    ] })
    const repaired = await analyzePluginConfiguration({ ...ctx,
      llm: { stream: options => { calls.push(options); const text = calls.length === 1 ? invalid : valid
        return (async function * () { yield { type: 'text-delta', text }; yield { type: 'finish', reason: { kind: 'stop' } } })() } }
    }, evidence, { selection: { provider: 'pengbao', model: 'explicit' } })
    assert.equal(repaired.writes.length, 4)
    assert.equal(calls.length, 2)
    assert.equal(calls[1].messages.length, 2)
    assert.match(calls[1].messages[1].content[0].text, /rejected by host validation/)
    assert.match(calls[1].messages[1].content[0].text, /INVALID_PROPOSAL: endpoint/)
    assert.match(warnings.join('\n'), /output=".*https:\/\/literal.invalid/)
    // Two rejected answers still surface the opaque code to the client.
    const rejected = { ...ctx, llm: { stream: () => (async function * () {
      yield { type: 'text-delta', text: invalid }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })() } }
    await assert.rejects(() => analyzePluginConfiguration(rejected, evidence,
      { selection: { provider: 'pengbao', model: 'explicit' } }), { code: 'INVALID_PROPOSAL' })
  } finally { console.warn = original }
})
