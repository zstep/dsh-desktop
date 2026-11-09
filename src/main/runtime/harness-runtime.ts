import { isMemoryExit } from '../resource-diagnostics'
import { execFile, execFileSync, type SpawnOptionsWithoutStdio } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, posix, win32 } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { RuntimePhase, RuntimeSnapshot } from '../../shared/contracts'
import type { ModelServiceConsumer } from '../state/model-service-discovery'
import { parsePrivatePluginConfigurationPacket, type PrivatePluginConfigurationPacket } from '../../shared/private-plugin-configuration'
import type { ModelServiceCapability, PrivateModelServicePacket } from '../../shared/model-service'
import { SAFE_MODE_PROFILE } from '../state/safe-mode-profile'
import { prepareHostDisabledPluginsPatch } from '../state/host-disabled-plugins'
import { prepareHostPluginSourcesPatch } from '../state/host-plugin-sources'
import { BUILTIN_IMAGE_GENERATION, BUILTIN_IMAGEGEN } from '../state/host-plugin-state'
import { resolveHostPluginState } from '../state/host-plugin-selection'
import { parsePluginStartupFailures, type PluginStartupFailure } from '../../shared/plugin-startup-failure'
import { removeStaleWriterLocks } from './stale-writer-locks'
import { inspectStartupConfiguration, repairStartupConfig, validModelEndpoint } from '../state/startup-config-recovery'

export interface HarnessRuntimeOptions {
  dshEntryPath: string
  nodeExecutablePath: string
  nodeEntryPath: string
  dshPatchPath: string
  dshSafePatchPath: string
  /** Overlay for dshmarket's entry, passed only when the profile declares the market. */
  dshMarketPatchPath?: string
  dshHome: string
  logPath: string
  launchProcess(
    executablePath: string,
    args: string[],
    options: SpawnOptionsWithoutStdio
  ): HarnessChildProcess
  preferredPort?: number
  startupTimeoutMs?: number
  /** Mirror log lines to the console (development builds only). */
  echoLogs?: boolean
  /**
   * Packaged pnpm script. Plugin manager uses this instead of PATH `pnpm`,
   * which on Windows is a `.cmd` shim and flashes a console on every
   * add-plugin click.
   */
  pnpmEntryPath?: string
  /** Lock-recovery runner placed ahead of `pnpmEntryPath` when the file exists. */
  pnpmRunnerPath?: string
  /** Windows console-hide bootstrap passed to the Harness as an absolute path. */
  hideConsoleBootstrapPath?: string
  onChanged(snapshot: RuntimeSnapshot): void
  /** Optional main-process-only provider capability for the next launch. */
  privateModelHandoff?: () => PrivateModelHandoff | undefined
  /** Discover exact, enabled profile consumers before issuing their scoped grants. */
  privateModelServiceConsumers?: (profile: string, desktopPatchPath?: string, additionalOverlayPaths?: readonly string[]) => Promise<readonly ModelServiceConsumer[]>
  /** Issue a scoped chat grant for the legacy model consumer. */
  privateModelServiceGrant?: (capabilities: readonly ModelServiceCapability[]) => PrivateModelServiceGrant | undefined
  /** Issued only for the selected in-box image plugin; revoked with this launch. */
  privateImageLease?: () => PrivateImageLease | undefined
  /** Host-only configuration broker, scoped and revoked with this launch. */
  privatePluginConfigurationLease?: (profile: string, overlays: readonly string[]) => PrivatePluginConfigurationLease | undefined | Promise<PrivatePluginConfigurationLease | undefined>
  /**
   * Optional extra `--patch` overlay (for the account's model route), resolved
   * per launch so it can merge the profile's current user layer. Appended after
   * every other overlay, for the normal and the Safe Mode profile alike.
   */
  providerOverlay?: (profile: string) => Promise<string | undefined>
}

export interface HarnessChildProcess extends EventEmitter {
  readonly stdout: NodeJS.ReadableStream
  readonly stderr: NodeJS.ReadableStream
  readonly exitCode: number | null
  kill(signal?: NodeJS.Signals): boolean
  /** Node's IPC send or the utility-process adapter's postMessage bridge. */
  send?(message: unknown, callback?: (error: Error | null) => void): boolean
}

/** This value never travels through launch arguments, the environment, or profile files. */
export interface PrivateModelHandoff {
  gatewayUrl?: string
  capabilityToken?: string
  modelService?: PrivateModelServicePacket
  consumers?: readonly ModelServiceConsumer[]
  image?: { gatewayUrl: string; capabilityToken: string }
  pluginConfiguration?: PrivatePluginConfigurationPacket
}

export interface PrivatePluginConfigurationLease extends PrivatePluginConfigurationPacket { revoke(): void }

export type PrivateModelServiceGrant = PrivateModelServicePacket & {
  revoke(): void
}

export interface PrivateImageLease {
  gatewayUrl: string
  capabilityToken: string
  revoke(): void
}

const PRIVATE_HANDOFF_MARKER = 'DSH_DESKTOP_PRIVATE_MODEL_HANDOFF'
const PRIVATE_HANDOFF_TIMEOUT_MS = 5_000
const MAX_PRIVATE_PACKET_BYTES = 256 * 1024
const validPrivateGateway = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(value)) return false
  const port = Number(value.slice(value.lastIndexOf(':') + 1))
  return Number.isInteger(port) && port > 0 && port <= 65535
}
const validPrivateToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{32,512}$/.test(value)

function privateHandoffSpawnOptions(
  options: SpawnOptionsWithoutStdio,
  enabled: boolean
): SpawnOptionsWithoutStdio {
  if (!enabled) return options
  return {
    ...options,
    env: { ...options.env, [PRIVATE_HANDOFF_MARKER]: '1' },
    // Node spawn (Windows/Linux) needs an IPC channel; Electron utilityProcess
    // ignores stdio[3] and uses postMessage through its own parentPort instead.
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'] as unknown as SpawnOptionsWithoutStdio['stdio']
  }
}

