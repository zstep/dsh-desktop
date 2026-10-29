import type { SecretStore } from './session-store'

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  getSelectedStorageBackend?(): string
}

/** Reject Linux's plaintext fallback as well as unavailable OS encryption. */
export function pengbaoSecretStore(storage: SafeStorageLike): SecretStore {
  const available = (): void => {
    if (!storage.isEncryptionAvailable() || storage.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('Secure credential storage unavailable')
    }
  }
  return {
    encrypt(value) { available(); return storage.encryptString(value) },
    decrypt(value) { available(); return storage.decryptString(value) }
  }
}
