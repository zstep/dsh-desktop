import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { parsePluginConfigurationPolicy, type PluginConfigurationPolicy, type PrivatePluginConfigurationPacket } from '../../shared/private-plugin-configuration'

export type { PluginConfigurationPolicy } from '../../shared/private-plugin-configuration'
export interface PluginConfigurationLease extends PrivatePluginConfigurationPacket { revoke(): void }
// A malformed request is rejected with a short fixed-vocabulary diagnostic.
const REASON = /^[a-z][a-z0-9-]{0,47}$/

function respond(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(body))
}

/** The broker cannot perform inference itself. Each child token has its own fixed inference scopes. */
export function createPluginConfigurationGateway(options: {
  getGatewayUrl(): string
  issue(policy: PluginConfigurationPolicy): { capabilityToken: string; revoke(): void }
}) {
  type Broker = { credential: Buffer; children: Map<string, { revoke(): void }>; active: Set<AbortController>; revoked: boolean }
  const brokers = new Set<Broker>()
  let stopped = false
  const revoke = (broker: Broker) => {
    if (broker.revoked) return
    broker.revoked = true
    broker.credential.fill(0)
    brokers.delete(broker)
    for (const controller of broker.active) controller.abort()
    for (const child of broker.children.values()) child.revoke()
    broker.children.clear()
  }
  async function read(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
    if (req.headers['content-encoding'] || req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json' || Number(req.headers['content-length'] ?? 0) > 32768) throw new Error('Invalid broker request')
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let length = 0
      const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', error); signal.removeEventListener('abort', abort) }
      const error = () => { cleanup(); reject(new Error('Invalid broker request')) }
      const abort = () => error()
      const data = (part: Buffer) => {
        length += part.length
        if (length > 32768) { req.pause(); error(); return }
        chunks.push(part)
      }
      const end = () => { cleanup(); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) } catch { reject(new Error('Invalid broker request')) } }
      req.on('data', data); req.once('end', end); req.once('error', error)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
  return {
    createLease(): PluginConfigurationLease {
      if (stopped || brokers.size >= 16) throw new Error('Plugin configuration gateway unavailable')
      const capabilityToken = randomBytes(32).toString('base64url')
      const broker: Broker = { credential: Buffer.from(`Bearer ${capabilityToken}`), children: new Map(), active: new Set(), revoked: false }
      brokers.add(broker)
      return { contractVersion: 1, gatewayUrl: options.getGatewayUrl(), capabilityToken, revoke: () => revoke(broker) }
    },
    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      let denial: string | undefined
      const fail = (status: number) => respond(res, status, { error: { type: 'plugin_configuration_error', message: 'Plugin configuration request failed',
        ...(status === 403 && denial && REASON.test(denial) ? { reason: denial } : {}) } })
      if (req.method !== 'POST' || (req.url !== '/v1/plugin-configuration/issue' && req.url !== '/v1/plugin-configuration/revoke')) return fail(404)
      const supplied = Buffer.from(req.headers.authorization ?? '')
      const broker = [...brokers].find(item => supplied.length === item.credential.length && timingSafeEqual(supplied, item.credential))
      if (!broker || broker.revoked || stopped) return fail(401)
      const issue = req.method === 'POST' && req.url === '/v1/plugin-configuration/issue'
      const remove = req.method === 'POST' && req.url === '/v1/plugin-configuration/revoke'
      if (!issue && !remove) return fail(404)
      if (broker.active.size >= 4) return fail(429)
      const controller = new AbortController()
      broker.active.add(controller)
      const timer = setTimeout(() => controller.abort(), 5_000)
      const close = () => { if (!res.writableFinished) controller.abort() }
      req.once('aborted', close); res.once('close', close)
      let issuedLeaseId: string | undefined
      let issuedRevoke: (() => void) | undefined
      let abort = () => {}
      try {
        const work = async () => {
          const input = await read(req, controller.signal)
          if (remove) {
            if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join(',') !== 'leaseId' ||
              !('leaseId' in input) || typeof input.leaseId !== 'string') throw new Error('Invalid revoke')
            broker.children.get(input.leaseId)?.revoke()
            broker.children.delete(input.leaseId)
            return { revoked: true }
          }
          // The broker capability token is held only by the model-service runtime,
          // and the desktop controller validates the plan, package evidence and
          // user confirmation before issuing. The host mints a scoped lease for
          // that request directly instead of re-approving the profile composition.
          const request = (() => {
            try { return parsePluginConfigurationPolicy(input) } catch { denial = 'request-shape'; throw new Error('Invalid broker request') }
          })()
          if (broker.children.size >= 512) { denial = 'lease-limit'; throw new Error('Too many plugin leases') }
          controller.signal.throwIfAborted()
          const child = options.issue(request)
          issuedRevoke = child.revoke
          const leaseId = randomBytes(24).toString('base64url')
          issuedLeaseId = leaseId
          broker.children.set(leaseId, { revoke: child.revoke })
          return { contractVersion: 1, leaseId, gatewayUrl: options.getGatewayUrl(), capabilityToken: child.capabilityToken }
        }
        const result = await Promise.race([work(), new Promise<never>((_resolve, reject) => {
          abort = () => reject(new Error('Broker request cancelled'))
          controller.signal.addEventListener('abort', abort, { once: true })
          if (controller.signal.aborted) abort()
        })])
        controller.signal.throwIfAborted()
        respond(res, 200, result)
      } catch {
        if (issuedRevoke) {
          if (issuedLeaseId) broker.children.delete(issuedLeaseId)
          issuedRevoke()
        }
        fail(controller.signal.aborted ? broker.revoked ? 401 : 504 : 403)
      }
      finally {
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', abort)
        req.off('aborted', close); res.off('close', close)
        broker.active.delete(controller)
      }
    },
    stop() { stopped = true; for (const broker of brokers) revoke(broker) }
  }
}