export function deliverPrivateHandoff(
  child: HarnessChildProcess,
  handoff: PrivateModelHandoff,
  isCurrent: () => boolean,
  signal: AbortSignal,
  modelService?: PrivateModelServicePacket,
  consumers: readonly ModelServiceConsumer[] = []
): Promise<void> {
  type ConsumerPacket = {
    id: string
    version?: string
    status: ModelServiceConsumer['status']
    capabilities: ModelServiceCapability[]
    adapter?: ModelServiceConsumer['adapter']
  }
  let registry: ConsumerPacket[]
  let safeHandoff: PrivateModelHandoff
  let safeModelService: PrivateModelServicePacket | undefined
  try {
    if (!handoff || typeof handoff !== 'object' || Array.isArray(handoff)) throw new Error('Invalid private model handoff')
    if (!Array.isArray(consumers) || consumers.length > 512) throw new Error('Invalid private model consumers')
    const ids = new Set<string>()
    registry = consumers.map((value): ConsumerPacket => {
      const item: unknown = value
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid private model consumers')
      const candidate = item as Record<string, unknown>
      const id = candidate.id
      const version = candidate.version
      const status = candidate.status
      const capabilities = candidate.capabilities
      const adapter = candidate.adapter
      if (typeof id !== 'string' || id.length > 256 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(id) || ids.has(id) ||
        (version !== undefined && (typeof version !== 'string' || version.length > 128 || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version))) ||
        (status !== 'declared' && status !== 'needs-adapter' && status !== 'invalid-declaration') || !Array.isArray(capabilities) ||
        capabilities.length > 16 || capabilities.some(capability => capability !== 'chat.completions' && capability !== 'image.generate') ||
        new Set(capabilities).size !== capabilities.length ||
        (adapter !== undefined && adapter !== 'llm-pi-ai' && adapter !== 'desktop-imagegen' && adapter !== 'image-generation')) {
        throw new Error('Invalid private model consumers')
      }
      ids.add(id)
      return {
        id,
        ...(version === undefined ? {} : { version }),
        status,
        capabilities: [...capabilities],
        ...(adapter === undefined ? {} : { adapter })
      }
    })
    if (Buffer.byteLength(JSON.stringify(registry)) > MAX_PRIVATE_PACKET_BYTES) throw new Error('Private model consumers exceed IPC size limit')

    const handoffRecord = handoff as Record<string, unknown>
    if (Object.keys(handoffRecord).some(key => !['gatewayUrl', 'capabilityToken', 'modelService', 'consumers', 'image', 'pluginConfiguration'].includes(key)) ||
      handoff.consumers !== undefined && !Array.isArray(handoff.consumers)) {
      throw new Error('Invalid private model handoff')
    }
    if (handoff.consumers !== undefined) {
      const suppliedRegistry: readonly ModelServiceConsumer[] = handoff.consumers
      if (suppliedRegistry.length !== registry.length || suppliedRegistry.some((item: ModelServiceConsumer, index: number) => {
        const normalized = registry[index]
        return !normalized || item.id !== normalized.id || item.version !== normalized.version || item.status !== normalized.status ||
          item.adapter !== normalized.adapter || item.capabilities.length !== normalized.capabilities.length ||
          item.capabilities.some((capability, capabilityIndex) => capability !== normalized.capabilities[capabilityIndex])
      })) throw new Error('Private model handoff consumers do not match discovery')
    }
    const gatewayUrl = handoff.gatewayUrl
    const capabilityToken = handoff.capabilityToken
    if ((gatewayUrl !== undefined || capabilityToken !== undefined) &&
      (!validPrivateGateway(gatewayUrl) || !validPrivateToken(capabilityToken))) {
      throw new Error('Invalid private model handoff')
    }
    const image = handoff.image
    if (image !== undefined && (!image || typeof image !== 'object' ||
      Object.keys(image).some(key => key !== 'gatewayUrl' && key !== 'capabilityToken') ||
      !validPrivateGateway(image.gatewayUrl) || !validPrivateToken(image.capabilityToken))) {
      throw new Error('Invalid private model handoff')
    }
    if (handoff.pluginConfiguration !== undefined) parsePrivatePluginConfigurationPacket(handoff.pluginConfiguration)
    const modelServiceInput = modelService ?? handoff.modelService
    if (modelServiceInput !== undefined) {
      if (!modelServiceInput || typeof modelServiceInput !== 'object' ||
        !validPrivateGateway(modelServiceInput.gatewayUrl) || !validPrivateToken(modelServiceInput.capabilityToken) ||
        modelServiceInput.contractVersion !== 1 || !Array.isArray(modelServiceInput.capabilities) || modelServiceInput.capabilities.length !== 1 ||
        modelServiceInput.capabilities[0] !== 'chat.completions') {
        throw new Error('Invalid private model service packet')
      }
      safeModelService = {
        contractVersion: 1,
        gatewayUrl: modelServiceInput.gatewayUrl,
        capabilityToken: modelServiceInput.capabilityToken,
        capabilities: [...modelServiceInput.capabilities]
      }
    }
    safeHandoff = {
      ...(gatewayUrl === undefined ? {} : { gatewayUrl }),
      ...(capabilityToken === undefined ? {} : { capabilityToken }),
      ...(image === undefined ? {} : { image: { gatewayUrl: image.gatewayUrl, capabilityToken: image.capabilityToken } }),
      ...(handoff.pluginConfiguration === undefined ? {} : { pluginConfiguration: parsePrivatePluginConfigurationPacket(handoff.pluginConfiguration) })
    }
    const fullPacket = { ...safeHandoff, ...(safeModelService ? { modelService: safeModelService } : {}), consumers: registry }
    if (Buffer.byteLength(JSON.stringify(fullPacket)) > MAX_PRIVATE_PACKET_BYTES) throw new Error('Private model handoff exceeds IPC size limit')
  } catch (error) { return Promise.reject(error) }
  return new Promise((resolve, reject) => {
    let finished = false
    let sent = false
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      child.off('message', message)
      child.off('exit', exited)
      child.off('error', errored)
      signal.removeEventListener('abort', cancelled)
      if (error) reject(error)
      else resolve()
    }
    const exited = () => finish(new Error('Harness exited before private model handoff'))
    const errored = () => finish(new Error('Harness failed before private model handoff'))
    const cancelled = () => finish(new Error('Private model handoff was cancelled'))
    const message = (packet: unknown) => {
      if (!isCurrent()) return finish(new Error('Private model handoff was cancelled'))
      if (!packet || typeof packet !== 'object') return
      const kind = (packet as { kind?: unknown }).kind
      if (kind === 'dsh-desktop:private-model-ready') {
        if (sent) return
        sent = true
        if (!child.send) return finish(new Error('Harness child has no private message channel'))
        try {
          child.send({ kind: 'dsh-desktop:private-model-delivery', ...safeHandoff,
            ...(safeModelService ? { modelService: safeModelService } : {}), consumers: registry }, (error) => {
            if (error) finish(new Error('Could not send private model handoff'))
          })
        } catch {
          finish(new Error('Could not send private model handoff'))
        }
      } else if (kind === 'dsh-desktop:private-model-received' && sent) {
        finish()
      } else if (kind === 'dsh-desktop:private-model-rejected' && sent) {
        finish(new Error('Harness rejected private model handoff'))
      }
    }
    const timer = setTimeout(() => finish(new Error('Harness private model handoff timed out')), PRIVATE_HANDOFF_TIMEOUT_MS)
    child.on('message', message)
    child.once('exit', exited)
    child.once('error', errored)
    signal.addEventListener('abort', cancelled, { once: true })
    if (signal.aborted || !isCurrent() || child.exitCode !== null) cancelled()
  })
}

export const DEFAULT_HARNESS_PORT = 43129

/**
 * Resolve the user's interactive login shell environment.
 *
 * Electron apps launched from macOS Finder/Spotlight inherit a minimal
 * environment from launchd that never sources the user's shell profile
 * (~/.zshenv, ~/.zprofile, ~/.zshrc). This leaves PATH without Homebrew,
 * mise shims, ~/.local/bin, etc., so CLIs like bun, lark-cli, and docker
 * are invisible to the Harness process and every subprocess it spawns.
 *
 * On Windows the same gap exists when tools are added via a PowerShell
 * profile ($PROFILE) rather than the user-level registry environment —
 * `cmd /c set` only sees registry vars, so we use PowerShell with the
 * profile loaded to capture the full set.
 *
 * This function shells out once to capture the full environment the user
 * would have in a terminal, and returns it for use as the Harness spawn
 * base. On any failure it falls back to `process.env` to preserve the
 * current behavior.
 *
 * The result is memoised for the process lifetime.
 */
let resolvedShellEnvironment: NodeJS.ProcessEnv | undefined

interface ShellCapture {
  file: string
  args: string[]
  timeout: number
  parse(output: string): NodeJS.ProcessEnv
}

