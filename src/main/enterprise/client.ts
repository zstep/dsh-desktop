import { PENGBAO_PRODUCT } from './config'

export const PENGBAO_SERVER = PENGBAO_PRODUCT.serverUrl
export const PENGBAO_REQUEST_TIMEOUT_MS = 15_000

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface PengbaoUser {
  id: string
  email?: string
  name?: string
  role?: string
  profileImageUrl?: string
  status?: string
}

const USER_FIELDS = ['id', 'email', 'name', 'role', 'profile_image_url', 'status'] as const

export interface PengbaoSession {
  kind: 'session'
  token: string
  user: PengbaoUser
  expiresAt?: number
}

export interface PengbaoPending {
  kind: 'pending'
}

export interface PengbaoMfa {
  kind: 'mfa'
  challengeToken: string
  expiresIn?: number
  nextStep?: 'verify' | 'recover' | 'enroll'
}

export type PengbaoLoginResult = PengbaoSession | PengbaoPending | PengbaoMfa
export interface MfaVerifyInput { challengeToken: string; code: string; recovery?: boolean }

/** One model route the account may use; permissions stay server-side. */
export interface PengbaoModel {
  id: string
  /** Server-configured display alias, when present. */
  name?: string
  input?: readonly ('text' | 'image')[]
}

export class PengbaoError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'PengbaoError'
    this.status = status
  }
}

