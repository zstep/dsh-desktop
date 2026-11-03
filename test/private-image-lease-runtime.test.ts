import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { HarnessRuntime, type HarnessChildProcess, type PrivateModelHandoff } from '../src/main/runtime/harness-runtime'
import { BUILTIN_IMAGE_GENERATION, BUILTIN_IMAGEGEN, MARKET_IMAGEGEN, setHostPluginEnabled } from '../src/main/state/host-plugin-state'
import { SAFE_MODE_PROFILE } from '../src/main/state/safe-mode-profile'

const roots: string[] = []
const runtimes: HarnessRuntime[] = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.stop()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(mode: 'timeout' | 'handshake' | 'launch' = 'timeout') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-image-lease-'))
  roots.push(root)
  const entry = join(root, 'entry.mjs')
  const patch = join(root, 'patch.yml')
  await writeFile(entry, 'export function runCli() {}')
  await writeFile(patch, '[]\n')
  const revoke = vi.fn()
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
    privateImageLease: issue,
    launchProcess: () => {
      if (mode === 'launch') throw new Error('fixture launch failed')
      queueMicrotask(() => child.emit('message', { kind: 'dsh-desktop:private-model-ready' }))
      return child
    }
  })
  runtimes.push(runtime)
  return { root, runtime, revoke, issue, child, packet: () => packet }
}

it.each(['timeout', 'handshake', 'launch'] as const)('revokes the image capability on %s failure', async mode => {
  const test = await fixture(mode)
  await test.runtime.start(test.root)
  expect(test.issue).toHaveBeenCalledOnce()
  expect(test.revoke).toHaveBeenCalledOnce()
  expect(test.runtime.snapshot().phase).toBe('failed')
  if (mode !== 'launch') expect(test.packet()?.image?.capabilityToken).toBe('image'.repeat(10))
  expect(JSON.stringify(test.runtime.snapshot())).not.toContain('image'.repeat(10))
  await test.runtime.stop()
  expect(test.revoke).toHaveBeenCalledOnce()
})

it('does not issue image capabilities when both trusted host plugins are disabled', async () => {
  const test = await fixture()
  await setHostPluginEnabled(test.root, BUILTIN_IMAGE_GENERATION, false)
  await setHostPluginEnabled(test.root, BUILTIN_IMAGEGEN, false)
  await test.runtime.start(test.root)
  expect(test.issue).not.toHaveBeenCalled()
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