function shellCapture(): ShellCapture {
  if (process.platform === 'win32') {
    return {
      // PowerShell with the user profile loaded captures both registry
      // environment variables and any PATH additions sourced in $PROFILE
      // (e.g. conda activate, nvm use, scoop shim).  -OutputFormat Text
      // avoids BOM/XML wrapping.
      file: 'powershell',
      args: [
        '-NoLogo',
        '-NonInteractive',
        '-OutputFormat', 'Text',
        '-Command',
        // Windows PowerShell writes stdout in the console codepage, not
        // UTF-8, and we decode as UTF-8 below. On a CJK install (ACP 936)
        // every non-ASCII byte then arrives as U+FFFD, so a user profile
        // directory like C:\Users\数据项素 comes back as eight replacement
        // characters — and TEMP, captured here and passed to Harness
        // unchanged, points nowhere. Harness dies in mkdtemp before it can
        // load a plugin tree. Pinning the output encoding is what makes the
        // decode below true; dropping undecodable values is the belt to its
        // braces.
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
        // Dot-source the profile (suppress errors if it doesn't exist),
        // then emit NAME=VALUE for every environment variable.
        '. $PROFILE 2>$null; Get-ChildItem Env: | ForEach-Object { "$($_.Name)=$($_.Value)" }'
      ],
      timeout: 15_000,
      parse: (output) => withoutUndecodableValues(parseEnvOutput(output, /\r?\n/), process.env)
    }
  }
  return {
    // macOS / Linux: run a login + interactive shell so both .zprofile
    // (Homebrew, OrbStack) and .zshrc (mise shims, ~/.local/bin, cargo,
    // go, etc.) are sourced.  stderr is ignored to suppress prompt noise.
    file: process.env.SHELL ?? '/bin/sh',
    args: ['-l', '-i', '-c', 'env'],
    timeout: 10_000,
    parse: (output) => parseEnvOutput(output, /\n/)
  }
}

export function resolveShellEnvironment(): NodeJS.ProcessEnv {
  if (resolvedShellEnvironment !== undefined) return resolvedShellEnvironment

  try {
    const capture = shellCapture()
    const output = execFileSync(capture.file, capture.args, {
      encoding: 'utf8',
      timeout: capture.timeout,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    resolvedShellEnvironment = capture.parse(output)
  } catch {
    // Shell capture failed — stay silent and keep the inherited environment.
    resolvedShellEnvironment = process.env
  }

  return resolvedShellEnvironment
}

let shellEnvironmentCapture: Promise<NodeJS.ProcessEnv> | undefined

/**
 * Capture the shell environment off the main thread, memoised with
 * {@link resolveShellEnvironment}.
 *
 * Running a login + interactive shell costs 300–450ms on a typical macOS
 * setup. Captured synchronously at spawn time, that blocked the main process
 * on the launch critical path; started when the app starts, it overlaps
 * Electron's own boot and the splash, and the launch just reads the result.
 */
export function prewarmShellEnvironment(): Promise<NodeJS.ProcessEnv> {
  if (resolvedShellEnvironment !== undefined) return Promise.resolve(resolvedShellEnvironment)
  shellEnvironmentCapture ??= new Promise<NodeJS.ProcessEnv>((resolve) => {
    let capture: ShellCapture
    try {
      capture = shellCapture()
    } catch {
      resolvedShellEnvironment = process.env
      resolve(resolvedShellEnvironment)
      return
    }
    execFile(
      capture.file,
      capture.args,
      { encoding: 'utf8', timeout: capture.timeout, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        // A capture the synchronous path already finished wins; otherwise keep
        // the inherited environment on failure, exactly like that path.
        resolvedShellEnvironment ??= error ? process.env : capture.parse(stdout)
        resolve(resolvedShellEnvironment)
      }
    ).stdin?.end()
  })
  return shellEnvironmentCapture
}

/**
 * Replace captured values that lost characters in decoding with the ones this
 * process already holds.
 *
 * A value carrying U+FFFD did not survive the trip out of the shell, and there
 * is no recovering the original from it — the byte that produced it is gone.
 * Passing it on is the harmful option: `TEMP` from a mis-decoded capture names
 * a directory that does not exist, and Harness fails in `mkdtemp` before it
 * loads anything, which reads as a launch that hangs. The inherited value is
 * always intact, because it never went through a console.
 *
 * A variable that exists only in the shell profile and mis-decoded has no
 * fallback to take; it is dropped rather than passed on broken, which leaves
 * the consumer to its own default instead of pointing it somewhere wrong.
 * @param captured - what the shell reported.
 * @param inherited - this process's own environment.
 */
export function withoutUndecodableValues(
  captured: NodeJS.ProcessEnv,
  inherited: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(captured)) {
    if (value === undefined || !value.includes('�')) {
      result[name] = value
      continue
    }
    const fallback = inherited[name]
    if (fallback !== undefined) result[name] = fallback
  }
  return result
}

function parseEnvOutput(output: string, lineSeparator: RegExp): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const line of output.split(lineSeparator)) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    env[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return env
}

/**
 * The process launch token from the Harness URL line.
 *
 * Since 0.1.2-alpha.1 the Host authenticates the whole API before dispatch:
 * `dsh-web-app` prints one root URL carrying a per-process token, and only
 * `GET /?token=...` exchanges it for the signed, authority-bound session
 * cookie. API paths and Authorization headers do not accept the token, so
 * every desktop-side consumer — the window and the mobile bridge alike —
 * has to start from this line.
 *
 * @param line - one line of Harness stdout.
 * @returns the token, or undefined when the line is not the URL line.
 */
export function extractLaunchToken(line: string): string | undefined {
  const match = /\bdsh web:\s*(\S+)/u.exec(line)
  if (!match?.[1]) return undefined
  try {
    const token = new URL(match[1]).searchParams.get('token')
    return token === null || token === '' ? undefined : token
  } catch {
    return undefined
  }
}

export function buildHarnessArguments(
  port: number,
  patchPaths?: string | readonly string[],
  profile = 'web'
): string[] {
  const patches = typeof patchPaths === 'string' ? [patchPaths] : patchPaths ?? []
  return [
    ...(profile === 'web' ? ['web'] : ['--profile', profile]),
    ...patches.flatMap((patchPath) => ['--patch', patchPath]),
    // The desktop window is the only intended surface. Without this, Harness
    // hands the same loopback URL to the system browser on every launch.
    '--no-open',
    '--host',
    '127.0.0.1',
    '--port',
    String(port)
  ]
}

/**
 * The captured PATH, looked up the way Windows actually stores it.
 *
 * `resolveShellEnvironment()` returns a plain object built by `parseEnvOutput`,
 * keyed by whatever case the environment block reported — and Windows does not
 * normalise that case, it follows the registry value name. A machine whose
 * PATH value name is stored lowercase yields the key `path`, which an
 * exact-case read misses entirely, launching the Harness with an empty PATH
 * (issue #232). `process.env` never has this problem because Node makes it
 * case-insensitive on win32 — but spreading it into a plain object keeps
 * only the stored casing, so every copy needs this lookup too.
 *
 * POSIX keeps the exact read: there `path` and `PATH` are genuinely
 * different variables.
 */
export function resolveEnvironmentPath(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== 'win32') return environment.PATH ?? ''
  // Exact-case reads first; the scan is the last resort for other casings.
  // A real Windows block stores a single casing, so the order between them
  // is never observable outside synthetic inputs.
  const direct = environment.Path ?? environment.PATH
  if (direct !== undefined) return direct
  for (const [name, value] of Object.entries(environment)) {
    if (/^path$/iu.test(name) && value !== undefined) return value
  }
  return ''
}

/** Paths the Harness entry turns into `runCli({ packageManager })`. */
export interface PackagedPnpmLaunchPaths {
  entryPath?: string
  runnerPath?: string
  /** Absolute path of the Windows `--import` bootstrap, when the file exists. */
  hideConsoleBootstrapPath?: string
}

