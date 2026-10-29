import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { pengbaoAccountPaths, PENGBAO_PRODUCT } from '../src/main/enterprise/config'

describe('Pengbao product configuration', () => {
  it('pins the production service', () => {
    expect(PENGBAO_PRODUCT.serverUrl).toBe('https://pengbao.ecombus.net')
  })

  it('isolates accounts without using their IDs as filesystem paths', () => {
    const first = pengbaoAccountPaths('/data/pengbao', '../../other')
    const second = pengbaoAccountPaths('/data/pengbao', 'second')
    expect(first.accountId).toMatch(/^[a-f0-9]{64}$/)
    expect(first.home).toBe(join('/data/pengbao', 'accounts', first.accountId, 'harness'))
    expect(first.partition).toBe(`persist:pengbao-${first.accountId}`)
    expect(first).toEqual(pengbaoAccountPaths('/data/pengbao', '../../other'))
    expect(first.home).not.toBe(second.home)
    expect(first.partition).not.toBe(second.partition)
  })

  it('rejects empty or unbounded identities', () => {
    for (const id of ['', '  ', 'x'.repeat(1025)]) {
      expect(() => pengbaoAccountPaths('/data/pengbao', id)).toThrow('Invalid Pengbao account ID')
    }
  })
})
