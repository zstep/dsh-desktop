/** Renderer-safe account state. Credentials and MFA challenges stay in main. */
export type PengbaoAccountState =
  | { phase: 'signed-out' }
  | { phase: 'busy' }
  | { phase: 'mfa'; enrollmentRequired: boolean; error?: 'credentials' | 'network' | 'rate-limit' | 'unknown' }
  | { phase: 'pending' }
  | { phase: 'signed-in'; name: string; email: string; persistent: boolean }
  | { phase: 'error'; reason: 'network' | 'credentials' | 'expired' | 'forbidden' | 'rate-limit' | 'storage' | 'unknown' }

export interface PengbaoSignInInput {
  email: string
  password: string
}

export interface PengbaoMfaInput {
  code: string
  recovery: boolean
}

export interface PengbaoAccountBridge {
  getState(): Promise<PengbaoAccountState>
  signIn(input: PengbaoSignInInput): Promise<PengbaoAccountState>
  verifyMfa(input: PengbaoMfaInput): Promise<PengbaoAccountState>
  signOut(): Promise<{ remoteConfirmed: boolean }>
  openEnrollment(): Promise<void>
}

export const PENGBAO_ACCOUNT_IPC = {
  state: 'pengbao:account-state',
  signIn: 'pengbao:sign-in',
  verifyMfa: 'pengbao:verify-mfa',
  signOut: 'pengbao:sign-out',
  enrollment: 'pengbao:enrollment'
} as const

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isPengbaoSignInInput(value: unknown): value is PengbaoSignInInput {
  return record(value) && typeof value.email === 'string' &&
    value.email.trim().length > 0 && value.email.length <= 320 &&
    typeof value.password === 'string' && value.password.length > 0 && value.password.length <= 4096
}

export function isPengbaoMfaInput(value: unknown): value is PengbaoMfaInput {
  return record(value) && typeof value.code === 'string' &&
    value.code.trim().length > 0 && value.code.length <= 128 && typeof value.recovery === 'boolean'
}
