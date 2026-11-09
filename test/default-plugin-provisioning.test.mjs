import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { DEFAULT_IMAGE_PLUGIN as name, LEGACY_IMAGE_PLUGIN as legacy, prepareDefaultPluginIntent, provisionDefaultPlugins, readDefaultPluginIntent, retireLegacyImagePlugin } from '../packages/dsh-desktop-market-installer/default-plugins.mjs'

const homes = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'desktop-default-plugin-'))
  homes.push(home)
  const directory = join(home, 'profiles', 'web')
  await mkdir(directory, { recursive: true })
  const manifest = { dependencies: {}, dsh: { profile: { bundles: [] } } }
  const pluginMarket = {
    listIndexes: () => [{ url: 'https://fixture.invalid/index.json' }],
    entry: vi.fn(async () => ({ name, defaultVersion: '2.0.0', versions: [
      { version: '3.0.0', compatibility: { compatible: false }, install: { spec: `${name}@3.0.0` } },
      { version: '2.0.0', compatibility: { compatible: true }, install: { spec: `${name}@2.0.0`, registry: 'https://fixture.invalid' } }
    ] }))
  }
  const pluginManager = {
    listBundles: vi.fn(async () => []),
    installBundle: vi.fn(async () => ({ application: 'restart-required', bundle: name, version: '2.0.0' })),
    cancelInstall: vi.fn(async () => ({ status: 'cancelled' }))
  }
  return { home, directory, manifest, pluginMarket, pluginManager }
}

