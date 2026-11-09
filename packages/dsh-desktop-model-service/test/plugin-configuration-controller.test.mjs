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
const token = seed => seed.repeat(32).slice(0, 32)

async function fixture({ image = false } = {}) {
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
    `  model: z.string().description('Chat model')${image ? ',' : ''}`,
    ...(image ? ["  imageModel: z.string().description('Image generation model')"] : [])
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
    ...(image ? { imageModel: z.string() } : {})
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
          yield { type: 'text-delta', text: JSON.stringify(image ? IMAGE_PROPOSAL : CHAT_PROPOSAL) }
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
  const server = createServer(async (request, response) => {
    const reply = value => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
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

async function scenario({ image = false, apply }) {
  const { root, profileDir, entry, ctx, service, effects } = await fixture({ image })
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

test('analyze, apply, and rollback keep markers in the profile layer and compare absent config as empty', async t => {
  const broker = await gateway()
  registerPrivatePluginConfiguration(broker.registration)
  try {
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