export function buildHarnessSpawnOptions(
  launchDirectory: string,
  dshHome: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  profile: string = 'web',
  packagedPnpm: PackagedPnpmLaunchPaths = {}
): SpawnOptionsWithoutStdio {
  const {
    ELECTRON_RUN_AS_NODE: _runAsNode,
    DSH_DESKTOP_HOST_RESOLVED: _hostResolved,
    // The desktop, not the parent shell, decides which pnpm the Harness uses.
    DSH_DESKTOP_PNPM_ENTRY: _pnpmEntry,
    DSH_DESKTOP_PNPM_RUNNER: _pnpmRunner,
    DSH_DESKTOP_HIDE_CONSOLE_BOOTSTRAP: _hideConsoleBootstrap,
    DSH_DESKTOP_PRIVATE_MODEL_HANDOFF: _privateHandoff,
    ...parentEnvironment
  } = environment
  const pathKey = platform === 'win32' ? 'Path' : 'PATH'
  const pathApi = platform === 'win32' ? win32 : posix

  // Windows and Linux run Harness through the Electron executable as Node. macOS
  // uses a utility process, which must not receive this flag before Chromium
  // parses its switches. Its entry declares Node mode only for children.
  //
  // On Windows, `detached: true` puts the Harness in its own process group
  // and console. Without it, a child process that calls `os.kill(pid, 0)`
  // (POSIX "liveness probe") ends up broadcasting a Ctrl+C to every process
  // sharing the desktop's console — including the desktop main process, which
  // exits silently. This is the same isolation that the Harness's own
  // subprocess layer is expected to apply; we apply it here so the desktop
  // shell never becomes collateral damage for a buggy child (issue #208).
  const cleanedEnvironment: NodeJS.ProcessEnv = { ...parentEnvironment }
  const rawDeepSeekKey = platform === 'win32'
    ? Object.keys(cleanedEnvironment).find(k => k.toUpperCase() === 'DEEPSEEK_BASE_URL')
    : 'DEEPSEEK_BASE_URL'
  if (rawDeepSeekKey) {
    const rawValue = cleanedEnvironment[rawDeepSeekKey]
    if (rawValue !== undefined && !validModelEndpoint(rawValue, true)) {
      delete cleanedEnvironment[rawDeepSeekKey]
    }
  }

  return {
    cwd: launchDirectory,
    env: {
      ...cleanedEnvironment,
      ...(platform !== 'darwin' && { ELECTRON_RUN_AS_NODE: '1' }),
      DSH_HOME: dshHome,
      NO_COLOR: '1',
      // package-import-method/child-concurrency are left at pnpm's defaults
      // (hardlink, auto concurrency): forcing clone-or-copy made every
      // install do a full physical file copy across the profile's 150+
      // packages, which is what turned installs that should take seconds
      // into multi-minute (up to 30-minute) waits on Windows. The Windows
      // locked-rename problem this was meant to route around is handled by
      // the dedicated lock-recovery runner instead (see pnpm-runner.mjs).
      npm_config_side_effects_cache: 'false',
      PNPM_CONFIG_SIDE_EFFECTS_CACHE: 'false',
      // Safe Mode loads only installation-owned bundles, so the patched Harness
      // resolves them from its own installation and never touches the shared
      // `profiles/node_modules` fallback, whose junctions Windows can refuse.
      ...(profile === SAFE_MODE_PROFILE && { DSH_DESKTOP_HOST_RESOLVED: '1' }),
      // Read by harness-node-entry before runCli. Plugin manager then spawns
      // the Electron executable directly instead of PATH `pnpm.cmd`.
      ...(packagedPnpm.entryPath ? { DSH_DESKTOP_PNPM_ENTRY: packagedPnpm.entryPath } : {}),
      ...(packagedPnpm.runnerPath ? { DSH_DESKTOP_PNPM_RUNNER: packagedPnpm.runnerPath } : {}),
      ...(platform === 'win32' && packagedPnpm.hideConsoleBootstrapPath
        ? { DSH_DESKTOP_HIDE_CONSOLE_BOOTSTRAP: packagedPnpm.hideConsoleBootstrapPath }
        : {}),
      NODE_COMPILE_CACHE: environment.NODE_COMPILE_CACHE ?? pathApi.join(dshHome, 'cache', 'compile-cache'),
      [pathKey]: resolveEnvironmentPath(environment, platform)
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: platform === 'win32'
  }
}

export function buildNodeArguments(
  nodeEntryPath: string,
  dshEntryPath: string,
  port: number,
  patchPaths?: string | readonly string[],
  profile = 'web'
): string[] {
  return [
    '--expose-internals',
    nodeEntryPath,
    dshEntryPath,
    ...buildHarnessArguments(port, patchPaths, profile)
  ]
}

/**
 * Whether a profile boots dshmarket, so its patch row has an entry to modify.
 * A row whose entry is absent makes the loader warn on every launch.
 * @param profileDirectory - the profile's package directory.
 * @returns true when `dsh.profile.bundles` lists dshmarket.
 */
export async function profileBootsMarket(profileDirectory: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(join(profileDirectory, 'package.json'), 'utf8')) as {
      dsh?: { profile?: { bundles?: unknown } }
    }
    const bundles = manifest.dsh?.profile?.bundles
    return Array.isArray(bundles) && bundles.includes('dshmarket')
  } catch {
    return false
  }
}

export function updateReadyStability(
  readySince: number | undefined,
  healthy: boolean,
  now: number,
  stabilityWindowMs = 500
): { readySince: number | undefined; ready: boolean } {
  if (!healthy) return { readySince: undefined, ready: false }
  const stableSince = readySince ?? now
  return {
    readySince: stableSince,
    ready: now - stableSince >= stabilityWindowMs
  }
}

/**
 * A loopback response proves only that the Host has opened its port. Since
 * 0.1.2-alpha.1 the renderer also needs the per-process launch token printed
 * on stdout; navigating before that line arrives produces the authentication
 * error page instead of exchanging the token for a session cookie.
 *
 * The unauthenticated readiness probe is expected to receive 401, so any
 * non-server-error response is acceptable once the token is available.
 */
export function isHarnessStartupProbeHealthy(
  status: number,
  launchToken: string | undefined
): boolean {
  return launchToken !== undefined && status >= 200 && status < 500
}

export class HarnessRuntime {
  private child?: HarnessChildProcess
  private privateHandoffAbort?: AbortController
  private imageLease?: PrivateImageLease
  private modelServiceGrant?: PrivateModelServiceGrant
  private pluginConfigurationLease?: PrivatePluginConfigurationLease
  private launchGeneration = 0
  private logStream?: WriteStream
  private phase: RuntimePhase = 'idle'
  private message = 'Harness is not running.'
  private launchDirectory?: string
  private url?: string
  private launchToken?: string
  /**
   * Wall clock for the current launch. Every log line carries `+<ms>` from it,
   * so a slow start can be attributed to a phase instead of guessed at: the
   * file otherwise timestamps only the `starting` line.
   */
  private launchClock?: number
  private readonly logLines: string[] = []
  private pluginFailures: PluginStartupFailure[] = []
  private failureReason?: RuntimeSnapshot['failureReason']
  private logDecoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
  private readonly logRemainders: Record<'stdout' | 'stderr', string> = {
    stdout: '',
    stderr: ''
  }

  constructor(private readonly options: HarnessRuntimeOptions) {}

  snapshot(): RuntimeSnapshot {
    return {
      phase: this.phase,
      message: this.message,
      launchDirectory: this.launchDirectory,
      url: this.url,
      authToken: this.launchToken,
      pluginFailures: structuredClone(this.pluginFailures),
      failureReason: this.failureReason,
      logs: [...this.logLines]
    }
  }

  private launchAttempts = 0
  get launchAttemptId(): number { return this.launchAttempts }

