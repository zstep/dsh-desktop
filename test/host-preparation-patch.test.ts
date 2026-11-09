import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const requireHost = createRequire(import.meta.url)
const patchPath = new URL('../patches/@deepseek-ai+dsh-app-boot+0.2.1-rc.3.patch', import.meta.url)
const entryPath = new URL('../build/harness-node-entry.mjs', import.meta.url)
const runtimePackagePath = new URL('../packages/dsh-desktop-model-service/package.json', import.meta.url)

async function preparationFixture() {
  const patch = await readFile(patchPath, 'utf8')
  const helper = patch.match(/^\+const hostPreparations = new Set\(\);\n(?:^\+.*\n)*?^\+\}/m)?.[0]
  const invoke = patch.match(/^\+\t\tfor \(const \{ callback \} of \[\.\.\.hostPreparations\]\) await callback\(ctx\);$/m)?.[0].slice(1).trim()
  expect(helper, 'authoritative patch must add the preparation registry').toBeDefined()
  expect(invoke, 'authoritative patch must invoke registered callbacks').toBeDefined()
  expect(patch).toContain('export declare function registerHostPreparation(callback: (ctx: Context) => Promise<void> | void): () => void;')
  expect(patch).toMatch(/export \{[^\n]*\bregisterHostPreparation\b[^\n]*\};/)

  if (!helper || !invoke) throw new Error('Host preparation patch fixture is missing')
  const installedSource = await readFile(requireHost.resolve('@deepseek-ai/dsh-app-boot'), 'utf8')
  const installedBoot = installedSource.match(/async function boot\(binName, absoluteConfigPath, patches, prepare, bareModuleBaseUrl\) \{[\s\S]*?\n\}/)?.[0]
  if (!installedBoot) throw new Error('Published boot fixture is missing')
  // This fixture works before and after package replay without mutating the installation.
  const boot = installedBoot.replace(`\t\t${invoke}\n`, '')
  const before = '\t\tawait prepare?.(ctx);\n\t\tstage = "plugin tree failed to load";'
  expect(boot).toContain(before)
  expect(patch).toContain(` \t\tawait prepare?.(ctx);\n+\t\t${invoke}\n \t\tstage = "plugin tree failed to load";`)
  const patchedBoot = boot.replace(before, `\t\tawait prepare?.(ctx);\n\t\t${invoke}\n\t\tstage = "plugin tree failed to load";`)
  class ContextFixture {
    logger = { exporter() {}, error() {} }
    fiber = { dispose: async () => {} }
    baseUrl = ''
    async plugin() {}
    provide() {}
    on() {}
    get() { return { await: async () => {} } }
  }
  const addedJavaScript = helper.split('\n').map(line => line.slice(1)).join('\n')
  let mount: (ctx: object) => void | Promise<void>
  const source = `${addedJavaScript}\n${patchedBoot}\n({ registerHostPreparation, boot })`
  const fixture = runInNewContext(source, {
    Context: ContextFixture, Loader: {}, dshHomePath: {}, dirname, pathToFileURL, Error,
    StartupError: class StartupError extends Error {},
    mountRootInclude: async (ctx: object) => { await mount(ctx) },
    auditStartupEntries: async () => {}, formatActivationError: String
  }) as {
    registerHostPreparation(callback: (ctx: object) => void | Promise<void>): () => void
    boot(binName: string, path: string, patches: undefined, prepare: (ctx: object) => void | Promise<void>): Promise<object>
  }
  return { patch, registerHostPreparation: fixture.registerHostPreparation,
    boot(prepare: (ctx: object) => void | Promise<void>, mountRootInclude: (ctx: object) => void | Promise<void>) {
      mount = mountRootInclude
      return fixture.boot('fixture', '/fixture/cordis.yml', undefined, prepare)
    } }
}

async function harnessRegistrationFixture(options: { failInstall?: boolean } = {}) {
  const entry = await readFile(entryPath, 'utf8')
  const registration = entry.match(/async function registerPrivateModelService\(dshEntryPathValue, handoff\) \{[\s\S]*?\n\}/)?.[0]
  if (!registration) throw new Error('Harness model service registration is missing')
  const preparation = await preparationFixture()
  const calls: string[] = []
  const installed: object[] = []
  const installFailure = new Error('fixture runtime install failed')
  const modules: Record<string, object> = {
    'dsh-desktop-model-service/private': {
      registerPrivatePluginConfiguration() { calls.push('broker-register') },
      registerModelService() { calls.push('model-register') },
      registerModelServiceConsumers() { calls.push('consumers-register') }
    },
    '@deepseek-ai/dsh-app-boot': { registerHostPreparation: preparation.registerHostPreparation },
    'dsh-desktop-model-service/plugin-configuration-runtime': {
      async installPluginConfigurationRuntime(ctx: object) {
        await Promise.resolve()
        calls.push('runtime-install')
        if (options.failInstall) throw installFailure
        installed.push(ctx)
      }
    }
  }
  const register = runInNewContext(`${registration.replace(/await import\(/g, 'await importModule(')}; registerPrivateModelService`, {
    createRequire(anchor: string) {
      expect(anchor).toBe('/installation/dsh/bin.js')
      return { resolve(name: string) {
        calls.push(`resolve:${name}`)
        if (!Object.hasOwn(modules, name)) throw new Error('Unexpected package resolution')
        return `/installation/node_modules/${name}/index.js`
      } }
    },
    pathToFileURL(path: string) { return { href: path } },
    async importModule(path: string) {
      const name = path.slice('/installation/node_modules/'.length, -'/index.js'.length)
      const module = modules[name]
      if (!module) throw new Error('Unexpected module import')
      return module
    },
    process: { stdout: { write() {} } }
  }) as (entry: string, handoff: object) => Promise<void>
  return { ...preparation, calls, installed, installFailure,
    register: (handoff: object) => register('/installation/dsh/bin.js', handoff) }
}

