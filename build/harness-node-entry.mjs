import childProcess from 'node:child_process'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerHostModuleFallback } from './host-module-fallback.mjs'
import { packagedArchiveRoot, registerOfficeEngineResolution } from './office-engine-resolution.mjs'
import {
  PACKAGED_PNPM_ENTRY_ENV,
  PACKAGED_PNPM_RUNNER_ENV,
  buildPackagedPnpmInvocation
} from './packaged-pnpm-invocation.mjs'
import { enforceWindowsChildProcessHide } from './windows-child-process-hide.mjs'

// On macOS Harness runs inside an Electron utility process (TCC responsibility
// isolation), so `process.execPath` and `argv0` point at the Electron helper
// instead of a Node binary. Plugins re-invoke the dsh CLI through the
// executable running them — dsh-market forwards `process.execArgv` with it —
// and without Node mode that child boots as an Electron app, where the leading
// `--expose-internals` shifts argv and the CLI answers "--profile <name> is
// required" instead of installing. Declaring it here, after this process has
// already parsed the Chromium switches it was launched with, marks only the
// children as Node processes. Windows and Linux declare Node mode before
// launching this entry.
if (process.versions.electron !== undefined) {
  process.env.ELECTRON_RUN_AS_NODE = '1'
}

const [dshEntryPath, ...dshArguments] = process.argv.slice(2)

