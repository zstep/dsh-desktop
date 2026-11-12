import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { patchPath, projectRoot } from './patch-path'

const profileConfigTags = [
  {
    tag: 'tag:yaml.org,2002:js',
    resolve: (value: string) => value
  }
]

async function readProfilePatch(): Promise<{ name?: string; insert?: { name?: string }[] }[]> {
  return parseYaml(
    await readFile(path.join(projectRoot, 'build', 'dsh-desktop.patch.yml'), 'utf8'),
    { customTags: profileConfigTags }
  ) as { name?: string; insert?: { name?: string }[] }[]
}

/**
 * Every desktop plugin the composed profile mounts has to be reachable from
 * the profile directory, and the profile does not resolve through the app's
 * own node_modules.
 *
 * Harness mirrors the dependency closure of `@deepseek-ai/dsh` into
 * `$DSH_HOME/profiles/node_modules`, anchored at that package's manifest — not
 * at ours. A desktop plugin therefore reaches the profile only by being
 * injected into that manifest's dependencies, which is what the `dsh` patch
 * does. Adding a row to the profile patch without that injection boots to
 * `Cannot find package ... imported from .../profiles/web/`, which fails the
 * whole plugin tree rather than just that row.
 */
describe('desktop plugin closure', () => {
  it('injects every profile-mounted package into the dsh dependency closure', async () => {
    const profilePatch = await readProfilePatch()

    const mounted = profilePatch
      .flatMap((row) => row.insert ?? [])
      .map((entry) => entry.name)
      .filter((name): name is string => typeof name === 'string')

    expect(mounted.length).toBeGreaterThan(0)

    const dshPatch = await readFile(patchPath('@deepseek-ai/dsh'), 'utf8')
    for (const name of mounted) {
      expect(dshPatch).toContain(`+    "${name}":`)
    }
  })

  it('declares every profile-mounted package as a local production dependency', async () => {
    const profilePatch = await readProfilePatch()

    const manifest = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as { dependencies: Record<string, string> }

    for (const row of profilePatch.flatMap((entry) => entry.insert ?? [])) {
      if (typeof row.name !== 'string') continue
      expect(manifest.dependencies[row.name]).toMatch(/^file:packages\//u)
    }
  })

  it('keeps the legacy imagegen wrapper available without mounting it by default', async () => {
    const manifest = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>; scripts: Record<string, string>; build: { files: unknown[] }
    }
    expect(manifest.dependencies['@dickpy/dsh-imagegen']).toBeUndefined()
    expect(manifest.dependencies['dsh-desktop-imagegen']).toMatch(/^file:packages\//u)
    // Pengbao keeps the managed image studio build step, but never mounts it by default.
    expect(manifest.scripts['imagegen:prepare']).toContain('scripts/prepare-imagegen.mjs')
    expect(manifest.build.files).not.toContain('!node_modules/@dickpy/dsh-imagegen{,/**}')
    expect(manifest.build.files).not.toContain('!node_modules/dsh-desktop-imagegen{,/**}')
    const mounted = (await readProfilePatch()).flatMap(row => row.insert ?? []).map(row => row.name)
    expect(mounted).not.toContain('dsh-desktop-imagegen')
    expect(mounted).not.toContain('@dickpy/dsh-imagegen')
    expect(await readFile(patchPath('@deepseek-ai/dsh'), 'utf8')).not.toContain('"dsh-desktop-imagegen"')
    await expect(readFile(path.join(projectRoot, 'patches/@dickpy+dsh-imagegen+1.11.0.patch'))).resolves.toBeTruthy()
  })
})
