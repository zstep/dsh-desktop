import { request as httpRequest } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { startPengbaoGateway, type PengbaoGateway } from '../src/main/enterprise/gateway'

const gateways: PengbaoGateway[] = []
afterEach(async () => { await Promise.all(gateways.splice(0).map(g => g.stop())) })

it('preserves seedance frame fields and returns only local task/content routes', async () => {
  const id = 'b'.repeat(32)
  const forwarded: unknown[] = []
  const gateway = await startPengbaoGateway({ jwt: 'fixture-jwt', fetch: async (input, init) => {
    const url = new URL(String(input)); expect(url.origin).toBe('https://pengbao.ecombus.net')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-jwt')
    if (url.pathname === '/api/v1/videos/proxy/models') return Response.json({ data: [{ id: 'seedance-2-0', name: 'Seedance', provider: 'volcengine', protocol: 'ark' }] })
    if (url.pathname.endsWith('/submit/ark')) { forwarded.push(JSON.parse(String(init?.body))); return Response.json({ id, status: 'queued', url: 'https://provider.invalid/private', secret: 'fixture-secret' }) }
    if (url.pathname.endsWith('/content')) return new Response('fixture-clip', { headers: { 'content-type': 'video/mp4', 'set-cookie': 'secret' } })
    return Response.json({ id, model: 'seedance-2-0', status: 'completed', url: 'https://private-provider.invalid/signed', error: 'secret' })
  } })
  gateways.push(gateway)
  const token = gateway.createVideoLease(['seedance-2-0']).capabilityToken
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const body = { model: 'seedance-2-0', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' }, role: 'first_frame' }], duration: 7, resolution: '720p' }
  const submitted = await fetch(gateway.url + '/v1/contents/generations/tasks', { method: 'POST', headers, body: JSON.stringify(body) })
  expect(submitted.status).toBe(200)
  expect(await submitted.json()).toEqual({ id, task_id: id, status: 'queued' })
  expect(forwarded).toEqual([body])
  const status = await fetch(`${gateway.url}/v1/contents/generations/tasks/${id}`, { headers })
  expect(await status.json()).toEqual({ id, task_id: id, status: 'completed', url: `/v1/contents/generations/tasks/${id}/content` })
  const clip = await fetch(`${gateway.url}/v1/contents/generations/tasks/${id}/content`, { headers })
  expect(await clip.text()).toBe('fixture-clip')
  expect(clip.headers.get('set-cookie')).toBeNull()
})

it('revocation interrupts a stalled request-body upload and frees its slot', async () => {
  const gateway = await startPengbaoGateway({ jwt: 'fixture-jwt', fetch: async () => { throw new Error('must not forward') } })
  gateways.push(gateway)
  const lease = gateway.createVideoLease(['seedance'])
  let uploaded!: ReturnType<typeof httpRequest>
  const response = new Promise<number>(resolve => {
    uploaded = httpRequest(gateway.url + '/v1/videos', { method: 'POST', headers: {
      authorization: `Bearer ${lease.capabilityToken}`, 'content-type': 'application/json', 'transfer-encoding': 'chunked'
    } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)) })
    uploaded.on('error', () => resolve(0))
    uploaded.write('{"model":')
  })
  try {
    await new Promise(resolve => setTimeout(resolve, 30))
    lease.revoke()
    expect(await Promise.race([response, new Promise(resolve => setTimeout(() => resolve(-1), 200))])).toBe(401)
  } finally { uploaded.destroy() }
})

it('revokes a pending video request even if an injected transport ignores AbortSignal', async () => {
  const gateway = await startPengbaoGateway({ jwt: 'fixture-jwt', fetch: async () => new Promise<Response>(() => {}) })
  gateways.push(gateway)
  const lease = gateway.createVideoLease(['seedance'])
  const pending = fetch(gateway.url + '/v1/videos', { method: 'POST', headers: { authorization: `Bearer ${lease.capabilityToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'seedance', prompt: 'fixture' }) })
  await new Promise(resolve => setTimeout(resolve, 30))
  lease.revoke()
  const result = await Promise.race([pending, new Promise<null>(resolve => setTimeout(() => resolve(null), 200))])
  expect(result).not.toBeNull()
  expect(result?.status).toBe(401)
})
