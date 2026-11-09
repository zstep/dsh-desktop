import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readPluginConfigurationPolicies } from '../src/main/enterprise/plugin-configuration-policies'

const roots: string[] = []
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const policy = {
  bindingId: 'binding-one',
  entryId: 'plugin-one',
  packageName: 'fixture-plugin',
  packageVersion: '1.0.0',
  capabilities: ['chat.completions'],
  models: ['chosen']
} as const

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(options: { disabled?: boolean; hostile?: boolean; unconfigured?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-policy-'))
  roots.push(root)
  const home = join(root, 'home')
  const profile = join(home, 'profiles', 'web')
  const host = join(root, 'host')
  const plugin = join(host, 'node_modules', policy.packageName)
  const overlay = join(root, 'overlay.yml')
  await mkdir(profile, { recursive: true })
  await mkdir(plugin, { recursive: true })
  await writeFile(join(host, 'package.json'), '{}')
  await writeFile(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
  const manifest = JSON.stringify({ name: policy.packageName, version: policy.packageVersion, main: 'index.js' })
  await writeFile(join(plugin, 'package.json'), manifest)
  await writeFile(join(plugin, 'index.js'), 'export default {}\n')
  const config = { endpoint: 'https://example.invalid', model: 'chosen' }
  const patch = options.hostile
    ? '- insert:\n    - id: plugin-one\n      name: fixture-plugin\n      disabled: !!js "process.exit(42)"\n      config: {}\n'
    : `- insert:\n    - id: plugin-one\n      name: fixture-plugin\n      ${options.disabled ? 'disabled: true\n      ' : ''}${options.unconfigured ? '' : `config: ${JSON.stringify(config)}\n`}`
  await writeFile(overlay, patch)
  const files = [{ path: 'package.json', digest: hash(manifest) }, { path: 'index.js', digest: hash('export default {}\n') }]
  const schemaDigest = '1'.repeat(64)
  const evidenceDigest = hash(JSON.stringify({ schemaDigest, files }))
  const binding = {
    identity: { bindingId: policy.bindingId, entryId: policy.entryId, namespace: policy.entryId, packageName: policy.packageName,
      packageVersion: policy.packageVersion, revision: 0, schemaDigest, evidenceDigest },
    policy,
    files,
    // The runtime exposes an absent plugin config as `{}`; the assistant binds that empty raw value.
    configDigest: hash(JSON.stringify(options.unconfigured ? {} : config))
  }
  await writeFile(join(profile, '.pengbao-plugin-configurations.json'), JSON.stringify({ contractVersion: 1, bindings: [binding] }))
  const read = () => readPluginConfigurationPolicies({ dshHome: home, profile: 'web', hostModuleAnchor: join(host, 'package.json'), overlayPaths: [overlay] })
  return { root, home, profile, host, plugin, overlay, read, binding }
}

describe('persisted plugin configuration policy reader', () => {
  it('grants only an enabled entry whose raw config and evidence still match', async () => {
    const f = await fixture()
    expect(await f.read()).toEqual([policy])
    const reasons: string[] = []
    const read = (bindingId?: string) => readPluginConfigurationPolicies({ dshHome: f.home, profile: 'web', hostModuleAnchor: join(f.host, 'package.json'), overlayPaths: [f.overlay],
      onReject: (reason, rejectedBinding) => { reasons.push(`${rejectedBinding ?? ''}:${reason}`) } })
    await writeFile(join(f.plugin, 'index.js'), 'changed\n')
    expect(await read()).toEqual([])
    expect(reasons).toEqual([`${policy.bindingId}:evidence-digest`])
  })

  it('fails closed for disabled, hostile, and Safe Mode entries', async () => {
    expect(await (await fixture({ disabled: true })).read()).toEqual([])
    expect(await (await fixture({ hostile: true })).read()).toEqual([])
    const f = await fixture()
    expect(await readPluginConfigurationPolicies({ dshHome: f.home, profile: 'desktop-safe-mode', hostModuleAnchor: join(f.host, 'package.json'), overlayPaths: [f.overlay] })).toEqual([])
  })

  it('rejects a changed full raw config even when package evidence is unchanged', async () => {
    const f = await fixture()
    await writeFile(f.overlay, '- insert:\n    - id: plugin-one\n      name: fixture-plugin\n      config: { endpoint: https://example.invalid, model: other }\n')
    expect(await f.read()).toEqual([])
  })

  it('uses bundle/profile/home/final overlays in Loader order and honors disabled parents', async () => {
    const f = await fixture()
    const bundle = join(f.host, 'node_modules', 'fixture-bundle')
    await mkdir(bundle)
    await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'fixture-bundle', version: '1.0.0', dsh: { bundle: { patch: 'patch.yml' } } }))
    await writeFile(join(f.profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['fixture-bundle'] } } }))
    await writeFile(join(bundle, 'patch.yml'), '- insert:\n    - id: parent\n      group: true\n      config:\n        - id: plugin-one\n          name: fixture-plugin\n          config: { endpoint: https://example.invalid, model: chosen }\n')
    await writeFile(f.overlay, '[]')
    expect(await f.read()).toEqual([policy])
    await writeFile(join(f.profile, 'cordis.patch.yml'), '- id: parent\n  disabled: true\n')
    expect(await f.read()).toEqual([])
    await writeFile(join(f.home, 'cordis.patch.yml'), '- id: parent\n  disabled: false\n')
    expect(await f.read()).toEqual([policy])
    await writeFile(f.overlay, '- id: plugin-one\n  name: wrong-name\n  disabled: true\n')
    expect(await f.read()).toEqual([policy])
    await writeFile(f.overlay, '- id: plugin-one\n  disabled: true\n')
    expect(await f.read()).toEqual([])
    await writeFile(f.overlay, '[]')
    await mkdir(join(f.profile, '.dsh-market'))
    await writeFile(join(f.profile, '.dsh-market', 'state.json'), JSON.stringify({ disabled: ['fixture-bundle'] }))
    expect(await f.read()).toEqual([])
  })

  it('does not trust matching dynamic configs or duplicate entry IDs', async () => {
    const f = await fixture()
    const config = { model: { __jsExpr: 'process.exit(42)' } }
    await writeFile(f.overlay, '- insert:\n    - id: plugin-one\n      name: fixture-plugin\n      config:\n        model: !!js "process.exit(42)"\n')
    await writeFile(join(f.profile, '.pengbao-plugin-configurations.json'), JSON.stringify({ contractVersion: 1, bindings: [{ ...f.binding, configDigest: hash(JSON.stringify(config)) }] }))
    const reasons: string[] = []
    expect(await readPluginConfigurationPolicies({ dshHome: f.home, profile: 'web', hostModuleAnchor: join(f.host, 'package.json'), overlayPaths: [f.overlay],
      onReject: (reason, bindingId) => { reasons.push(`${bindingId ?? ''}:${reason}`) } })).toEqual([])
    expect(reasons).toEqual([`${policy.bindingId}:config-dynamic`])
    const g = await fixture()
    await writeFile(join(g.profile, 'cordis.patch.yml'), '- insert:\n    - id: plugin-one\n      name: fixture-plugin\n      disabled: true\n      config: {}\n')
    expect(await g.read()).toEqual([])
  })

  it('rejects escaped evidence paths, malformed records, and redirected approval stores', async () => {
    const f = await fixture()
    const store = join(f.profile, '.pengbao-plugin-configurations.json')
    const write = (binding: unknown) => writeFile(store, JSON.stringify({ contractVersion: 1, bindings: [binding] }))
    await write({ ...f.binding, files: [{ path: '../outside.js', digest: 'a'.repeat(64) }] })
    expect(await f.read()).toEqual([])
    await write({ ...f.binding, priorConfigDigest: f.binding.configDigest })
    expect(await f.read()).toEqual([])
    const outside = join(f.root, 'approval.json')
    await writeFile(outside, JSON.stringify({ contractVersion: 1, bindings: [f.binding] }))
    await rm(store)
    await symlink(outside, store)
    expect(await f.read()).toEqual([])
  })

  it('approves a linked package installed in the profile with a user-layer override', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-policy-'))
    roots.push(root)
    const home = join(root, 'home')
    const profile = join(home, 'profiles', 'web')
    const host = join(root, 'host')
    const store = join(root, 'store', policy.packageName)
    const bundle = join(host, 'node_modules', 'fixture-bundle')
    await mkdir(profile, { recursive: true })
    await mkdir(join(profile, 'node_modules'), { recursive: true })
    await mkdir(host, { recursive: true })
    await mkdir(store, { recursive: true })
    await mkdir(bundle, { recursive: true })
    const manifest = JSON.stringify({ name: policy.packageName, version: policy.packageVersion, main: 'index.js' })
    await writeFile(join(store, 'package.json'), manifest)
    await writeFile(join(store, 'index.js'), 'export default {}\n')
    await symlink(store, join(profile, 'node_modules', policy.packageName))
    await writeFile(join(host, 'package.json'), '{}')
    await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'fixture-bundle', version: '1.0.0', dsh: { bundle: { patch: 'patch.yml' } } }))
    await writeFile(join(bundle, 'patch.yml'), '- insert:\n    - id: plugin-one\n      name: fixture-plugin\n      config: { endpoint: https://example.invalid, model: chosen }\n')
    await writeFile(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['fixture-bundle'] } } }))
    const config = { endpoint: 'https://example.invalid', model: 'chosen' }
    const files = [{ path: 'package.json', digest: hash(manifest) }, { path: 'index.js', digest: hash('export default {}\n') }]
    const schemaDigest = '1'.repeat(64)
    const binding = {
      identity: { bindingId: policy.bindingId, entryId: policy.entryId, namespace: policy.entryId, packageName: policy.packageName,
        packageVersion: policy.packageVersion, revision: 0, schemaDigest, evidenceDigest: hash(JSON.stringify({ schemaDigest, files })) },
      policy,
      files,
      configDigest: hash(JSON.stringify(config))
    }
    await writeFile(join(profile, '.pengbao-plugin-configurations.json'), JSON.stringify({ contractVersion: 1, bindings: [binding] }))
    const read = () => readPluginConfigurationPolicies({ dshHome: home, profile: 'web', hostModuleAnchor: join(host, 'package.json'), overlayPaths: [] })
    expect(await read()).toEqual([policy])
    // ConfigEditor writes the complete raw config into the profile's own patch file.
    await writeFile(join(profile, 'cordis.patch.yml'), '- id: plugin-one\n  name: fixture-plugin\n  config: { endpoint: https://example.invalid, model: chosen }\n')
    expect(await read()).toEqual([policy])
  })

  it('approves a plugin whose effective raw config is empty, matching the runtime value', async () => {
    // The controller reads `entry.options.config ?? {}`, so an entry inserted
    // without any config layer binds `{}`. The reader must compare the same
    // normalized value instead of refusing entries that have no config at all.
    const f = await fixture({ unconfigured: true })
    const reasons: string[] = []
    const read = () => readPluginConfigurationPolicies({ dshHome: f.home, profile: 'web', hostModuleAnchor: join(f.host, 'package.json'), overlayPaths: [f.overlay],
      onReject: reason => { reasons.push(reason) } })
    expect(await read()).toEqual([policy])
    expect(reasons).toEqual([])
    // Any non-empty effective config still has to match the bound digest.
    await writeFile(f.overlay, '- insert:\n    - id: plugin-one\n      name: fixture-plugin\n      config: { model: other }\n')
    expect(await read()).toEqual([])
    expect(reasons).toEqual(['config-digest'])
  })

  it('does not authorize a package/version mismatch or a redirected evidence file', async () => {
    const f = await fixture()
    await writeFile(join(f.plugin, 'package.json'), JSON.stringify({ name: policy.packageName, version: '2.0.0', main: 'index.js' }))
    const reasons: string[] = []
    expect(await readPluginConfigurationPolicies({ dshHome: f.home, profile: 'web', hostModuleAnchor: join(f.host, 'package.json'), overlayPaths: [f.overlay],
      onReject: reason => { reasons.push(reason) } })).toEqual([])
    expect(reasons).toEqual(['package-version'])
    const g = await fixture()
    await rm(join(g.plugin, 'index.js'))
    await symlink(join(g.root, 'outside.js'), join(g.plugin, 'index.js'))
    await writeFile(join(g.root, 'outside.js'), 'export default {}\n')
    expect(await g.read()).toEqual([])
  })
})
