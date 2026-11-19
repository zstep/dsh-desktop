import { randomUUID } from 'node:crypto'
import type { PluginOperationRunId } from '@deepseek-ai/dsh-plugin-manager/diagnostic'
import { localDragResource } from './file-drag'
import { installOperationDiagnostics } from './operation-diagnostics'
import { pluginOperationHost } from './upstream-api'
import { createRequire } from 'node:module'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerOfficeEngineResolution } from '../../build/office-engine-resolution.mjs'
import { inspect } from 'node:util'
import { StartupError, loadLayeredEnv, loadProfileDirectory, reportSkippedBundles } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'

const MAX_FATAL_DIAGNOSTIC_CHARS = 64 * 1024
const MAX_ORIGINAL_ERROR_CHARS = 8 * 1024
const MAX_STARTUP_ENTRY_CHARS = 8 * 1024
const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u

async function main(): Promise<void> {
  // The diagnostic contract brands this startup UUID; randomUUID already returns that shape.
  const runId = randomUUID() as PluginOperationRunId
  sendIpc({ type: 'starting', runId })
  const runtimeDir = process.argv[2]
  const projectDir = process.argv[3]
  if (runtimeDir === undefined || projectDir === undefined) {
    throw new Error('dsh desktop host: runtime and project directories are required')
  }
  // The packaged engine is spawned by the OS, so it has to resolve under
  // app.asar.unpacked. This path only supplies the archive depth; bin.js is
  // not executed. Outside a package the registration does nothing.
  registerOfficeEngineResolution(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const profile = loadProfileDirectory('dsh', projectDir, installAnchor)
  reportSkippedBundles('dsh', profile)
  let privateDelivery: PrivateModelDelivery | undefined
  try {
    privateDelivery = await receivePrivateModelHandoff()
    if (privateDelivery !== undefined) {
      const handoff = privateDelivery.handoff
      if (handoff.gatewayUrl !== undefined && handoff.capabilityToken !== undefined) {
        await registerPrivateModelCredential(installAnchor, handoff)
      }
      if (handoff.modelService !== undefined || handoff.consumers !== undefined || handoff.pluginConfiguration !== undefined) {
        await registerPrivateModelService(installAnchor, handoff)
      }
      if (handoff.image !== undefined) {
        await registerPrivateImageCredential(installAnchor, handoff.image)
        await registerPrivateModelImage(installAnchor)
      }
      privateDelivery.acknowledge()
    }
  } catch (error) {
    privateDelivery?.reject()
    throw error
  }
  const packageManager = process.argv[5] === undefined ? undefined : {
    command: process.execPath,
    args: ['--expose-internals', process.argv[5]],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
      PATH: `${process.argv[6] ?? ''}${delimiter}${process.env.PATH ?? ''}`
    }
  }
  const application = runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: profileName(),
    resolvedProfile: { profile, installAnchor },
    patchFiles: productPatchFiles(),
    args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
    ...(packageManager === undefined ? {} : { packageManager })
  })
  let stopping: Promise<void> | undefined
  const dragReads = new Map<number, AbortController>()
  const dragTasks = new Set<Promise<void>>()
  const send = (message: object): Promise<void> => new Promise((resolve, reject) => {
    sendIpc(message, error => { if (error === null) resolve(); else reject(error) })
  })
  const stop = (): Promise<void> => stopping ??= (async () => {
    for (const abort of dragReads.values()) abort.abort()
    await Promise.allSettled(dragTasks)
    const running = await application.catch(() => undefined)
    await running?.shutdown.shutdown(0)
    await send({ type: 'shutdown-complete' })
    if (process.connected) process.disconnect()
    if (running !== undefined) process.exit()
  })()
  process.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    if (message.type === 'shutdown') {
      void stop()
      return
    }
    if (message.type === 'file-drag-cancel') {
      if ('requestId' in message && typeof message.requestId === 'number') dragReads.get(message.requestId)?.abort()
      return
    }
    if (message.type !== 'file-drag-resource') return
    if (!('requestId' in message) || typeof message.requestId !== 'number' || !Number.isSafeInteger(message.requestId)
      || !('address' in message) || typeof message.address !== 'string') return
    const requestId = message.requestId
    const address = message.address
    const abort = new AbortController()
    dragReads.set(requestId, abort)
    const task = (async () => {
      try {
        if (stopping !== undefined) throw new Error('Host stopping')
        const { ctx } = await application
        const resource = await localDragResource(ctx, address, abort.signal)
        await send({ type: 'file-drag-resource', requestId, resource })
      } catch (error) {
        if (!abort.signal.aborted) console.error(error)
        await send({ type: 'file-drag-resource', requestId, resource: null, error: 'File drag resource unavailable' })
      } finally {
        dragReads.delete(requestId)
      }
    })().catch((error: unknown) => { console.error(error) })
    dragTasks.add(task)
    void task.finally(() => { dragTasks.delete(task) })
  })
  process.once('disconnect', () => { void stop() })
  const { ctx } = await application
  installOperationDiagnostics(pluginOperationHost(ctx), async record => {
    await send({ type: 'plugin-operation', record })
  }, 32, runId)
  const url = ctx.connection.authenticatedUrl(`${ctx.webServer.protocol}//127.0.0.1:${String(ctx.webServer.port)}`)
  sendIpc({
    type: 'ready',
    url,
    injections: ctx.webServer.collectIndexInjections(ctx.connection.browserPeer)
  })
}

