import type { PengbaoAccountState, PengbaoMfaInput, PengbaoSignInInput } from '../../shared/pengbao-account'
import { isPengbaoMfaInput, isPengbaoSignInInput } from '../../shared/pengbao-account'
import { PengbaoClient, PengbaoError, type PengbaoLoginResult, type PengbaoSession } from './client'
import type { SessionStore } from './session-store'

export interface AccountControllerOptions {
  client: PengbaoClient
  store: SessionStore
  activate(session: PengbaoSession): Promise<void>
  deactivate(): Promise<void>
}

/** Serializes credential persistence and runtime transitions across all windows. */
export class PengbaoAccountController {
  private state: PengbaoAccountState = { phase: 'signed-out' }
  private challenge?: { token: string; expires: number; enrollment: boolean }
  private queue: Promise<unknown> = Promise.resolve()
  private active = false
  private storageBlocked = false
  private expiry?: ReturnType<typeof setTimeout>

  constructor(private readonly options: AccountControllerOptions) {}

  snapshot(): PengbaoAccountState { return { ...this.state } }

  private run(action: () => Promise<void>, preserveActive = false): Promise<PengbaoAccountState> {
    const result = this.queue.then(async () => {
      const previous = this.state
      this.state = { phase: 'busy' }
      try { await action() } catch (error) {
        if (!this.active) this.options.client.clearToken()
        if (this.storageBlocked) this.state = { phase: 'error', reason: 'storage' }
        else if (preserveActive && this.active && previous.phase === 'signed-in') this.state = previous
        else this.state = this.errorState(error)
      }
      return this.snapshot()
    })
    this.queue = result
    return result
  }

  restore(): Promise<PengbaoAccountState> {
    return this.run(async () => {
      if (this.active) throw new Error('Account already active')
      if (this.storageBlocked) { this.state = { phase: 'error', reason: 'storage' }; return }
      let token: string | undefined
      try { token = await this.options.store.load(this.options.client.serverUrl) }
      catch { this.state = { phase: 'error', reason: 'storage' }; return }
      if (!token) { this.state = { phase: 'signed-out' }; return }
      this.options.client.setToken(token)
      try { await this.accept(await this.options.client.session(), true) }
      catch (error) {
        if (this.active || this.storageBlocked) throw error
        this.options.client.clearToken()
        if (error instanceof PengbaoError && error.status === 401) {
          this.storageBlocked = true
          await this.options.store.clear(this.options.client.serverUrl)
          this.storageBlocked = false
        }
        throw error
      }
    })
  }

  signIn(input: PengbaoSignInInput): Promise<PengbaoAccountState> {
    if (!isPengbaoSignInInput(input)) return Promise.reject(new Error('Invalid login input'))
    return this.run(async () => {
      if (this.active) throw new Error('Sign out before changing accounts')
      if (this.storageBlocked) { this.state = { phase: 'error', reason: 'storage' }; return }
      this.challenge = undefined
      this.options.client.clearToken()
      await this.accept(await this.options.client.signIn(input.email.trim(), input.password))
    }, true)
  }

  verifyMfa(input: PengbaoMfaInput): Promise<PengbaoAccountState> {
    if (!isPengbaoMfaInput(input)) return Promise.reject(new Error('Invalid MFA input'))
    return this.run(async () => {
      if (this.active) throw new Error('Account already active')
      if (this.storageBlocked) { this.state = { phase: 'error', reason: 'storage' }; return }
      const challenge = this.challenge
      if (!challenge || challenge.enrollment || challenge.expires <= Date.now()) {
        this.challenge = undefined
        this.state = { phase: 'error', reason: 'expired' }
        return
      }
      let result: PengbaoLoginResult
      try {
        result = await this.options.client.verifyMfa({
          challengeToken: challenge.token, code: input.code.trim(), recovery: input.recovery
        })
      } catch (error) {
        const status = error instanceof PengbaoError ? error.status : undefined
        if (challenge.expires > Date.now() && (status === 400 || status === 401 || status === 429 || status === undefined)) {
          const reason = status === 400 || status === 401 ? 'credentials' : status === 429 ? 'rate-limit' :
            error instanceof PengbaoError ? 'network' : 'unknown'
          this.state = { phase: 'mfa', enrollmentRequired: false, error: reason }
          return
        }
        this.challenge = undefined
        throw error
      }
      await this.accept(result)
      if (this.state.phase === 'mfa') return
      this.challenge = undefined
    })
  }

