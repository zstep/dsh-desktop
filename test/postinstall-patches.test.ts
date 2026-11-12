import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { patchPath, projectRoot } from './patch-path'

const require = createRequire(import.meta.url)
const { getPatchFiles } = require('patch-package/dist/patchFs') as {
  getPatchFiles: (directory: string) => string[]
}
const { parsePatchFile } = require('patch-package/dist/patch/parse') as {
  parsePatchFile: (text: string) => Array<{
    type: string
    path: string
    hunks: unknown[]
  }>
}
const { executeEffects } = require('patch-package/dist/patch/apply') as {
  executeEffects: (effects: unknown[], options: { dryRun: boolean; cwd: string; bestEffort: boolean }) => void
}

describe('postinstall patch replay', () => {
  it('does not discover optional external plugin patches as Desktop dependencies', () => {
    const files = getPatchFiles(path.join(projectRoot, 'patches'))
    expect(files.length).toBeGreaterThan(0)
    expect(files.filter(file => file.includes('/') || file.includes('\\'))).toEqual([])
  })

  it('replays the app-boot host preparation declaration against the published EOF layout', async () => {
    const target = 'node_modules/@deepseek-ai/dsh-app-boot/lib/types/index.d.ts'
    const source = [
      ...Array<string>(343).fill('// unrelated declaration'),
      ' * mounted, `plugin tree failed to load` afterwards. Cyclic causes terminate',
      ' * diagnostic traversal without replacing the original cause.',
      ' */',
      'export declare function boot(binName: string, absoluteConfigPath: string, patches?: PatchOptions[], prepare?: (ctx: Context) => Promise<void> | void, bareModuleBaseUrl?: string): Promise<Context>;',
      '//# sourceMappingURL=index.d.ts.map'
    ].join('\n') // The published declaration has no trailing newline.
    const text = await readFile(patchPath('@deepseek-ai/dsh-app-boot'), 'utf8')
    const effect = parsePatchFile(text).find(effect => effect.type === 'patch' && effect.path === target)
    if (!effect) throw new Error('app-boot declaration patch missing')
    const hunk = effect.hunks.at(-1)
    if (!hunk) throw new Error('host preparation declaration hunk missing')
    const root = await mkdtemp(path.join(tmpdir(), 'postinstall-patch-'))
    try {
      const file = path.join(root, target)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, source)
      // Use the same replay implementation as npm ci's postinstall.
      executeEffects([{ ...effect, hunks: [hunk] }], { dryRun: false, cwd: root, bestEffort: false })
      expect(await readFile(file, 'utf8')).toBe(source.replace(
        '//# sourceMappingURL=index.d.ts.map',
        '/** Register asynchronous host setup run after `prepare` but before config entries mount. */\n' +
        'export declare function registerHostPreparation(callback: (ctx: Context) => Promise<void> | void): () => void;\n' +
        '//# sourceMappingURL=index.d.ts.map'
      ))
      // Also catch missing EOF metadata that patch-package may tolerate but git rejects.
      await writeFile(file, source)
      const start = text.indexOf('@@ -344,5 +344,7 @@')
      expect(start).toBeGreaterThan(-1)
      const end = text.indexOf('diff --git ', start)
      const isolated = `diff --git a/${target} b/${target}\n--- a/${target}\n+++ b/${target}\n${text.slice(start, end)}`
      const result = spawnSync('git', ['apply', '--check', '-'], { cwd: root, input: isolated, encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps imagegen preparation wired and its authoritative patch content in sync', async () => {
    const scripts = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')).scripts as Record<string, string>
    expect(scripts['imagegen:prepare']).toBe('node scripts/prepare-imagegen.mjs')
    for (const name of ['dev', 'build', 'pretest', 'pretest:watch']) {
      expect(scripts[name]).toContain('npm run imagegen:prepare')
    }
    // The derived client is gitignored, so every build/test path must generate it.
    const appBoot = await readFile(patchPath('@deepseek-ai/dsh-app-boot'), 'utf8')
    expect(appBoot).toContain('[["imagegen", "dsh-desktop-imagegen"], ["dsh-desktop-model-service", "dsh-desktop-model-service"]]')
    const imagegen = await readFile(patchPath('@dickpy/dsh-imagegen'), 'utf8')
    for (const marker of ['applyWithHost', 'managedParameterInvalid', 'HOST_CHANNEL_ID']) {
      expect(imagegen).toContain(marker)
    }
    const prepare = await readFile(path.join(projectRoot, 'scripts/prepare-imagegen.mjs'), 'utf8')
    expect(prepare).toContain("adapter.includes('HOST_CHANNEL_ID')")
  })
})