function sendIpc(message: object, callback?: (error: Error | null) => void): void {
  if (!process.connected || process.send === undefined) {
    callback?.(null)
    return
  }
  process.send(message, undefined, undefined, error => {
    if (error !== null) console.error(error)
    callback?.(error)
  })
}

function productPatchFiles(): string[] {
  const additional = process.env.DSH_DESKTOP_ADDITIONAL_PATCH_FILES
  let extras: string[] = []
  if (additional !== undefined && additional !== '') {
    try {
      const parsed: unknown = JSON.parse(additional)
      if (Array.isArray(parsed)) extras = parsed.filter((path): path is string => typeof path === 'string' && path !== '')
    } catch {
      throw new Error('dsh desktop host: DSH_DESKTOP_ADDITIONAL_PATCH_FILES must be a JSON array of paths')
    }
  }
  return [process.env.DSH_DESKTOP_PATCH_FILE, ...extras]
    .filter((path): path is string => path !== undefined && path !== '')
}

function profileName(): string {
  const configured = process.env.DSH_DESKTOP_PROFILE
  if (configured === undefined || configured === '') return 'desktop'
  if (!PROFILE_NAME.test(configured)) throw new Error('dsh desktop host: DSH_DESKTOP_PROFILE must be a short lowercase name')
  return configured
}

type PrivateModelCapability = 'chat.completions' | 'image.generate'

interface PrivateModelConsumer {
  readonly id: string
  readonly version?: string
  readonly status: 'declared' | 'needs-adapter' | 'invalid-declaration'
  readonly capabilities: readonly PrivateModelCapability[]
  readonly adapter?: 'llm-pi-ai' | 'desktop-imagegen' | 'image-generation'
}

interface PrivateModelServicePacket {
  readonly contractVersion: 1
  readonly gatewayUrl: string
  readonly capabilityToken: string
  readonly capabilities: readonly ['chat.completions']
}

interface PrivateImagePacket {
  readonly gatewayUrl: string
  readonly capabilityToken: string
}

interface PrivatePluginConfigurationPacket {
  readonly contractVersion: 1
  readonly gatewayUrl: string
  readonly capabilityToken: string
}

interface PrivateModelHandoff {
  readonly gatewayUrl?: string
  readonly capabilityToken?: string
  readonly modelService?: PrivateModelServicePacket
  readonly consumers?: readonly PrivateModelConsumer[]
  readonly pluginConfiguration?: PrivatePluginConfigurationPacket
  readonly image?: PrivateImagePacket
}

interface PrivateModelDelivery {
  readonly handoff: PrivateModelHandoff
  acknowledge(): void
  reject(): void
}

const PRIVATE_HANDOFF_TIMEOUT_MS = 5_000
const PRIVATE_HANDOFF_KEY = 'DSH_DESKTOP_PRIVATE_MODEL_HANDOFF'
const PRIVATE_HANDOFF_KIND = 'dsh-desktop:private-model-delivery'
const PRIVATE_TOKEN = /^[A-Za-z0-9_-]{32,512}$/u
const PRIVATE_GATEWAY = /^http:\/\/127\.0\.0\.1:\d+$/u

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return hasOnlyKeys(value, keys) && keys.every(key => Object.hasOwn(value, key))
}

function validGateway(value: unknown): value is string {
  if (typeof value !== 'string' || !PRIVATE_GATEWAY.test(value)) return false
  const port = Number(value.slice(value.lastIndexOf(':') + 1))
  return Number.isInteger(port) && port > 0 && port <= 65_535
}

