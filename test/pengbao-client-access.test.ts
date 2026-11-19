import { describe, expect, it } from 'vitest'
import { PengbaoClient, clientVisibleModels } from '../src/main/enterprise/client'

describe('Pengbao account model client access', () => {
  it('carries the server model-management switch and surfaces into the account catalog', async () => {
    const client = new PengbaoClient({ fetch: async () => Response.json({ data: [
      { id: 'chat', info: { meta: { client: { enabled: true, types: ['text'] } } } },
      { id: 'image', info: { meta: { client: { enabled: true, types: ['image', 'video'] } } } },
      { id: 'off', info: { meta: { client: { enabled: false, types: ['text'] } } } },
      { id: 'legacy' },
      { id: 'malformed', info: { meta: { client: 'yes' } } }
    ] }) })
    expect(await client.models()).toEqual([
      { id: 'chat', input: ['text'], client: { enabled: true, types: ['text'] } },
      { id: 'image', input: ['text'], client: { enabled: true, types: ['image', 'video'] } },
      { id: 'off', input: ['text'], client: { enabled: false, types: ['text'] } },
      { id: 'legacy', input: ['text'] },
      { id: 'malformed', input: ['text'], client: { enabled: false, types: [] } }
    ])
  })

  it('filters a configured catalog per surface and keeps the legacy catalog before any tag exists', () => {
    const configured = [
      { id: 'chat', client: { enabled: true, types: ['text'] as const } },
      { id: 'image', client: { enabled: true, types: ['image'] as const } },
      { id: 'off', client: { enabled: false, types: ['text', 'image'] as const } },
      { id: 'legacy' }
    ]
    expect(clientVisibleModels(configured, 'text').map(model => model.id)).toEqual(['chat'])
    expect(clientVisibleModels(configured, 'image').map(model => model.id)).toEqual(['image'])
    expect(clientVisibleModels([{ id: 'a' }, { id: 'b' }], 'text').map(model => model.id)).toEqual(['a', 'b'])
  })
})