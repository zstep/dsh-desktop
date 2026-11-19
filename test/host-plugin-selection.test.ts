import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadProfileDirectory, readDisabledProfileBundles } from '@deepseek-ai/dsh-app-boot'
import { readEffectiveDisabledHostPlugins, resolveHostPluginState } from '../src/main/profile/host-plugin-selection'
import { BUILTIN_IMAGEGEN, MARKET_IMAGEGEN, prepareProfileBundleForHostEnable, setHostPluginEnabled } from '../src/main/profile/host-plugin-state'
import { prepareHostPluginSourcesPatch } from '../src/main/profile/host-plugin-sources'
import { inspectProfileBootInputs } from '../src/main/profile/profile-boot-preflight'

const image = 'dsh-image-generation'
const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })

async function fixture(image = 'dsh-image-generation', host = image) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-host-selection-'))
  homes.push(home)
  const profile = join(home, 'profiles', 'web')
  const bundle = join(profile, 'node_modules', image)
  const market = join(profile, '.dsh-market', 'state.json')
  await mkdir(bundle, { recursive: true })
  await mkdir(join(profile, '.dsh-market'))
  const manifest = JSON.stringify({ dsh: { profile: { bundles: [image] } } })
  await writeFile(join(profile, 'package.json'), manifest)
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: image, dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  await writeFile(join(bundle, 'cordis.patch.yml'), `- insert:\n    - id: image-gen\n      name: ${JSON.stringify(image)}\n`)
  const patch = join(home, 'desktop.patch.yml')
  await writeFile(patch, `- insert:\n    - id: ${host === BUILTIN_IMAGEGEN ? 'imagegen' : 'dsh-image-generation'}\n      name: ${host}\n`)
  return { home, profile, market, manifest, patch }
}

