import { test, expect } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readProfilePatches, composeEntries } from '@deepseek-ai/dsh-app-boot'

const source = pathToFileURL(createRequire(import.meta.url).resolve('dsh-desktop-imagegen')).href

test('trusted image studio default insertion permits profile settings without relaxing overlay overrides', async () => {
  const home = await mkdtemp(join(tmpdir(), 'imagegen-composition-'))
  try {
    await writeFile(join(home, 'cordis.patch.yml'), '[]\n')
    const initial = { layers: [], patches: [{ id: 'imagegen', config: { desktopImageModelId: 'image-b' } }] }
    const insertion = { insert: [{ id: 'imagegen', name: source }, { id: 'other', name: 'other' }] }
    const context = { dir: home, home, patchPath: join(home, 'profile.yml'), installAnchor: resolve('package.json'), overlays: [insertion] }
    const rows = composeEntries([readProfilePatches('dsh', context, initial)])
    expect(rows.find(row => row.id === 'imagegen').config).toEqual({ desktopImageModelId: 'image-b' })
    expect(insertion.insert).toHaveLength(2)
    expect(rows.find(row => row.id === 'other').config).toBeUndefined()
    context.overlays.push({ id: 'imagegen', config: { desktopImageMode: 'off' } })
    expect(composeEntries([readProfilePatches('dsh', context, initial)]).find(row => row.id === 'imagegen').config).toEqual({ desktopImageMode: 'off' })
    for (const name of ['dsh-desktop-imagegen', 'file:///tmp/untrusted-imagegen.js']) {
      context.overlays = [{ insert: [{ id: 'imagegen', name }] }]
      expect(composeEntries([readProfilePatches('dsh', context, initial)]).find(row => row.id === 'imagegen').config).toBeUndefined()
    }
    context.overlays = [{ insert: [{ id: 'imagegen', name: source, config: { desktopImageMode: 'off' } }] }]
    expect(composeEntries([readProfilePatches('dsh', context, initial)]).find(row => row.id === 'imagegen').config).toEqual({ desktopImageMode: 'off' })
  } finally { await rm(home, { recursive: true, force: true }) }
})