function validToken(value: unknown): value is string {
  return typeof value === 'string' && PRIVATE_TOKEN.test(value)
}

function validConsumer(value: unknown): value is PrivateModelConsumer {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return Object.keys(item).every(key => ['id', 'version', 'status', 'capabilities', 'adapter'].includes(key)) &&
    typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 256 &&
    (item.version === undefined || typeof item.version === 'string' && item.version.length <= 128) &&
    ['declared', 'needs-adapter', 'invalid-declaration'].includes(item.status as string) &&
    Array.isArray(item.capabilities) && item.capabilities.length <= 16 &&
    item.capabilities.every(capability => capability === 'chat.completions' || capability === 'image.generate') &&
    (item.adapter === undefined || ['llm-pi-ai', 'desktop-imagegen', 'image-generation'].includes(item.adapter as string))
}

function validConsumers(value: unknown): value is readonly PrivateModelConsumer[] {
  return value === undefined || (Array.isArray(value) && value.length <= 512 &&
    new Set(value.map(item => (item as { id?: unknown } | null)?.id)).size === value.length &&
    value.every(validConsumer))
}

function validModelService(value: unknown): value is PrivateModelServicePacket {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const packet = value as Record<string, unknown>
  return exactKeys(packet, ['contractVersion', 'gatewayUrl', 'capabilityToken', 'capabilities']) &&
    packet.contractVersion === 1 && validGateway(packet.gatewayUrl) && validToken(packet.capabilityToken) &&
    Array.isArray(packet.capabilities) && packet.capabilities.length === 1 && packet.capabilities[0] === 'chat.completions'
}

function validPluginConfiguration(value: unknown): value is PrivatePluginConfigurationPacket {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const packet = value as Record<string, unknown>
  return exactKeys(packet, ['contractVersion', 'gatewayUrl', 'capabilityToken']) &&
    packet.contractVersion === 1 && validGateway(packet.gatewayUrl) && validToken(packet.capabilityToken)
}

function validImage(value: unknown): value is PrivateImagePacket {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const packet = value as Record<string, unknown>
  return exactKeys(packet, ['gatewayUrl', 'capabilityToken']) &&
    validGateway(packet.gatewayUrl) && validToken(packet.capabilityToken)
}

/**
 * The only secret-bearing channel is the parent/child message pipe. Never put
 * its contents in argv, `process.env`, a profile document, or diagnostics. The
 * environment bit is only a mode selector and has no authority by itself.
 */