  async start(launchDirectory: string, profile = 'web'): Promise<void> {
    await this.stop()
    const launchGeneration = ++this.launchGeneration
    this.launchAttempts++
    this.logRemainders.stdout = ''
    this.logRemainders.stderr = ''
    this.pluginFailures = []
    this.logDecoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
    this.launchDirectory = launchDirectory
    this.url = undefined
    this.launchToken = undefined

    if (!existsSync(this.options.dshEntryPath)) {
      this.setState('failed', `Harness entry was not found: ${this.options.dshEntryPath}`)
      return
    }
    if (!existsSync(this.options.nodeExecutablePath)) {
      this.setState('failed', `Harness Node executable was not found: ${this.options.nodeExecutablePath}`)
      return
    }
    if (!existsSync(this.options.nodeEntryPath)) {
      this.setState('failed', `Harness diagnostic entry was not found: ${this.options.nodeEntryPath}`)
      return
    }
    // Profile isolation alone is insufficient: --patch is applied afterwards.
    // Never reintroduce optional product plugins into the recovery profile.
    const sourcePatchPath = profile === SAFE_MODE_PROFILE
      ? this.options.dshSafePatchPath
      : this.options.dshPatchPath
    if (!existsSync(sourcePatchPath)) {
      this.setState('failed', `DSH Desktop patch was not found: ${sourcePatchPath}`)
      return
    }
    await mkdir(this.options.dshHome, { recursive: true })
    const shellEnvironment = await prewarmShellEnvironment()
    if (launchGeneration !== this.launchGeneration) return
    let configurationProblems
    try {
      configurationProblems = await inspectStartupConfiguration(this.options.dshHome, profile, shellEnvironment, launchDirectory)
    } catch (error) {
      this.writeLog(`[desktop] configuration inspection failed: ${error instanceof Error ? error.message : String(error)}`)
      this.setState('failed', 'Startup configuration could not be inspected; check file access permissions.')
      return
    }
    const autoMigratable = configurationProblems.filter(problem => problem.kind === 'legacy-workflow' && problem.repair)
    for (const problem of autoMigratable) {
      try {
        const backup = await repairStartupConfig(this.options.dshHome, problem)
        this.writeLog(`[desktop] auto-migrated legacy-workflow to workflow-ptc; backup: ${backup}`)
      } catch (error) {
        this.writeLog(`[desktop] auto-migration of legacy-workflow failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (autoMigratable.length > 0) {
      configurationProblems = await inspectStartupConfiguration(this.options.dshHome, profile, shellEnvironment, launchDirectory)
    }
    const blockingProblems = configurationProblems.filter(problem => problem.blocking !== false)
    if (blockingProblems.length > 0) {
      const detail = blockingProblems.map(problem => `${problem.kind}: ${problem.source} ${problem.path}`).join('\n')
      this.writeLog(`[desktop] startup configuration requires recovery: ${detail}`)
      this.setState('failed', `Startup configuration requires recovery:\n${detail}`)
      return
    }
    if (configurationProblems.length > 0) {
      const nonBlockingDetail = configurationProblems.map(problem => `${problem.kind}: ${problem.source} ${problem.path}`).join('\n')
      this.writeLog(`[desktop] non-blocking configuration notice (editable in UI):\n${nonBlockingDetail}`)
    }
    const patchPath = profile === SAFE_MODE_PROFILE
      ? sourcePatchPath
      : await prepareHostPluginSourcesPatch(this.options.dshHome, sourcePatchPath, this.options.dshEntryPath)
    const marketPatchPath = this.options.dshMarketPatchPath
    const patchPaths = profile !== SAFE_MODE_PROFILE &&
      marketPatchPath !== undefined &&
      existsSync(marketPatchPath) &&
      await profileBootsMarket(join(this.options.dshHome, 'profiles', profile))
      ? [patchPath, marketPatchPath]
      : [patchPath]
    if (profile !== SAFE_MODE_PROFILE) {
      const disabledPatch = await prepareHostDisabledPluginsPatch(this.options.dshHome, sourcePatchPath)
      if (disabledPatch) patchPaths.push(disabledPatch)
    }
    const providerOverlayPath = await this.options.providerOverlay?.(profile)
    if (providerOverlayPath) patchPaths.push(providerOverlayPath)

    await mkdir(this.options.dshHome, { recursive: true })
    await mkdir(dirname(this.options.logPath), { recursive: true })
    this.logStream ??= this.openLogStream()
    for (const lock of await removeStaleWriterLocks(this.options.dshHome)) {
      this.writeLog(`[desktop] removed stale writer lock ${lock}`)
    }

    const preferredPort = this.options.preferredPort ?? DEFAULT_HARNESS_PORT
    const { port, usedPreferredPort } = await reserveLoopbackPort(preferredPort)
    const url = `http://127.0.0.1:${port}`
    const args = buildNodeArguments(
      this.options.nodeEntryPath,
      this.options.dshEntryPath,
      port,
      patchPaths,
      profile
    )
    const startupTimeoutMs =
      this.options.startupTimeoutMs ?? (process.platform === 'win32' ? 180_000 : 45_000)

    this.launchClock ??= Date.now()
    this.writeLog(`[desktop] starting ${new Date().toISOString()}`)
    this.writeLog(`[desktop] launch directory ${launchDirectory}`)
    this.writeLog(`[desktop] profile ${profile}`)
    for (const path of patchPaths) this.writeLog(`[desktop] patch ${path}`)
    if (!usedPreferredPort) {
      this.writeLog(
        `[desktop] preferred endpoint http://127.0.0.1:${preferredPort} is unavailable; using a temporary port`
      )
    }
    this.writeLog(`[desktop] endpoint ${url}`)
    this.setState('starting', 'Starting DeepSeek Harness…')

    let child: HarnessChildProcess
    let handoff: PrivateModelHandoff | undefined
    let discoveredConsumers: ModelServiceConsumer[] = []
    let modelServiceGrant: PrivateModelServiceGrant | undefined
    let pluginConfigurationLease: PrivatePluginConfigurationLease | undefined
    let privateDelivery = false
    if (launchGeneration !== this.launchGeneration) return
    try {
      const consumers = this.options.privateModelServiceConsumers
        ? [...await this.options.privateModelServiceConsumers(profile, sourcePatchPath, patchPaths.slice(1))]
        : []
      if (launchGeneration !== this.launchGeneration) return
      const builtInChat = { id: '@deepseek-ai/dsh-llm-pi-ai', version: '0.2.1-rc.3', status: 'declared' as const, capabilities: ['chat.completions' as const], adapter: 'llm-pi-ai' as const }
      if (!this.options.privateModelServiceConsumers && this.options.privateModelServiceGrant) consumers.push(builtInChat)
      discoveredConsumers = consumers
      if (launchGeneration !== this.launchGeneration) return
      handoff = this.options.privateModelHandoff?.()
      pluginConfigurationLease = await this.options.privatePluginConfigurationLease?.(profile, patchPaths)
      if (launchGeneration !== this.launchGeneration) { pluginConfigurationLease?.revoke(); pluginConfigurationLease = undefined; return }
      if (pluginConfigurationLease) {
        this.pluginConfigurationLease = pluginConfigurationLease
        handoff = { ...handoff, pluginConfiguration: {
          contractVersion: pluginConfigurationLease.contractVersion,
          gatewayUrl: pluginConfigurationLease.gatewayUrl,
          capabilityToken: pluginConfigurationLease.capabilityToken
        } }
      }
      if (!this.options.privateModelServiceConsumers && !consumers.some(consumer => consumer.id === builtInChat.id) && (handoff || this.options.privateModelServiceGrant)) {
        consumers.push(builtInChat)
        discoveredConsumers = consumers
      }
      const chatConsumers = consumers.filter(consumer => consumer.status === 'declared' && consumer.capabilities.includes('chat.completions'))
      const declaredCapabilities = chatConsumers.length ? ['chat.completions' as const] : []
      if (this.options.privateModelServiceConsumers && !chatConsumers.length && handoff && !handoff.pluginConfiguration) handoff = undefined
      if (this.options.privateImageLease && profile !== SAFE_MODE_PROFILE) {
        const selections = await Promise.all([BUILTIN_IMAGE_GENERATION, BUILTIN_IMAGEGEN].map(
          name => resolveHostPluginState(this.options.dshHome, name)
        ))
        if (launchGeneration !== this.launchGeneration) return
        const hasDeclaredImageConsumer = consumers.some(consumer => consumer.status === 'declared' && consumer.capabilities.includes('image.generate'))
        const legacyHostImage = !this.options.privateModelServiceConsumers && selections.some(selection => selection.effectiveSource === 'host' && selection.effectiveEnabled)
        if (hasDeclaredImageConsumer || legacyHostImage) {
          this.imageLease = this.options.privateImageLease()
          if (this.imageLease) {
            handoff = { ...handoff, image: {
              gatewayUrl: this.imageLease.gatewayUrl,
              capabilityToken: this.imageLease.capabilityToken
            } }
          }
        }
      }
      if (declaredCapabilities.length > 0) {
        modelServiceGrant = this.options.privateModelServiceGrant?.(declaredCapabilities)
        if (modelServiceGrant) this.modelServiceGrant = modelServiceGrant
      }
      if (launchGeneration !== this.launchGeneration) {
        this.revokeModelServiceGrant()
        return
      }
      if (modelServiceGrant) {
        if (!validPrivateGateway(modelServiceGrant.gatewayUrl) || !validPrivateToken(modelServiceGrant.capabilityToken) ||
          modelServiceGrant.contractVersion !== 1 || modelServiceGrant.capabilities.length !== 1 ||
          modelServiceGrant.capabilities.some(capability => capability !== 'chat.completions')) {
          throw new Error('Invalid model service grant')
        }
      }
      if (modelServiceGrant && !handoff) {
        handoff = { gatewayUrl: modelServiceGrant.gatewayUrl, capabilityToken: modelServiceGrant.capabilityToken }
      }
      if (modelServiceGrant && handoff) {
        handoff = { ...handoff, gatewayUrl: modelServiceGrant.gatewayUrl, capabilityToken: modelServiceGrant.capabilityToken }
      }
      privateDelivery = Boolean(handoff?.pluginConfiguration || handoff && validPrivateGateway(handoff.gatewayUrl) && validPrivateToken(handoff.capabilityToken) || modelServiceGrant || this.imageLease || (this.options.privateModelServiceConsumers && discoveredConsumers.length > 0))
      if (handoff && (handoff.gatewayUrl !== undefined || handoff.capabilityToken !== undefined) &&
        (!validPrivateGateway(handoff.gatewayUrl) || !validPrivateToken(handoff.capabilityToken))) {
        throw new Error('Invalid private model handoff')
      }
      if (handoff?.image && (!validPrivateGateway(handoff.image.gatewayUrl) || !validPrivateToken(handoff.image.capabilityToken))) {
        throw new Error('Invalid private model handoff')
      }
      child = this.options.launchProcess(
        this.options.nodeExecutablePath,
        args,
        privateHandoffSpawnOptions(buildHarnessSpawnOptions(
          launchDirectory,
          this.options.dshHome,
          process.platform,
          shellEnvironment,
          profile,
          {
            entryPath: this.options.pnpmEntryPath,
            runnerPath: this.options.pnpmRunnerPath,
            hideConsoleBootstrapPath: this.options.hideConsoleBootstrapPath
          }
        ), privateDelivery)
      )
    } catch (error) {
      if (pluginConfigurationLease && this.pluginConfigurationLease !== pluginConfigurationLease) {
        pluginConfigurationLease.revoke()
      }
      this.revokeImageLease()
      this.revokeModelServiceGrant()
      const message = error instanceof Error ? error.message : String(error)
      this.writeLog(`[utility] launch failed: ${message}`)
      this.setState('failed', `Harness could not start: ${message}`)
      return
    }
    this.child = child
    const modelGrant = this.modelServiceGrant
    const imageLease = this.imageLease
    const configurationLease = this.pluginConfigurationLease
    const revokeChildImageLease = () => {
      if (configurationLease && this.pluginConfigurationLease === configurationLease) this.revokeModelServiceGrant()
      if (imageLease && this.imageLease === imageLease) this.revokeImageLease()
      if (modelGrant && this.modelServiceGrant === modelGrant) this.revokeModelServiceGrant()
    }
    child.once('error', revokeChildImageLease)
    child.once('exit', revokeChildImageLease)
    const servicePacket = modelServiceGrant ? {
      contractVersion: modelServiceGrant.contractVersion,
      gatewayUrl: modelServiceGrant.gatewayUrl,
      capabilityToken: modelServiceGrant.capabilityToken,
      capabilities: [...modelServiceGrant.capabilities]
    } satisfies PrivateModelServicePacket : undefined
    let fatalMemoryFailure = false
    let memoryEvidenceTail = ''

    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child === child) this.writeChunk('stdout', chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (this.child !== child) return
      memoryEvidenceTail = (memoryEvidenceTail + chunk.toString()).slice(-8192)
      fatalMemoryFailure ||= /(?:^|\n)FATAL ERROR:.*(?:heap|[Aa]llocation)|OOM error in V8:/.test(memoryEvidenceTail)
      this.writeChunk('stderr', chunk)
      if (this.child !== child || this.phase !== 'starting') return

      const cause = extractDshEntryFailureCause(this.logLines)
      if (!cause) return

      // The Harness entry has already rejected, so waiting for the HTTP
      // readiness timeout can no longer succeed. Detach this launch before
      // stopping it so the later OS exit code cannot replace the real DSH
      // failure (a graceful SIGTERM may otherwise be reported as exit 0).
      this.child = undefined
      this.url = undefined
      this.launchToken = undefined
      this.writeLog('[desktop] Harness entry failed during startup; stopping immediately')
      this.setState('failed', `Harness could not start.\n${cause}`)
      this.revokeImageLease()
      this.revokeModelServiceGrant()
      void this.stopChild(child).catch((error) => {
        const detail = error instanceof Error ? error.message : String(error)
        this.writeLog(`[desktop] failed to stop rejected Harness launch: ${detail}`)
      })
    })
    child.once('spawn', () => this.writeLog('[desktop] Harness process started'))
    child.once('error', (error) => {
      this.writeLog(`[node] ${error.stack ?? error.message}`)
      if (this.child !== child) return
      this.child = undefined
      this.revokeModelServiceGrant()
      this.revokeImageLease()
      this.setState('failed', `Harness could not start: ${error.message}`)
    })
    child.once('exit', (code, signal) => {
      this.flushLogRemainders()
      const detail = signal ? `signal ${signal}` : formatExitCode(code ?? -1)
      this.writeLog(`[node] Harness process exited (${detail})`)
      if (this.child !== child) return
      this.child = undefined
      this.revokeImageLease()
      this.revokeModelServiceGrant()
      const cause = extractFailureCause(this.logLines)
      this.setState(
        'failed',
        cause
          ? `Harness stopped unexpectedly (${detail}).
${cause}`
          : `Harness stopped unexpectedly (${detail}).`,
        fatalMemoryFailure || isMemoryExit('', code ?? -1) ? 'memory-exhausted' : undefined
      )
    })

    // Drain output and observe early process failures before awaiting private IPC.
    // A child can reject/bootstrap-log immediately, before acknowledging handoff.
    if (privateDelivery) {
      const abort = new AbortController()
      this.privateHandoffAbort = abort
      try {
        await deliverPrivateHandoff(child, handoff ?? {}, () => this.child === child && launchGeneration === this.launchGeneration,
          abort.signal, servicePacket, discoveredConsumers)
      } catch (error) {
        if (this.child !== child) return
        this.child = undefined
        this.revokeImageLease()
        this.revokeModelServiceGrant()
        await this.stopChild(child)
        this.setState('failed', error instanceof Error ? error.message : 'Private model handoff failed')
        return
      } finally {
        if (this.privateHandoffAbort === abort) this.privateHandoffAbort = undefined
      }
    }
    if (this.child !== child || launchGeneration !== this.launchGeneration) return

    const startedAt = Date.now()
    const progressTimer = setInterval(
      () => this.writeLog(`[desktop] waiting for Harness (${Math.round((Date.now() - startedAt) / 1000)}s)`),
      5_000
    )
    const ready = await waitUntilReady(
      url,
      () => this.child === child && child.exitCode === null,
      () => this.launchToken,
      startupTimeoutMs
    ).finally(() => clearInterval(progressTimer))

    if (this.child !== child) return
    if (!ready) {
      this.revokeImageLease()
      this.revokeModelServiceGrant()
      await this.stopChild(child)
      this.setState(
        'failed',
        `Harness did not become ready within ${Math.round(startupTimeoutMs / 1000)} seconds.`,
        'startup-timeout'
      )
      return
    }

    this.url = url
    this.writeLog('[desktop] Harness is ready')
    this.setState('ready', 'Harness is ready.')
  }

  private revokeModelServiceGrant(): void {
    const pluginConfiguration = this.pluginConfigurationLease
    this.pluginConfigurationLease = undefined
    pluginConfiguration?.revoke()
    const grant = this.modelServiceGrant
    this.modelServiceGrant = undefined
    grant?.revoke()
  }

  private revokeImageLease(): void {
    const lease = this.imageLease
    this.imageLease = undefined
    lease?.revoke()
  }

  async stop(): Promise<void> {
    ++this.launchGeneration
    this.revokeImageLease()
    this.revokeModelServiceGrant()
    this.privateHandoffAbort?.abort()
    const child = this.child
    if (!child) {
      this.closeLog()
      if (this.phase !== 'failed') this.setState('idle', 'Harness is not running.')
      return
    }

    this.setState('stopping', 'Stopping Harness…')
    this.child = undefined
    await this.stopChild(child)
    this.closeLog()
    this.url = undefined
    this.launchToken = undefined
    this.setState('idle', 'Harness is not running.')
  }

  private async stopChild(child: HarnessChildProcess): Promise<void> {
    if (child.exitCode !== null) return
    const exitPromise = new Promise<boolean>((resolve) =>
      child.once('exit', () => resolve(true))
    )
    child.kill('SIGTERM')
    const exited = await Promise.race([
      exitPromise,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 4_000))
    ])
    if (!exited && child.exitCode === null) child.kill('SIGKILL')
  }

  private setState(
    phase: RuntimePhase,
    message: string,
    failureReason?: RuntimeSnapshot['failureReason']
  ): void {
    this.phase = phase
    if (phase === 'failed') { this.revokeImageLease(); this.revokeModelServiceGrant() }
    this.message = message
    this.failureReason = failureReason
    this.options.onChanged(this.snapshot())
  }

  private writeChunk(source: 'stdout' | 'stderr', chunk: Buffer): void {
    const lines = `${this.logRemainders[source]}${this.logDecoders[source].write(chunk)}`.split(/\r?\n/)
    this.logRemainders[source] = lines.pop() ?? ''
    for (const line of lines) {
      if (line.length === 0) continue
      if (source === 'stderr' && this.phase === 'starting') {
        const failures = parsePluginStartupFailures(line)
        if (failures) this.pluginFailures.push(...failures)
      }
      this.writeLog(`[${source}] ${line}`)
      const hadToken = this.launchToken !== undefined
      this.launchToken ??= extractLaunchToken(line)
      if (!hadToken && this.launchToken !== undefined) {
        this.writeLog('[desktop] Harness announced its endpoint; probing until it answers')
      }
    }
  }

  private flushLogRemainders(): void {
    for (const source of ['stdout', 'stderr'] as const) {
      const line = this.logRemainders[source] + this.logDecoders[source].end()
      this.logRemainders[source] = ''
      if (line.length > 0) this.writeLog(`[${source}] ${line}`)
    }
  }

  /**
   * Record a line the desktop wants in the Harness log, including before a
   * launch: what happens to the profile between launches is exactly what
   * someone reading the log after a failed install needs to see.
   */
  /**
   * Start this launch's clock before any pre-flight work runs. Profile
   * maintenance — migration recovery, the pnpm store, generation projection,
   * LaunchAgent audit — happens before `start()`, so a clock that began at
   * `starting` hid all of it and made the launch look faster than it felt.
   */
  beginLaunch(reason: string): void {
    this.launchClock = Date.now()
    this.note(`\n[desktop] launch requested (${reason})`)
  }

  note(line: string): void {
    if (!this.logStream) {
      try {
        mkdirSync(dirname(this.options.logPath), { recursive: true })
        this.logStream = this.openLogStream()
      } catch {
        // Keep the line in the in-memory buffer regardless.
      }
    }
    this.writeLog(line)
  }

  private openLogStream(): WriteStream {
    const stream = createWriteStream(this.options.logPath, { flags: 'a' })
    // File-stream errors are asynchronous. Keep diagnostics best effort instead of
    // letting an unwritable log abort the native recovery path with an unhandled event.
    stream.on('error', (error: NodeJS.ErrnoException) => {
      console.warn('[desktop] Harness log write failed:', error.code ?? 'UNKNOWN')
    })
    return stream
  }

  private writeLog(line: string): void {
    this.logLines.push(line)
    if (this.logLines.length > 200) this.logLines.splice(0, this.logLines.length - 200)
    const stamped = this.stampLog(line)
    this.logStream?.write(`${stamped}\n`)
    if (this.options.echoLogs) console.log(stamped)
  }

  /**
   * Prefix a log line with an ISO date and milliseconds since this launch began.
   * Only the file copy is stamped: `logLines` feeds recovery detection and failure-cause
   * extraction, which match on the line text.
   */
  private stampLog(line: string): string {
    const iso = new Date().toISOString()
    const elapsed = this.launchClock !== undefined ? `+${String(Date.now() - this.launchClock).padStart(5)}ms ` : ''
    const stamp = `[${iso}] ${elapsed}`
    return line.startsWith('\n') ? `\n${stamp}${line.slice(1)}` : `${stamp}${line}`
  }

  flushLog(): Promise<void> {
    const stream = this.logStream
    if (stream?.errored) return Promise.reject(stream.errored)
    if (!stream || stream.destroyed || stream.writableEnded) return Promise.resolve()
    return new Promise((resolve, reject) => {
      stream.write('', error => error ? reject(error) : resolve())
    })
  }

  private closeLog(): void {
    this.logStream?.end()
    this.logStream = undefined
  }
}