// The only secret-bearing channel is the parent/child message pipe. Never put
// its contents in argv, process.env, a profile document, or diagnostics. The
// environment bit is only a mode selector and has no authority by itself.
async function receivePrivateModelHandoff() {
  if (process.env.DSH_DESKTOP_PRIVATE_MODEL_HANDOFF !== '1') return undefined
  delete process.env.DSH_DESKTOP_PRIVATE_MODEL_HANDOFF
  const port = process.parentPort
  const ipc = typeof process.send === 'function'
  if (!port && !ipc) throw new Error('Private model handoff requires a parent message channel')
  return new Promise((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Private model handoff timed out'))
    }, 5_000)
    const cleanup = () => {
      clearTimeout(timeout)
      if (port) port.off('message', onUtilityMessage)
      else process.off('message', onNodeMessage)
    }
    const receive = (message) => {
      if (settled || message?.kind !== 'dsh-desktop:private-model-delivery') return
      settled = true
      const { gatewayUrl, capabilityToken, image, modelService, consumers, pluginConfiguration } = message
      const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{32,512}$/.test(value)
      const hasOnlyKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
        Object.keys(value).every(key => keys.includes(key))
      const exactKeys = (value, keys) => hasOnlyKeys(value, keys) && keys.every(key => Object.hasOwn(value, key))
      const validGateway = value => {
        if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(value)) return false
        const port = Number(value.slice(value.lastIndexOf(':') + 1))
        return Number.isInteger(port) && port > 0 && port <= 65535
      }
      const validImage = value => exactKeys(value, ['capabilityToken', 'gatewayUrl']) && validGateway(value.gatewayUrl) && validToken(value.capabilityToken)
      const validConsumers = value => value === undefined || (Array.isArray(value) && value.length <= 512 && new Set(value.map(item => item?.id)).size === value.length && value.every(item =>
        item !== null && typeof item === 'object' && !Array.isArray(item) &&
        Object.keys(item).every(key => ['id', 'version', 'status', 'capabilities', 'adapter'].includes(key)) &&
        Object.hasOwn(item, 'id') && Object.hasOwn(item, 'status') && Object.hasOwn(item, 'capabilities') &&
        typeof item.id === 'string' && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(item.id) && item.id.length <= 256 &&
        (item.version === undefined || typeof item.version === 'string' && item.version.length <= 128 && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(item.version)) &&
        ['declared', 'needs-adapter', 'invalid-declaration'].includes(item.status) && Array.isArray(item.capabilities) &&
        item.capabilities.length <= 16 && new Set(item.capabilities).size === item.capabilities.length && item.capabilities.every(capability => ['chat.completions', 'image.generate'].includes(capability)) &&
        (item.adapter === undefined || ['llm-pi-ai', 'desktop-imagegen', 'image-generation'].includes(item.adapter))))
      const validModelService = value => exactKeys(value, ['contractVersion', 'gatewayUrl', 'capabilityToken', 'capabilities']) &&
        value.contractVersion === 1 && validGateway(value.gatewayUrl) && validToken(value.capabilityToken) &&
        Array.isArray(value.capabilities) && value.capabilities.length === 1 && value.capabilities[0] === 'chat.completions'
      const validPluginConfiguration = value => exactKeys(value, ['contractVersion', 'gatewayUrl', 'capabilityToken']) && value.contractVersion === 1 && validGateway(value.gatewayUrl) && validToken(value.capabilityToken)
      const hasLegacy = gatewayUrl !== undefined || capabilityToken !== undefined
      if ((hasLegacy && (!validGateway(gatewayUrl) || !validToken(capabilityToken))) ||
          (!hasLegacy && !modelService && !image && !consumers && !pluginConfiguration) ||
          (pluginConfiguration !== undefined && !validPluginConfiguration(pluginConfiguration)) ||
          (modelService !== undefined && !validModelService(modelService)) || !validConsumers(consumers) ||
          (image !== undefined && !validImage(image)) ||
          !hasOnlyKeys(message, ['kind', 'gatewayUrl', 'capabilityToken', 'modelService', 'consumers', 'image', 'pluginConfiguration'])) {
        cleanup()
        send({ kind: 'dsh-desktop:private-model-rejected' })
        reject(new Error('Invalid private model handoff'))
        return
      }
      cleanup()
      let acknowledged = false
      const delivery = Object.freeze({
        ...(hasLegacy ? { gatewayUrl, capabilityToken } : {}),
        ...(modelService ? { modelService: Object.freeze({
          contractVersion: modelService.contractVersion,
          gatewayUrl: modelService.gatewayUrl,
          capabilityToken: modelService.capabilityToken,
          capabilities: Object.freeze([...modelService.capabilities])
        }) } : {}),
        ...(consumers ? { consumers: Object.freeze(consumers.map(item => Object.freeze({
          id: item.id, ...(item.version === undefined ? {} : { version: item.version }), status: item.status,
          capabilities: Object.freeze([...item.capabilities]), ...(item.adapter ? { adapter: item.adapter } : {})
        }))) } : {}),
        ...(pluginConfiguration ? { pluginConfiguration: Object.freeze({ contractVersion: 1, gatewayUrl: pluginConfiguration.gatewayUrl, capabilityToken: pluginConfiguration.capabilityToken }) } : {}),
        ...(image ? { image: Object.freeze({ gatewayUrl: image.gatewayUrl, capabilityToken: image.capabilityToken }) } : {})
      })
      resolve(Object.freeze({
        handoff: delivery,
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
    const onUtilityMessage = (event) => receive(event?.data)
    const onNodeMessage = (message) => receive(message)
    const send = (message) => {
      if (port) port.postMessage(message)
      else process.send(message)
    }
    if (port) port.on('message', onUtilityMessage)
    else process.on('message', onNodeMessage)
    send({ kind: 'dsh-desktop:private-model-ready' })
  })
}

function report(label, value) {
  process.stderr.write(`[harness-node] ${label}: ${value}\n`)
}

// The capability token reaches the provider credential seam through module
// memory only. Resolve the llm plugin exactly as the profile composition does
// — anchored at the DSH entry's own installation (pnpm realpath-dedupes both to
// one module instance) — and hand the token to its one-shot registry, which
// answers only the provider route naming this loopback gateway. A failed
// registration must fail the launch: a runtime without its credential is a
// silently broken model link, not a degraded mode to boot into.
async function registerPrivateModelCredential(dshEntryPathValue, handoff) {
  const piAiUrl = await resolvePiAiModuleUrl(dshEntryPathValue)
  const { registerPrivateModelCredential: register } = await import(piAiUrl)
  register({
    provider: 'pengbao',
    baseURL: handoff.gatewayUrl,
    apiKey: handoff.capabilityToken
  })
  process.stdout.write('[harness-node] private model credential registered\n')
}

async function registerPrivateModelService(dshEntryPathValue, handoff) {
  const requireHost = createRequire(dshEntryPathValue)
  const serviceEntry = requireHost.resolve('dsh-desktop-model-service/private')
  const { registerModelService, registerModelServiceConsumers, registerPrivatePluginConfiguration } = await import(pathToFileURL(serviceEntry).href)
  if (handoff.pluginConfiguration) {
    registerPrivatePluginConfiguration(handoff.pluginConfiguration)
    const appBootEntry = requireHost.resolve('@deepseek-ai/dsh-app-boot')
    const { registerHostPreparation } = await import(pathToFileURL(appBootEntry).href)
    const runtimeEntry = requireHost.resolve('dsh-desktop-model-service/plugin-configuration-runtime')
    registerHostPreparation(async ctx => {
      const { installPluginConfigurationRuntime } = await import(pathToFileURL(runtimeEntry).href)
      await installPluginConfigurationRuntime(ctx)
    })
  }
  if (handoff.modelService) registerModelService(handoff.modelService)
  registerModelServiceConsumers(handoff.consumers ?? [])
  process.stdout.write('[harness-node] private model service registered\n')
}

async function registerPrivateModelImage(dshEntryPathValue) {
  const requireHost = createRequire(dshEntryPathValue)
  const hostEntry = requireHost.resolve('dsh-image-generation')
  const bridgeEntry = createRequire(hostEntry).resolve('dsh-image-generation/desktop-bridge')
  const { getDesktopImageBridge } = await import(pathToFileURL(bridgeEntry).href)
  const serviceEntry = requireHost.resolve('dsh-desktop-model-service/private')
  const { registerModelServiceImage } = await import(pathToFileURL(serviceEntry).href)
  const operations = getDesktopImageBridge()
  if (operations) registerModelServiceImage(operations)
}
async function registerPrivateImageCredential(dshEntryPathValue, handoff) {
  // Match the host insertion's installation anchor; never resolve a Profile
  // package with the same name or fall back to an ambient market instance.
  const requireHost = createRequire(dshEntryPathValue)
  const hostEntry = requireHost.resolve('dsh-image-generation')
  const bridgeEntry = createRequire(hostEntry).resolve('dsh-image-generation/desktop-bridge')
  const { registerDesktopImageBridge } = await import(pathToFileURL(bridgeEntry).href)
  registerDesktopImageBridge(handoff)
  process.stdout.write('[harness-node] private image credential registered\n')
}

async function resolvePiAiModuleUrl(dshEntryPathValue) {
  try {
    const requireFromDshEntry = createRequire(dshEntryPathValue)
    return pathToFileURL(requireFromDshEntry.resolve('@deepseek-ai/dsh-llm-pi-ai')).href
  } catch {
    // The anchor is unavailable (for example a test double entry); fall back
    // to ambient resolution, which the host module fallback hook also anchors
    // at the DSH entry for @deepseek-ai packages.
    return '@deepseek-ai/dsh-llm-pi-ai'
  }
}

// Send loader-owned identity before the human-readable error. Do not serialize
// arbitrary Error properties, plugin config, or the entire context/fiber graph.
function reportPluginFailures(error) {
  const failures = []
  const visited = new Set()
  function visit(value) {
    if (!value || typeof value !== 'object' || visited.has(value)) return false
    visited.add(value)
    let nested = visit(value.cause)
    if (value instanceof AggregateError) {
      for (const child of value.errors) nested = visit(child) || nested
    }
    const failure = value.dshPluginFailure
    if (!nested && failure && typeof failure === 'object') {
      const { stage, entryId, packageName, owner, chain, message } = failure
      failures.push({ stage, entryId, packageName, owner, chain, message })
      return true
    }
    return nested
  }
  visit(error)
  if (failures.length) report('plugin failures', JSON.stringify({ version: 1, failures }))
}

process.on('uncaughtException', (error) => report('uncaught exception', error?.stack ?? error))
process.on('unhandledRejection', (error) => report('unhandled rejection', error?.stack ?? error))

process.stdout.write(
  `[harness-node] runtime node=${process.version} platform=${process.platform} arch=${process.arch}\n`
)
process.stdout.write(`[harness-node] execPath=${process.execPath}\n`)
process.stdout.write(`[harness-node] cwd=${process.cwd()}\n`)
process.stdout.write(`[harness-node] DSH_HOME=${process.env.DSH_HOME ?? ''}\n`)

// Harness and the plugins running inside it spawn their own child processes
// (pwsh, git, ripgrep, …) without windowsHide — that flag on the Harness
// process itself only hides Harness's own console, not what it goes on to
// launch. Each of those visible console windows steals foreground focus on
// Windows. Patching child_process here, before dshEntryPath loads, catches
// every spawn made anywhere in this process tree — Harness internals and
// third-party plugins alike — without needing an upstream fix in each of
// them. A caller that explicitly sets windowsHide keeps its own choice.
if (process.platform === 'win32') {
  // The Harness is spawned console-less (detached + windowsHide), so child
  // console apps flash their own window unless the Harness owns a hidden
  // console for them to inherit (issue #233).
  const { createHiddenConsole } = await import('./windows-hidden-console.mjs')
  createHiddenConsole()

  enforceWindowsChildProcessHide(childProcess, syncBuiltinESMExports)

  process.stdout.write('[harness-node] windowsHide enforcement enabled for child processes\n')
}

if (!dshEntryPath) {
  report('startup error', 'missing DSH entry path')
  process.exitCode = 1
} else {
  process.stdout.write(`[harness-node] loading=${dshEntryPath}\n`)
  process.argv = [process.execPath, dshEntryPath, ...dshArguments]
  let privateDelivery
  try {
    const privateModelHandoff = (privateDelivery = await receivePrivateModelHandoff())?.handoff
    const archive = packagedArchiveRoot(dshEntryPath)
    const resources = archive ? dirname(archive) : import.meta.dirname
    process.env.DSH_DESKTOP_OFFICE_RESOURCES = archive
      ? join(resources, 'office-runtime')
      : join(resources, '..', '.build', 'office-runtime')
    process.env.DSH_DESKTOP_OFFICE_CLI = join(resources, 'office-cli.mjs')
    registerHostModuleFallback(dshEntryPath)
    // Packages load through app.asar; the Office engine must resolve to its
    // unpacked directory so the OS can spawn it.
    registerOfficeEngineResolution(dshEntryPath)
    if (privateModelHandoff) {
      if (privateModelHandoff.gatewayUrl && privateModelHandoff.capabilityToken) {
        await registerPrivateModelCredential(dshEntryPath, privateModelHandoff)
      }
      if (privateModelHandoff.modelService || privateModelHandoff.consumers || privateModelHandoff.pluginConfiguration) await registerPrivateModelService(dshEntryPath, privateModelHandoff)
      if (privateModelHandoff.image) await registerPrivateImageCredential(dshEntryPath, privateModelHandoff.image)
      if (privateModelHandoff.image) await registerPrivateModelImage(dshEntryPath)
    }
    privateDelivery?.acknowledge()
    // Harness 0.1.5 gates its CLI behind `if (import.meta.main)` and exports
    // `runCli`. This file imports the entry rather than being it, so that guard
    // is false here and a plain import would load the module, run nothing, and
    // let the process exit 0 with no diagnostics. Call the export when the
    // entry offers one; older builds still self-execute on import.
    const entry = await import(pathToFileURL(dshEntryPath).href)
    process.stdout.write('[harness-node] DSH entry loaded\n')
    if (typeof entry.runCli === 'function') {
      // PATH `pnpm` is a `.cmd` shim on Windows. Plugin manager's registry
      // read (`pnpm config get registry`) runs on every add-plugin click, and
      // execa launches that shim through cmd.exe. Pass the packaged executable
      // so the same read never creates a console. Missing injection keeps the
      // previous PATH fallback rather than failing startup.
      const packageManager = buildPackagedPnpmInvocation(process.env, process.execPath)
      if (packageManager) {
        const runner = packageManager.args.length > 1 ? 'via lock-recovery runner' : 'without lock-recovery runner'
        process.stdout.write(`[harness-node] invoking DSH runCli() with packaged pnpm (${runner})\n`)
        if (process.env[PACKAGED_PNPM_RUNNER_ENV] && packageManager.args.length === 1) {
          process.stderr.write('[harness-node] packaged pnpm runner is missing; installs skip lock recovery\n')
        }
        await entry.runCli({ packageManager })
      } else {
        process.stdout.write('[harness-node] invoking DSH runCli()\n')
        if (process.env[PACKAGED_PNPM_ENTRY_ENV]) {
          process.stderr.write('[harness-node] packaged pnpm entry is missing; plugin manager will resolve pnpm from PATH\n')
        }
        await entry.runCli()
      }
    }
  } catch (error) {
    privateDelivery?.reject()
    reportPluginFailures(error)
    report('DSH entry failed', error?.stack ?? error)
    process.exitCode = 1
  }
}
