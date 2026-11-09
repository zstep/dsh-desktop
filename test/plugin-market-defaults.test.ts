import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { composeEntries, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { parse } from 'yaml'
import { DEFAULT_PLUGIN_MARKET_INDEX, ensurePluginMarketDefaults, PLUGIN_MARKET_BUNDLE } from '../src/main/state/plugin-market-defaults'
import { ensureSafeModeProfile, SAFE_MODE_PROFILE } from '../src/main/state/safe-mode-profile'

const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})
async function fixture(manifest?: unknown, patch?: string) {
  const home = await mkdtemp(join(tmpdir(), 'pengbao-plugin-market-'))
  homes.push(home)
  const profile = join(home, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  if (manifest !== undefined) await writeFile(join(profile, 'package.json'), JSON.stringify(manifest))
  if (patch !== undefined) await writeFile(join(profile, 'cordis.patch.yml'), patch)
  return { home, profile }
}
const base = () => ({ name: 'kept', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } })
const load = (profile: string) => loadProfileDirectory('test', profile, resolve(import.meta.dirname, '../node_modules/@deepseek-ai/dsh/package.json'))
const composed = (profile: string) => {
  const loaded = load(profile)
  return composeEntries([...loaded.layers.map(layer => layer.patches), loaded.patches])
}

