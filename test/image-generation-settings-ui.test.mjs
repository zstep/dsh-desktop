// @vitest-environment jsdom
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { DEFAULTS, MODEL_CATALOG } from '../packages/dsh-image-generation/lib/provider.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const defaults = () => ({ revision: 0, provider: 'bytedance', writable: true, catalogs: MODEL_CATALOG,
  profiles: Object.fromEntries(Object.entries(DEFAULTS).map(([name, value]) => [name, { ...value, configured: false }])) })
async function mount(settings, handleSave, locale = 'en') {
  const source = await readFile(resolve('packages/dsh-image-generation/client.js'), 'utf8')
  const primitives = await readFile(createRequire(resolve('package.json')).resolve('@deepseek-ai/dsh-client-ui-primitives'), 'utf8')
  const exports = primitives.match(/export \{([^}]+)\}/)[1].split(',').map(value => value.trim())
  let plugin, translations
  const require = name => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return new Proxy({}, { get(_target, key) {
      expect(exports).toContain(key)
      if (key === 'Menu') return ({ anchor, open, items, onSelect }) => React.createElement(React.Fragment, null, anchor,
        open && items.map(item => React.createElement('button', { key: item.id, type: 'button', 'data-option': item.id, onClick: () => onSelect(item.id) }, item.label)))
      return props => React.createElement('svg', props)
    } })
    throw new Error(name)
  }
  new Function('window', source)({ __ModuleLoader__: { load({ factory }) { plugin = factory(require) } } })
  const entries = [], disposers = []
  plugin.apply({
    uiConversation: { events: { register() {} } },
    locale: { register(_ns, value) { translations = value }, bind: () => key => translations[locale][key] || key },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    slots: {
      inject(name, fn) { if (['settings.plugins.tab', 'conversation.chat.node'].includes(name)) fn() },
      register(options, Component) { entries.push({ options, Component }) }
    }
  })
  expect(Object.keys(translations.zh).sort()).toEqual(Object.keys(translations.en).sort())
  const entry = entries.find(item => item.options.name === 'settings.plugins.tab')
  expect(entry.options.id).toBe('image-generation')
  const fetchMock = vi.fn(async (_url, options) => ({ ok: true, text: async () => JSON.stringify(options.method === 'POST' && handleSave ? await handleSave(JSON.parse(options.body), options) : settings) }))
  vi.stubGlobal('fetch', fetchMock)
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(React.createElement(entry.Component, { t: key => translations[locale][key] || key, ...entry.options.inject() })))
  await act(async () => container.querySelector('button[aria-controls]').click())
  const click = async selector => act(async () => container.querySelector(selector).click())
  return { container, fetchMock, click, translations, async dispose() {
    await act(async () => root.unmount()); container.remove(); disposers.reverse().forEach(dispose => dispose()); vi.unstubAllGlobals()
  } }
}

it('registers the image settings tab in ModuleLoader and retains exact standalone defaults', async () => {
  const ui = await mount(defaults())
  try {
    expect(ui.container.querySelector('form')).not.toBeNull()
    expect(ui.container.querySelector('input[type=password]')).not.toBeNull()
    expect(ui.container.querySelector('button[type=submit]').textContent).toBe('Save')
    expect(ui.container.querySelector('button[name=provider]').textContent).toBe('Seedream')
    expect(ui.container.querySelector('button[name=model]').textContent).toBe(DEFAULTS.bytedance.model)
    expect(ui.fetchMock).toHaveBeenCalledTimes(1)
    expect(ui.fetchMock.mock.calls[0][1].method).toBe('GET')
    await ui.click('button[name=provider]')
    expect(ui.container.querySelector('[data-option=pengbao]')).toBeNull()
  } finally { await ui.dispose() }
})

it.each(['en', 'zh'])('renders managed mode without model/key fields and saves only mode and revision (%s)', async locale => {
  const settings = { ...defaults(), provider: 'pengbao', managed: { supported: true, available: true, reason: 'available', serviceUrl: 'https://pengbao.ecombus.net', modelSelection: 'server-managed' } }
  const save = vi.fn(async () => ({ ...settings, revision: 1 }))
  const ui = await mount(settings, save, locale)
  try {
    expect(ui.container.querySelector('input[type=password]')).toBeNull()
    expect(ui.container.querySelector('button[name=model]')).toBeNull()
    expect(ui.container.querySelector('input[name=serviceUrl]').readOnly).toBe(true)
    expect(ui.container.querySelector('input[name=serviceUrl]').value).toBe('https://pengbao.ecombus.net')
    expect(ui.container.textContent).toContain(ui.translations[locale].managedModel)
    expect(ui.container.textContent).toContain(ui.translations[locale].cloudNotice)
    expect(ui.container.textContent).not.toContain(ui.translations[locale].configuredHint)
    await ui.click('button[type=submit]')
    expect(save.mock.calls[0][0]).toEqual({ revision: 0, provider: 'pengbao' })
    expect(ui.container.textContent).toContain(ui.translations[locale].managedSaved)
    await ui.click('button[name=provider]')
    await ui.click('[data-option=openai]')
    expect(ui.container.querySelector('input[type=password]')).not.toBeNull()
    expect(ui.container.querySelector('button[name=model]').textContent).toBe(DEFAULTS.openai.model)
    await ui.click('button[name=provider]'); await ui.click('[data-option=pengbao]')
    expect(ui.container.querySelector('input[type=password]')).toBeNull()
  } finally { await ui.dispose() }
})

it.each(['disabled', 'forbidden', 'unauthenticated', 'unavailable'])('shows managed %s and refreshes without touching manual drafts', async reason => {
  const settings = { ...defaults(), provider: 'pengbao', managed: { supported: true, available: false, reason } }
  const ui = await mount(settings)
  try {
    expect(ui.container.textContent).toContain(ui.translations.en[`managed_${reason}`])
    expect(ui.container.querySelector('button[type=submit]').disabled).toBe(false)
    settings.managed = { ...settings.managed, available: true, reason: 'available' }
    const refresh = [...ui.container.querySelectorAll('button')].find(button => button.textContent === ui.translations.en.refresh)
    await act(async () => refresh.click())
    expect(ui.container.textContent).toContain(ui.translations.en.managed_available)
    expect(ui.fetchMock.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true)
  } finally { await ui.dispose() }
})

it('keeps the desktop switch bound to enabled preference even if the market version is active', async () => {
  vi.stubGlobal('dshDesktop', { getBuiltInImageGenerationStatus: async () => ({ enabled: true, effectiveEnabled: true, effectiveSource: 'profile' }) })
  const ui = await mount(defaults())
  try {
    expect(ui.container.querySelector('input[role=switch]').checked).toBe(true)
    expect(ui.container.textContent).toContain(ui.translations.en.effective_market)
  } finally { await ui.dispose() }
})