async function receivePrivateModelHandoff(): Promise<PrivateModelDelivery | undefined> {
  if (process.env[PRIVATE_HANDOFF_KEY] !== '1') return undefined
  delete process.env[PRIVATE_HANDOFF_KEY]
  if (typeof process.send !== 'function') throw new Error('Private model handoff requires a parent message channel')
  return new Promise<PrivateModelDelivery>((resolve, reject) => {
    let settled = false
    const send = (message: object): void => { process.send?.(message) }
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Private model handoff timed out'))
    }, PRIVATE_HANDOFF_TIMEOUT_MS)
    const receive = (message: unknown): void => {
      if (settled || typeof message !== 'object' || message === null ||
        (message as { kind?: unknown }).kind !== PRIVATE_HANDOFF_KIND) return
      settled = true
      const raw = message as Record<string, unknown>
      const { gatewayUrl, capabilityToken, image, modelService, consumers, pluginConfiguration } = raw
      const hasLegacy = gatewayUrl !== undefined || capabilityToken !== undefined
      const valid = (hasLegacy && validGateway(gatewayUrl) && validToken(capabilityToken)) ||
        (!hasLegacy && (modelService !== undefined || image !== undefined || consumers !== undefined || pluginConfiguration !== undefined))
      if (!valid || (pluginConfiguration !== undefined && !validPluginConfiguration(pluginConfiguration)) ||
        (modelService !== undefined && !validModelService(modelService)) || !validConsumers(consumers) ||
        (image !== undefined && !validImage(image)) ||
        !hasOnlyKeys(raw, ['kind', 'gatewayUrl', 'capabilityToken', 'modelService', 'consumers', 'image', 'pluginConfiguration'])) {
        cleanup()
        send({ kind: 'dsh-desktop:private-model-rejected' })
        reject(new Error('Invalid private model handoff'))
        return
      }
      cleanup()
      let acknowledged = false
      const handoff: PrivateModelHandoff = Object.freeze({
        ...(hasLegacy ? { gatewayUrl, capabilityToken } : {}),
        ...(modelService === undefined ? {} : { modelService: Object.freeze({
          contractVersion: 1 as const,
          gatewayUrl: (modelService as PrivateModelServicePacket).gatewayUrl,
          capabilityToken: (modelService as PrivateModelServicePacket).capabilityToken,
          capabilities: Object.freeze(['chat.completions'] as const)
        }) }),
        ...(consumers === undefined ? {} : { consumers: Object.freeze(consumers.map(item => Object.freeze({
          id: item.id,
          ...(item.version === undefined ? {} : { version: item.version }),
          status: item.status,
          capabilities: Object.freeze([...item.capabilities]),
          ...(item.adapter === undefined ? {} : { adapter: item.adapter })
        }))) }),
        ...(pluginConfiguration === undefined ? {} : { pluginConfiguration: Object.freeze({
          contractVersion: 1 as const,
          gatewayUrl: (pluginConfiguration as PrivatePluginConfigurationPacket).gatewayUrl,
          capabilityToken: (pluginConfiguration as PrivatePluginConfigurationPacket).capabilityToken
        }) }),
        ...(image === undefined ? {} : { image: Object.freeze({
          gatewayUrl: (image as PrivateImagePacket).gatewayUrl,
          capabilityToken: (image as PrivateImagePacket).capabilityToken
        }) })
      })
      resolve(Object.freeze({
        handoff,
        acknowledge() {
          if (acknowledged) return
          acknowledged = true
          send({ kind: 'dsh-desktop:private-model-received' })
        },
        reject() {
          if (acknowledged) return
          acknowledged = true
          send({ kind: 'dsh-desktop:private-model-rejected' })
        }
      }))
    }
    const onMessage = (message: unknown): void => { receive(message) }
    process.on('message', onMessage)
    send({ kind: 'dsh-desktop:private-model-ready' })
  })
}

async function resolvePiAiModuleUrl(anchor: string): Promise<string> {
  try {
    return pathToFileURL(createRequire(anchor).resolve('@deepseek-ai/dsh-llm-pi-ai')).href
  } catch {
    // The anchor is unavailable (for example a test double entry); fall back
    // to ambient resolution, which the host module fallback hook also anchors
    // at the DSH entry for @deepseek-ai packages.
    return '@deepseek-ai/dsh-llm-pi-ai'
  }
}

/**
 * The capability token reaches the provider credential seam through module
 * memory only. Resolve the llm plugin exactly as the profile composition does
 * — anchored at the DSH entry's own installation (pnpm realpath-dedupes both to
 * one module instance) — and hand the token to its one-shot registry, which
 * answers only the provider route naming this loopback gateway. A failed
 * registration must fail the launch: a runtime without its credential is a
 * silently broken model link, not a degraded mode to boot into.
 */
async function registerPrivateModelCredential(anchor: string, handoff: PrivateModelHandoff): Promise<void> {
  const piAiUrl = await resolvePiAiModuleUrl(anchor)
  const module = await import(piAiUrl) as {
    registerPrivateModelCredential?: (entry: { provider: string; baseURL: string; apiKey: string }) => void
  }
  if (typeof module.registerPrivateModelCredential !== 'function') {
    throw new Error('The installed llm adapter has no private model credential seam')
  }
  module.registerPrivateModelCredential({
    provider: 'pengbao',
    baseURL: handoff.gatewayUrl as string,
    apiKey: handoff.capabilityToken as string
  })
  process.stdout.write('[harness-node] private model credential registered\n')
}

async function registerPrivateModelService(anchor: string, handoff: PrivateModelHandoff): Promise<void> {
  const requireHost = createRequire(anchor)
  const serviceEntry = requireHost.resolve('dsh-desktop-model-service/private')
  const service = await import(pathToFileURL(serviceEntry).href) as {
    registerModelService?: (packet: unknown) => void
    registerModelServiceConsumers?: (consumers: readonly unknown[]) => void
    registerPrivatePluginConfiguration?: (packet: unknown) => void
  }
  if (handoff.pluginConfiguration !== undefined) {
    service.registerPrivatePluginConfiguration?.(handoff.pluginConfiguration)
    const appBootEntry = requireHost.resolve('@deepseek-ai/dsh-app-boot')
    const appBoot = await import(pathToFileURL(appBootEntry).href) as {
      registerHostPreparation?: (callback: (ctx: unknown) => Promise<void>) => (() => void) | void
    }
    const runtimeEntry = requireHost.resolve('dsh-desktop-model-service/plugin-configuration-runtime')
    appBoot.registerHostPreparation?.(async ctx => {
      const runtime = await import(pathToFileURL(runtimeEntry).href) as {
        installPluginConfigurationRuntime?: (ctx: unknown) => Promise<void>
      }
      await runtime.installPluginConfigurationRuntime?.(ctx)
    })
  }
  if (handoff.modelService !== undefined) service.registerModelService?.(handoff.modelService)
  service.registerModelServiceConsumers?.(handoff.consumers ?? [])
  process.stdout.write('[harness-node] private model service registered\n')
}

