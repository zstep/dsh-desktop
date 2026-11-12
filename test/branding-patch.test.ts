import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const projectRoot = path.resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const sharp = require('sharp') as (input: string) => {
  metadata: () => Promise<{
    width?: number
    height?: number
    hasAlpha?: boolean
  }>
}

describe('DSH Desktop sidebar branding', () => {

  it('uses Pengbao copy and mark in the running status indicator', async () => {
    const client = await readFile(
      path.join(projectRoot, 'node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js'),
      'utf8'
    )

    expect(client).toContain('src: "dsh-desktop://desktop/pengbao-b2-mark.png"')
    expect(client).toContain('"chat.deepDiving": "鹏宝 AI 思考中"')
    expect(client).toContain('"chat.deepDivingFor": "鹏宝 AI 思考中，用时 {duration} ···"')
    expect(client).toContain('"chat.deepDiving": "Pengbao AI is thinking"')
    expect(client).toContain('"chat.deepDivingFor": "Pengbao AI is thinking for {duration} ···"')
  })

  it('uses upstream platform-aware collapsed titlebar spacing', async () => {
    const client = await readFile(
      path.join(projectRoot, 'node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js'),
      'utf8'
    )

    expect(client).toContain('document.documentElement.dataset.platform === "darwin"')
    expect(client).toContain('document.documentElement.hasAttribute("data-windows-titlebar") ? 0 : 56')
    expect(client).toContain('sidebar === 0 ? collapsedWidth')
  })

  it('installs the source logo into the Harness static frontend', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as { scripts: { postinstall: string } }

    expect(packageJson.scripts.postinstall).toContain('node scripts/install-brand-assets.mjs')
  })

  it('generates alpha-aware Teal on Black assets from the tracked source image', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as { scripts: Record<string, string>; build: { extraResources: Array<{ from: string; to: string }> } }
    const source = await sharp(path.join(projectRoot, 'build/pengbao-b2-source.jpeg')).metadata()
    const icon = await sharp(path.join(projectRoot, 'build/app-icon.png')).metadata()
    const light = await sharp(path.join(projectRoot, 'build/logo-light.png')).metadata()
    const dark = await sharp(path.join(projectRoot, 'build/logo-dark.png')).metadata()
    const manifestInstaller = await readFile(path.join(projectRoot, 'scripts/install-brand-assets.mjs'), 'utf8')
    const splash = await readFile(path.join(projectRoot, 'build/splash.html'), 'utf8')

    expect(packageJson.scripts['brand:generate']).toContain('scripts/generate-brand-assets.mjs')
    expect(packageJson.scripts.build).toContain('npm run brand:generate')
    expect(packageJson.scripts.build).toContain('npm run icons:generate')
    expect(packageJson.scripts.build).toContain('npm run loader:generate')
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'build/pengbao-b2-mark.png',
      to: 'pengbao-b2-mark.png'
    })
    expect(source.width).toBe(2048)
    expect(source.height).toBe(2048)
    expect(icon.width).toBe(1024)
    expect(icon.height).toBe(1024)
    expect(icon.hasAlpha).toBe(true)
    expect(light.width).toBe(336)
    expect(light.height).toBe(192)
    expect(light.hasAlpha).toBe(true)
    expect(dark.width).toBe(336)
    expect(dark.height).toBe(192)
    expect(dark.hasAlpha).toBe(true)
    expect(manifestInstaller).toContain("path.join(projectRoot, 'build', 'app-icon.png')")
    expect(manifestInstaller).toContain("src: '/dsh-desktop-logo.png', sizes: '1024x1024'")
    expect(splash).toContain('src="pengbao-b2-mark.png"')
  })
})