describe('effective Desktop image source selection', () => {
  it('normalizes host wrapper identity when exposing omitted source names', async () => {
    const { home, profile } = await fixture(MARKET_IMAGEGEN, BUILTIN_IMAGEGEN)
    await rm(join(profile, 'package.json'))
    await setHostPluginEnabled(home, BUILTIN_IMAGEGEN, false)
    expect(await readEffectiveDisabledHostPlugins(home)).toEqual([BUILTIN_IMAGEGEN])
  })

  it('keeps the new workbench independent of the old Office switch and honors its own existing off', async () => {
    const { home, profile } = await fixture(MARKET_IMAGEGEN, BUILTIN_IMAGEGEN)
    await rm(join(profile, 'package.json'))
    await setHostPluginEnabled(home, image, false)
    expect(await resolveHostPluginState(home, BUILTIN_IMAGEGEN)).toEqual({ enabled: true, effectiveSource: 'host', effectiveEnabled: true })
    expect(await readEffectiveDisabledHostPlugins(home)).toEqual([image])
    await setHostPluginEnabled(home, MARKET_IMAGEGEN, false)
    const before = await readFile(join(home, 'desktop-host-plugins.json'), 'utf8')
    expect(await resolveHostPluginState(home, BUILTIN_IMAGEGEN)).toEqual({ enabled: false, effectiveSource: 'disabled', effectiveEnabled: false, reason: 'host-disabled' })
    expect(await readEffectiveDisabledHostPlugins(home)).toContain(BUILTIN_IMAGEGEN)
    expect(await readFile(join(home, 'desktop-host-plugins.json'), 'utf8')).toBe(before)
    await setHostPluginEnabled(home, BUILTIN_IMAGEGEN, true)
    expect((await resolveHostPluginState(home, BUILTIN_IMAGEGEN)).effectiveSource).toBe('host')
    expect((await resolveHostPluginState(home, image)).enabled).toBe(false)
    await setHostPluginEnabled(home, BUILTIN_IMAGEGEN, false)
    expect((await resolveHostPluginState(home, BUILTIN_IMAGEGEN)).effectiveEnabled).toBe(false)
  })

  it.each([MARKET_IMAGEGEN, BUILTIN_IMAGEGEN])('preserves the Profile %s owner including its disabled row without a handoff', async owner => {
    const { home, profile, market, manifest, patch } = await fixture(owner, BUILTIN_IMAGEGEN)
    const bundlePatch = join(profile, 'node_modules', owner, 'cordis.patch.yml')
    await writeFile(bundlePatch, `- insert:\n    - id: imagegen\n      name: ${JSON.stringify(owner)}\n`)
    expect(await resolveHostPluginState(home, BUILTIN_IMAGEGEN)).toEqual({ enabled: true, effectiveSource: 'profile', effectiveEnabled: true, reason: 'market-active' })
    await setHostPluginEnabled(home, BUILTIN_IMAGEGEN, false)
    expect(await resolveHostPluginState(home, BUILTIN_IMAGEGEN)).toMatchObject({ enabled: false, effectiveSource: 'profile', effectiveEnabled: true })
    const rowOff = '- id: imagegen\n  disabled: true\n'
    await writeFile(join(profile, 'cordis.patch.yml'), rowOff)
    expect(await resolveHostPluginState(home, BUILTIN_IMAGEGEN)).toMatchObject({ effectiveSource: 'profile', effectiveEnabled: false, reason: 'market-row-disabled' })
    expect(await readEffectiveDisabledHostPlugins(home)).toContain(BUILTIN_IMAGEGEN)
    expect(await readFile(await prepareHostPluginSourcesPatch(home, patch, join(home, 'missing.json')), 'utf8')).not.toContain(BUILTIN_IMAGEGEN)
    expect(await inspectProfileBootInputs(home, join(home, 'app', 'lib', 'bin.js'), patch)).toBeUndefined()
    expect(await prepareProfileBundleForHostEnable(home, BUILTIN_IMAGEGEN)).toEqual({ ok: false, reason: 'market-active' })
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe(manifest)
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toBe(rowOff)
    await expect(readFile(market)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    [{ disabled: [MARKET_IMAGEGEN] }, 'host'],
    [{ disabledSkins: [MARKET_IMAGEGEN] }, 'host'],
    [{ disabled: null, disabledSkins: [MARKET_IMAGEGEN] }, 'profile'],
    [{ disabled: [3, MARKET_IMAGEGEN] }, 'host'],
    [{ disabled: 'invalid' }, 'profile'],
    [null, 'profile'],
    ['{broken', 'profile']
  ] as const)('matches Harness package skip for the wrapper target: %j', async (state, source) => {
    const { home, profile, market } = await fixture(MARKET_IMAGEGEN, BUILTIN_IMAGEGEN)
    await writeFile(market, typeof state === 'string' ? state : JSON.stringify(state))
    expect((await resolveHostPluginState(home, BUILTIN_IMAGEGEN)).effectiveSource).toBe(source)
    expect(readDisabledProfileBundles(profile).has(MARKET_IMAGEGEN)).toBe(source === 'host')
    expect(loadProfileDirectory('test', profile, join(home, 'missing.json')).layers).toHaveLength(source === 'host' ? 0 : 1)
  })

  it('defaults to host, preserves explicit off, and allows reversible toggles without creating read state', async () => {
    const { home, profile } = await fixture()
    await rm(join(profile, 'package.json'))
    expect(await resolveHostPluginState(home, image)).toEqual({ enabled: true, effectiveSource: 'host', effectiveEnabled: true })
    expect(await readEffectiveDisabledHostPlugins(home)).toEqual([])
    await expect(readFile(join(home, 'desktop-host-plugins.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(join(home, 'desktop-host-plugins.json'), JSON.stringify({ version: 1, disabled: [image] }))
    expect(await resolveHostPluginState(home, image)).toEqual({ enabled: false, effectiveSource: 'disabled', effectiveEnabled: false, reason: 'host-disabled' })
    await setHostPluginEnabled(home, image, true)
    expect((await resolveHostPluginState(home, image)).effectiveSource).toBe('host')
    await setHostPluginEnabled(home, image, false)
    expect(await readEffectiveDisabledHostPlugins(home)).toEqual([image])
  })

  it('preserves the declared Profile owner regardless of host preference and never mutates it', async () => {
    const { home, profile, manifest, patch } = await fixture()
    expect(await resolveHostPluginState(home, image)).toEqual({ enabled: true, effectiveSource: 'profile', effectiveEnabled: true, reason: 'market-active' })
    expect(await readEffectiveDisabledHostPlugins(home)).toEqual([image])
    // Suppression requires no host installation and avoids resolving its entry.
    const generated = await prepareHostPluginSourcesPatch(home, patch, join(home, 'missing-host.json'))
    expect(await readFile(generated, 'utf8')).not.toContain(image)
    expect(await inspectProfileBootInputs(home, join(home, 'app', 'lib', 'bin.js'), patch)).toBeUndefined()
    expect(await prepareProfileBundleForHostEnable(home, image)).toEqual({ ok: false, reason: 'market-active' })
    await setHostPluginEnabled(home, image, false)
    expect(await resolveHostPluginState(home, image)).toMatchObject({ enabled: false, effectiveSource: 'profile', effectiveEnabled: true })
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe(manifest)
  })

  it('retains the Profile Loader owner when its patch row is disabled until explicit handoff', async () => {
    const { home, profile, market, patch } = await fixture()
    await writeFile(join(profile, 'cordis.patch.yml'), '- id: image-gen\n  disabled: true\n')
    expect(await resolveHostPluginState(home, image)).toEqual({ enabled: true, effectiveSource: 'profile', effectiveEnabled: false, reason: 'market-row-disabled' })
    expect(await readEffectiveDisabledHostPlugins(home)).toEqual([image])
    expect(loadProfileDirectory('test', profile, join(home, 'missing-app.json')).layers.map(layer => layer.packageName)).toEqual([image])
    expect(await inspectProfileBootInputs(home, join(home, 'app', 'lib', 'bin.js'), patch)).toBeUndefined()
    expect(await readFile(await prepareHostPluginSourcesPatch(home, patch, join(home, 'missing-host.json')), 'utf8')).not.toContain(image)
    await expect(readFile(market)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await prepareProfileBundleForHostEnable(home, image)).toEqual({ ok: true })
    expect((await resolveHostPluginState(home, image)).effectiveSource).toBe('host')
  })

  it.each([
    [{ disabled: [image] }, 'host'],
    [{ disabledSkins: [image] }, 'host'],
    [{ disabled: null, disabledSkins: [image] }, 'profile'],
    [{ disabled: [3, image] }, 'host'],
    [{ disabled: 'invalid' }, 'profile'],
    [null, 'profile'],
    ['{broken', 'profile']
  ] as const)('matches the actual Harness package skip for %j', async (state, source) => {
    const { home, profile, market } = await fixture()
    await writeFile(market, typeof state === 'string' ? state : JSON.stringify(state))
    expect((await resolveHostPluginState(home, image)).effectiveSource).toBe(source)
    expect(readDisabledProfileBundles(profile).has(image)).toBe(source === 'host')
    expect(loadProfileDirectory('test', profile, join(home, 'missing-app.json')).layers).toHaveLength(source === 'host' ? 0 : 1)
  })

  it.each(['{broken', '{}', '{"version":2,"disabled":[]}', '{"version":1,"disabled":[null]}'])('reports corrupt host state without fallback or mutation: %s', async state => {
    const { home } = await fixture()
    const path = join(home, 'desktop-host-plugins.json')
    await writeFile(path, state)
    await expect(resolveHostPluginState(home, image)).rejects.toThrow()
    await expect(readEffectiveDisabledHostPlugins(home)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(state)
  })
})