describe('once-only default market plugin intent', () => {
  it('installs one compatible exact ordinary package, then uninstall/restart never resurrects it', async () => {
    const f = await fixture()
    expect((await prepareDefaultPluginIntent(f.home, f.manifest, { fresh: true })).imagegen.status).toBe('pending')
    expect((await provisionDefaultPlugins(f)).imagegen).toEqual({ status: 'completed', version: '2.0.0', application: 'restart-required' })
    expect(f.pluginManager.installBundle).toHaveBeenCalledWith(`${name}@2.0.0`, expect.objectContaining({ expectedName: name, expectedVersion: '2.0.0', saveExact: true, enabled: true, registry: 'https://fixture.invalid' }))
    await prepareDefaultPluginIntent(f.home, f.manifest, { fresh: true })
    await provisionDefaultPlugins(f)
    expect(f.pluginManager.installBundle).toHaveBeenCalledOnce()
  })

  it('does not seed ambiguous existing absent profiles', async () => {
    const f = await fixture()
    expect((await prepareDefaultPluginIntent(f.home, f.manifest)).imagegen).toMatchObject({ status: 'skipped', reason: 'existing-profile-without-install-evidence' })
    await provisionDefaultPlugins(f)
    expect(f.pluginMarket.entry).not.toHaveBeenCalled()
  })

  it('adopts existing ordinary installation without replacing or re-enabling it', async () => {
    const f = await fixture()
    f.manifest.dependencies[name] = '1.9.0'
    expect((await prepareDefaultPluginIntent(f.home, f.manifest)).imagegen.status).toBe('adopted')
    await provisionDefaultPlugins(f)
    expect(f.pluginManager.installBundle).not.toHaveBeenCalled()
  })

  it.each([name, legacy, 'imagegen'])('preserves host opt-out alias %s', async alias => {
    const f = await fixture()
    await writeFile(join(f.home, 'desktop-host-plugins.json'), JSON.stringify({ version: 1, disabled: [alias] }))
    expect((await prepareDefaultPluginIntent(f.home, f.manifest, { fresh: true })).imagegen.status).toBe('skipped')
    await provisionDefaultPlugins(f)
    expect(f.pluginManager.installBundle).not.toHaveBeenCalled()
  })

  it.each(['disabled', 'disabledSkins'])('preserves market %s and loader disable', async field => {
    const f = await fixture()
    await mkdir(join(f.directory, '.dsh-market'))
    await writeFile(join(f.directory, '.dsh-market', 'state.json'), JSON.stringify({ [field]: [legacy] }))
    expect((await prepareDefaultPluginIntent(f.home, f.manifest, { fresh: true })).imagegen.status).toBe('skipped')
    const other = await fixture()
    await writeFile(join(other.directory, 'cordis.patch.yml'), '- id: imagegen\n  disabled: true\n')
    expect((await prepareDefaultPluginIntent(other.home, other.manifest, { fresh: true })).imagegen.status).toBe('skipped')
  })

  it('keeps offline/failed installs pending and retries on next launch', async () => {
    const f = await fixture()
    await prepareDefaultPluginIntent(f.home, f.manifest, { fresh: true })
    f.pluginMarket.entry.mockRejectedValueOnce(new Error('offline'))
    expect((await provisionDefaultPlugins(f)).imagegen.status).toBe('pending')
    f.pluginManager.installBundle.mockResolvedValueOnce({ application: 'failed', error: { code: 'network' } })
    expect((await provisionDefaultPlugins(f)).imagegen.status).toBe('pending')
    expect((await provisionDefaultPlugins(f)).imagegen.status).toBe('completed')
  })

  it('recovers a crash after successful publication by adopting it, never reinstalling', async () => {
    const f = await fixture()
    await prepareDefaultPluginIntent(f.home, f.manifest, { fresh: true })
    f.pluginManager.listBundles.mockResolvedValue([{ name, installed: true, version: '2.0.0' }])
    expect((await provisionDefaultPlugins(f)).imagegen.status).toBe('adopted')
    expect(f.pluginManager.installBundle).not.toHaveBeenCalled()
    f.pluginManager.listBundles.mockResolvedValue([])
    await provisionDefaultPlugins(f)
    expect(f.pluginManager.installBundle).not.toHaveBeenCalled()
  })

  it('checks opt-out again after market I/O and respects disposed startup', async () => {
    const f = await fixture()
    await prepareDefaultPluginIntent(f.home, f.manifest, { fresh: true })
    const entry = await f.pluginMarket.entry()
    f.pluginMarket.entry.mockImplementationOnce(async () => {
      await writeFile(join(f.directory, 'cordis.patch.yml'), '- id: imagegen\n  disabled: true\n')
      return entry
    })
    expect((await provisionDefaultPlugins(f)).imagegen.status).toBe('skipped')
    expect(f.pluginManager.installBundle).not.toHaveBeenCalled()
    const other = await fixture()
    await prepareDefaultPluginIntent(other.home, other.manifest, { fresh: true })
    await provisionDefaultPlugins({ ...other, signal: AbortSignal.abort() })
    expect(other.pluginManager.installBundle).not.toHaveBeenCalled()
  })

  it('retires explicit legacy wrapper declarations but preserves Loader config, unrelated metadata and data', async () => {
    const f = await fixture()
    f.manifest.dependencies = { [legacy]: 'file:old-wrapper', other: '1.0.0' }
    f.manifest.dsh.profile.bundles = [legacy, 'other']
    await writeFile(join(f.directory, 'cordis.patch.yml'), '- insert:\n    - id: imagegen\n      name: dsh-desktop-imagegen\n      config:\n        channels: [keep]\n    - id: other\n      name: other\n')
    await mkdir(join(f.home, 'dsh-imagegen'))
    await writeFile(join(f.home, 'dsh-imagegen', 'history.json'), 'preserve')
    expect((await prepareDefaultPluginIntent(f.home, f.manifest)).imagegen).toEqual({ status: 'pending', reason: 'legacy-wrapper' })
    const next = await retireLegacyImagePlugin(f.home, f.manifest)
    expect(next.dependencies).toEqual({ other: '1.0.0' })
    expect(next.dsh.profile.bundles).toEqual(['other'])
    expect(parse(await readFile(join(f.directory, 'cordis.patch.yml'), 'utf8'))).toEqual([
      { insert: [{ id: 'other', name: 'other' }] }
    ])
    expect(await readFile(join(f.home, 'dsh-imagegen', 'history.json'), 'utf8')).toBe('preserve')
    expect(await retireLegacyImagePlugin(f.home, next)).toEqual(next)
    expect((await readDefaultPluginIntent(f.directory)).imagegen.status).toBe('pending')
  })

  it('does nothing without intent (including Safe Mode)', async () => {
    const f = await fixture()
    expect(await provisionDefaultPlugins(f)).toBeUndefined()
    expect(f.pluginMarket.entry).not.toHaveBeenCalled()
  })
})
