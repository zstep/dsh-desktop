import { expect, it, vi } from 'vitest'
import { checkWebsiteUpdate, comparePengbaoVersions, PENGBAO_CATALOG_URL } from '../src/main/update/website-update'

it.each([
  ['0.13.2.2', '0.13.2.1', 1],
  ['0.13.2.10', '0.13.2.9', 1],
  ['0.13.2.1', '0.13.2', 1],
  ['0.13.3', '0.13.2.99', 1],
  ['0.13.2.1', '0.13.2.1', 0],
  ['0.13.2.1', '0.13.3', -1]
])('compares Pengbao release %s to %s', (next, current, expected) => {
  expect(comparePengbaoVersions(next as string, current as string)).toBe(expected)
})

const catalog = (version = '0.13.2.2') => ({ version, available: true, platforms: [
  { id: 'mac-arm64', filename: 'pengbao-ai-mac-arm64.dmg' }
] })
it('checks only the fixed Pengbao catalog and returns a newer platform release', async () => {
  const request = vi.fn(async () => Response.json(catalog()))
  expect(await checkWebsiteUpdate('0.13.2.1', 'darwin', 'arm64', request)).toEqual({ version: '0.13.2.2' })
  expect(request).toHaveBeenCalledWith(PENGBAO_CATALOG_URL, expect.objectContaining({ redirect: 'error', cache: 'no-store' }))
})
it('does not offer equal, older, missing-platform or unavailable releases', async () => {
  for (const data of [catalog('0.13.2.1'), catalog('0.13.1'), { ...catalog(), platforms: [] }, { ...catalog(), available: false }]) {
    expect(await checkWebsiteUpdate('0.13.2.1', 'darwin', 'arm64', async () => Response.json(data))).toBeNull()
  }
})
it('rejects malformed versions and oversized or failed responses', async () => {
  for (const response of [Response.json(catalog('0.13.2+evil.3')), new Response('x'.repeat(65537)), new Response('', { status: 503 })]) {
    await expect(checkWebsiteUpdate('0.13.2.1', 'darwin', 'arm64', async () => response)).rejects.toThrow()
  }
})
