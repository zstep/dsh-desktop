import { randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rename, stat, symlink, unlink } from 'node:fs/promises'
import { posix, win32 } from 'node:path'

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    // Missing, inaccessible and broken-link candidates are not usable npm CLIs.
    return false
  }
}

async function npmCli(entries: readonly string[], appData: string | undefined, platform: NodeJS.Platform): Promise<string | undefined> {
  const path = platform === 'win32' ? win32 : posix
  for (const entry of entries) {
    // Follow npm links without executing a shell or package-manager shim.
    try {
      const target = await realpath(path.join(entry, 'npm'))
      if (path.basename(target) === 'npm-cli.js' && await isFile(target)) return target
    } catch {
      // A broken link must not hide later candidates or PATH entries.
    }
    for (const candidate of [
      path.join(entry, 'node_modules/npm/bin/npm-cli.js'),
      path.join(entry, '../node_modules/npm/bin/npm-cli.js'),
      path.join(entry, '../lib/node_modules/npm/bin/npm-cli.js')
    ]) {
      if (await isFile(candidate)) return realpath(candidate)
    }
  }
  if (platform === 'win32' && appData && path.isAbsolute(appData)) {
    const candidate = path.join(appData, 'npm/node_modules/npm/bin/npm-cli.js')
    if (await isFile(candidate)) return realpath(candidate)
  }
  return undefined
}

async function ownedDirectory(directory: string): Promise<void> {
  await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  // Do not follow a replaced compatibility parent into unrelated user data.
  if (!(await lstat(directory)).isDirectory()) throw new Error('npm compatibility parent is not a directory')
}

/**
 * HyperFrames 0.11.3–0.11.5 only probes <PATH>/node_modules/npm and misses
 * standard prefix/lib installs when process.execPath is an Electron Helper.
 * Expose the user's npm through a desktop-owned prefix, without changing the
 * installed plugin generation, system npm, or command resolution elsewhere.
 */
export async function withNpmCompatibility(
  dshHome: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): Promise<NodeJS.ProcessEnv> {
  const path = platform === 'win32' ? win32 : posix
  const separator = platform === 'win32' ? ';' : ':'
  const key = platform === 'win32'
    ? (['Path', 'PATH'].find(name => environment[name] !== undefined) ??
      Object.keys(environment).find(name => /^path$/i.test(name)) ?? 'Path')
    : 'PATH'
  const prefix = path.join(dshHome, 'compat', 'npm')
  const entries = (environment[key] ?? '').split(separator)
    .filter(entry => entry !== prefix)
  try {
    const cli = await npmCli(entries.filter(entry => path.isAbsolute(entry)), environment.APPDATA, platform)
    if (!cli) return environment
    const packageRoot = path.dirname(path.dirname(cli))
    await mkdir(dshHome, { recursive: true })
    for (const directory of [path.join(dshHome, 'compat'), prefix, path.join(prefix, 'node_modules')]) {
      await ownedDirectory(directory)
    }
    const link = path.join(prefix, 'node_modules', 'npm')
    const existing = await lstat(link).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    if (existing && !existing.isSymbolicLink()) return environment
    if (!existing || await realpath(link).catch(() => undefined) !== packageRoot) {
      const staged = `${link}.${randomUUID()}.tmp`
      try {
        await symlink(packageRoot, staged, platform === 'win32' ? 'junction' : 'dir')
        await rename(staged, link)
      } finally {
        // Only remove our own temporary link; never recursively delete data.
        await unlink(staged).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
      }
    }
    return { ...environment, [key]: [prefix, ...entries].join(separator) }
  } catch {
    // Optional compatibility must not block Harness startup. Leave the original
    // environment intact so the plugin retains its own missing-npm diagnostic.
    return environment
  }
}
