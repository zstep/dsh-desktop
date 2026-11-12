import type { GpuExitContext } from '../gpu-fallback'
import { totalmem, freemem, release } from 'node:os'
import { resourceSnapshot, graphicsSnapshot } from '../resource-diagnostics'
import { app, net } from 'electron'
import { join } from 'node:path'
import { DesktopService } from './service'
import { attachDiagnostics } from './diagnostics'

let gpuInfo = 'not-yet-available'
let service: DesktopService | undefined
export let desktopDiagnostics: ReturnType<typeof attachDiagnostics> | undefined

/** Call only after the single-instance lock, before bootstrap writes this session's log. */
export function initializeDesktopService(options: { getExitContext?: () => GpuExitContext } = {}): void {
  if (!app.isPackaged || service) return
  try {
    service = new DesktopService({
      stateDir: join(app.getPath('userData'), 'desktop-service'),
      logPath: join(app.getPath('userData'), 'desktop-service', 'diagnostics.log'),
      version: app.getVersion(), platform: process.platform, arch: process.arch,
      remoteEnabled: true,
      // Chromium networking uses the same proxy configuration as the desktop app.
      request: (url, init) => net.fetch(url, init),
      confirmUpload: async () => false
    })
    void app.whenReady().then(async () => {
      gpuInfo = graphicsSnapshot(await app.getGPUInfo('basic'))
    }).catch(error => console.warn('[desktop-service] GPU metadata unavailable', error instanceof Error ? error.name : 'unknown'))
    desktopDiagnostics = attachDiagnostics(app, service, {
      getExitContext: options.getExitContext,
      resourceEvidence: () => `os=${release()} acceleration=${app.isHardwareAccelerationEnabled()} gpu=${gpuInfo} ${resourceSnapshot(totalmem(), freemem(), app.getAppMetrics())}`,
      onError: error => console.warn('[desktop-service]', error instanceof Error ? error.name : 'Diagnostic failure')
    })
  } catch (error) {
    service = undefined
    console.warn('[desktop-service] initialization failed', error instanceof Error ? error.name : 'Unknown error')
  }
}
export async function checkDesktopUpdate(manual = false) {
  if (!service) throw new Error('Desktop update service is unavailable')
  return service.checkUpdate(manual)
}
