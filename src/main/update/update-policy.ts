export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000
export const UPDATE_STARTUP_DELAY_MS = 15_000
export const UPDATE_STARTUP_JITTER_MS = 15_000
export const AUTO_INSTALL_ON_APP_QUIT = false

// Auto-updates are backed by the Pengbao update service (dshdesktop.com) and are
// active only in packaged builds. Development and diagnostics builds never reach
// the update feed or policy service.
export function supportsAutoUpdates(isPackaged: boolean, _platform: NodeJS.Platform): boolean {
  return isPackaged
}

export function shouldCheckAfterResume(lastCheckedAt: number, now = Date.now()): boolean {
  return now - lastCheckedAt >= UPDATE_CHECK_INTERVAL_MS
}