/**
 * Runtime logger output bridged by `dsh-desktop-log-bridge`. It is kept in
 * harness.log for people and the Repair Agent, but it is not launch evidence:
 * a warning logged while running must not become recovery's failure cause or
 * the plugin it blames.
 */
const BRIDGED_LOG_PREFIX = '[stderr] [harness-log] '

/** The latest launch attempt's log lines, without bridged runtime logger output. */
export function latestHarnessAttemptLogs(logLines: readonly string[]): readonly string[] {
  let start = 0
  for (let index = logLines.length - 1; index >= 0; index -= 1) {
    if (logLines[index]?.trimStart().startsWith('[desktop] starting ')) {
      start = index + 1
      break
    }
  }
  return logLines.slice(start).filter((line) => !line.startsWith(BRIDGED_LOG_PREFIX))
}

export function extractFailureCause(logLines: readonly string[]): string | undefined {
  const stderrLines: string[] = []
  let dshEntryError: string | undefined
  let uncaughtError: string | undefined

  for (const line of latestHarnessAttemptLogs(logLines)) {
    if (!line.startsWith('[stderr] ')) continue
    const text = line.slice(8)
    stderrLines.push(text)

    if (dshEntryError === undefined) {
      const m = text.match(/DSH entry failed:\s*(.+)/)
      if (m && m[1]) dshEntryError = m[1].trim()
    }

    if (uncaughtError === undefined) {
      const m1 = text.match(/uncaught exception:\s*(.+)/)
      if (m1 && m1[1]) {
        uncaughtError = m1[1].trim()
      } else {
        const m2 = text.match(/unhandled rejection:\s*(.+)/)
        if (m2 && m2[1]) uncaughtError = m2[1].trim()
      }
    }
  }

  if (dshEntryError) return dshEntryError
  if (uncaughtError) return uncaughtError

  for (let i = stderrLines.length - 1; i >= 0; i--) {
    const line = stderrLines[i]?.trim()
    if (!line) continue
    if (line.length < 200 && /\b(error|Error|ERROR|failed|Failed|FAILED)\b/.test(line)) {
      return line
    }
  }

  if (stderrLines.length > 0) {
    const last = stderrLines[stderrLines.length - 1]?.trim()
    if (last && last.length < 200) return last
  }

  return undefined
}

