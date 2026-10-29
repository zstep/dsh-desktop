export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000
export const UPDATE_STARTUP_DELAY_MS = 15_000
export const UPDATE_STARTUP_JITTER_MS = 15_000
export const AUTO_INSTALL_ON_APP_QUIT = false

// No Pengbao update service has been provisioned. Never fall back to the vendor feed.
export function supportsAutoUpdates(_isPackaged: boolean, _platform: NodeJS.Platform): boolean {
  return false
}

export function shouldCheckAfterResume(lastCheckedAt: number, now = Date.now()): boolean {
  return now - lastCheckedAt >= UPDATE_CHECK_INTERVAL_MS
}
