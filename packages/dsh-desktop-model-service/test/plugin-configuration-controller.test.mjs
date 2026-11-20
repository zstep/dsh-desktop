import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { registerPrivatePluginConfiguration } from '../private.js'
import { installPluginConfigurationRuntime, readPluginConfigurations } from '../plugin-configuration-runtime.js'
import { createPluginConfigurationController } from '../plugin-configuration.js'
import { collectPluginEvidence } from '../plugin-config-analysis.js'
import { createModelServiceConnections } from '../connections.js'

const proposal = writes => ({ contractVersion: 1, protocol: 'openai', capabilities: ['chat.completions'], writes })
const CHAT_PROPOSAL = proposal([
  { path: ['baseUrl'], value: { $semantic: 'endpoint' }, evidenceIds: ['e1'] },
  { path: ['apiKey'], value: { $semantic: 'credential' }, evidenceIds: ['e1'] },
  { path: ['model'], value: { $semantic: 'chat-model' }, evidenceIds: ['e1'] }
])
const IMAGE_PROPOSAL = {
  ...proposal([
    { path: ['baseUrl'], value: { $semantic: 'endpoint' }, evidenceIds: ['e1'] },
    { path: ['apiKey'], value: { $semantic: 'credential' }, evidenceIds: ['e1'] },
    { path: ['model'], value: { $semantic: 'chat-model' }, evidenceIds: ['e1'] },
    { path: ['imageModel'], value: { $semantic: 'image-model' }, evidenceIds: ['e1'] }
  ]),
  capabilities: ['chat.completions', 'image.generate']
}
const VIDEO_PROPOSAL = {
  ...proposal([
    { path: ['baseUrl'], value: { $semantic: 'endpoint' }, evidenceIds: ['e1'] },
    { path: ['apiKey'], value: { $semantic: 'credential' }, evidenceIds: ['e1'] },
    { path: ['model'], value: { $semantic: 'chat-model' }, evidenceIds: ['e1'] },
    { path: ['videoModel'], value: { $semantic: 'video-model' }, evidenceIds: ['e1'] }
  ]),
  capabilities: ['chat.completions', 'video.generate']
}
const token = seed => seed.repeat(32).slice(0, 32)