export function extractDshEntryFailureCause(
  logLines: readonly string[]
): string | undefined {
  for (const line of latestHarnessAttemptLogs(logLines)) {
    if (!line.startsWith('[stderr] ')) continue
    const match = line.slice(8).match(/DSH entry failed:\s*(.+)/)
    if (match?.[1]) return match[1].trim()
  }
  return undefined
}

const CORE_BUNDLES = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dshmarket'])
const PACKAGE_REFERENCE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i

function isPackageReference(value: string): boolean {
  const candidate = value.trim()
  if (!candidate || candidate.includes(':')) return false
  return PACKAGE_REFERENCE_PATTERN.test(candidate)
}

function isActionablePluginReference(value: string): boolean {
  const candidate = value.trim()
  return (
    isPackageReference(candidate) &&
    !CORE_BUNDLES.has(candidate) &&
    !candidate.startsWith('@deepseek-ai/')
  )
}

function extractPluginReferences(
  logLines: readonly string[],
  accepts: (value: string) => boolean
): string[] {
  const plugins = new Set<string>()
  const attemptLogs = latestHarnessAttemptLogs(logLines)
  const hasDuplicatePrefixRoute = attemptLogs.some((line) =>
    line.startsWith('[stderr] ') && /duplicate prefix route ["'][^"']+["']/i.test(line)
  )

  for (const line of attemptLogs) {
    if (!line.startsWith('[stderr] ')) continue
    const text = line.slice(8)
    const bootFailureLines = text.split(/\r?\n/).map((value) => value.trim())

    // Loader failures are nested (for example the internal `cordis:include`
    // entry wrapping a third-party bundle). Collect every entry in the chain;
    // taking only the first one loses the actual uninstallable owner.
    for (const match of text.matchAll(
      /failed to (?:apply|import) loader entry [^\s]+ \((@[^)]+|[^)]+)\)/gi
    )) {
      if (match[1] && accepts(match[1])) plugins.add(match[1].trim())
    }

    const m2 = text.match(/cannot resolve profile bundle ["']([^"']+)["']/i)
    if (m2 && m2[1] && accepts(m2[1])) {
      plugins.add(m2[1].trim())
    }

    const m3 = text.match(/profile bundle ["']([^"']+)["'] declares no dsh\.bundle/i)
    if (m3 && m3[1] && accepts(m3[1])) {
      plugins.add(m3[1].trim())
    }

    const m5 = text.match(/plugin\(s\) failed to load:\s*([a-zA-Z0-9@/_-]+)/i)
    if (m5 && m5[1] && accepts(m5[1])) {
      plugins.add(m5[1].trim())
    }

    for (const candidate of bootFailureLines) {
      const pendingEntry = candidate.match(
        /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*):\s*pending\s*\(waiting for service:\s*[^)]+\)\s*$/i
      )
      if (pendingEntry?.[1] && accepts(pendingEntry[1])) {
        plugins.add(pendingEntry[1].trim())
      }
    }

    // Some Harness errors do not include the loader wrapper that normally
    // names the bundle. For duplicate routes, the first profile stack frame is
    // still direct ownership evidence. Restrict stack extraction to that
    // failure class so unrelated warnings cannot turn into removal suspects.
    if (hasDuplicatePrefixRoute) {
      for (const match of text.matchAll(
        /[\\/]profiles[\\/][^\\/\s]+[\\/]node_modules[\\/]((?:@[^\\/\s]+[\\/])?[^\\/\s)]+)/gi
      )) {
        const candidate = match[1]?.replace(/\\/g, '/')
        if (candidate && accepts(candidate)) plugins.add(candidate.trim())
      }
    }

    const bootFailureTitle = bootFailureLines.findIndex((value) => value === 'Failed to load plugins')
    if (bootFailureTitle >= 0) {
      for (const candidate of bootFailureLines.slice(bootFailureTitle + 1)) {
        if (accepts(candidate)) plugins.add(candidate)
      }
    }
  }

  return [...plugins]
}