describe('dsh-app-boot host preparation patch fixture', () => {
  it('awaits host setup after caller preparation and before any root entry mounts', async () => {
    const { registerHostPreparation, boot } = await preparationFixture()
    const events: string[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    registerHostPreparation(async () => {
      events.push('host-setup-start')
      await gate
      events.push('host-setup-ready')
    })

    const pending = boot(
      () => { events.push('caller-prepare') },
      () => { events.push('root-entry-mount') }
    )
    await new Promise(resolve => setImmediate(resolve))
    expect(events).toEqual(['caller-prepare', 'host-setup-start'])
    if (!release) throw new Error('Host preparation gate is missing')
    release()
    await pending
    expect(events).toEqual(['caller-prepare', 'host-setup-start', 'host-setup-ready', 'root-entry-mount'])
  })

  it('keeps upstream behavior with no callbacks and supports idempotent disposal', async () => {
    const fixture = await preparationFixture()
    const events: string[] = []
    await fixture.boot(() => { events.push('caller-prepare') }, () => { events.push('root-entry-mount') })
    expect(events).toEqual(['caller-prepare', 'root-entry-mount'])

    const dispose = fixture.registerHostPreparation(() => { events.push('disposed-callback') })
    dispose()
    dispose()
    await fixture.boot(() => {}, () => { events.push('second-root-entry-mount') })
    expect(events).toEqual(['caller-prepare', 'root-entry-mount', 'second-root-entry-mount'])
  })

  it('runs independent registrations in order and disposing one does not remove its duplicate', async () => {
    const fixture = await preparationFixture()
    const events: string[] = []
    const callback = () => { events.push('duplicate') }
    const dispose = fixture.registerHostPreparation(callback)
    fixture.registerHostPreparation(callback)
    fixture.registerHostPreparation(async () => { await Promise.resolve(); events.push('last') })
    dispose()
    await fixture.boot(() => {}, () => { events.push('mount') })
    expect(events).toEqual(['duplicate', 'last', 'mount'])
  })

  it('stops root entry mounting and propagates host preparation failures', async () => {
    const { registerHostPreparation, boot } = await preparationFixture()
    const events: string[] = []
    const failure = new Error('host setup failed')
    registerHostPreparation(async () => { throw failure })
    await expect(boot(() => {}, () => { events.push('root-entry-mount') })).rejects.toMatchObject({ cause: failure, message: expect.stringContaining('host preparation failed') })
    expect(events).toEqual([])
  })

  it('registers the private broker before installing runtime on the prepared root context', async () => {
    const fixture = await harnessRegistrationFixture()
    await fixture.register({ pluginConfiguration: { contractVersion: 1 }, consumers: [] })
    expect(fixture.calls).toEqual([
      'resolve:dsh-desktop-model-service/private', 'broker-register', 'resolve:@deepseek-ai/dsh-app-boot',
      'resolve:dsh-desktop-model-service/plugin-configuration-runtime', 'consumers-register'
    ])
    expect(fixture.installed).toEqual([])
    let prepared: object | undefined
    await fixture.boot(ctx => { prepared = ctx }, ctx => {
      expect(ctx).toBe(prepared)
      expect(fixture.installed).toEqual([ctx])
      expect(fixture.calls.at(-1)).toBe('runtime-install')
    })
  })

  it('does not resolve or install configuration runtime without a private broker handoff', async () => {
    const fixture = await harnessRegistrationFixture()
    await fixture.register({ consumers: [] })
    await fixture.boot(() => {}, () => {})
    expect(fixture.calls).toEqual(['resolve:dsh-desktop-model-service/private', 'consumers-register'])
    expect(fixture.installed).toEqual([])
  })

  it('blocks root entry mounts when the registered configuration runtime fails', async () => {
    const fixture = await harnessRegistrationFixture({ failInstall: true })
    await fixture.register({ pluginConfiguration: { contractVersion: 1 } })
    let mounted = false
    await expect(fixture.boot(() => {}, () => { mounted = true })).rejects.toMatchObject({
      cause: fixture.installFailure, message: expect.stringContaining('host preparation failed')
    })
    expect(mounted).toBe(false)
  })

  it('wires plugin-configuration handoff through the installation runtime export', async () => {
    const [entry, manifest] = await Promise.all([readFile(entryPath, 'utf8'), readFile(runtimePackagePath, 'utf8')])
    expect(entry).toContain("requireHost.resolve('@deepseek-ai/dsh-app-boot')")
    expect(entry).toContain("requireHost.resolve('dsh-desktop-model-service/plugin-configuration-runtime')")
    expect(entry).toContain('registerHostPreparation(async ctx => {')
    expect(entry).toContain('await installPluginConfigurationRuntime(ctx)')
    expect(manifest).toContain('"./plugin-configuration-runtime"')
    expect(entry.indexOf("if (handoff.pluginConfiguration) {")).toBeLessThan(entry.indexOf('registerHostPreparation(async ctx'))
    expect(entry.indexOf('registerHostPreparation(async ctx')).toBeLessThan(entry.indexOf("if (handoff.modelService)"))
  })
})
