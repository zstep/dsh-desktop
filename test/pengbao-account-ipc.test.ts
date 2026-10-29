import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pathToFileURL } from 'node:url'
import { PENGBAO_ACCOUNT_IPC } from '../src/shared/pengbao-account'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  openExternal: vi.fn(async () => {})
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, callback: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, callback),
    removeHandler: (channel: string) => mocks.handlers.delete(channel)
  },
  shell: { openExternal: mocks.openExternal }
}))
import { registerPengbaoAccountIpc } from '../src/main/enterprise/account-ipc'
import { PengbaoAccountController } from '../src/main/enterprise/account-controller'
import { PengbaoClient } from '../src/main/enterprise/client'
import type { BrowserWindow } from 'electron'

beforeEach(() => { mocks.handlers.clear(); mocks.openExternal.mockClear() })

describe('Pengbao privileged account IPC', () => {
  function setup() {
    const pagePath = '/app/pengbao-account.html'
    const frame = { url: pathToFileURL(pagePath).href }
    const contents = { mainFrame: frame }
    // Only the BrowserWindow methods used by the trust boundary are modeled.
    const window = { isDestroyed: () => false, webContents: contents } as BrowserWindow
    const controller = new PengbaoAccountController({
      client: new PengbaoClient({ fetch: async () => Response.json({ token: 'secret', id: 'a', role: 'user' }) }),
      store: { load: async () => undefined, save: async () => {}, clear: async () => {} },
      activate: async () => {}, deactivate: async () => {}
    })
    const dispose = registerPengbaoAccountIpc({ window: () => window, pagePath, controller })
    const event = { sender: contents, senderFrame: frame }
    function invoke(channel: string, source: unknown = event, input?: unknown): unknown {
      const handler = mocks.handlers.get(channel)
      if (!handler) throw new Error('Missing handler')
      return handler(source, input)
    }
    return { invoke, dispose, event, frame }
  }

  it('rejects other windows, child frames and navigated pages', () => {
    const { invoke, event, frame } = setup()
    expect(() => invoke(PENGBAO_ACCOUNT_IPC.state, { ...event, sender: {} })).toThrow('Untrusted')
    expect(() => invoke(PENGBAO_ACCOUNT_IPC.state, { ...event, senderFrame: { ...frame } })).toThrow('Untrusted')
    frame.url = 'https://pengbao.ecombus.net'
    expect(() => invoke(PENGBAO_ACCOUNT_IPC.state)).toThrow('Untrusted')
  })

  it('validates arguments before sending credentials and returns sanitized state', async () => {
    const { invoke, event } = setup()
    expect(() => invoke(PENGBAO_ACCOUNT_IPC.signIn, event, { email: 'a' })).toThrow('Invalid login')
    const result = await invoke(PENGBAO_ACCOUNT_IPC.signIn, event, { email: 'a@example.test', password: 'secret' })
    expect(result).toMatchObject({ phase: 'signed-in' })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('opens only the pinned service and disposes all handlers', async () => {
    const { invoke, dispose, event } = setup()
    await invoke(PENGBAO_ACCOUNT_IPC.enrollment, event, 'https://evil.example')
    expect(mocks.openExternal).toHaveBeenCalledWith('https://pengbao.ecombus.net')
    dispose()
    expect(mocks.handlers.size).toBe(0)
  })
})
