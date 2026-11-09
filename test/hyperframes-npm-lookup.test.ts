import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, resolve, win32 } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const project = resolve(import.meta.dirname, '..')
const roots: string[] = []
let patched: string

// Only the two published 0.11.3 regions touched by the external patch.
const imports = `import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, stat, symlink, copyFile, open, unlink, realpath } from 'node:fs/promises';
import { basename, dirname, join, delimiter, toNamespacedPath } from 'node:path';
import { createServer } from 'node:net';
import lockfile from 'proper-lockfile';
import { zipSync, strToU8 } from 'fflate';
`
const originalLookup = `function npmCli() {
    const paths = [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
    for (const path of (process.env.PATH || '').split(delimiter))
        paths.push(join(path, 'node_modules/npm/bin/npm-cli.js'), join(path, '../node_modules/npm/bin/npm-cli.js'));
    if (process.env.APPDATA)
        paths.push(join(process.env.APPDATA, 'npm/node_modules/npm/bin/npm-cli.js'));
    const file = paths.find(existsSync);
    if (!file)
        throw new Error('没有找到 npm。请安装 Node.js 22.19+ 或 24+，重启 DSH 后再准备环境。');
    return file;
}
`

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'hyperframes-npm-'))
  roots.push(root)
  return root
}

async function file(path: string, content = '// fixture npm CLI\n') {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  return path
}

function lookup(source: string, execPath: string, environment: Record<string, string>) {
  const body = source.match(/function npmCli\(\) \{[\s\S]*?\n\}/)?.[0]
  if (!body) throw new Error('npmCli fixture is missing')
  const result: unknown = runInNewContext(`${body}; npmCli()`, {
    process: { execPath, env: environment },
    join, dirname, basename, delimiter, isAbsolute, existsSync, realpathSync, statSync
  })
  if (typeof result !== 'string') throw new Error('npmCli must return a path')
  return result
}

beforeAll(async () => {
  const root = await temporaryRoot()
  const path = await file(join(root, 'lib/media-workbench.js'), imports + '\n'.repeat(12) + originalLookup)
  const apply = (...args: string[]) => {
    const result = spawnSync('git', ['apply', ...args, join(project, 'patches/external/dsh-hyperframes+0.11.3.patch')], {
      cwd: root, encoding: 'utf8'
    })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  }
  apply('--check')
  apply()
  patched = await readFile(path, 'utf8')
  apply('--reverse', '--check')
  apply('--reverse')
  expect(await readFile(path, 'utf8')).toBe(imports + '\n'.repeat(12) + originalLookup)
})

afterAll(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('HyperFrames 0.11.3 external npm compatibility patch', () => {
  it('finds standard prefix/lib npm with an Electron-like executable', async () => {
    const root = await temporaryRoot()
    const bin = join(root, 'node-prefix/bin')
    const npm = await file(join(bin, '../lib/node_modules/npm/bin/npm-cli.js'))
    const helper = join(root, 'Desktop Helper.app/Contents/MacOS/Helper')
    expect(() => lookup(originalLookup, helper, { PATH: bin })).toThrow('没有找到 npm')
    expect(lookup(patched, helper, { PATH: bin })).toBe(npm)
  })

  it.skipIf(process.platform === 'win32')('resolves a Homebrew-style npm symlink outside the bin prefix', async () => {
    const root = await temporaryRoot()
    const npm = await file(join(root, 'Cellar/node/version/lib/node_modules/npm/bin/npm-cli.js'))
    const bin = join(root, 'homebrew/bin')
    await mkdir(bin, { recursive: true })
    await symlink(npm, join(bin, 'npm'))
    const helper = join(root, 'Helper')
    expect(() => lookup(originalLookup, helper, { PATH: bin })).toThrow('没有找到 npm')
    expect(lookup(patched, helper, { PATH: bin })).toBe(realpathSync(npm))
  })

  it.each(['node_modules/npm/bin/npm-cli.js', '../lib/node_modules/npm/bin/npm-cli.js'])(
    'retains executable-adjacent layout %s and its precedence over PATH', async layout => {
      const root = await temporaryRoot()
      const bin = join(root, 'node/bin')
      const npm = await file(join(bin, layout))
      const other = join(root, 'other/bin')
      await file(join(other, '../lib/node_modules/npm/bin/npm-cli.js'))
      expect(lookup(patched, join(bin, 'node'), { PATH: other })).toBe(npm)
    }
  )

  it.each(['node_modules/npm/bin/npm-cli.js', '../node_modules/npm/bin/npm-cli.js'])(
    'retains legacy PATH layout %s', async layout => {
      const root = await temporaryRoot()
      const bin = join(root, 'node/bin')
      const npm = await file(join(bin, layout))
      expect(lookup(patched, join(root, 'Helper'), { PATH: bin })).toBe(npm)
    }
  )

  it('ignores a directory masquerading as npm-cli.js and uses the next valid prefix', async () => {
    const root = await temporaryRoot()
    const first = join(root, 'first/bin')
    await mkdir(join(first, 'node_modules/npm/bin/npm-cli.js'), { recursive: true })
    const second = join(root, 'second/bin')
    const npm = await file(join(second, '../lib/node_modules/npm/bin/npm-cli.js'))
    expect(lookup(patched, join(root, 'Helper'), { PATH: [first, second].join(delimiter) })).toBe(npm)
  })

  it.skipIf(process.platform === 'win32')('skips a broken npm symlink without hiding later PATH entries', async () => {
    const root = await temporaryRoot()
    const first = join(root, 'first/bin')
    await mkdir(first, { recursive: true })
    await symlink(join(root, 'missing/npm-cli.js'), join(first, 'npm'))
    const second = join(root, 'second/bin')
    const npm = await file(join(second, '../lib/node_modules/npm/bin/npm-cli.js'))
    expect(lookup(patched, join(root, 'Helper'), { PATH: [first, second].join(delimiter) })).toBe(npm)
  })

  it('does not execute npm shims while discovering a CLI', async () => {
    const root = await temporaryRoot()
    const bin = join(root, 'bin')
    await file(join(bin, 'npm'), 'throw new Error("must not execute")\n')
    expect(() => lookup(patched, join(root, 'Helper'), { PATH: bin })).toThrow('没有找到 npm')
    expect(() => lookup(patched, join(root, 'Helper'), { PATH: `${delimiter}.${delimiter}relative/bin` })).toThrow('没有找到 npm')
  })

  it('preserves Windows adjacent and APPDATA layouts using Windows path semantics', () => {
    const body = patched.match(/function npmCli\(\) \{[\s\S]*?\n\}/)?.[0]
    if (!body) throw new Error('npmCli fixture is missing')
    for (const npm of [
      'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
      'C:\\Users\\Fixture\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npm-cli.js'
    ]) {
      const result: unknown = runInNewContext(`${body}; npmCli()`, {
        ...win32, delimiter: ';',
        process: { execPath: 'C:\\Desktop\\Helper.exe', env: { PATH: 'C:\\Program Files\\nodejs', APPDATA: 'C:\\Users\\Fixture\\AppData\\Roaming' } },
        realpathSync() { throw new Error('No symlink fixture') },
        statSync(path: string) {
          if (path !== npm) throw new Error('Missing fixture candidate')
          return { isFile: () => true }
        }
      })
      expect(result).toBe(npm)
    }
  })

  it('still reports missing npm rather than returning a nonexistent candidate', async () => {
    const root = await temporaryRoot()
    expect(() => lookup(patched, join(root, 'Helper'), {})).toThrow('没有找到 npm')
  })
})
