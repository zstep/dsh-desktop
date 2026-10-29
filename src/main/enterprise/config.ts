import { createHash } from 'node:crypto'
import { join } from 'node:path'

export const PENGBAO_PRODUCT = {
  name: '鹏宝 AI',
  nameEn: 'Pengbao AI',
  appId: 'net.ecombus.pengbao.desktop',
  dataDirectory: 'PengbaoAI',
  serverUrl: 'https://pengbao.ecombus.net'
} as const

/** Account identity is bound to the service, never to a mutable email or name. */
export function pengbaoAccountPaths(userData: string, userId: string): {
  accountId: string
  home: string
  partition: string
} {
  if (!userId.trim() || userId.length > 1024) throw new Error('Invalid Pengbao account ID')
  const accountId = createHash('sha256')
    .update(JSON.stringify([PENGBAO_PRODUCT.serverUrl, userId]))
    .digest('hex')
  return {
    accountId,
    home: join(userData, 'accounts', accountId, 'harness'),
    partition: `persist:pengbao-${accountId}`
  }
}
