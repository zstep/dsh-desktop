import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApplicationRollback } from '../src/main/update/application-rollback'

const mocks = vi.hoisted(() => ({
  root: '',
  catalog: vi.fn(),
  policy: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  updater: { setFeedURL: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(), on: vi.fn() }
}))
vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '0.13.0', getPath: () => mocks.root, isReady: () => true },
  BrowserWindow: { getAllWindows: () => [] },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
  ipcMain: { handle: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(name, handler)) }
}))
vi.mock('electron-updater', () => ({ default: { autoUpdater: mocks.updater } }))
vi.mock('../src/main/desktop-service', () => ({ checkDesktopUpdate: mocks.policy }))
vi.mock('../src/main/update/version-catalog', async original => ({ ...await original<object>(), fetchAvailableReleases: mocks.catalog }))
let manager: typeof import('../src/main/update/update-manager')
let journalPath: string

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.handlers.clear()
  mocks.root = await mkdtemp(join(tmpdir(), 'pengbao-rollback-manager-'))
  journalPath = join(mocks.root, 'application-rollback.json')
  await new ApplicationRollback(journalPath, {
    version: '0.11.2', platform: process.platform, arch: process.arch, packaged: true
  }).recordUpgrade('0.13.0')
  manager = await import('../src/main/update/update-manager')
})
afterEach(async () => { manager.stopUpdateManager(); await rm(mocks.root, { recursive: true, force: true }) })

function expectNoRemoteUpdate(): void {
  expect(mocks.policy).not.toHaveBeenCalled()
  expect(mocks.catalog).not.toHaveBeenCalled()
  expect(mocks.updater.setFeedURL).not.toHaveBeenCalled()
  expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled()
  expect(mocks.updater.downloadUpdate).not.toHaveBeenCalled()
  expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled()
}

it('keeps recovery unavailable and preserves the previous-version journal', async () => {
  const prepare = vi.fn(async () => {})
  const compatibility = vi.fn(async () => ({ compatible: true }))
  const before = await readFile(journalPath, 'utf8')
  manager.startUpdateManager({ prepareToInstall: prepare, rollbackCompatibility: compatibility })
  expect(await manager.getApplicationRollbackStatus()).toEqual({ available: false, reason: 'pengbao-update-service-unconfigured' })
  await expect(manager.rollbackApplication()).rejects.toThrow('pengbao-update-service-unconfigured')
  expect(await readFile(journalPath, 'utf8')).toBe(before)
  expect(compatibility).not.toHaveBeenCalled()
  expect(prepare).not.toHaveBeenCalled()
  expectNoRemoteUpdate()
})

it('rejects manual checks and exact-version installation without contacting the former vendor', async () => {
  manager.startUpdateManager({ prepareToInstall: async () => {} })
  await manager.checkForUpdates(false, 'startup')
  await manager.checkForUpdates(true)
  await manager.installSpecificVersion('0.11.2')
  await manager.downloadAvailableUpdate()
  await manager.installDownloadedUpdate()
  expect(manager.getUpdateStatus().phase).toBe('unsupported')
  expectNoRemoteUpdate()
})

it('keeps registered update IPC routes offline, including release history', async () => {
  manager.registerUpdateHandlers()
  manager.startUpdateManager({ prepareToInstall: async () => {} })
  expect(await mocks.handlers.get('updates:list-versions')?.()).toEqual([])
  expect(await mocks.handlers.get('updates:check')?.()).toMatchObject({ phase: 'unsupported' })
  expect(await mocks.handlers.get('updates:install-version')?.({}, '0.11.2')).toMatchObject({ phase: 'unsupported' })
  await mocks.handlers.get('updates:download')?.()
  await mocks.handlers.get('updates:install')?.()
  expectNoRemoteUpdate()
})
