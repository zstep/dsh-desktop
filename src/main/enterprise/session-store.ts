import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface SecretStore {
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}
export interface SessionStore {
  load(server: string): Promise<string | undefined>
  save(server: string, token: string): Promise<void>
  clear(server: string): Promise<void>
}
interface StoredSession { version: 1; server: string; encryptedToken: string }

function canonicalServer(server: string): string {
  const url = new URL(server)
  if (url.protocol !== 'https:') throw new Error('Session server must use HTTPS')
  url.pathname = url.pathname.replace(/\/$/, '')
  return url.href
}
function isStored(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.version === 1 && typeof record.server === 'string' && typeof record.encryptedToken === 'string'
}

export function createFileSessionStore(path: string, secretStore: SecretStore): SessionStore {
  return {
    async load(server) {
      let parsed: unknown
      try { parsed = JSON.parse(await readFile(path, 'utf8')) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw new Error('Unable to read Pengbao session')
      }
      if (!isStored(parsed) || parsed.server !== canonicalServer(server)) return undefined
      try { return secretStore.decrypt(Buffer.from(parsed.encryptedToken, 'base64')) } catch { throw new Error('Unable to decrypt Pengbao session') }
    },
    async save(server, token) {
      const canonical = canonicalServer(server)
      let encrypted: Buffer
      try { encrypted = secretStore.encrypt(token) } catch { throw new Error('Unable to encrypt Pengbao session') }
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        const document = JSON.stringify({ version: 1, server: canonical, encryptedToken: encrypted.toString('base64') }) + '\n'
        await writeFile(temporary, document, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        await chmod(temporary, 0o600)
        await rename(temporary, path)
      } catch (error) {
        try { await unlink(temporary) } catch { /* Preserve the original write failure. */ }
        throw new Error('Unable to save Pengbao session')
      }
    },
    async clear(server) {
      // Check the binding before deleting so one server cannot erase another server's token.
      const canonical = canonicalServer(server)
      let parsed: unknown
      try {
        const document = await readFile(path, 'utf8')
        try { parsed = JSON.parse(document) } catch { parsed = undefined }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw new Error('Unable to clear Pengbao session')
      }
      // A corrupt credential file cannot be bound to another server. Remove it
      // rather than leaving an unreadable token that blocks local logout forever.
      if (typeof parsed === 'object' && parsed !== null && 'server' in parsed &&
        typeof parsed.server === 'string' && parsed.server !== canonical) return
      try { await unlink(path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Unable to clear Pengbao session')
      }
    }
  }
}
