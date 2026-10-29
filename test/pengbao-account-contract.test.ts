import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isPengbaoMfaInput, isPengbaoSignInInput } from '../src/shared/pengbao-account'

describe('Pengbao account IPC input validation', () => {
  it('accepts bounded login input without modifying the password', () => {
    expect(isPengbaoSignInInput({ email: 'person@example.test', password: ' pass ' })).toBe(true)
  })

  it('rejects malformed and oversized login arguments', () => {
    for (const input of [null, [], {}, { email: ' ', password: 'x' },
      { email: 'person@example.test', password: 42 },
      { email: 'person@example.test', password: 'x'.repeat(4097) },
      { email: 'x'.repeat(321), password: 'x' }]) {
      expect(isPengbaoSignInInput(input)).toBe(false)
    }
  })

  it('requires an explicit recovery flag and bounded nonempty code', () => {
    expect(isPengbaoMfaInput({ code: '123456', recovery: false })).toBe(true)
    expect(isPengbaoMfaInput({ code: 'recovery-code', recovery: true })).toBe(true)
    for (const input of [null, [], {}, { code: '123456' }, { code: ' ', recovery: false },
      { code: 'x'.repeat(129), recovery: true }, { code: '123456', recovery: 'false' }]) {
      expect(isPengbaoMfaInput(input)).toBe(false)
    }
  })

  it('pins the account page inline script to its CSP digest', () => {
    const page = readFileSync(new URL('../build/pengbao-account.html', import.meta.url), 'utf8')
    const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    expect(script).toBeDefined()
    const digest = createHash('sha256').update(script!).digest('base64')
    expect(page).toContain(`script-src 'sha256-${digest}'`)
  })
})
