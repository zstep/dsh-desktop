import { compareVersions } from './version-catalog'

export const PENGBAO_CATALOG_URL = 'https://pengbao.ecombus.net/api/desktop/downloads'
export const PENGBAO_DOWNLOAD_URL = 'https://pengbao.ecombus.net/download'
const VERSION = /^(\d+\.\d+\.\d+)(?:\.([1-9]\d{0,8}))?$/

/** Compare the upstream three-part version first, then the Pengbao fourth revision. */
export function comparePengbaoVersions(next: string, current: string): number {
  const a = VERSION.exec(next)
  const b = VERSION.exec(current)
  if (!a || !b) throw new Error('Invalid Pengbao release version')
  return compareVersions(a[1]!, b[1]!) || Math.sign(Number(a[2] ?? 0) - Number(b[2] ?? 0))
}

export async function checkWebsiteUpdate(
  currentVersion: string, platform: string, arch: string,
  request: (url: string, init: RequestInit) => Promise<Response>
): Promise<{ version: string } | null> {
  const id = platform === 'darwin' ? (arch === 'arm64' ? 'mac-arm64' : arch === 'x64' ? 'mac-x64' : undefined)
    : platform === 'win32' && arch === 'x64' ? 'windows-x64' : undefined
  if (!id) return null
  const response = await request(PENGBAO_CATALOG_URL, { signal: AbortSignal.timeout(8000), redirect: 'error', cache: 'no-store' })
  if (!response.ok || !response.body) throw new Error('Pengbao download catalog unavailable')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 65536) throw new Error('Pengbao download catalog too large')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  const catalog = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!catalog || typeof catalog.version !== 'string' || !VERSION.test(catalog.version)) throw new Error('Invalid Pengbao download catalog')
  if (catalog.available !== true || !Array.isArray(catalog.platforms) || !catalog.platforms.some((item: unknown) =>
    item !== null && typeof item === 'object' && 'id' in item && item.id === id)) return null
  return comparePengbaoVersions(catalog.version, currentVersion) > 0 ? { version: catalog.version } : null
}
