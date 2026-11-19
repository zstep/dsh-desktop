export const DEFAULT_COMMAND_TIMEOUT_MS: number
export function withDefaultCommandTimeout(argv: readonly string[]): readonly string[]
export function packagedArchiveRoot(dshEntryPath: string): string | undefined
export function registerOfficeEngineResolution(dshEntryPath: string): { deregister(): void } | undefined
