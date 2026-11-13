import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fsPromises, { realpath } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
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

const chatProposal = ids => ({ contractVersion: 1, protocol: 'openai', capabilities: ['chat.completions'], writes: [
  { path: ['endpoint'], value: { $semantic: 'endpoint' }, evidenceIds: ids },
  { path: ['credential', '$binding-id'], value: { token: { $semantic: 'credential' } }, evidenceIds: ids },
  { path: ['chatModel'], value: { $semantic: 'chat-model' }, evidenceIds: ids }
] })

function offlineModel(requests, answer = chatProposal(['e2'])) {
  return { stream(request) {
    requests.push(request)
    return (async function* () {
      yield { type: 'text-delta', text: JSON.stringify(answer) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  } }
}

// Dropping oversized sources, hashing only excerpts, or using character offsets
// instead of byte offsets must each break this observable evidence contract.
test('extracts deterministic byte-ranged evidence from 1 MiB server and 3.5 MiB client bundles', async t => {
  const { ctx, root } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'profiles/web/node_modules/fixture-provider')
  const sources = new Map()
  for (const [path, size, marker, offset] of [
    ['index.js', 1024 * 1024, 'fetch(config.endpoint + "/chat/completions", {model: config.chatModel})', 64 * 1024 - 20],
    ['client.js', 3.5 * 1024 * 1024, 'const Config = {credential: "schema-only"}; /* 客户端实现 */', 3 * 1024 * 1024]
  ]) {
    const source = Buffer.alloc(size, 120)
    source.write(marker, offset)
    // UTF-8 at both potential excerpt boundaries must not produce replacements.
    for (const position of [offset - 2049, offset + 2046]) source.write('界', position)
    sources.set(path, source)
    await writeFile(join(packageRoot, path), source)
  }
  const evidence = await collectPluginEvidence(ctx, 'fixture-provider')
  assert.deepEqual(evidence.files.map(file => file.path), ['package.json', 'index.js', 'client.js'])
  for (const file of evidence.files.slice(1)) {
    const source = sources.get(file.path)
    assert.equal(file.bytes, source.length)
    assert.equal(file.digest, createHash('sha256').update(source).digest('hex'))
    assert.equal(file.truncated, true)
    assert.ok(file.ranges.length > 0 && file.ranges.length <= 8)
    assert.equal(file.text, file.ranges.map(({ start, end }) => {
      assert.ok(start >= 0 && end <= source.length && end > start && end - start <= 4096)
      return source.subarray(start, end).toString('utf8')
    }).join('\n'))
    assert.equal(file.text.includes('�'), false)
    assert.ok(Buffer.byteLength(file.text) <= 8 * 4096 + 7)
  }
  assert.match(evidence.files[1].text, /\/chat\/completions/)
  assert.match(evidence.files[2].text, /schema-only/)
  assert.deepEqual(await collectPluginEvidence(ctx, 'fixture-provider'), evidence)
  const requests = []
  await analyzePluginConfiguration({ ...ctx, llm: offlineModel(requests) }, evidence,
    { selection: { provider: 'pengbao', model: 'offline' } })
  const payloadText = requests[0].messages[0].content[0].text
  const payload = JSON.parse(payloadText)
  assert.match(payloadText, /\/chat\/completions/)
  assert.deepEqual(payload.files[1].ranges, evidence.files[1].ranges)
  assert.equal(payload.files[1].bytes, 1024 * 1024)
  assert.equal(payload.files[1].truncated, true)
  assert.equal(payloadText.includes(root), false)
  assert.equal(payloadText.includes('secret-from-host'), false)
  assert.ok(Buffer.byteLength(payloadText) <= 256 * 1024)
})

test('bounds serialized model evidence including schema, escaping and complete manifest', async t => {
  const { ctx, root } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'profiles/web/node_modules/fixture-provider')
  // Each source fits the old text budget, but JSON escaping does not.
  for (const path of ['index.js', 'client.js', 'config.js', 'schema.js']) {
    await writeFile(join(packageRoot, path), 'config.endpoint;' + '\\'.repeat(60 * 1024))
  }
  const evidence = await collectPluginEvidence(ctx, 'fixture-provider')
  const requests = []
  await analyzePluginConfiguration({ ...ctx, llm: offlineModel(requests) }, evidence,
    { selection: { provider: 'pengbao', model: 'offline' } })
  const text = requests[0].messages[0].content[0].text
  assert.ok(Buffer.byteLength(text) <= 256 * 1024, `serialized bytes: ${Buffer.byteLength(text)}`)
  const payload = JSON.parse(text)
  assert.equal(payload.files[0].text, evidence.files[0].text)
  assert.equal(payload.files[0].truncated, false)
  assert.ok(payload.files.slice(1).some(file => file.text.includes('config.endpoint')))
  assert.ok(evidence.files.length <= 12)
  assert.ok(evidence.files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0) <= 256 * 1024)
})

