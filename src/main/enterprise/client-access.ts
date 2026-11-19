/** Pengbao desktop availability configured on the server's model management page. */
export type ClientSurface = 'text' | 'image' | 'video'

export interface ClientAccess {
  enabled: boolean
  types: readonly ClientSurface[]
}

const SURFACES: readonly ClientSurface[] = ['text', 'image', 'video']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `undefined` means the model has no client metadata at all (legacy/unconfigured).
 * A present but malformed block is treated as explicitly disabled so a bad
 * payload can never widen the client catalog.
 */
export function parseClientAccess(meta: unknown): ClientAccess | undefined {
  if (!isRecord(meta) || !('client' in meta) || meta.client === null) return undefined
  const client = meta.client
  if (!isRecord(client)) return { enabled: false, types: [] }
  const types: ClientSurface[] = []
  if (Array.isArray(client.types)) {
    for (const value of client.types) {
      if (typeof value === 'string' && (SURFACES as readonly string[]).includes(value) && !types.includes(value as ClientSurface)) {
        types.push(value as ClientSurface)
      }
      if (types.length === SURFACES.length) break
    }
  }
  return { enabled: client.enabled === true, types }
}

/** Read `info.meta` from an OpenAI-compatible model entry. */
function entryMeta(entry: unknown): unknown {
  if (!isRecord(entry) || !isRecord(entry.info)) return undefined
  return entry.info.meta
}

export function entryClientAccess(entry: unknown): ClientAccess | undefined {
  return parseClientAccess(entryMeta(entry))
}

/** A catalog is configured once any entry carries a `client` block, even if disabled. */
export function clientAccessConfigured(entries: readonly unknown[]): boolean {
  return entries.some(entry => {
    const meta = entryMeta(entry)
    return isRecord(meta) && 'client' in meta && meta.client !== null
  })
}