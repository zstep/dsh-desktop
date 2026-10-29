import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateAppIcons } from '../scripts/generate-app-icons.mjs'

const require = createRequire(import.meta.url)
const sharp = require('sharp')

describe('native Windows app icons', () => {
  it('generates a complete ICO without Apple CLI tools or changing the source', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pengbao-icons-test-'))
    try {
      const source = path.join(root, 'source.png')
      const outputDirectory = path.join(root, 'output')
      await sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 28, g: 198, b: 196, alpha: 0.5 } } })
        .png().toFile(source)
      const original = await readFile(source)
      await generateAppIcons({ source, outputDirectory, platform: 'win32' })
      expect(await readFile(source)).toEqual(original)
      expect(await readdir(outputDirectory)).toEqual(['icon.ico'])

      const icon = await readFile(path.join(outputDirectory, 'icon.ico'))
      const sizes = [16, 24, 32, 48, 64, 128, 256]
      expect(icon.readUInt16LE(0)).toBe(0)
      expect(icon.readUInt16LE(2)).toBe(1)
      expect(icon.readUInt16LE(4)).toBe(sizes.length)
      let offset = 6 + sizes.length * 16
      for (const [index, size] of sizes.entries()) {
        const entry = 6 + index * 16
        expect(icon[entry]).toBe(size === 256 ? 0 : size)
        expect(icon[entry + 1]).toBe(size === 256 ? 0 : size)
        expect(icon.readUInt16LE(entry + 4)).toBe(1)
        expect(icon.readUInt16LE(entry + 6)).toBe(32)
        expect(icon.readUInt32LE(entry + 12)).toBe(offset)
        const length = icon.readUInt32LE(entry + 8)
        const metadata = await sharp(icon.subarray(offset, offset + length)).metadata()
        expect(metadata.format).toBe('png')
        expect(metadata.width).toBe(size)
        expect(metadata.height).toBe(size)
        expect(metadata.hasAlpha).toBe(true)
        offset += length
      }
      expect(offset).toBe(icon.length)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