async function resolveImageDesktopBridge(anchor: string): Promise<{
  registerDesktopImageBridge?: (packet: unknown) => void
  getDesktopImageBridge?: () => unknown
}> {
  const requireHost = createRequire(anchor)
  const hostEntry = requireHost.resolve('dsh-image-generation')
  const bridgeEntry = createRequire(hostEntry).resolve('dsh-image-generation/desktop-bridge')
  return await import(pathToFileURL(bridgeEntry).href) as {
    registerDesktopImageBridge?: (packet: unknown) => void
    getDesktopImageBridge?: () => unknown
  }
}

async function registerPrivateImageCredential(anchor: string, image: PrivateImagePacket): Promise<void> {
  const bridge = await resolveImageDesktopBridge(anchor)
  bridge.registerDesktopImageBridge?.(image)
  process.stdout.write('[harness-node] private image credential registered\n')
}

async function registerPrivateModelImage(anchor: string): Promise<void> {
  const requireHost = createRequire(anchor)
  const bridge = await resolveImageDesktopBridge(anchor)
  const serviceEntry = requireHost.resolve('dsh-desktop-model-service/private')
  const service = await import(pathToFileURL(serviceEntry).href) as {
    registerModelServiceImage?: (operations: unknown) => void
  }
  const operations = bridge.getDesktopImageBridge?.()
  if (operations !== undefined) service.registerModelServiceImage?.(operations)
}

export function formatFatalDiagnostic(error: unknown): string {
  const original = inspect(error, { depth: 4, maxArrayLength: 50 })
  const sections: string[] = []
  const seen = new Set<Error>()
  const visit = (value: unknown): void => {
    if (!(value instanceof Error) || seen.has(value)) return
    seen.add(value)
    if (value instanceof StartupError) {
      if (value.startup !== undefined) sections.push(`Configuration file: ${value.startup.configurationPath}`)
      const entries = inspect(value.entries, { depth: 6, maxArrayLength: null, maxStringLength: 4096 })
      sections.push('--- startup entries ---', entries.length <= MAX_STARTUP_ENTRY_CHARS
        ? entries
        : `${entries.slice(0, MAX_STARTUP_ENTRY_CHARS)}\n… (startup entries truncated at ${MAX_STARTUP_ENTRY_CHARS} characters)`)
      sections.push(value.composition === undefined
        ? 'Startup composition diagnostic unavailable.'
        : `Omitted plugin rows: ${String(value.composition.omittedPlugins)}; omitted missing-service observations: ${String(value.composition.omittedServices)}.`)
    }
    visit(value.cause)
    if (value instanceof AggregateError) for (const item of value.errors) visit(item)
  }
  visit(error)
  sections.unshift(sections.length === 0 || original.length <= MAX_ORIGINAL_ERROR_CHARS
    ? original
    : `${original.slice(0, MAX_ORIGINAL_ERROR_CHARS)}\n… (original error truncated at ${MAX_ORIGINAL_ERROR_CHARS} characters)`)
  const text = sections.join('\n')
  if (text.length <= MAX_FATAL_DIAGNOSTIC_CHARS) return text
  const notice = `\n… (Host diagnostic truncated at ${MAX_FATAL_DIAGNOSTIC_CHARS} characters)`
  return text.slice(0, MAX_FATAL_DIAGNOSTIC_CHARS - notice.length) + notice
}

function isDirectRun(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return pathToFileURL(entry).href === import.meta.url
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    const diagnostic = formatFatalDiagnostic(error)
    sendIpc({ type: 'fatal', message, diagnostic })
    console.error(error)
    process.exitCode = 1
    if (process.connected) process.disconnect()
  })
}