test('trims model materials deterministically while preserving complete manifest and rejecting removed evidence ids', async t => {
  const { ctx, root } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'profiles/web/node_modules/fixture-provider')
  const paths = Array.from({ length: 14 }, (_, index) => `config-${String(index).padStart(2, '0')}.js`)
  const manifest = JSON.stringify({ name: 'fixture-provider', version: '1.2.3', main: 'index.js',
    exports: Object.fromEntries(paths.map(path => [`./${path}`, `./${path}`])) })
  await writeFile(join(packageRoot, 'package.json'), manifest)
  const source = Buffer.alloc(128 * 1024, 92) // Backslashes double in serialized JSON.
  for (const [index, anchor] of ['endpoint', 'credential', 'chatModel', 'Config', 'openai',
    '/chat/completions', '/images/generations', '/images/edits', 'Authorization', 'Bearer '].entries()) {
    source.write(anchor, 2048 + index * 12 * 1024)
  }
  for (const path of ['index.js', ...paths]) await writeFile(join(packageRoot, path), source)
  const evidence = await collectPluginEvidence(ctx, 'fixture-provider')
  assert.ok(evidence.files.length <= 12)
  assert.ok(evidence.files.reduce((bytes, file) => bytes + Buffer.byteLength(file.text), 0) <= 256 * 1024)
  const requests = []
  await analyzePluginConfiguration({ ...ctx, llm: offlineModel(requests) }, evidence,
    { selection: { provider: 'pengbao', model: 'offline' } })
  const first = requests[0].messages[0].content[0].text
  const payload = JSON.parse(first)
  assert.ok(Buffer.byteLength(first) <= 256 * 1024)
  assert.equal(payload.files[0].text, manifest)
  assert.ok(payload.files.length < evidence.files.length || payload.files.at(-1).ranges.length < evidence.files.find(file => file.id === payload.files.at(-1).id).ranges.length,
    'serialization overhead must trim a source file or range')
  await analyzePluginConfiguration({ ...ctx, llm: offlineModel(requests) }, evidence,
    { selection: { provider: 'pengbao', model: 'offline' } })
  assert.equal(requests[1].messages[0].content[0].text, first)
  const removedId = evidence.files.find(file => !payload.files.some(sent => sent.id === file.id)).id
  const original = console.warn
  console.warn = () => {}
  try {
    await assert.rejects(() => analyzePluginConfiguration({ ...ctx, llm: offlineModel([], chatProposal([removedId])) }, evidence,
      { selection: { provider: 'pengbao', model: 'offline' } }), { code: 'INVALID_PROPOSAL' })
  } finally { console.warn = original }
})

test('rejects a schema and complete manifest that cannot fit serialized evidence before invoking the model', async t => {
  const { ctx, entry, root } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  entry.fiber.runtime.Config = z.object({ endpoint: z.string(), credential: z.string().role('secret'),
    chatModel: z.string(), protocol: z.const('\\'.repeat(140 * 1024)) })
  const evidence = await collectPluginEvidence(ctx, 'fixture-provider')
  const requests = []
  await assert.rejects(() => analyzePluginConfiguration({ ...ctx, llm: offlineModel(requests) }, evidence,
    { selection: { provider: 'pengbao', model: 'offline' } }), { code: 'EVIDENCE_UNAVAILABLE' })
  assert.equal(requests.length, 0)
})

