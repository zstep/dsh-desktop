import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PengbaoClient, PengbaoError } from '../src/main/enterprise/client'
import { createFileSessionStore } from '../src/main/enterprise/session-store'

const user = { id: 'u-1', email: 'user@example.test' }
const crypto = {
  encrypt: (value: string) => Buffer.from(`encrypted:${value}`),
  decrypt: (value: Buffer) => value.toString().replace(/^encrypted:/, '')
}

describe('Pengbao client', () => {
  it('validates session, pending and MFA login responses without exposing server data', async () => {
    const responses = [
      { token: 'jwt', user },
      { next_step: 'pending' },
      { next_step: 'verify', challenge_token: 'challenge', expires_in: 30 }
    ]
    const fetcher = async (_url: string | URL) => new Response(JSON.stringify(responses.shift()), { status: 200 })
    const client = new PengbaoClient({ fetch: fetcher })
    await expect(client.signIn('u', 'p')).resolves.toEqual({ kind: 'session', token: 'jwt', user })
    await expect(client.signIn('u', 'p')).resolves.toEqual({ kind: 'pending' })
    await expect(client.signIn('u', 'p')).resolves.toEqual({ kind: 'mfa', challengeToken: 'challenge', expiresIn: 30, nextStep: 'verify' })
  })

  it('uses POST JSON, bearer token, timeout signal and rejects redirects', async () => {
    let seen: RequestInit | undefined
    const client = new PengbaoClient({ fetch: async (_url, init) => {
      seen = init
      return new Response(JSON.stringify({ ...user, role: 'user' }), { status: 200 })
    } })
    client.setToken('secret-jwt')
    await expect(client.session(AbortSignal.timeout(1000))).resolves.toMatchObject({ kind: 'session', token: 'secret-jwt', user })
    expect(seen?.method).toBe('GET')
    expect(seen?.redirect).toBe('error')
    expect((seen?.headers as Record<string, string>).Authorization).toBe('Bearer secret-jwt')
  })

  it('does not expose sensitive server error bodies or credentials', async () => {
    const client = new PengbaoClient({ fetch: async () => new Response(JSON.stringify({ detail: 'password=secret-jwt' }), { status: 401 }) })
    await expect(client.signIn('email', 'password')).rejects.toMatchObject({ message: 'Pengbao request failed' })
    await expect(client.signIn('email', 'password')).rejects.not.toThrow('secret-jwt')
  })

  it('does not read or surface a failed response body containing credentials', async () => {
    const response = new Response('{}', { status: 401 })
    response.json = async () => { throw new Error('private-password') }
    const client = new PengbaoClient({ fetch: async () => response })
    await expect(client.signIn('email', 'private-password')).rejects.toMatchObject({ message: 'Pengbao request failed', status: 401 })
  })

  it('rejects empty challenges rather than offering an unusable MFA retry', async () => {
    const client = new PengbaoClient({ fetch: async () => Response.json({ challenge_token: '', next_step: 'verify' }) })
    await expect(client.signIn('email', 'password')).rejects.toBeInstanceOf(PengbaoError)
  })


  it('parses comma-separated server defaults with strict deduplication and trimming', async () => {
    const seen: string[] = []
    const client = new PengbaoClient({ fetch: async (url, init) => {
      seen.push(String(url))
      expect(init?.redirect).toBe('error')
      return Response.json({ default_models: ' chat-a,chat-b ' })
    } })
    client.setToken('secret-jwt')
    await expect(client.modelDefaults()).resolves.toEqual({ defaultModels: ['chat-a', 'chat-b'] })
    expect(seen).toEqual(['https://pengbao.ecombus.net/api/config'])
  })

  it('prefers server display aliases over names without changing model IDs or vision capabilities', async () => {
    const client = new PengbaoClient({ fetch: async () => Response.json({ data: [
      { id: 'chat-id', alias: '聊天别名', name: 'Underlying model name' },
      { id: 'vision-id', alias: 'Vision alias', name: 'Vision provider name', info: { meta: { capabilities: { vision: true } } } },
      { id: 'name-only', name: 'Name fallback' },
      { id: 'empty-alias', alias: '', name: 'Empty alias fallback' },
      { id: 'invalid-alias', alias: 42, name: 'Non-string alias fallback' },
      { id: 'id-only' }
    ] }) })
    client.setToken('secret-jwt')
    await expect(client.models()).resolves.toEqual([
      { id: 'chat-id', name: '聊天别名', input: ['text'] },
      { id: 'vision-id', name: 'Vision alias', input: ['text', 'image'] },
      { id: 'name-only', name: 'Name fallback', input: ['text'] },
      { id: 'empty-alias', name: 'Empty alias fallback', input: ['text'] },
      { id: 'invalid-alias', name: 'Non-string alias fallback', input: ['text'] },
      { id: 'id-only', input: ['text'] }
    ])
  })

  it('rejects malformed server defaults', async () => {
    const client = new PengbaoClient({ fetch: async () => Response.json({ default_models: 'chat-a, chat-a' }) })
    client.setToken('secret-jwt')
    await expect(client.modelDefaults()).rejects.toMatchObject({ message: 'Invalid response from Pengbao' })
  })

  it('rejects malformed success responses', async () => {
    expect(() => new PengbaoClient({ server: 'https://pengbao.ecombus.net/api?token=x' })).toThrow('Invalid Pengbao server URL')
    const client = new PengbaoClient({ fetch: async () => new Response(JSON.stringify({ token: 'jwt' }), { status: 200 }) })
    await expect(client.signIn('email', 'password')).rejects.toBeInstanceOf(PengbaoError)
  })
})

describe('Pengbao session store', () => {
  it('encrypts, atomically stores with restrictive permissions, and isolates server bindings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pengbao-session-'))
    const path = join(dir, 'session.json')
    const store = createFileSessionStore(path, crypto)
    await store.save('https://pengbao.ecombus.net/', 'jwt')
    expect(await store.load('https://pengbao.ecombus.net')).toBe('jwt')
    expect(await store.load('https://other.example')).toBeUndefined()
    expect((await readFile(path, 'utf8')).includes('jwt')).toBe(false)
    // Windows uses inherited ACLs and does not expose POSIX owner-only mode bits.
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    await store.clear('https://other.example')
    expect(await store.load('https://pengbao.ecombus.net')).toBe('jwt')
    await store.clear('https://pengbao.ecombus.net')
    expect(await store.load('https://pengbao.ecombus.net')).toBeUndefined()
  })

  it('removes malformed credential files but leaves a different server binding alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pengbao-session-'))
    const path = join(dir, 'session.json')
    const store = createFileSessionStore(path, crypto)
    await writeFile(path, '{invalid-json')
    await store.clear('https://pengbao.ecombus.net')
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(path, JSON.stringify({ server: 'https://other.example/', version: 2 }))
    await store.clear('https://pengbao.ecombus.net')
    expect(await readFile(path, 'utf8')).toContain('other.example')
  })

  it('fails closed when encryption fails and never writes plaintext', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pengbao-session-'))
    const path = join(dir, 'session.json')
    const store = createFileSessionStore(path, { encrypt: () => { throw new Error('no key') }, decrypt: crypto.decrypt })
    await expect(store.save('https://pengbao.ecombus.net', 'jwt')).rejects.toThrow('Unable to encrypt Pengbao session')
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
