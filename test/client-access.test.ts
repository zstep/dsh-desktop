import { describe, expect, it } from 'vitest'
import { clientAccessConfigured, entryClientAccess, parseClientAccess } from '../src/main/enterprise/client-access'

describe('Pengbao client model metadata', () => {
  it('distinguishes an unconfigured model from an explicitly disabled one', () => {
    expect(parseClientAccess({})).toBeUndefined()
    expect(parseClientAccess({ client: null })).toBeUndefined()
    expect(parseClientAccess({ client: { enabled: false, types: [] } })).toEqual({ enabled: false, types: [] })
  })

  it('keeps only known, unique surfaces and fails closed on malformed metadata', () => {
    expect(parseClientAccess({ client: { enabled: true, types: ['text', 'image', 'text', 'audio', 7] } }))
      .toEqual({ enabled: true, types: ['text', 'image'] })
    expect(parseClientAccess({ client: 'enabled' })).toEqual({ enabled: false, types: [] })
  })

  it('reads the client block from a catalog entry info.meta', () => {
    const entry = { id: 'm', info: { meta: { client: { enabled: true, types: ['video'] } } } }
    expect(entryClientAccess(entry)).toEqual({ enabled: true, types: ['video'] })
    expect(entryClientAccess({ id: 'm', info: { meta: {} } })).toBeUndefined()
  })

  it('treats the catalog as configured when any row carries client metadata', () => {
    expect(clientAccessConfigured([{ id: 'a', info: { meta: {} } }])).toBe(false)
    expect(clientAccessConfigured([{ id: 'b', info: { meta: { client: null } } }])).toBe(false)
    expect(clientAccessConfigured([{ id: 'a', info: { meta: {} } }, { id: 'b', info: { meta: { client: { enabled: false, types: [] } } } }])).toBe(true)
  })
})