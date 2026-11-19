import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { DesktopHostProcess } from '../src/main/shell/backend/host-process'
import { ensureHostBundle, hostBundle } from './host/host-bundle-helper'

const require = createRequire(import.meta.url)
const electron = require('electron') as string
const project = resolve(import.meta.dirname, '..')

it('loads the global Pengbao identity in the actual Harness child without model requests', async () => {
  await ensureHostBundle()
  const home = await mkdtemp(join(tmpdir(), 'pengbao-identity-runtime-'))
  let host: DesktopHostProcess | undefined
  try {
    const probe = join(home, 'identity-probe.mjs')
    await writeFile(probe, `
export const inject = ['systemPrompt', 'connection'];
export function apply(ctx) {
  ctx.connection.fetch.register({ path: '/api/identity-fixture', methods: ['POST'], fetch: async () => {
    const assembly = await ctx.systemPrompt.assemble();
    return Response.json({ sections: assembly.sections.map(({ name, text }) => ({ name, text })) });
  } });
}
`)
    const patch = join(home, 'identity.patch.yml')
    await writeFile(patch, `${await readFile(join(project, 'build/dsh-desktop-safe.patch.yml'), 'utf8')}
# The test profile has no product telemetry service; match the product patch.
- id: desktop-product-telemetry
  disabled: true
- id: product-analytics
  disabled: true
- insert:
    - id: identity-fixture
      name: ${JSON.stringify(pathToFileURL(probe).href)}
`)
    const profile = join(home, 'profiles', 'desktop')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }
    }))
    await writeFile(join(profile, 'cordis.yml'), '[]\n')
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')

    host = new DesktopHostProcess({
      node: electron,
      entry: hostBundle,
      runtimeDir: project,
      projectDir: profile,
      dshHome: home,
      profile: 'desktop',
      environment: { DSH_DESKTOP_PATCH_FILE: patch },
      primaryRuntime: join(home, 'unused-runtime')
    })
    const ready = await host.start()
    const login = await fetch(ready.url, { redirect: 'manual' })
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    await login.body?.cancel()
    const response = await fetch(new URL('/api/identity-fixture', ready.url), {
      method: 'POST', headers: { Cookie: cookie }, signal: AbortSignal.timeout(15_000)
    })
    expect(response.status).toBe(200)
    const { sections } = await response.json() as { sections: { name: string; text: string }[] }
    const identity = sections.filter(section => section.name === 'pengbao:product-identity')
    expect(identity).toHaveLength(1)
    expect(identity[0]?.text).toContain('你是鹏宝 AI')
    expect(identity[0]?.text).toContain('如实说明')
    expect(sections.some(section => section.name === 'harness:identity')).toBe(true)
  } finally {
    await host?.stop()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 180_000)