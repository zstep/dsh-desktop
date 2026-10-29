import { describe, expect, it, vi } from 'vitest'
import { PengbaoAccountController } from '../src/main/enterprise/account-controller'
import { PengbaoClient } from '../src/main/enterprise/client'
import type { SessionStore } from '../src/main/enterprise/session-store'

function setup() {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
    token: 'private-token', id: 'account-a', role: 'user', name: 'Person'
  }))
  const client = new PengbaoClient({ fetch: fetcher })
  const store: SessionStore = {
    load: vi.fn(async () => undefined), save: vi.fn(async () => {}), clear: vi.fn(async () => {})
  }
  const activate = vi.fn(async () => {})
  const deactivate = vi.fn(async () => {})
  const controller = new PengbaoAccountController({ client, store, activate, deactivate })
  return { controller, store, fetcher, activate, deactivate }
}

const login = { email: 'person@example.test', password: 'private-password' }

describe('Pengbao account lifecycle', () => {
  it('exposes no token or password in renderer state', async () => {
    const { controller, activate } = setup()
    const state = await controller.signIn(login)
    expect(state).toEqual({ phase: 'signed-in', name: 'Person', email: '', persistent: true })
    expect(JSON.stringify(state)).not.toContain('private-')
    expect(activate).toHaveBeenCalledOnce()
  })

  it('supports memory-only sessions after removing stale persisted credentials', async () => {
    const { controller, store } = setup()
    vi.mocked(store.save).mockRejectedValue(new Error('Encryption unavailable'))
    expect(await controller.signIn(login)).toMatchObject({ phase: 'signed-in', persistent: false })
    expect(store.clear).toHaveBeenCalledOnce()
  })

  it('does not activate if stale persisted credentials cannot be removed', async () => {
    const { controller, store, activate } = setup()
    vi.mocked(store.save).mockRejectedValue(new Error('Encryption unavailable'))
    vi.mocked(store.clear).mockRejectedValue(new Error('Disk unavailable'))
    expect(await controller.signIn(login)).toMatchObject({ phase: 'error' })
    expect(activate).not.toHaveBeenCalled()
  })

  it('stops the runtime before remote logout, and clears local credentials on network failure', async () => {
    const { controller, deactivate, fetcher, store } = setup()
    await controller.signIn(login)
    fetcher.mockImplementationOnce(async () => {
      expect(deactivate).toHaveBeenCalledOnce()
      throw new Error('Offline')
    })
    expect(await controller.signOut()).toEqual({ remoteConfirmed: false })
    expect(store.clear).toHaveBeenCalledOnce()
    expect(controller.snapshot()).toEqual({ phase: 'signed-out' })
  })

  it('blocks another identity if runtime shutdown fails', async () => {
    const { controller, deactivate, activate } = setup()
    await controller.signIn(login)
    deactivate.mockRejectedValue(new Error('Runtime still running'))
    await controller.signOut()
    expect(await controller.signIn(login)).toMatchObject({ phase: 'signed-in' })
    expect(activate).toHaveBeenCalledOnce()
  })

  it('blocks restore and account switching until failed credential deletion is retried', async () => {
    const { controller, store, activate } = setup()
    await controller.signIn(login)
    vi.mocked(store.clear).mockRejectedValueOnce(new Error('Disk unavailable'))
    await controller.signOut()
    expect(controller.snapshot()).toEqual({ phase: 'error', reason: 'storage' })
    expect(await controller.restore()).toEqual({ phase: 'error', reason: 'storage' })
    expect(await controller.signIn(login)).toEqual({ phase: 'error', reason: 'storage' })
    expect(activate).toHaveBeenCalledOnce()
    await controller.signOut()
    expect(await controller.signIn(login)).toMatchObject({ phase: 'signed-in' })
  })

  it('revalidates persisted credentials before activating a workspace', async () => {
    const { controller, store, activate } = setup()
    vi.mocked(store.load).mockResolvedValue('saved-token')
    expect(await controller.restore()).toMatchObject({ phase: 'signed-in' })
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ token: 'saved-token' }))
  })

  it('blocks account changes after partial activation when cleanup fails', async () => {
    const { controller, activate, deactivate } = setup()
    activate.mockRejectedValue(new Error('Partially started'))
    deactivate.mockRejectedValue(new Error('Cannot stop'))
    expect(await controller.signIn(login)).toMatchObject({ phase: 'error' })
    expect(await controller.signIn(login)).toMatchObject({ phase: 'error' })
    expect(activate).toHaveBeenCalledOnce()
  })

  it('keeps the signed-in identity and retries shutdown after a transient failure', async () => {
    const { controller, deactivate, fetcher } = setup()
    const signedIn = await controller.signIn(login)
    deactivate.mockRejectedValueOnce(new Error('Still running'))
    expect(await controller.signOut()).toEqual({ remoteConfirmed: false })
    expect(controller.snapshot()).toEqual(signedIn)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(await controller.signIn(login)).toEqual(signedIn)
    expect(await controller.signOut()).toEqual({ remoteConfirmed: true })
    expect(controller.snapshot()).toEqual({ phase: 'signed-out' })
  })

  it('keeps credential deletion blocked after failed memory-only cleanup', async () => {
    const { controller, store, activate } = setup()
    vi.mocked(store.save).mockRejectedValue(new Error('No key'))
    vi.mocked(store.clear).mockRejectedValueOnce(new Error('Disk unavailable'))
    expect(await controller.signIn(login)).toEqual({ phase: 'error', reason: 'storage' })
    expect(await controller.signIn(login)).toEqual({ phase: 'error', reason: 'storage' })
    expect(activate).not.toHaveBeenCalled()
    await controller.signOut()
    expect(await controller.signIn(login)).toMatchObject({ phase: 'signed-in', persistent: false })
  })

  it('does not rewrite saved credentials when restoring and blocks failed revocation', async () => {
    const { controller, store, activate } = setup()
    vi.mocked(store.load).mockResolvedValue('saved-token')
    vi.mocked(store.save).mockRejectedValue(new Error('No key'))
    expect(await controller.restore()).toMatchObject({ phase: 'signed-in', persistent: true })
    expect(store.save).not.toHaveBeenCalled()
    expect(activate).toHaveBeenCalledOnce()
  })

  it('blocks switching after restore cannot delete a rejected credential', async () => {
    const { controller, store, fetcher } = setup()
    vi.mocked(store.load).mockResolvedValue('saved-token')
    fetcher.mockResolvedValueOnce(new Response('{}', { status: 401 }))
    vi.mocked(store.clear).mockRejectedValueOnce(new Error('Disk unavailable'))
    expect(await controller.restore()).toEqual({ phase: 'error', reason: 'storage' })
    expect(await controller.signIn(login)).toEqual({ phase: 'error', reason: 'storage' })
  })

  it('does not retain the bearer token after an activation failure with failed shutdown', async () => {
    const { controller, activate, deactivate, fetcher } = setup()
    activate.mockRejectedValueOnce(new Error('Partial activation'))
    deactivate.mockRejectedValueOnce(new Error('Cannot stop'))
    expect(await controller.signIn(login)).toMatchObject({ phase: 'error' })
    await controller.signOut()
    const request = fetcher.mock.calls[1]?.[1]
    expect((request?.headers as Record<string, string>).Authorization).toBeUndefined()
  })


  it('blocks a new identity if cleanup after partial activation cannot erase its token', async () => {
    const { controller, store, activate } = setup()
    activate.mockRejectedValueOnce(new Error('Partially started'))
    vi.mocked(store.clear).mockRejectedValueOnce(new Error('Disk unavailable'))
    expect(await controller.signIn(login)).toEqual({ phase: 'error', reason: 'storage' })
    expect(await controller.signIn(login)).toEqual({ phase: 'error', reason: 'storage' })
    expect(activate).toHaveBeenCalledOnce()
    await controller.signOut()
    expect(await controller.signIn(login)).toMatchObject({ phase: 'signed-in' })
  })

  it('keeps an active restored workspace locked if activation partially fails', async () => {
    const { controller, store, activate, deactivate } = setup()
    vi.mocked(store.load).mockResolvedValue('saved-token')
    activate.mockRejectedValueOnce(new Error('Partial activation'))
    deactivate.mockRejectedValueOnce(new Error('Cannot stop'))
    expect(await controller.restore()).toMatchObject({ phase: 'error' })
    expect(await controller.signIn(login)).toMatchObject({ phase: 'error' })
    expect(activate).toHaveBeenCalledOnce()
  })


  it('reports rejected passwords as credential errors', async () => {
    const { controller, fetcher } = setup()
    fetcher.mockResolvedValueOnce(new Response('{}', { status: 400 }))
    expect(await controller.signIn(login)).toEqual({ phase: 'error', reason: 'credentials' })
  })

  it('keeps a retryable MFA challenge available without exposing its token', async () => {
    const { controller, fetcher, activate } = setup()
    fetcher.mockResolvedValueOnce(Response.json({ challenge_token: 'secret-challenge', next_step: 'verify' }))
    expect(await controller.signIn(login)).toEqual({ phase: 'mfa', enrollmentRequired: false })
    fetcher.mockResolvedValueOnce(new Response('{}', { status: 400 }))
    const rejected = await controller.verifyMfa({ code: 'wrong-code', recovery: false })
    expect(rejected).toEqual({ phase: 'mfa', enrollmentRequired: false, error: 'credentials' })
    expect(JSON.stringify(rejected)).not.toContain('secret-challenge')
    fetcher.mockResolvedValueOnce(new Response('{}', { status: 429 }))
    expect(await controller.verifyMfa({ code: '123456', recovery: false })).toEqual({ phase: 'mfa', enrollmentRequired: false, error: 'rate-limit' })
    expect(await controller.verifyMfa({ code: '654321', recovery: false })).toMatchObject({ phase: 'signed-in' })
    expect(activate).toHaveBeenCalledOnce()
    const attempts = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/auths/mfa/verify'))
    expect(attempts).toHaveLength(3)
    expect(attempts.every(([, init]) => JSON.parse(String(init?.body)).challenge_token === 'secret-challenge')).toBe(true)
  })

  it('does not start a workspace for pending accounts or MFA challenges', async () => {
    const { controller, fetcher, activate } = setup()
    fetcher.mockResolvedValueOnce(Response.json({ next_step: 'pending' }))
    expect(await controller.signIn(login)).toEqual({ phase: 'pending' })
    fetcher.mockResolvedValueOnce(Response.json({ challenge_token: 'secret-challenge', next_step: 'enroll' }))
    expect(await controller.signIn(login)).toEqual({ phase: 'mfa', enrollmentRequired: true })
    expect(await controller.verifyMfa({ code: '123456', recovery: false })).toMatchObject({ phase: 'error', reason: 'expired' })
    expect(activate).not.toHaveBeenCalled()
  })
})