test('requires every manifest executable entrypoint when a sibling config file has usable anchors', async t => {
  const { ctx, root } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'profiles/web/node_modules/fixture-provider')
  await rm(join(packageRoot, 'index.js'))
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'fixture-provider', version: '1.2.3', main: 'server.js' }))
  await writeFile(join(packageRoot, 'server.js'), Buffer.alloc(8 * 1024 * 1024 + 1, 120))
  await writeFile(join(packageRoot, 'config.js'), 'config.endpoint + "/chat/completions"')
  await assert.rejects(() => collectPluginEvidence(ctx, 'fixture-provider'), { code: 'EVIDENCE_UNAVAILABLE' })
})

// Omitting exports-only runtime targets would allow changed executable code to
// retain the same approval identity even when a readable config sibling exists.
test('rejects an oversized exports-only executable rather than approving only its config sibling', async t => {
  const { ctx, root } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'profiles/web/node_modules/fixture-provider')
  await rm(join(packageRoot, 'index.js'))
  await mkdir(join(packageRoot, 'dist'))
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'fixture-provider', version: '1.2.3',
    exports: { '.': './dist/server.js' } }))
  await writeFile(join(packageRoot, 'dist/server.js'), Buffer.alloc(8 * 1024 * 1024 + 1, 120))
  await writeFile(join(packageRoot, 'config.js'), 'config.endpoint + "/chat/completions"')
  await assert.rejects(() => collectPluginEvidence(ctx, 'fixture-provider'), { code: 'EVIDENCE_UNAVAILABLE' })
})

test('binds conditional root export fallback targets to the evidence identity', async t => {
  const { ctx, root } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'profiles/web/node_modules/fixture-provider')
  await rm(join(packageRoot, 'index.js'))
  await mkdir(join(packageRoot, 'dist'))
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'fixture-provider', version: '1.2.3',
    exports: { '.': { import: ['./dist/server.mjs', './dist/fallback.mjs'], require: './dist/server.cjs' } } }))
  for (const path of ['server.mjs', 'fallback.mjs', 'server.cjs']) {
    await writeFile(join(packageRoot, 'dist', path), 'config.endpoint')
  }
  const before = await collectPluginEvidence(ctx, 'fixture-provider')
  assert.deepEqual(before.files.map(file => file.path), ['package.json', 'dist/server.mjs', 'dist/fallback.mjs', 'dist/server.cjs'])
  await writeFile(join(packageRoot, 'dist/fallback.mjs'), 'changed: config.endpoint')
  const after = await collectPluginEvidence(ctx, 'fixture-provider')
  assert.notEqual(before.identity.evidenceDigest, after.identity.evidenceDigest)
})

test('keeps a readable anchor-free bootstrap when it fits the evidence budget', async t => {
  const { ctx, root } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'profiles/web/node_modules/fixture-provider')
  const source = `export { default } from './runtime.js'; /*${'x'.repeat(5 * 1024)}*/`
  await writeFile(join(packageRoot, 'index.js'), source)
  await writeFile(join(packageRoot, 'config.js'), 'config.endpoint + "/chat/completions"')
  const evidence = await collectPluginEvidence(ctx, 'fixture-provider')
  const bootstrap = evidence.files.find(file => file.path === 'index.js')
  assert.equal(bootstrap.text, source)
  assert.equal(bootstrap.truncated, false)
  assert.equal(bootstrap.digest, createHash('sha256').update(source).digest('hex'))
})

test('collects required server and client before optional subpath exports exhaust allocation', async t => {
  const { ctx, root } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'profiles/web/node_modules/fixture-provider')
  const paths = Array.from({ length: 23 }, (_, index) => `extra-${index}.js`)
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'fixture-provider', version: '1.2.3',
    main: 'index.js', exports: Object.fromEntries(paths.map(path => [`./${path}`, `./${path}`])), dsh: { client: 'ui.js' } }))
  for (const path of [...paths, 'ui.js']) await writeFile(join(packageRoot, path), 'config.endpoint')
  const evidence = await collectPluginEvidence(ctx, 'fixture-provider')
  assert.ok(evidence.files.some(file => file.path === 'index.js'))
  assert.ok(evidence.files.some(file => file.path === 'ui.js'))
  assert.ok(evidence.files.length <= 12)
})