describe('bundled plugin discovery defaults', () => {
  it('seeds a fresh Profile and composes exactly one service and discovery UI from the shipped bundle', async () => {
    const { home, profile } = await fixture()
    expect(await ensurePluginMarketDefaults(home, resolve(import.meta.dirname, '../node_modules/@deepseek-ai/dsh/lib/bin.js'))).toBe(true)
    const entries = composed(profile)
    expect(entries.filter(row => row.id === 'plugin-market')).toHaveLength(1)
    expect(entries.find(row => row.id === 'plugin-market')?.config).toEqual({ indexes: [DEFAULT_PLUGIN_MARKET_INDEX] })
    expect(entries.filter(row => row.id === 'ui-plugin-market')).toHaveLength(1)
    const before = await readFile(join(profile, 'package.json'), 'utf8')
    expect(await ensurePluginMarketDefaults(home, resolve(import.meta.dirname, '../node_modules/@deepseek-ai/dsh/lib/bin.js'))).toBe(false)
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe(before)
    await expect(readFile(join(profile, 'pnpm-lock.yaml'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(join(profile, 'desktop-default-plugins.json'), 'utf8')).imagegen).toEqual({ status: 'pending', reason: 'fresh-profile' })
  })

  it('does not infer fresh-install permission from an absent manifest in a nonempty Profile', async () => {
    const { home, profile } = await fixture(undefined, '[]\n')
    await ensurePluginMarketDefaults(home, resolve(import.meta.dirname, '../node_modules/@deepseek-ai/dsh/lib/bin.js'))
    expect(JSON.parse(await readFile(join(profile, 'desktop-default-plugins.json'), 'utf8')).imagegen).toMatchObject({ status: 'skipped' })
  })

  it('retains fresh intent after a crash before publishing the manifest', async () => {
    const { home, profile } = await fixture()
    await writeFile(join(profile, 'desktop-default-plugins.json'), JSON.stringify({ version: 1, imagegen: { status: 'pending', reason: 'fresh-profile' } }))
    await ensurePluginMarketDefaults(home, resolve(import.meta.dirname, '../node_modules/@deepseek-ai/dsh/lib/bin.js'))
    expect(JSON.parse(await readFile(join(profile, 'desktop-default-plugins.json'), 'utf8')).imagegen.status).toBe('pending')
  })

  it.each(['[https://company.example/index.json]', '[]'])('preserves user indexes %s, comments, expressions and other manifest metadata', async indexes => {
    const manifest = { ...base(), custom: { kept: true } }
    const patch = `# Keep me\n- id: plugin-market\n  config:\n    indexes: ${indexes}\n- id: unrelated\n  disabled: !!js "!ctx.get('example')"\n`
    const { home, profile } = await fixture(manifest, patch)
    await ensurePluginMarketDefaults(home, resolve(import.meta.dirname, '../node_modules/@deepseek-ai/dsh/lib/bin.js'))
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toBe(patch)
    expect(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')).custom).toEqual({ kept: true })
  })

  it('does not overwrite home-level market configuration or duplicate an enabled bundle', async () => {
    const manifest = base()
    manifest.dsh.profile.bundles.push(PLUGIN_MARKET_BUNDLE)
    const { home, profile } = await fixture(manifest, '[]\n')
    await writeFile(join(home, 'cordis.patch.yml'), '- id: plugin-market\n  config:\n    indexes: []\n')
    await ensurePluginMarketDefaults(home, resolve(import.meta.dirname, '../node_modules/@deepseek-ai/dsh/lib/bin.js'))
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
    expect(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')).dsh.profile.bundles.filter((name: string) => name === PLUGIN_MARKET_BUNDLE)).toHaveLength(1)
  })

  it('retains package disable state and never re-enables a later user selection', async () => {
    const { home, profile } = await fixture(base(), '[]\n')
    await mkdir(join(profile, '.dsh-market'))
    const state = JSON.stringify({ disabled: [PLUGIN_MARKET_BUNDLE] })
    await writeFile(join(profile, '.dsh-market', 'state.json'), state)
    await ensurePluginMarketDefaults(home, resolve(import.meta.dirname, '../node_modules/@deepseek-ai/dsh/lib/bin.js'))
    expect(composed(profile).some(row => row.id === 'plugin-market')).toBe(false)
    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name: string) => name !== PLUGIN_MARKET_BUNDLE)
    await writeFile(join(profile, 'package.json'), JSON.stringify(manifest))
    await writeFile(join(profile, 'cordis.patch.yml'), '- id: plugin-market\n  config:\n    indexes: []\n')
    expect(await ensurePluginMarketDefaults(home, resolve(import.meta.dirname, '../node_modules/@deepseek-ai/dsh/lib/bin.js'))).toBe(false)
    expect(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')).dsh.profile.bundles).not.toContain(PLUGIN_MARKET_BUNDLE)
    expect(await readFile(join(profile, '.dsh-market', 'state.json'), 'utf8')).toBe(state)
  })

  it('preserves a valid expression patch and leaves Safe Mode free of market components', async () => {
    const { home, profile } = await fixture(base(), '# user comment\n- id: ui-sidebar-browser\n  disabled: !!js "false"\n')
    await ensurePluginMarketDefaults(home, resolve(import.meta.dirname, '../node_modules/@deepseek-ai/dsh/lib/bin.js'))
    const patch = await readFile(join(profile, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('# user comment')
    expect(patch).toContain('!!js')
    expect(parse(patch, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })).toHaveLength(2)
    await ensureSafeModeProfile(home)
    const entries = composed(join(home, 'profiles', SAFE_MODE_PROFILE))
    expect(entries.some(row => ['plugin-market', 'ui-plugin-market'].includes(row.id ?? ''))).toBe(false)
  })

  it('retries a patch-only interrupted initialization without duplicating or replacing the config', async () => {
    const patch = `- id: plugin-market\n  config:\n    indexes: [${DEFAULT_PLUGIN_MARKET_INDEX}]\n`
    const { home, profile } = await fixture(base(), patch)
    await ensurePluginMarketDefaults(home, resolve(import.meta.dirname, '../node_modules/@deepseek-ai/dsh/lib/bin.js'))
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toBe(patch)
    expect(composed(profile).filter(row => row.id === 'plugin-market')).toHaveLength(1)
  })

  it('does not mutate a Profile when the running installation lacks the shipped market bundle', async () => {
    const { home, profile } = await fixture(base(), '[]\n')
    const before = await readFile(join(profile, 'package.json'), 'utf8')
    await expect(ensurePluginMarketDefaults(home, join(home, 'missing-install', 'lib', 'bin.js'))).rejects.toThrow()
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe(before)
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
  })

  it.each(['not: a-list\n', '- id: [\n'])('does not publish a manifest or marker for malformed YAML', async patch => {
    const { home, profile } = await fixture(base(), patch)
    const previous = await readFile(join(profile, 'package.json'), 'utf8')
    await expect(ensurePluginMarketDefaults(home, resolve(import.meta.dirname, '../node_modules/@deepseek-ai/dsh/lib/bin.js'))).rejects.toThrow('valid Profile patch list')
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe(previous)
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toBe(patch)
  })
})