  private async accept(result: PengbaoLoginResult, restored = false): Promise<void> {
    if (result.kind === 'pending') { this.state = { phase: 'pending' }; return }
    if (result.kind === 'mfa') {
      this.challenge = {
        token: result.challengeToken,
        expires: Date.now() + (result.expiresIn ?? 300) * 1000,
        enrollment: result.nextStep === 'enroll'
      }
      this.state = { phase: 'mfa', enrollmentRequired: this.challenge.enrollment }
      return
    }
    if (!['user', 'admin'].includes(result.user.role ?? '') ||
      (result.expiresAt !== undefined && result.expiresAt * 1000 <= Date.now())) {
      this.options.client.clearToken()
      this.state = { phase: 'error', reason: 'expired' }
      return
    }
    this.challenge = undefined
    this.options.client.setToken(result.token)
    let persistent = restored
    if (!restored) {
      persistent = true
      try { await this.options.store.save(this.options.client.serverUrl, result.token) }
      catch {
        // Remove any older identity before allowing an explicitly memory-only session.
        this.storageBlocked = true
        await this.options.store.clear(this.options.client.serverUrl)
        this.storageBlocked = false
        persistent = false
      }
    }
    // Activation may partially start processes before rejecting. Keep the identity
    // locked until cleanup has positively completed.
    this.active = true
    try { await this.options.activate(result) }
    catch (error) {
      this.options.client.clearToken()
      try { await this.options.deactivate() }
      catch { throw error }
      this.active = false
      this.storageBlocked = true
      await this.options.store.clear(this.options.client.serverUrl)
      this.storageBlocked = false
      throw error
    }
    this.active = true
    this.state = {
      phase: 'signed-in', name: result.user.name ?? '', email: result.user.email ?? '', persistent
    }
    if (result.expiresAt !== undefined) this.scheduleExpiry(result.expiresAt)
  }

  private scheduleExpiry(expiresAt: number): void {
    if (this.expiry) clearTimeout(this.expiry)
    const remaining = expiresAt * 1000 - Date.now()
    this.expiry = setTimeout(() => {
      if (expiresAt * 1000 > Date.now()) this.scheduleExpiry(expiresAt)
      else void this.signOut()
    }, Math.max(0, Math.min(remaining, 2_147_483_647)))
    this.expiry.unref()
  }

  signOut(): Promise<{ remoteConfirmed: boolean }> {
    let remoteConfirmed = false
    return this.run(async () => {
      // Failure here blocks the next identity and leaves its state and expiry intact.
      await this.options.deactivate()
      this.active = false
      this.challenge = undefined
      if (this.expiry) clearTimeout(this.expiry)
      this.expiry = undefined
      try { await this.options.client.signOut(); remoteConfirmed = true }
      catch { /* Local logout still proceeds when the service is unreachable. */ }
      finally { this.options.client.clearToken() }
      this.storageBlocked = true
      try { await this.options.store.clear(this.options.client.serverUrl) }
      catch { this.state = { phase: 'error', reason: 'storage' }; return }
      this.storageBlocked = false
      this.state = { phase: 'signed-out' }
    }, true).then(() => ({ remoteConfirmed }))
  }

  private errorState(error: unknown): PengbaoAccountState {
    const status = error instanceof PengbaoError ? error.status : undefined
    return { phase: 'error', reason: status === 400 || status === 401 ? 'credentials' : status === 403 ? 'forbidden' :
      status === 429 ? 'rate-limit' : error instanceof PengbaoError ? 'network' : 'unknown' }
  }
}