test('does not rescan duplicate candidate spellings and spend the aggregate scan budget twice', async t => {
  const { ctx, root } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'profiles/web/node_modules/fixture-provider')
  const manifest = { name: 'fixture-provider', version: '1.2.3', main: 'index.js',
    exports: { './first': './config.js', './second': 'config.js' } }
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest))
  await writeFile(join(packageRoot, 'config.js'), Buffer.alloc(8 * 1024 * 1024, 120))
  await writeFile(join(packageRoot, 'client.js'), 'config.endpoint + "/chat/completions"')
  const evidence = await collectPluginEvidence(ctx, 'fixture-provider')
  assert.ok(evidence.files.some(file => file.path === 'client.js'))
})

test('rejects FIFO candidates without blocking or treating them as evidence', { skip: process.platform === 'win32' }, async t => {
  const { ctx, root } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'profiles/web/node_modules/fixture-provider')
  execFileSync('mkfifo', [join(packageRoot, 'config.js')])
  const evidence = await collectPluginEvidence(ctx, 'fixture-provider')
  assert.equal(evidence.files.some(file => file.path === 'config.js'), false)
})

test('collects regular nested manifest entrypoints without accepting symlink directories', async t => {
  const { ctx, root } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'profiles/web/node_modules/fixture-provider')
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'fixture-provider', version: '1.2.3', main: 'src/index.ts' }))
  await writeFile(join(packageRoot, 'src/index.ts'), 'config.endpoint + "/chat/completions"')
  const evidence = await collectPluginEvidence(ctx, 'fixture-provider')
  assert.ok(evidence.files.some(file => file.path === 'src/index.ts'))
  await rm(join(packageRoot, 'src'), { recursive: true })
  await mkdir(join(root, 'outside'))
  await writeFile(join(root, 'outside/index.ts'), 'config.endpoint')
  await symlink(join(root, 'outside'), join(packageRoot, 'src'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(() => collectPluginEvidence(ctx, 'fixture-provider'), { code: 'EVIDENCE_UNAVAILABLE' })
})

test('never enumerates a symlinked discovery directory outside the package', async t => {
  const { ctx, root } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'profiles/web/node_modules/fixture-provider')
  const outside = join(root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'config-private.js'), 'private-fixture')
  const linked = join(await realpath(packageRoot), 'lib')
  await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
  const originals = { readdir: fsPromises.readdir, opendir: fsPromises.opendir }
  let outsideReads = 0
  for (const name of Object.keys(originals)) fsPromises[name] = async (...args) => {
    if (String(args[0]) === linked) outsideReads++
    return originals[name](...args)
  }
  syncBuiltinESMExports()
  try {
    const evidence = await collectPluginEvidence(ctx, 'fixture-provider')
    assert.equal(outsideReads, 0)
    assert.equal(evidence.files.some(file => file.path.startsWith('lib/')), false)
  } finally {
    Object.assign(fsPromises, originals)
    syncBuiltinESMExports()
  }
})

test('rejects an earlier source changed while a later source is being read', async t => {
  const { ctx, root } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'profiles/web/node_modules/fixture-provider')
  const source = join(packageRoot, 'index.js')
  const later = join(packageRoot, 'client.js')
  await writeFile(later, 'config.endpoint')
  const originalOpen = fsPromises.open
  let changed = false
  fsPromises.open = async (...args) => {
    if (args[0] === await realpath(later) && !changed) {
      changed = true
      await writeFile(source, 'changed implementation: config.endpoint')
    }
    return originalOpen(...args)
  }
  syncBuiltinESMExports()
  try {
    await assert.rejects(() => collectPluginEvidence(ctx, 'fixture-provider'), { code: 'EVIDENCE_CHANGED' })
    assert.equal(changed, true)
  } finally {
    fsPromises.open = originalOpen
    syncBuiltinESMExports()
  }
})

