import { afterEach, expect, it, vi } from 'vitest'

const remote = vi.hoisted(() => ({
  policy: vi.fn(), catalog: vi.fn(), resume: vi.fn(), fetch: vi.fn(), open: vi.fn(),
  updater: { setFeedURL: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(), on: vi.fn() }
}))
vi.mock('../src/main/desktop-service', () => ({ checkDesktopUpdate: remote.policy }))
vi.mock('../src/main/update/version-catalog', async original => ({ ...await original<object>(), fetchAvailableReleases: remote.catalog }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: remote.updater } }))
vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '0.13.2+pengbao.1', getPath: () => '/nonexistent-pengbao-update-test', isReady: () => true },
  BrowserWindow: { getAllWindows: () => [] },
  net: { fetch: remote.fetch }, shell: { openExternal: remote.open },
  powerMonitor: { on: remote.resume, removeListener: vi.fn() },
  ipcMain: { handle: vi.fn() }
}))

import { checkForUpdates, downloadAvailableUpdate, getUpdateStatus, installSpecificVersion, startUpdateManager, stopUpdateManager } from '../src/main/update/update-manager'
import { desktopVersion } from '../src/shared/desktop-version'

afterEach(() => { stopUpdateManager(); vi.useRealTimers() })

it('packaged builds check Pengbao and only open the download page after user action', async () => {
  vi.useFakeTimers()
  const id = process.platform === 'darwin' ? `mac-${process.arch}` : 'windows-x64'
  remote.fetch.mockImplementation(async () => Response.json({ version: '0.13.2.2', available: true, platforms: [{ id }] }))
  startUpdateManager({ prepareToInstall: async () => {} })
  await vi.advanceTimersByTimeAsync(40000)
  expect(getUpdateStatus()).toMatchObject({ currentVersion: '0.13.2.1', availableVersion: '0.13.2.2', phase: 'available', downloadPage: true })
  expect(remote.open).not.toHaveBeenCalled()
  await checkForUpdates(true)
  await installSpecificVersion('0.13.3')
  await downloadAvailableUpdate()
  expect(remote.fetch).toHaveBeenCalledWith('https://pengbao.ecombus.net/api/desktop/downloads', expect.anything())
  expect(remote.open).toHaveBeenCalledExactlyOnceWith('https://pengbao.ecombus.net/download')
  expect(remote.policy).not.toHaveBeenCalled()
  expect(remote.catalog).not.toHaveBeenCalled()
  expect(remote.updater.on).not.toHaveBeenCalled()
  expect(remote.updater.setFeedURL).not.toHaveBeenCalled()
  expect(remote.updater.checkForUpdates).not.toHaveBeenCalled()
  expect(remote.updater.downloadUpdate).not.toHaveBeenCalled()
  expect(remote.updater.quitAndInstall).not.toHaveBeenCalled()
})
it('displays the fourth revision without the packaging-only SemVer suffix', () => {
  expect(desktopVersion('0.13.2+pengbao.1')).toBe('0.13.2.1')
  expect(desktopVersion('0.13.3+pengbao.12')).toBe('0.13.3.12')
  expect(desktopVersion('0.13.2')).toBe('0.13.2')
})
