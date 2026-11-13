// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import React, { act } from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { createRoot } from 'react-dom/client'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const cleanups = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function load(path, modules) {
  let registration
  const previous = window.__ModuleLoader__
  window.__ModuleLoader__ = { load(value) { registration = value } }
  try { new Function('window', readFileSync(new URL(path, import.meta.url), 'utf8'))(window) }
  finally { window.__ModuleLoader__ = previous }
  return registration.factory(name => {
    if (name in modules) return modules[name]
    throw new Error(`Unexpected module ${name}`)
  })
}

it('keeps the complete model foundation exclusively under Built-in plugins', () => {
  const plugin = load('../packages/dsh-desktop-model-service/client.js', { react: React })
  const registrations = []
  plugin.apply({ effect() {}, locale: { bind: () => key => key }, slots: {
    inject: (_name, apply) => apply(), register: (options, component) => registrations.push({ options, component })
  } })
  expect(registrations.map(value => [value.options.name, value.options.id])).toEqual([
    ['settings.plugins.tab', 'desktop-model-service']
  ])
  expect(registrations[0].component).toBeDefined()
  expect(registrations[0].options.inject().callApi).toBeDefined()
  expect(registrations[0].options.label()).toBe('title')
})

async function mountPlugins({ defer = false, rows = [
  { id: 'inventory', label: 'Inventory', order: 0 },
  { id: 'desktop-model-service', label: 'Pengbao model foundation', order: 1 }
] } = {}) {
  const plugin = load('../node_modules/@deepseek-ai/dsh-client-ui-settings-plugins/lib/client.js', {
    react: React, 'react/jsx-runtime': jsxRuntime,
    '@deepseek-ai/dsh-client-ui-slots': { resolveSlotLabel: value => typeof value === 'function' ? value() : value }
  })
  let entry
  const disposers = [], rowListeners = new Set()
  plugin.apply({
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    locale: { bind: () => key => key, register() {}, getSnapshot: () => ({ revision: 0 }), subscribe: () => () => {} },
    slots: {
      getVersion: () => rows,
      entries: () => rows.map(row => ({ options: row })),
      subscribe: (_name, fn) => { rowListeners.add(fn); return () => rowListeners.delete(fn) },
      inject: (_name, fn) => fn(), register(options, Component) { entry = { options, Component } }
    }
  })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  function render() {
    const injected = entry.options.inject()
    const tabs = injected.hooks.tabs
    root.render(React.createElement(entry.Component, { ...injected, t: key => key,
      useTabs: selector => React.useSyncExternalStore(tabs.subscribe, () => selector(tabs.getSnapshot())),
      ...(injected.hooks.selection ? { useSelection: selector => React.useSyncExternalStore(injected.hooks.selection.subscribe, () => selector(injected.hooks.selection.getSnapshot())) } : {}),
      renderSlot: (_name, _props, { only }) => React.createElement('p', { 'data-content': only }, only)
    }))
  }
  const request = id => act(async () => { window.dispatchEvent(new CustomEvent('dsh-settings-plugins:select', { detail: { id } })) })
  const show = () => act(async () => render())
  cleanups.push(async () => { await act(async () => root.unmount()); container.remove(); disposers.reverse().forEach(dispose => dispose()) })
  if (!defer) await show()
  return { container, request, show, async rows(value) { await act(async () => { rows = value; rowListeners.forEach(fn => fn()) }) } }
}

function installShortcut(openSection) {
  const path = '../node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js'
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const start = source.indexOf('const openModelService =')
  const end = source.indexOf('\n\t\t\t}));', start)
  return new Function('window', 'shellInstance', 'disposeCommand', 'disposeSlot', source.slice(start, end))(
    window, { actions: { openSection } }, () => {}, () => {})
}

it('routes the imagegen shortcut into the plugins child before mounting and cleans up on unload', async () => {
  const app = await mountPlugins({ defer: true })
  const opened = []
  let dispose = installShortcut(id => opened.push(id))
  const shortcut = () => act(async () => { window.dispatchEvent(new CustomEvent('dsh-desktop-model-service:open')) })
  try {
    await shortcut()
    await app.show()
    expect(opened).toEqual(['plugins'])
    expect(selected(app.container)).toBe('Pengbao model foundation')
    dispose()
    await act(async () => app.container.querySelector('[role=tab]').click())
    await shortcut()
    expect(opened).toEqual(['plugins'])
    expect(selected(app.container)).toBe('Inventory')
    dispose = installShortcut(id => opened.push(id))
    await shortcut()
    expect(opened).toEqual(['plugins', 'plugins'])
    expect(selected(app.container)).toBe('Pengbao model foundation')
  } finally { dispose() }
})

function selected(container) {
  const tab = container.querySelector('[role=tab][aria-selected=true]')
  return tab?.textContent
}
it('selects the model child requested before the plugins section mounts', async () => {
  const app = await mountPlugins({ defer: true })
  await app.request('desktop-model-service')
  await app.show()
  expect(selected(app.container)).toBe('Pengbao model foundation')
  expect(app.container.querySelector('[role=tabpanel]:not([hidden]) [data-content]').dataset.content).toBe('desktop-model-service')
})
it('reopens the model child after a different tab was selected without trapping manual navigation', async () => {
  const app = await mountPlugins()
  expect(selected(app.container)).toBe('Inventory')
  await app.request('desktop-model-service')
  expect(selected(app.container)).toBe('Pengbao model foundation')
  await act(async () => app.container.querySelector('[role=tab]').click())
  expect(selected(app.container)).toBe('Inventory')
  await app.request('desktop-model-service')
  expect(selected(app.container)).toBe('Pengbao model foundation')
})
it('waits for a late child registration and safely ignores unknown targets', async () => {
  const app = await mountPlugins()
  await app.request('absent')
  expect(selected(app.container)).toBe('Inventory')
  await app.request('late')
  await app.rows([{ id: 'inventory', label: 'Inventory' }, { id: 'late', label: 'Late view' }])
  expect(selected(app.container)).toBe('Late view')
})
it('keeps single-child rendering and keyboard tab selection working', async () => {
  const app = await mountPlugins()
  await app.request('desktop-model-service')
  await act(async () => app.container.querySelector('[role=tab][aria-selected=true]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
  expect(selected(app.container)).toBe('Inventory')
  await app.rows([{ id: 'desktop-model-service', label: 'Pengbao model foundation' }])
  expect(app.container.querySelector('[role=tablist]')).toBeNull()
  expect(app.container.querySelector('[data-content]').dataset.content).toBe('desktop-model-service')
})