async function fixture({ image = false, collections = false, video = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-controller-'))
  const profileDir = join(root, 'profiles', 'web')
  const packageRoot = join(profileDir, 'node_modules', '@fixture', 'chatplugin')
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@fixture/chatplugin', version: '1.0.0', type: 'module', main: 'index.js'
  }, null, 2) + '\n')
  const fields = [
    "  baseUrl: z.string().description('Chat completion endpoint URL'),",
    "  apiKey: z.string().role('secret').description('API key'),",
    `  model: z.string().description('Chat model')${image || video ? ',' : ''}`,
    ...(image ? ["  imageModel: z.string().description('Image generation model')"] : []),
    ...(video ? ["  videoModel: z.string().description('Video generation model')"] : [])
  ]
  await writeFile(join(packageRoot, 'index.js'), [
    "import z from '@deepseek-ai/schemastery'",
    '',
    "export const name = '@fixture/chatplugin'",
    'export const Config = z.object({',
    ...fields,
    '})',
    ''
  ].join('\n'))
  const schema = z.object({
    baseUrl: z.string(),
    apiKey: z.string().role('secret'),
    model: z.string(),
    ...(image ? { imageModel: z.string() } : {}),
    ...(video ? { videoModel: z.string() } : {}),
    ...(collections ? { channels: z.array(z.object({
      id: z.string(), name: z.string(), apiUrl: z.string(), protocol: z.const('rig-chat-literal'),
      models: z.array(z.object({ alias: z.string(), id: z.string() })),
      videoModels: z.array(z.object({ alias: z.string(), id: z.string() })).default([])
    })).default([]) } : {})
  })
  const entry = {
    options: { id: 'fixture-chat', name: '@fixture/chatplugin', config: undefined },
    parent: { tree: { ctx: { baseUrl: `file://${packageRoot}/index.js` } } },
    fiber: { state: 2, runtime: { Config: schema }, uid: 1 }
  }
  const configHooks = []
  const updateHooks = []
  const effects = []
  const profile = { home: root, dir: profileDir, name: 'web', installAnchor: packageRoot }
  const ctx = {
    profileContext: profile,
    get: service => service === 'profileContext' ? profile : undefined,
    configEditor: {
      configuration: () => [{ entry, inherited: {}, override: {} }],
      // Emulate the Loader: absent config reads back as undefined and the profile
      // patch rewrite reconciles the include carrier before the next config applies.
      async edit(target, change) {
        const carrier = { options: { id: 'include', name: 'cordis:include' }, parent: undefined }
        const tree = { include: [{ id: 'fixture-chat', config: {
          apiKey: 'pengbao-runtime:binding-one:credential' } }] }
        for (const hook of configHooks) hook.call({ entry: carrier }, tree, () => tree)
        const current = structuredClone(target.options.config ?? {})
        const next = change(current)
        target.options.config = Object.keys(next).length === 0 ? undefined : structuredClone(next)
      }
    },
    settings: { describe: () => [] },
    pluginPackages: { packageOf: () => ({ name: '@fixture/chatplugin', version: '1.0.0', dir: packageRoot,
      manifestPath: join(packageRoot, 'package.json'), manifest: {} }) },
    llm: {
      stream() {
        return (async function* () {
          yield { type: 'block-start', blockType: 'text' }
          yield { type: 'text-delta', text: JSON.stringify(video ? VIDEO_PROPOSAL : image ? IMAGE_PROPOSAL : CHAT_PROPOSAL) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      }
    },
    on(event, hook) {
      const list = event === 'internal/config' ? configHooks : event === 'internal/update' ? updateHooks : []
      list.push(hook)
      return () => { const index = list.indexOf(hook); if (index >= 0) list.splice(index, 1) }
    },
    effect(factory) {
      const cleanup = factory()
      if (typeof cleanup === 'function') effects.push(cleanup)
      return cleanup
    },
    logger: { warn: () => {} }
  }
  const service = {
    async catalog() {
      const models = [{ id: 'rig-chat', name: 'Rig Chat', capabilities: ['chat.completions'] }]
      if (image) models.push({ id: 'rig-image', name: 'Rig Image', capabilities: ['image.generate'] })
      return { defaults: { 'chat.completions': 'rig-chat', ...(image ? { 'image.generate': 'rig-image' } : {}) },
        imageDefaultModel: image ? 'rig-image' : null, imageSelection: image ? 'request-local' : 'server-only',
        models }
    }
  }
  return { root, profileDir, entry, ctx, service, effects }
}

async function gateway() {
  const brokerToken = token('b')
  const leaseToken = token('l')
  let issued = 0
  let revoked = 0
  let url
  let videoRows = [
    { id: 'seedance-fixture', name: 'Seedance', provider: 'volcengine', protocol: 'ark' },
    { id: 'wan-fixture', name: 'Wan', provider: 'alibaba', protocol: 'dashscope' }
  ]
  const server = createServer(async (request, response) => {
    const reply = value => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
    if (request.url === '/v1/plugin-configuration/video-models') return reply({ data: videoRows })
    if (request.url === '/v1/plugin-configuration/issue') {
      issued++
      for await (const _chunk of request) { /* drain */ }
      return reply({ contractVersion: 1, leaseId: 'lease-one', gatewayUrl: url, capabilityToken: leaseToken })
    }
    if (request.url === '/v1/plugin-configuration/revoke') {
      revoked++
      for await (const _chunk of request) { /* drain */ }
      return reply({ revoked: true })
    }
    response.writeHead(404); response.end('{}')
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  url = `http://127.0.0.1:${server.address().port}`
  return {
    registration: { contractVersion: 1, gatewayUrl: url, capabilityToken: brokerToken },
    counts: () => ({ issued, revoked }),
    setVideoRows: rows => { videoRows = rows },
    close: async () => {
      server.closeAllConnections?.()
      await new Promise(resolve => server.close(resolve))
    }
  }
}

async function expectedConfig(profileDir, model, imageModel) {
  const { bindings } = JSON.parse(await readFile(join(profileDir, '.pengbao-plugin-configurations.json'), 'utf8'))
  const { bindingId } = bindings[0].identity
  return {
    baseUrl: `pengbao-runtime:${bindingId}:endpoint`,
    apiKey: `pengbao-runtime:${bindingId}:credential`,
    model,
    ...(imageModel ? { imageModel } : {})
  }
}

async function scenario({ image = false, video = false, apply }) {
  const { root, profileDir, entry, ctx, service, effects } = await fixture({ image, video })
  const controller = createPluginConfigurationController(ctx, service)
  try {
    await installPluginConfigurationRuntime(ctx)
    await apply(controller, entry, profileDir)
  } finally {
    controller.dispose()
    for (const cleanup of effects) await cleanup()
    await rm(root, { recursive: true, force: true })
  }
}

// If source digests cover snippets only, an unshown implementation change could
// wrongly apply a stale approval and issue a credential lease.
async function staleApprovalTests(t, broker) {
  for (const position of [500_020, 100]) await t.test(`changed byte ${position}`, async () => {
    const { root, profileDir, entry, ctx, service, effects } = await fixture()
    const packageRoot = join(profileDir, 'node_modules/@fixture/chatplugin')
    const source = Buffer.alloc(1024 * 1024, 120)
    source.write('fetch(config.baseUrl + "/chat/completions", {apiKey: config.apiKey, model: config.model})', 500_000)
    await writeFile(join(packageRoot, 'index.js'), source)
    const controller = createPluginConfigurationController(ctx, service)
    try {
      await installPluginConfigurationRuntime(ctx)
      const evidence = await collectPluginEvidence(ctx, 'fixture-chat')
      const implementation = evidence.files.find(file => file.path === 'index.js')
      assert.ok(implementation, 'large implementation must be part of the approval evidence')
      assert.equal(implementation.ranges.some(({ start, end }) => start <= position && end > position), position !== 100)
      const analysis = await controller.analyze({ entryId: 'fixture-chat' })
      const before = broker.counts()
      source[position] = source[position] === 121 ? 122 : 121
      await writeFile(join(packageRoot, 'index.js'), source)
      await assert.rejects(() => controller.apply({ planId: analysis.planId }), { code: 'CONFLICT' })
      assert.equal(entry.options.config, undefined)
      assert.deepEqual(await readPluginConfigurations(profileDir), [])
      assert.deepEqual(broker.counts(), before)
    } finally {
      controller.dispose()
      for (const cleanup of effects) await cleanup()
      await rm(root, { recursive: true, force: true })
    }
  })
}

async function modelCollectionScenario() {
  const { root, profileDir, entry, ctx, service, effects } = await fixture({ image: true, collections: true })
  const catalog = await service.catalog()
  catalog.models.push(
    { id: 'rig-image-fast', name: 'Fast Picture', capabilities: ['image.generate'] },
    { id: 'rig-chat-extra', name: 'Other Chat', capabilities: ['chat.completions'] },
    { id: 'rig-chat-literal', name: 'Protocol collision', capabilities: ['chat.completions'] },
    { id: 'Pengbao', name: 'Label collision', capabilities: ['chat.completions'] }
  )
  service.catalog = async () => catalog
  const mapping = { ...IMAGE_PROPOSAL, capabilities: [...IMAGE_PROPOSAL.capabilities, 'video.generate'], writes: [...IMAGE_PROPOSAL.writes, {
    path: ['channels', '$append'], value: {
      id: { $semantic: 'binding-id' }, name: { $semantic: 'label' }, apiUrl: { $semantic: 'endpoint' }, protocol: 'rig-chat-literal',
      models: [{ alias: { $semantic: 'image-model' }, id: { $semantic: 'image-model' } }],
      videoModels: [{ alias: { $semantic: 'video-model' }, id: { $semantic: 'video-model' } }]
    }, evidenceIds: ['e1']
  }] }
  ctx.llm.stream = () => (async function* () {
    yield { type: 'text-delta', text: JSON.stringify(mapping) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  const controller = createPluginConfigurationController(ctx, service)
  try {
    await installPluginConfigurationRuntime(ctx)
    const analysis = await controller.analyze({ entryId: 'fixture-chat' })
    const channel = analysis.writes.find(write => write.path[0] === 'channels').value
    assert.equal(channel.name, 'Pengbao')
    assert.deepEqual(channel.models, [
      { alias: 'rig-image', id: 'rig-image' },
      { alias: 'rig-image-fast', id: 'rig-image-fast' }
    ])
    assert.equal(analysis.writes.find(write => write.path[0] === 'imageModel').value, 'rig-image')
    const applied = await controller.apply({ planId: analysis.planId })
    assert.deepEqual(entry.options.config.channels[0].models, channel.models)
    const [binding] = await readPluginConfigurations(profileDir)
    assert.deepEqual(binding.policy.models, ['rig-chat', 'rig-image', 'rig-image-fast', 'seedance-fixture', 'wan-fixture'])
    assert.deepEqual(channel.videoModels, [{ alias: 'seedance-fixture', id: 'seedance-fixture' }, { alias: 'wan-fixture', id: 'wan-fixture' }])
    await controller.rollback({ receiptId: applied.receiptId })
    assert.equal(entry.options.config, undefined)
  } finally {
    controller.dispose()
    for (const cleanup of effects) await cleanup()
    await rm(root, { recursive: true, force: true })
  }
}

test('analyze, apply, and rollback keep markers in the profile layer and compare absent config as empty', async t => {
  const broker = await gateway()
  registerPrivatePluginConfiguration(broker.registration)
  try {
    await t.test('request cancellation aborts analysis during model streaming without saving or retry', async () => {
      const f = await fixture()
      const controller = createPluginConfigurationController(f.ctx, f.service)
      let started
      const entered = new Promise(resolve => { started = resolve })
      let modelSignal, calls = 0
      f.ctx.llm.stream = options => { modelSignal = options.signal; calls++; started(); return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: async () => ({ done: true }) }) } }
      const abort = new AbortController()
      try {
        await installPluginConfigurationRuntime(f.ctx)
        const pending = controller.analyze({ entryId: 'fixture-chat' }, { signal: abort.signal })
        const rejected = assert.rejects(pending, { code: 'ANALYSIS_CANCELLED' })
        await entered
        abort.abort()
        await Promise.race([rejected, new Promise((_, reject) => setTimeout(() => reject(new Error('Request cancellation did not stop analysis')), 300))])
        assert.equal(modelSignal.aborted, true)
        assert.equal(calls, 1)
        assert.equal(f.entry.options.config, undefined)
      } finally {
        controller.dispose()
        for (const cleanup of f.effects) await cleanup()
        await rm(f.root, { recursive: true, force: true })
      }
    })
    await t.test('overview reads the same private video broker as plugin configuration', async () => {
      const f = await fixture()
      const overview = createModelServiceConnections(f.ctx, f.service)
      try {
        await installPluginConfigurationRuntime(f.ctx)
        const view = await overview.overview()
        assert.deepEqual(view.video.models, [
          { id: 'seedance-fixture', name: 'Seedance', provider: 'volcengine', protocol: 'ark' },
          { id: 'wan-fixture', name: 'Wan', provider: 'alibaba', protocol: 'dashscope' }
        ])
        assert.equal(view.video.available, true)
        assert.equal(JSON.stringify(view).includes(token('b')), false)
      } finally {
        overview.dispose()
        for (const cleanup of f.effects) await cleanup()
        await rm(f.root, { recursive: true, force: true })
      }
    })
    await t.test('missing video models degrade to chat/image configuration instead of failing the plan', async () => {
      broker.setVideoRows([])
      try {
        await scenario({ video: true, apply: async (controller, entry, profileDir) => {
          const analysis = await controller.analyze({ entryId: 'fixture-chat' })
          assert.deepEqual(analysis.capabilities, ['chat.completions'])
          assert.equal(analysis.writes.some(write => write.path[0] === 'videoModel'), false)
          const applied = await controller.apply({ planId: analysis.planId })
          assert.equal(applied.status, 'saved-active')
          assert.deepEqual(entry.options.config, await expectedConfig(profileDir, 'rig-chat'))
          const [binding] = await readPluginConfigurations(profileDir)
          assert.deepEqual(binding.policy.capabilities, ['chat.completions'])
          await controller.rollback({ receiptId: applied.receiptId })
          assert.equal(entry.options.config, undefined)
        } })
      } finally {
        broker.setVideoRows([
          { id: 'seedance-fixture', name: 'Seedance', provider: 'volcengine', protocol: 'ark' },
          { id: 'wan-fixture', name: 'Wan', provider: 'alibaba', protocol: 'dashscope' }
        ])
      }
    })
    await t.test('model collections expose every authorized image model while scalar fields retain defaults', modelCollectionScenario)

  await t.test('existing image channels are pruned to the tagged image catalog', async () => {
    const { root, profileDir, entry, ctx, service, effects } = await fixture({ image: true, collections: true })
    const catalog = await service.catalog()
    catalog.models.push({ id: 'rig-image-fast', name: 'Fast Picture', capabilities: ['image.generate'] })
    service.catalog = async () => catalog
    entry.options.config = { channels: [{
      id: 'legacy', name: 'Pengbao', apiUrl: 'https://legacy.invalid/v1', apiKey: 'fixture', protocol: 'rig-chat-literal',
      models: [
        { alias: 'rig-chat', id: 'rig-chat' },
        { alias: 'rig-image', id: 'rig-image' },
        { alias: 'rig-image-fast', id: 'rig-image-fast' },
        { alias: 'seedance-fixture', id: 'seedance-fixture' }
      ]
    }] }
    const mapping = { ...IMAGE_PROPOSAL, writes: [...IMAGE_PROPOSAL.writes, {
      path: ['channels', '$append'], value: {
        id: { $semantic: 'binding-id' }, name: { $semantic: 'label' }, apiUrl: { $semantic: 'endpoint' }, protocol: 'rig-chat-literal',
        models: [{ alias: { $semantic: 'image-model' }, id: { $semantic: 'image-model' } }]
      }, evidenceIds: ['e1']
    }] }
    ctx.llm.stream = () => (async function* () {
      yield { type: 'text-delta', text: JSON.stringify(mapping) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
    const controller = createPluginConfigurationController(ctx, service)
    try {
      await installPluginConfigurationRuntime(ctx)
      const analysis = await controller.analyze({ entryId: 'fixture-chat' })
      await controller.apply({ planId: analysis.planId })
      assert.deepEqual(entry.options.config.channels[0].models, [
        { alias: 'rig-image', id: 'rig-image' },
        { alias: 'rig-image-fast', id: 'rig-image-fast' }
      ])
    } finally {
      controller.dispose()
      for (const cleanup of effects) await cleanup()
      await rm(root, { recursive: true, force: true })
    }
  })
    await t.test('large bundle changes inside or outside snippets invalidate approval without config writes', async t => {
      await staleApprovalTests(t, broker)
    })
    await t.test('chat-only catalog applies one chat model', async () => {
      const before = broker.counts()
      await scenario({ apply: async (controller, entry, profileDir) => {
        const analysis = await controller.analyze({ entryId: 'fixture-chat' })
        assert.equal(analysis.entryId, 'fixture-chat')
        assert.deepEqual(analysis.capabilities, ['chat.completions'])
        assert.deepEqual(analysis.writes.map(write => write.path), [['baseUrl'], ['apiKey'], ['model']])
        assert.equal(JSON.stringify(analysis.writes).includes('pengbao-runtime:'), false)

        const applied = await controller.apply({ planId: analysis.planId })
        assert.equal(applied.status, 'saved-active')
        // Unlike the fake editor, the real ConfigEditor persists the raw candidate;
        // this proves no materialized runtime value reached the profile layer.
        assert.deepEqual(entry.options.config, await expectedConfig(profileDir, 'rig-chat'))
        assert.ok(broker.counts().issued > before.issued)

        // The fixture began without a stored config, so rollback returns the entry
        // to options.config === undefined. Verification must treat that as {} and
        // succeed instead of hashing undefined.
        const rolledBack = await controller.rollback({ receiptId: applied.receiptId })
        assert.equal(rolledBack.status, 'rolled-back')
        assert.equal(entry.options.config, undefined)
        assert.deepEqual(await readPluginConfigurations(profileDir), [])
        assert.equal(broker.counts().revoked, before.revoked + 1)
      } })
    })

    await t.test('chat and image catalog applies both server defaults', async () => {
      const before = broker.counts()
      await scenario({ image: true, apply: async (controller, entry, profileDir) => {
        const analysis = await controller.analyze({ entryId: 'fixture-chat' })
        assert.deepEqual(analysis.capabilities, ['chat.completions', 'image.generate'])
        assert.deepEqual(analysis.writes.map(write => write.path), [['baseUrl'], ['apiKey'], ['model'], ['imageModel']])
        assert.equal(JSON.stringify(analysis.writes).includes('pengbao-runtime:'), false)
        assert.equal(JSON.stringify(analysis.writes).includes('rig-image'), true)

        const applied = await controller.apply({ planId: analysis.planId })
        assert.equal(applied.status, 'saved-active')
        assert.deepEqual(entry.options.config, await expectedConfig(profileDir, 'rig-chat', 'rig-image'))

        const rolledBack = await controller.rollback({ receiptId: applied.receiptId })
        assert.equal(rolledBack.status, 'rolled-back')
        assert.equal(entry.options.config, undefined)
        assert.deepEqual(await readPluginConfigurations(profileDir), [])
        assert.equal(broker.counts().revoked, before.revoked + 1)
      } })
    })
  } finally {
    await broker.close()
  }
})