export function extractPluginFailureReferences(logLines: readonly string[]): string[] {
  return extractPluginReferences(logLines, isPackageReference)
}

export function extractOffendingPlugins(logLines: readonly string[]): string[] {
  return extractPluginReferences(logLines, isActionablePluginReference)
}

export function extractDuplicateLoaderEntryId(
  logLines: readonly string[]
): string | undefined {
  for (const line of latestHarnessAttemptLogs(logLines)) {
    if (!line.startsWith('[stderr] ')) continue
    const match = line.slice(8).match(/duplicate loader entry id:\s*["']?([^\s"']+)["']?/i)
    if (match?.[1]) return match[1].trim()
  }
  return undefined
}

export function extractSlotConflictName(
  logLines: readonly string[]
): string | undefined {
  for (const line of latestHarnessAttemptLogs(logLines)) {
    if (!line.startsWith('[stderr] ')) continue
    const text = line.slice(8)
    const loaderMatch = text.match(
      /single slot\s+["']([^"']+)["']\s+already has a registration/i
    )
    if (loaderMatch?.[1]) return loaderMatch[1].trim()
    const rendererMatch = text.match(
      /UI slot\s+["']([^"']+)["']\s+has duplicate registrations/i
    )
    if (rendererMatch?.[1]) return rendererMatch[1].trim()
  }
  return undefined
}

export function extractOffendingPlugin(logLines: readonly string[]): string | undefined {
  return extractOffendingPlugins(logLines)[0]
}

export function formatExitCode(code: number): string {
  const unsigned = code >>> 0
  const hexadecimal = `0x${unsigned.toString(16).padStart(8, '0').toUpperCase()}`
  if (unsigned === 0xffff7003) {
    return `exit code ${unsigned} (${hexadecimal}, Crashpad handler unavailable)`
  }
  return `exit code ${code} (${hexadecimal})`
}

async function reservePort(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port }, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not reserve a local port.'))
        return
      }
      const { port } = address
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

/**
 * Prefer a stable loopback origin so Chromium can reuse the Harness frontend
 * cache across launches. A conflicting local process must not prevent Desktop
 * from starting, so an ephemeral port remains the fallback.
 */
export async function reserveLoopbackPort(
  preferredPort = DEFAULT_HARNESS_PORT
): Promise<{ port: number; usedPreferredPort: boolean }> {
  try {
    return { port: await reservePort(preferredPort), usedPreferredPort: true }
  } catch {
    return { port: await reservePort(0), usedPreferredPort: false }
  }
}

async function waitUntilReady(
  url: string,
  isAlive: () => boolean,
  launchToken: () => string | undefined,
  timeoutMs: number
): Promise<boolean> {
  let deadline = Date.now() + timeoutMs
  let extendedForLaunch = false
  // A probe only counts as healthy once Harness has printed its launch token,
  // and Harness prints that line after its whole plugin tree has loaded and
  // the web server is serving. The first healthy probe is therefore already
  // the settled state; a 500ms sustain window on top of it was pure latency
  // at the end of every launch.
  const stabilityWindowMs = 0
  let readySince: number | undefined
  while (Date.now() < deadline && isAlive()) {
    // If Harness has already announced its endpoint (launch token emitted),
    // grant at least 30s for the HTTP probe to answer before timing out.
    if (!extendedForLaunch && launchToken() !== undefined) {
      extendedForLaunch = true
      deadline = Math.max(deadline, Date.now() + 30_000)
    }
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1_000) })
      const stability = updateReadyStability(
        readySince,
        isHarnessStartupProbeHealthy(response.status, launchToken()),
        Date.now(),
        stabilityWindowMs
      )
      readySince = stability.readySince
      if (stability.ready) return true
    } catch {
      // The server is expected to reject connections while it is booting.
      readySince = updateReadyStability(readySince, false, Date.now()).readySince
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}
