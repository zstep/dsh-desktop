import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { HarnessRuntime, type HarnessChildProcess, type HarnessRuntimeOptions, type PrivateModelHandoff, type PrivateModelServiceGrant, type PrivatePluginConfigurationLease } from '../src/main/runtime/harness-runtime'
import { BUILTIN_IMAGE_GENERATION, BUILTIN_IMAGEGEN, MARKET_IMAGEGEN, setHostPluginEnabled } from '../src/main/state/host-plugin-state'
import { SAFE_MODE_PROFILE } from '../src/main/state/safe-mode-profile'

const roots: string[] = []
const runtimes: HarnessRuntime[] = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.stop()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(mode: 'timeout' | 'handshake' | 'launch' = 'timeout', overrides: Partial<HarnessRuntimeOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-image-lease-'))
  roots.push(root)
  const entry = join(root, 'entry.mjs')
  const patch = join(root, 'patch.yml')
  await writeFile(entry, 'export function runCli() {}')
  await writeFile(patch, '[]\n')
  const revoke = vi.fn()
  const serviceGrantRevoke = vi.fn()
  const pluginConfigurationRevoke = vi.fn()
  const pluginConfigurationIssue = vi.fn((): PrivatePluginConfigurationLease => ({
    contractVersion: 1,
    gatewayUrl: 'http://127.0.0.1:43131',
    capabilityToken: 'configuration'.repeat(6),
    revoke: pluginConfigurationRevoke
  }))
  const serviceGrantIssue = vi.fn((capabilities: PrivateModelServiceGrant['capabilities']): PrivateModelServiceGrant => ({
    contractVersion: 1,
    gatewayUrl: 'http://127.0.0.1:43130',
    capabilityToken: 'service'.repeat(10),
    capabilities,
    revoke: serviceGrantRevoke
  }))
  const issue = vi.fn(() => ({ gatewayUrl: 'http://127.0.0.1:43129', capabilityToken: 'image'.repeat(10), revoke }))
  let packet: PrivateModelHandoff | undefined
  const child = new EventEmitter() as HarnessChildProcess
  Object.assign(child, {
    stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null,
    kill: () => {
      Object.assign(child, { exitCode: 0 })
      child.emit('exit', 0, null)
      return true
    },
    send: (message: PrivateModelHandoff) => {
      packet = message
      queueMicrotask(() => child.emit('message', { kind: mode === 'handshake'
        ? 'dsh-desktop:private-model-rejected' : 'dsh-desktop:private-model-received' }))
      return true
    }
  })
  const runtime = new HarnessRuntime({
    dshEntryPath: entry, nodeEntryPath: entry, nodeExecutablePath: process.execPath,
    dshPatchPath: patch, dshSafePatchPath: patch, dshHome: root, logPath: join(root, 'runtime.log'),
    preferredPort: 0, startupTimeoutMs: 5, onChanged() {},
    privateModelHandoff: () => ({ gatewayUrl: 'http://127.0.0.1:43129', capabilityToken: 'model'.repeat(10) }),
    privateModelServiceGrant: serviceGrantIssue,
    ...(mode === 'launch' ? { privatePluginConfigurationLease: pluginConfigurationIssue } : {}),
    privateImageLease: issue,
    launchProcess: () => {
      if (mode === 'launch') throw new Error('fixture launch failed')
      queueMicrotask(() => child.emit('message', { kind: 'dsh-desktop:private-model-ready' }))
      return child
    },
    ...overrides
  })
  runtimes.push(runtime)
  return { root, runtime, revoke, issue, serviceGrantIssue, serviceGrantRevoke, pluginConfigurationIssue, pluginConfigurationRevoke, child, packet: () => packet }
}

it.each(['timeout', 'handshake', 'launch'] as const)('revokes the image capability on %s failure', async mode => {
  const test = await fixture(mode)
  await test.runtime.start(test.root)
  expect(test.issue).toHaveBeenCalledOnce()
  expect(test.revoke).toHaveBeenCalledOnce()
  expect(test.serviceGrantIssue).toHaveBeenCalledOnce()
  expect(test.serviceGrantIssue).toHaveBeenCalledWith(['chat.completions'])
  expect(test.serviceGrantRevoke).toHaveBeenCalledOnce()
  if (mode === 'launch') {
    expect(test.pluginConfigurationIssue).toHaveBeenCalledOnce()
    expect(test.pluginConfigurationRevoke).toHaveBeenCalledOnce()
  } else {
    expect(test.pluginConfigurationIssue).not.toHaveBeenCalled()
    expect(test.pluginConfigurationRevoke).not.toHaveBeenCalled()
  }
  if (mode !== 'launch') {
    expect(test.packet()?.gatewayUrl).toBe('http://127.0.0.1:43130')
    expect(test.packet()?.capabilityToken).toBe('service'.repeat(10))
    expect(test.packet()?.image?.gatewayUrl).toBe('http://127.0.0.1:43129')
    expect(test.packet()?.image?.capabilityToken).toBe('image'.repeat(10))
    expect(JSON.stringify(test.runtime.snapshot())).not.toContain('service'.repeat(10))
    expect(JSON.stringify(test.runtime.snapshot())).not.toContain('image'.repeat(10))
  }
  await test.runtime.stop()
  expect(test.revoke).toHaveBeenCalledOnce()
  expect(test.serviceGrantRevoke).toHaveBeenCalledOnce()
})