test('keeps evidence at the 8 MiB scan boundary and omits an oversized sibling', async t => {
  const { ctx, root } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'profiles/web/node_modules/fixture-provider')
  const source = Buffer.alloc(8 * 1024 * 1024, 120)
  source.write('config.endpoint + "/chat/completions"', source.length - 100)
  await writeFile(join(packageRoot, 'index.js'), source)
  await writeFile(join(packageRoot, 'client.js'), Buffer.alloc(8 * 1024 * 1024 + 1, 120))
  const evidence = await collectPluginEvidence(ctx, 'fixture-provider')
  assert.deepEqual(evidence.files.map(file => file.path), ['package.json', 'index.js'])
  assert.equal(evidence.files[1].bytes, 8 * 1024 * 1024)
  assert.match(evidence.files[1].text, /\/chat\/completions/)
})

test('fails safely when local per-file or aggregate scan limits leave no implementation evidence', async t => {
  for (const [name, sizes] of [
    ['per-file', [8 * 1024 * 1024 + 1]],
    // The manifest also counts toward the 16 MiB aggregate scan bound.
    ['aggregate', [8 * 1024 * 1024, 8 * 1024 * 1024]]
  ]) await t.test(name, async t => {
    const { ctx, root } = await fixture()
    t.after(() => rm(root, { recursive: true, force: true }))
    const packageRoot = join(root, 'profiles/web/node_modules/fixture-provider')
    for (let index = 0; index < sizes.length; index++) {
      const source = Buffer.alloc(sizes[index], 120)
      if (index > 0) source.write('config.endpoint + "/chat/completions"', source.length - 100)
      await writeFile(join(packageRoot, index === 0 ? 'index.js' : 'client.js'), source)
    }
    await assert.rejects(() => collectPluginEvidence(ctx, 'fixture-provider'), { code: 'EVIDENCE_UNAVAILABLE' })
  })
})

test('rejects a file-symlink executable when the platform permits creating one', async t => {
  const { ctx, root } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'profiles/web/node_modules/fixture-provider')
  await rm(join(packageRoot, 'index.js'))
  await writeFile(join(root, 'outside.js'), 'config.endpoint + "/chat/completions"')
  try {
    await symlink(join(root, 'outside.js'), join(packageRoot, 'index.js'), 'file')
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip('Windows file symlink creation requires Developer Mode or elevation')
      return
    }
    throw error
  }
  await writeFile(join(packageRoot, 'config.js'), 'config.endpoint')
  await assert.rejects(() => collectPluginEvidence(ctx, 'fixture-provider'), { code: 'EVIDENCE_UNAVAILABLE' })
})

test('does not turn binary source or excluded credential files into implementation evidence', async t => {
  const { ctx, root } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'profiles/web/node_modules/fixture-provider')
  await writeFile(join(packageRoot, 'index.js'), Buffer.from('config.endpoint\0/chat/completions'))
  await mkdir(join(packageRoot, 'credentials'))
  await writeFile(join(packageRoot, 'credentials/config.js'), 'config.endpoint + "private-fixture-value"')
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'fixture-provider', version: '1.2.3',
    main: 'index.js', exports: './credentials/config.js' }))
  await assert.rejects(() => collectPluginEvidence(ctx, 'fixture-provider'), { code: 'EVIDENCE_UNAVAILABLE' })
})

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
    assert.equal(warnings.some(line => line.includes('https://literal.invalid')), false)
    assert.match(warnings.join('\\n'), /analysis proposal rejected: INVALID_PROPOSAL: endpoint/)
    // Two rejected answers still surface the opaque code to the client.
    const rejected = { ...ctx, llm: { stream: () => (async function * () {
      yield { type: 'text-delta', text: invalid }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })() } }
    await assert.rejects(() => analyzePluginConfiguration(rejected, evidence,
      { selection: { provider: 'pengbao', model: 'explicit' } }), { code: 'INVALID_PROPOSAL' })
  } finally { console.warn = original }
})
