import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { PengbaoClient } from '../src/main/enterprise/client'
import {
  assertServableModels,
  pengbaoProviderOverlayText,
  preparePengbaoProviderOverlay,
  removePengbaoProviderOverlay
} from '../src/main/enterprise/provider-overlay'

const dirs: string[] = []
afterEach(async () => Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))))

describe('Pengbao provider overlay', () => {
  it('preserves user provider settings and pins Pengbao without an environment credential', () => {
    const text = pengbaoProviderOverlayText({
      gatewayUrl: 'http://127.0.0.1:43129/',
      models: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b' }]
    }, { providers: { other: { api: 'openai-completions' }, pengbao: { baseURL: 'https://wrong.example' } }, keep: true })
    const row = (parse(text) as Array<{ config: Record<string, any> }>)[0]!
    expect(row.config.keep).toBe(true)
    expect(row.config.providers.other).toEqual({ api: 'openai-completions' })
    expect(row.config.providers.pengbao).toEqual({
      api: 'openai-completions', displayName: 'Pengbao', baseURL: 'http://127.0.0.1:43129/v1',
      defaultInput: ['text'], models: [{ id: 'model-a', name: 'Model A', input: ['text'] }, { id: 'model-b', input: ['text'] }]
    })
    expect(row.config.providers.pengbao).not.toHaveProperty('apiKeyEnv')
  })

  it('pins explicit per-model input without copying upstream route settings', () => {
    const text = pengbaoProviderOverlayText({
      gatewayUrl: 'http://127.0.0.1:43129',
      models: [
        { id: 'vision', input: ['text', 'image'] },
        { id: 'text', input: ['text'] },
        { id: 'legacy' },
        { id: 'empty', input: [] }
      ]
    }, undefined)
    const provider = parse(text)[0].config.providers.pengbao
    expect(provider.defaultInput).toEqual(['text'])
    expect(provider.models).toEqual([
      { id: 'vision', input: ['text', 'image'] },
      { id: 'text', input: ['text'] },
      { id: 'legacy', input: ['text'] },
      { id: 'empty', input: ['text'] }
    ])
    expect(provider).not.toHaveProperty('apiKeyEnv')
  })

  it('uses the later home patch config and removes its managed overlay', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pengbao-overlay-'))
    dirs.push(home)
    const profile = join(home, 'profiles', 'web')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'cordis.patch.yml'), '- id: llm-pi-ai\n  config:\n    providers:\n      profile: { api: openai-completions }\n')
    await writeFile(join(home, 'cordis.patch.yml'), '- id: llm-pi-ai\n  config:\n    providers:\n      home: { api: openai-completions }\n')
    const path = await preparePengbaoProviderOverlay(home, 'web', { gatewayUrl: 'http://127.0.0.1:43129', models: [{ id: 'm' }] })
    const row = (parse(await readFile(path, 'utf8')) as Array<{ config: { providers: Record<string, unknown> } }>)[0]!
    expect(row.config.providers).toHaveProperty('home')
    expect(row.config.providers).not.toHaveProperty('profile')
    await removePengbaoProviderOverlay(home)
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails on malformed user patches and an empty model catalog', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pengbao-overlay-'))
    dirs.push(home)
    await writeFile(join(home, 'cordis.patch.yml'), '- id: llm-pi-ai\n  config: "unterminated\n')
    await expect(preparePengbaoProviderOverlay(home, 'web', { gatewayUrl: 'http://127.0.0.1:43129', models: [{ id: 'm' }] }))
      .rejects.toThrow('does not carry a config object')
    await writeFile(join(home, 'cordis.patch.yml'), '{unterminated: "y')
    await expect(preparePengbaoProviderOverlay(home, 'web', { gatewayUrl: 'http://127.0.0.1:43129', models: [{ id: 'm' }] }))
      .rejects.toThrow('profile patch layer could not be read')
    expect(() => assertServableModels([])).toThrow('serves no models')
    expect(() => assertServableModels([{ id: 'm' }])).not.toThrow()
  })
})

describe('Pengbao model catalog client', () => {
  it.each([true, false])('preserves strict server vision declarations (wrapped: %s)', async wrapped => {
    const data = [
      { id: 'vision', name: 'Vision', info: { meta: { capabilities: { vision: true } } }, baseURL: 'https://untrusted.example', apiKey: 'not-a-real-key' },
      { id: 'text', info: { meta: { capabilities: { vision: false } } } },
      { id: 'unknown' },
      { id: 'generated-image', capabilities: { vision: true }, output: ['image'] },
      { id: 'text', info: { meta: { capabilities: { vision: true } } } }
    ]
    const client = new PengbaoClient({ fetch: async () => Response.json(wrapped ? { data } : data) })
    const models = await client.models()
    expect(models).toEqual([
      { id: 'vision', name: 'Vision', input: ['text', 'image'] },
      { id: 'text', input: ['text'] },
      { id: 'unknown', input: ['text'] },
      { id: 'generated-image', input: ['text'] }
    ])
    const overlay = pengbaoProviderOverlayText({ gatewayUrl: 'http://127.0.0.1:43129', models }, undefined)
    expect(parse(overlay)[0].config.providers.pengbao.models).toEqual(models)
    expect(overlay).not.toContain('untrusted.example')
    expect(overlay).not.toContain('not-a-real-key')
  })

  it.each([
    {},
    { info: null },
    { info: [] },
    { info: 'invalid' },
    { info: { meta: null } },
    { info: { meta: [] } },
    { info: { meta: 'invalid' } },
    { info: { meta: { capabilities: null } } },
    { info: { meta: { capabilities: [] } } },
    { info: { meta: { capabilities: 'invalid' } } },
    ...[false, null, 'true', 1, {}, []].map(vision => ({ info: { meta: { capabilities: { vision } } } }))
  ])('keeps absent or malformed capability metadata text-only: %j', async metadata => {
    const client = new PengbaoClient({ fetch: async () => Response.json({ data: [{ id: 'model', ...metadata }] }) })
    await expect(client.models()).resolves.toEqual([{ id: 'model', input: ['text'] }])
  })

  it('maps model listings, deduplicates IDs and uses the authenticated fixed route', async () => {
    let requested = ''
    let init: RequestInit | undefined
    const client = new PengbaoClient({ fetch: async (url, options) => {
      requested = String(url)
      init = options
      return Response.json({ data: [
        { id: 'm1', name: 'Model 1' }, { id: 'm1', name: 'duplicate' }, { id: '  ' }, null, { id: 'm2' }
      ] })
    } })
    client.setToken('private-jwt')
    await expect(client.models()).resolves.toEqual([{ id: 'm1', name: 'Model 1', input: ['text'] }, { id: 'm2', input: ['text'] }])
    expect(requested).toBe('https://pengbao.ecombus.net/api/v1/models')
    expect(init?.method).toBe('GET')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer private-jwt')
  })
})
