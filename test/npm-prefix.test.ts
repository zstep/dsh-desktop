import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { withNpmCompatibility } from '../src/main/profile/npm-prefix'

const roots: string[] = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'desktop-npm-prefix-'))
  roots.push(root)
  return { root, home: join(root, 'harness') }
}

async function cliAt(root: string) {
  const cli = join(root, 'bin', 'npm-cli.js')
  await mkdir(dirname(cli), { recursive: true })
  await writeFile(cli, 'console.log("fixture npm")\n')
  return cli
}

// Published HyperFrames 0.11.5 lookup, deliberately unchanged. With an
// Electron Helper executable, only the PATH candidates can expose npm.
function hyperframesLookup(environment: NodeJS.ProcessEnv, root: string): unknown {
  return runInNewContext(`
    const paths = [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
    for (const path of (process.env.PATH || '').split(delimiter))
      paths.push(join(path, 'node_modules/npm/bin/npm-cli.js'), join(path, '../node_modules/npm/bin/npm-cli.js'));
    if (process.env.APPDATA)
      paths.push(join(process.env.APPDATA, 'npm/node_modules/npm/bin/npm-cli.js'));
    paths.find(existsSync);
  `, {
    process: { execPath: join(root, 'Desktop Helper.app/Contents/MacOS/Helper'), env: environment },
    dirname, join, delimiter, existsSync
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Harness npm compatibility prefix', () => {
  it('makes standard prefix/lib npm discoverable by unmodified HyperFrames', async () => {
    const { root, home } = await fixture()
    const bin = join(root, 'node/bin')
    const cli = await cliAt(join(root, 'node/lib/node_modules/npm'))
    const environment = { PATH: bin, KEEP: 'unchanged' }
    expect(hyperframesLookup(environment, root)).toBeUndefined()

    const compatible = await withNpmCompatibility(home, environment)
    const discovered = hyperframesLookup(compatible, root)
    expect(typeof discovered).toBe('string')
    expect(await realpath(String(discovered))).toBe(await realpath(cli))
    expect(compatible.KEEP).toBe('unchanged')
    expect(compatible.PATH?.split(delimiter).slice(1)).toEqual([bin])
    expect(environment).toEqual({ PATH: bin, KEEP: 'unchanged' })
  })

  it('resolves Homebrew npm symlinks without executing a shim', async () => {
    const { root, home } = await fixture()
    const bin = join(root, 'brew/bin')
    const cli = await cliAt(join(root, 'Cellar/node/version/lib/node_modules/npm'))
    await mkdir(bin, { recursive: true })
    await symlink(cli, join(bin, 'npm'))
    const compatible = await withNpmCompatibility(home, { PATH: bin })
    expect(await realpath(String(hyperframesLookup(compatible, root)))).toBe(await realpath(cli))
  })

  it('retains Windows-style adjacent node_modules npm layout', async () => {
    const { root, home } = await fixture()
    const bin = join(root, 'node')
    const cli = await cliAt(join(bin, 'node_modules/npm'))
    const compatible = await withNpmCompatibility(home, { PATH: bin })
    expect(await realpath(String(hyperframesLookup(compatible, root)))).toBe(await realpath(cli))
  })

  it('honors the first PATH npm even when a later prefix has an adjacent npm', async () => {
    const { root, home } = await fixture()
    const first = join(root, 'brew/bin')
    const cli = await cliAt(join(root, 'Cellar/node/lib/node_modules/npm'))
    await mkdir(first, { recursive: true })
    await symlink(cli, join(first, 'npm'))
    const second = join(root, 'other/bin')
    await cliAt(join(second, 'node_modules/npm'))
    const compatible = await withNpmCompatibility(home, { PATH: [first, second].join(delimiter) })
    expect(await realpath(String(hyperframesLookup(compatible, root)))).toBe(await realpath(cli))
  })

  it('refreshes the link after switching Node prefixes without creating a self-link', async () => {
    const { root, home } = await fixture()
    const bin = join(root, 'first/bin')
    await cliAt(join(root, 'first/lib/node_modules/npm'))
    const first = await withNpmCompatibility(home, { PATH: bin })
    const secondBin = join(root, 'second/bin')
    const secondCli = await cliAt(join(root, 'second/lib/node_modules/npm'))
    const prefix = join(home, 'compat/npm')
    const second = await withNpmCompatibility(home, { PATH: [prefix, secondBin].join(delimiter) })
    expect(await realpath(String(hyperframesLookup(second, root)))).toBe(await realpath(secondCli))
    const repeated = await withNpmCompatibility(home, second)
    expect(repeated.PATH?.split(delimiter).filter(entry => entry === prefix)).toHaveLength(1)
    expect(await realpath(String(hyperframesLookup(repeated, root)))).toBe(await realpath(secondCli))
    expect(first.PATH?.split(delimiter)[0]).toBe(prefix)
  })

  it('skips directories and broken links and continues to a valid prefix', async () => {
    const { root, home } = await fixture()
    const broken = join(root, 'broken/bin')
    await mkdir(join(broken, 'node_modules/npm/bin/npm-cli.js'), { recursive: true })
    await symlink(join(root, 'missing'), join(broken, 'npm'))
    const valid = join(root, 'valid/bin')
    const cli = await cliAt(join(root, 'valid/lib/node_modules/npm'))
    const compatible = await withNpmCompatibility(home, { PATH: [broken, valid].join(delimiter) })
    expect(await realpath(String(hyperframesLookup(compatible, root)))).toBe(await realpath(cli))
  })

  it('leaves the environment untouched when npm is missing and never executes npm shims', async () => {
    const { root, home } = await fixture()
    const bin = join(root, 'bin')
    await mkdir(bin, { recursive: true })
    const marker = join(root, 'executed')
    await writeFile(join(bin, 'npm'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
    const environment = { PATH: [bin, '.', 'relative/bin'].join(delimiter) }
    expect(await withNpmCompatibility(home, environment)).toBe(environment)
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(home)).toBe(false)
  })

  it('preserves an existing non-link npm directory instead of overwriting it', async () => {
    const { root, home } = await fixture()
    const bin = join(root, 'node/bin')
    await cliAt(join(root, 'node/lib/node_modules/npm'))
    const link = join(home, 'compat/npm/node_modules/npm')
    await mkdir(link, { recursive: true })
    const marker = join(link, 'keep.txt')
    await writeFile(marker, 'keep me')
    const environment = { PATH: bin }
    expect(await withNpmCompatibility(home, environment)).toBe(environment)
    expect(await readFile(marker, 'utf8')).toBe('keep me')
  })

  it('does not write through a symlinked compatibility parent', async () => {
    const { root, home } = await fixture()
    const bin = join(root, 'node/bin')
    await cliAt(join(root, 'node/lib/node_modules/npm'))
    const outside = join(root, 'outside')
    await mkdir(outside)
    await mkdir(home)
    await symlink(outside, join(home, 'compat'), process.platform === 'win32' ? 'junction' : 'dir')
    const environment = { PATH: bin }
    expect(await withNpmCompatibility(home, environment)).toBe(environment)
    expect(existsSync(join(outside, 'npm'))).toBe(false)
  })

  it('degrades safely if the harness home is unusable', async () => {
    const { root, home } = await fixture()
    const bin = join(root, 'node/bin')
    await cliAt(join(root, 'node/lib/node_modules/npm'))
    await writeFile(home, 'not a directory')
    const environment = { PATH: bin }
    expect(await withNpmCompatibility(home, environment)).toBe(environment)
    expect((await lstat(home)).isFile()).toBe(true)
  })
})
