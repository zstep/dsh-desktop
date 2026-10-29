import { describe, expect, it, vi } from 'vitest'
import { pengbaoSecretStore } from '../src/main/enterprise/secret-store'

describe('Pengbao OS encryption adapter', () => {
  it.each([false, true])('rejects unavailable or plaintext encryption (%s)', available => {
    const encryptString = vi.fn(() => Buffer.from('plaintext'))
    const store = pengbaoSecretStore({
      isEncryptionAvailable: () => available,
      getSelectedStorageBackend: () => 'basic_text',
      encryptString,
      decryptString: () => 'plaintext'
    })
    expect(() => store.encrypt('secret')).toThrow('Secure credential storage unavailable')
    expect(() => store.decrypt(Buffer.from('ciphertext'))).toThrow('Secure credential storage unavailable')
    expect(encryptString).not.toHaveBeenCalled()
  })

  it('delegates only to available OS encryption', () => {
    const encryptString = vi.fn(() => Buffer.from('ciphertext'))
    const decryptString = vi.fn(() => 'secret')
    const store = pengbaoSecretStore({ isEncryptionAvailable: () => true, encryptString, decryptString })
    expect(store.encrypt('secret')).toEqual(Buffer.from('ciphertext'))
    expect(store.decrypt(Buffer.from('ciphertext'))).toBe('secret')
  })
})