it('does not issue image capabilities when both trusted host plugins are disabled', async () => {
  const test = await fixture()
  await setHostPluginEnabled(test.root, BUILTIN_IMAGE_GENERATION, false)
  await setHostPluginEnabled(test.root, BUILTIN_IMAGEGEN, false)
  await test.runtime.start(test.root)
  expect(test.issue).not.toHaveBeenCalled()
  expect(test.serviceGrantIssue).toHaveBeenCalledWith(['chat.completions'])
  expect(test.packet()?.gatewayUrl).toBe('http://127.0.0.1:43130')
  expect(test.packet()?.image).toBeUndefined()
})

it('does not issue image capabilities in Safe Mode', async () => {
  const test = await fixture()
  await test.runtime.start(test.root, SAFE_MODE_PROFILE)
  expect(test.issue).not.toHaveBeenCalled()
  expect(test.packet()?.image).toBeUndefined()
})

it.each([BUILTIN_IMAGE_GENERATION, BUILTIN_IMAGEGEN])('issues and revokes a capability when only trusted %s is selected', async selected => {
  const test = await fixture()
  await setHostPluginEnabled(test.root, selected === BUILTIN_IMAGEGEN ? BUILTIN_IMAGE_GENERATION : BUILTIN_IMAGEGEN, false)
  await test.runtime.start(test.root)
  expect(test.issue).toHaveBeenCalledOnce()
  expect(test.packet()?.image).toBeDefined()
  expect(test.revoke).toHaveBeenCalledOnce()
})

it('never revives consumers excluded by discovery through legacy host fallbacks', async () => {
  const test = await fixture('timeout', { privateModelServiceConsumers: async () => [] })
  await test.runtime.start(test.root)
  expect(test.issue).not.toHaveBeenCalled()
  expect(test.serviceGrantIssue).not.toHaveBeenCalled()
  expect(test.packet()).toBeUndefined()
})

it('does not issue grants for invalid or unsupported discovered consumers', async () => {
  const test = await fixture('timeout', { privateModelServiceConsumers: async () => [
    { id: '@deepseek-ai/dsh-llm-pi-ai', version: '99.0.0', status: 'needs-adapter', capabilities: [] },
    { id: 'dsh-desktop-imagegen', version: '0.1.0', status: 'invalid-declaration', capabilities: [] }
  ] })
  await test.runtime.start(test.root)
  expect(test.issue).not.toHaveBeenCalled()
  expect(test.serviceGrantIssue).not.toHaveBeenCalled()
  expect(test.packet()?.gatewayUrl).toBeUndefined()
  expect(test.packet()?.image).toBeUndefined()
})

it('issues an image-only grant for an explicitly declared consumer without giving it chat credentials', async () => {
  const test = await fixture('timeout', { privateModelServiceConsumers: async () => [
    { id: 'fixture-image', version: '1.0.0', status: 'declared', capabilities: ['image.generate'] }
  ] })
  await test.runtime.start(test.root)
  expect(test.issue).toHaveBeenCalledOnce()
  expect(test.serviceGrantIssue).not.toHaveBeenCalled()
  expect(test.packet()?.gatewayUrl).toBeUndefined()
  expect(test.packet()?.image).toBeDefined()
  expect(test.revoke).toHaveBeenCalledOnce()
})

it.each([BUILTIN_IMAGE_GENERATION, MARKET_IMAGEGEN, BUILTIN_IMAGEGEN])('does not hand a host capability to a declared Profile %s package', async owner => {
  const test = await fixture()
  // Disable the other independent trusted source so only the replacement is considered.
  await setHostPluginEnabled(test.root, owner === BUILTIN_IMAGE_GENERATION ? BUILTIN_IMAGEGEN : BUILTIN_IMAGE_GENERATION, false)
  const profile = join(test.root, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [owner] } } }))
  await test.runtime.start(test.root)
  expect(test.issue).not.toHaveBeenCalled()
  expect(test.packet()?.image).toBeUndefined()
})