function validateServerUrl(input: string): URL {
  let url: URL
  try { url = new URL(input) } catch { throw new Error('Invalid Pengbao server URL') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.port) {
    throw new Error('Invalid Pengbao server URL')
  }
  return url
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function user(value: unknown): PengbaoUser | undefined {
  if (!isRecord(value) || typeof value.id !== 'string') return undefined
  const result: PengbaoUser = { id: value.id }
  for (const field of USER_FIELDS) {
    if (field === 'id') continue
    const property = field === 'profile_image_url' ? 'profileImageUrl' : field
    if (typeof value[field] === 'string') result[property as keyof PengbaoUser] = value[field] as never
  }
  return result
}
function string(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }

export class PengbaoClient {
  private readonly fetcher: FetchLike
  private readonly server: URL
  private token?: string
  constructor(options: { fetch?: FetchLike; server?: string } = {}) {
    this.fetcher = options.fetch ?? fetch
    this.server = validateServerUrl(options.server ?? PENGBAO_SERVER)
  }

  get serverUrl(): string { return this.server.href.replace(/\/$/, '') }
  setToken(token: string | undefined): void { this.token = token }
  clearToken(): void { this.token = undefined }

  async signIn(email: string, password: string, signal?: AbortSignal): Promise<PengbaoLoginResult> {
    const response = await this.request('/api/v1/auths/signin', 'POST', { email, password }, signal)
    return parseLogin(response)
  }
  async session(signal?: AbortSignal): Promise<PengbaoSession> {
    const response = await this.request('/api/v1/auths/', 'GET', undefined, signal)
    const profile = parseUser(response)
    if (profile.role !== 'user' && profile.role !== 'admin') throw new PengbaoError('Invalid response from Pengbao')
    if (!this.token) throw new PengbaoError('Invalid response from Pengbao')
    return {
      kind: 'session', token: this.token, user: profile,
      ...(isRecord(response) && typeof response.expires_at === 'number' && Number.isFinite(response.expires_at) ? { expiresAt: response.expires_at } : {})
    }
  }
  async signOut(signal?: AbortSignal): Promise<void> {
    await this.request('/api/v1/auths/signout', 'POST', undefined, signal)
    this.clearToken()
  }
  async verifyMfa(input: MfaVerifyInput, signal?: AbortSignal): Promise<PengbaoLoginResult> {
    const response = await this.request('/api/v1/auths/mfa/verify', 'POST', {
      challenge_token: input.challengeToken, code: input.code, recovery: input.recovery ?? false
    }, signal)
    return parseLogin(response)
  }
  async models(signal?: AbortSignal): Promise<PengbaoModel[]> {
    return parseModels(await this.request('/api/v1/models', 'GET', undefined, signal))
  }
  /** Authenticated server metadata only; never derive defaults from user settings. */
  async modelDefaults(signal?: AbortSignal): Promise<{ defaultModels: string[] }> {
    if (!this.token) throw new PengbaoError('Pengbao authentication required', 401)
    const value = await this.request('/api/config', 'GET', undefined, signal)
    if (!isRecord(value) || (value.default_models != null && typeof value.default_models !== 'string')) {
      throw new PengbaoError('Invalid response from Pengbao')
    }
    const ids = typeof value.default_models === 'string' ? value.default_models.split(',').map(id => id.trim()).filter(Boolean) : []
    if (ids.length > 256 || ids.some(id => id.length > 256 || /[\p{C}\p{Zl}\p{Zp}]/u.test(id) || /https?:\/\//i.test(id)) || new Set(ids).size !== ids.length) {
      throw new PengbaoError('Invalid response from Pengbao')
    }
    return { defaultModels: [...new Set(ids)] }
  }

  private async request(path: string, method: string, body: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (body) headers['Content-Type'] = 'application/json'
    if (this.token) headers.Authorization = `Bearer ${this.token}`
    let response: Response
    const timeout = AbortSignal.timeout(PENGBAO_REQUEST_TIMEOUT_MS)
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      response = await this.fetcher(new URL(path, this.server).href, {
        method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: requestSignal,
        redirect: 'error'
      })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      throw new PengbaoError('Pengbao request failed')
    }
    let payload: unknown
    if (!response.ok) throw new PengbaoError('Pengbao request failed', response.status)
    try { payload = await response.json() } catch { throw new PengbaoError('Invalid response from Pengbao', response.status) }
    return payload
  }
}

function parseUser(value: unknown): PengbaoUser {
  const result = user(value)
  if (!result) throw new PengbaoError('Invalid response from Pengbao')
  return result
}
function parseModels(value: unknown): PengbaoModel[] {
  const list = isRecord(value) && Array.isArray(value.data) ? value.data : Array.isArray(value) ? value : []
  const models: PengbaoModel[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (!isRecord(entry)) continue
    const id = entry.id
    if (typeof id !== 'string' || id.trim().length === 0 || seen.has(id)) continue
    seen.add(id)
    const info = isRecord(entry.info) ? entry.info : undefined
    const meta = isRecord(info?.meta) ? info.meta : undefined
    const capabilities = isRecord(meta?.capabilities) ? meta.capabilities : undefined
    const displayName = [entry.alias, entry.name].find(value => typeof value === 'string' && value.length > 0)
    models.push({
      id,
      ...(typeof displayName === 'string' ? { name: displayName } : {}),
      input: capabilities?.vision === true ? ['text', 'image'] : ['text']
    })
  }
  return models
}

function parseLogin(value: unknown): PengbaoLoginResult {
  if (!isRecord(value)) throw new PengbaoError('Invalid response from Pengbao')
  const token = value.token ?? value.access_token
  const profile = user(value.user ?? value)
  if (string(token) && profile) return {
    kind: 'session', token, user: profile,
    ...(typeof value.expires_at === 'number' && Number.isFinite(value.expires_at) ? { expiresAt: value.expires_at } : {})
  }
  if (string(value.challenge_token)) return {
    kind: 'mfa', challengeToken: value.challenge_token,
    ...(typeof value.expires_in === 'number' && Number.isFinite(value.expires_in) && value.expires_in > 0 ? { expiresIn: value.expires_in } : {}),
    ...(value.next_step === 'verify' || value.next_step === 'recover' || value.next_step === 'enroll' ? { nextStep: value.next_step } : {})
  }
  if (value.next_step === 'pending') return { kind: 'pending' }
  throw new PengbaoError('Invalid response from Pengbao')
}
