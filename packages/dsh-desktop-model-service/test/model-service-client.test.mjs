import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const overview = () => ({
  writable: true, models: [
    { id: 'chat-model', name: '<Chat & model>', capabilities: ['chat.completions'] },
    { id: 'image-model', name: 'Image', capabilities: ['image.generate'] },
    { id: 'image-model-two', name: 'Second image', alias: 'Second alias', capabilities: ['image.generate'] },
    { id: 'chat-image-model', name: 'Chat only model', capabilities: ['chat.completions'] }
  ],
  availability: { chat: { available: true }, image: { available: true } },
  defaults: { chat: { provider: 'pengbao', model: 'chat-model' }, image: { id: 'image-model', name: 'Image' } },
  selections: { chat: null, image: '' }, editable: { chat: true, image: true }, imageSelection: 'request-local',
  imageCatalogStatus: 'available', video: { available: false, reason: 'unverified' },
  consumers: [
    { id: 'first', version: '0.1.0', state: 'not-connected', adapter: 'facade' },
    { id: 'second', version: '0.1.0', state: 'not-connected', adapter: 'facade' },
    { id: 'disabled', version: '0.1.0', state: 'conflict', adapter: 'facade' },
    { id: 'connected', version: '0.1.0', state: 'connected', adapter: 'facade' }
  ]
})

// Keep the package tests dependency-free apart from the app's existing React.
// The hook driver exposes rendered host elements; React's server renderer also
// checks that each resulting tree is renderable and text is escaped.
function mount({ language = 'en', initial = overview(), plugins = [], request } = {}) {
  let cursor = 0, tree, registration, dictionaries, component, props, callbacks = []
  let nextId = 0
  const hooks = []
  const calls = []
  const effects = []
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const react = {
    ...React,
    useState(initialValue) {
      const index = cursor++
      if (!hooks[index]) hooks[index] = { value: typeof initialValue === 'function' ? initialValue() : initialValue }
      return [hooks[index].value, value => { hooks[index].value = typeof value === 'function' ? value(hooks[index].value) : value }]
    },
    useRef(value) {
      const index = cursor++
      hooks[index] ??= { current: value }
      return hooks[index]
    },
    useCallback(callback, deps) {
      const index = cursor++
      if (!sameDeps(hooks[index]?.deps, deps)) hooks[index] = { deps, value: callback }
      return hooks[index].value
    },
    useEffect(callback, deps) {
      const index = cursor++
      if (!sameDeps(hooks[index]?.deps, deps)) {
        hooks[index] = { deps }
        effects.push(callback)
      }
    }
  }
  const t = key => {
    const value = dictionaries?.[language]?.[key]
    assert.equal(typeof value, 'string', `missing ${language} locale key: ${key}`)
    return value
  }
  const defaultRequest = (endpoint, payload) => {
    if (endpoint === 'configuration.inventory') return { plugins }
    if (endpoint === 'configuration.analyze') return { planId: 'assistant-plan-1', entryId: payload.entryId, packageName: 'fixture-provider', packageVersion: '1.2.3', expiresAt: Date.now() + 60_000, capabilities: ['chat.completions'], writes: [
      { path: ['endpoint'], value: 'Pengbao gateway' },
      { path: ['credential', 'host-id'], value: '••••••••' },
      { path: ['chatModel'], value: '<actual-model-id>' }
    ] }
    if (endpoint === 'configuration.cancel') return {}
    if (endpoint === 'configuration.apply') return { status: 'saved-active', receiptId: 'assistant-receipt-1' }
    if (endpoint === 'configuration.rollback') return { status: 'rolled-back' }
    if (endpoint === 'overview') return initial
    if (endpoint === 'plan') {
      const skips = new Set(payload.skipConsumerIds ?? [])
      const candidates = payload.action === 'connect-all'
        ? initial.consumers.filter(item => item.adapter === 'facade').map(item => ({ id: item.id,
          state: skips.has(item.id) ? 'skipped' : item.state === 'conflict' ? 'conflict' : item.state === 'connected' ? 'already-connected' : 'ready' }))
        : undefined
      return { id: `plan-${++nextId}`, expiresAt: Date.now() + 60_000,
        candidates, changes: payload.action === 'connect-all'
          ? candidates.filter(item => item.state === 'ready').map(item => ({ path: ['bindings', item.id], before: null, after: { enabled: true } }))
          : [{ path: ['model'], before: null, after: payload.modelId || payload.consumerId }] }
    }
    if (endpoint === 'apply') {
      initial = { ...initial, rollbackAvailable: true, receiptId: 'receipt-1' }
      return { state: 'applied', rollbackAvailable: true, receiptId: 'receipt-1' }
    }
    if (endpoint === 'rollback') {
      initial = { ...initial, rollbackAvailable: false, receiptId: undefined }
      return { state: 'rolled-back' }
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }
  const fetch = async (url, options) => {
    const endpoint = url.replace('/api/model-service.', '')
    const payload = options.body ? JSON.parse(options.body) : undefined
    calls.push({ endpoint, payload, options, url })
    const result = request ? await request(endpoint, payload, defaultRequest) : defaultRequest(endpoint, payload)
    return result instanceof Response ? result : Response.json(result)
  }
  const document = {
    querySelector: () => null, createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} }
  }
  const context = vm.createContext({ window: { __ModuleLoader__: { load: value => { registration = value } } },
    document, fetch, AbortController, Date })
  new vm.Script(source, { filename: 'model-service-client.js' }).runInContext(context)
  const plugin = registration.factory(name => { assert.equal(name, 'react'); return react })
  plugin.apply({
    effect(callback) { const cleanup = callback(); if (typeof cleanup === 'function') callbacks.push(cleanup) },
    locale: { register(ns, values) { assert.equal(ns, 'settings.desktopModelService'); dictionaries = values }, bind: () => t },
    slots: {
      inject(name, callback) { assert.ok(['settings.section', 'settings.plugins.tab'].includes(name)); callback() },
      register(config, value) { component = value; props = config.inject(); return config }
    }
  })
  const render = () => {
    cursor = 0
    tree = component(props)
    while (effects.length) { const cleanup = effects.shift()(); if (typeof cleanup === 'function') callbacks.push(cleanup) }
    return tree
  }
  render()
  const settle = async () => {
    await new Promise(resolve => setImmediate(resolve))
    render()
    return tree
  }
  const elements = (predicate, node = tree) => {
    if (!React.isValidElement(node)) return []
    return [...(predicate(node) ? [node] : []), ...React.Children.toArray(node.props.children).flatMap(child => elements(predicate, child))]
  }
  const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
    : React.isValidElement(node) ? React.Children.toArray(node.props.children).map(text).join('') : ''
  const button = key => {
    const matches = elements(node => node.type === 'button' && text(node) === t(key))
    assert.equal(matches.length, 1, `expected one ${key} button`)
    return matches[0]
  }
  return { settle, render, calls, elements, text, button, t, dictionaries,
    html: () => renderToStaticMarkup(tree), dispose: () => { callbacks.reverse().forEach(callback => callback()); callbacks = [] } }
}

for (const language of ['en', 'zh']) {
  test(`client JavaScript renders valid escaped ${language} UI and complete locales`, async () => {
    const app = mount({ language })
    await app.settle()
    assert.deepEqual(Object.keys(app.dictionaries.en).sort(), Object.keys(app.dictionaries.zh).sort())
    let html = app.html()
    assert.equal(app.elements(node => node.type === 'select').length, 0)
    assert.equal(app.elements(node => node.type === 'button' && app.text(node) === app.t('checkConfiguration')).length, 0)

    assert.ok(html.includes('&lt;Chat &amp; model&gt;'))
    assert.equal(html.includes('Server selected') || html.includes('由服务器选择'), false)
    assert.ok(html.includes(app.t('unverified')))
    await app.button('connectAll').props.onClick()
    await app.settle()
    html = app.html()
    assert.match(html, /role="dialog"/)
    assert.equal(app.elements(node => node.props.role === 'dialog')[0].props['aria-label'], language === 'zh' ? '检查配置' : 'Check configuration')
    assert.ok(html.includes(app.t('checkConfiguration')))
    assert.equal(app.calls.some(item => item.endpoint === 'apply'), false, 'checking configuration must still require confirmation')
    assert.ok(html.includes(app.t('ready')))
    assert.ok(html.includes(app.t('conflict')))
    assert.equal(app.elements(node => node.type === 'input' && node.props.type === 'checkbox').length, 4)
    app.dispose()
  })
}

test('connect-all UI supports skip/reinclude, disabled conflicts, apply and rollback receipts', async () => {
  const app = mount()
  await app.settle()
  await app.button('connectAll').props.onClick()
  await app.settle()
  let checkboxes = app.elements(node => node.type === 'input')
  assert.equal(checkboxes[2].props.disabled, true)
  assert.equal(checkboxes[3].props.disabled, true)
  checkboxes[0].props.onChange({ target: { checked: false } })
  await app.settle()
  assert.deepEqual(app.calls.at(-1).payload, { action: 'connect-all', skipConsumerIds: ['first'] })
  assert.equal(app.elements(node => node.type === 'input')[0].props.checked, false)
  assert.ok(app.html().includes(app.t('skipped')))
  app.elements(node => node.type === 'input')[0].props.onChange({ target: { checked: true } })
  await app.settle()
  assert.deepEqual(app.calls.at(-1).payload, { action: 'connect-all', skipConsumerIds: [] })
  assert.equal(app.elements(node => node.type === 'input')[0].props.checked, true)
  await app.button('apply').props.onClick()
  await app.settle()
  assert.equal(app.elements(node => node.props.role === 'dialog').length, 0)
  assert.ok(app.html().includes(app.t('applied')))
  assert.deepEqual(app.calls.find(item => item.endpoint === 'apply').payload, { planId: 'plan-3' })
  await app.button('rollback').props.onClick()
  await app.settle()
  assert.deepEqual(app.calls.find(item => item.endpoint === 'rollback').payload, { receiptId: 'receipt-1' })
  assert.ok(app.html().includes(app.t('rolledBack')))
  assert.equal(app.elements(node => node.type === 'button' && app.text(node) === app.t('rollback')).length, 0)
  assert.ok(app.calls.every(item => item.options.credentials === 'same-origin' && item.options.cache === 'no-store'))
  app.dispose()
})

test('failed skip replan removes old apply UI and never submits the obsolete plan', async () => {
  let plans = 0
  const waiting = deferred()
  const app = mount({ request(endpoint, payload, next) {
    if (endpoint === 'plan' && ++plans === 2) return waiting.promise
    return next(endpoint, payload)
  } })
  await app.settle()
  await app.button('connectAll').props.onClick()
  await app.settle()
  app.elements(node => node.type === 'input')[0].props.onChange({ target: { checked: false } })
  app.render()
  assert.equal(app.elements(node => node.props.role === 'dialog').length, 0)
  assert.equal(app.button('connectAll').props.disabled, true)
  waiting.resolve(Response.json({ code: 'UNAVAILABLE' }, { status: 503 }))
  await app.settle()
  assert.equal(app.elements(node => node.props.role === 'dialog').length, 0)
  assert.ok(app.html().includes(app.t('failed')))
  assert.equal(app.calls.some(item => item.endpoint === 'apply'), false)
  await app.button('connectAll').props.onClick()
  await app.settle()
  assert.deepEqual(app.calls.at(-1).payload.skipConsumerIds, ['first'])
  app.dispose()
})

test('refresh keeps the read-only foundation view and does not offer default edits', async () => {
  const app = mount()
  await app.settle()
  await app.button('refresh').props.onClick()
  await app.settle()
  assert.equal(app.elements(node => node.type === 'select').length, 0)
  assert.equal(app.elements(node => node.type === 'button' && app.text(node) === app.t('checkConfiguration')).length, 0)
  app.dispose()
})


test('apply conflicts discard stale preview and display the localized error', async () => {
  const app = mount({ request(endpoint, payload, next) {
    return endpoint === 'apply' ? Response.json({ code: 'CONFLICT' }, { status: 409 }) : next(endpoint, payload)
  } })
  await app.settle()
  await app.button('connectAll').props.onClick()
  await app.settle()
  await app.button('apply').props.onClick()
  await app.settle()
  assert.equal(app.elements(node => node.props.role === 'dialog').length, 0)
  assert.ok(app.html().includes(app.t('conflict')))
  assert.equal(app.elements(node => node.props.role === 'alert').length, 1)
  app.dispose()
})

test('skip-all preview is a no-op and cancel never applies changes', async () => {
  const app = mount({ request(endpoint, payload, next) {
    if (endpoint === 'apply') return { state: 'already-connected', rollbackAvailable: false }
    return next(endpoint, payload)
  } })
  await app.settle()
  await app.button('connectAll').props.onClick()
  await app.settle()
  for (const index of [0, 1]) {
    app.elements(node => node.type === 'input')[index].props.onChange({ target: { checked: false } })
    await app.settle()
  }
  assert.ok(app.html().includes(app.t('noChanges')))
  await app.button('apply').props.onClick()
  await app.settle()
  assert.ok(app.html().includes(app.t('noChanges')))
  assert.equal(app.elements(node => node.type === 'button' && app.text(node) === app.t('rollback')).length, 0)
  await app.button('connectAll').props.onClick()
  await app.settle()
  app.button('cancel').props.onClick()
  app.render()
  assert.equal(app.elements(node => node.props.role === 'dialog').length, 0)
  assert.equal(app.calls.filter(item => item.endpoint === 'apply').length, 1)
  app.dispose()
})

test('expired preview is discarded locally without an apply request', async () => {
  const app = mount({ request(endpoint, payload, next) {
    const result = next(endpoint, payload)
    return endpoint === 'plan' ? { ...result, expiresAt: Date.now() - 1 } : result
  } })
  await app.settle()
  await app.button('connectAll').props.onClick()
  await app.settle()
  await app.button('apply').props.onClick()
  app.render()
  assert.equal(app.elements(node => node.props.role === 'dialog').length, 0)
  assert.ok(app.html().includes(app.t('failed')))
  assert.equal(app.calls.some(item => item.endpoint === 'apply'), false)
  app.dispose()
})

test('default display prefers aliases, falls back to names or IDs and never offers default edits', async () => {
  for (const language of ['en', 'zh']) {
    for (const mode of ['alias', 'name', 'id', 'missing']) {
      const initial = overview()
      initial.consumers = []
      initial.models = mode === 'alias' ? initial.models.map(model => ({ ...model, alias: `Catalog ${model.id}` })) : []
      initial.defaults = mode === 'missing' ? { chat: null, image: null } : {
        chat: { provider: 'pengbao', model: 'chat-model', ...(mode !== 'id' ? { name: '<Chat & name>' } : {}), ...(mode === 'alias' ? { alias: '<Chat & alias>' } : {}) },
        image: { id: 'image-model', ...(mode !== 'id' ? { name: '<Image & name>' } : {}), ...(mode === 'alias' ? { alias: '<Image & alias>' } : {}) }
      }
      const app = mount({ language, initial })
      await app.settle()
      for (const capability of ['chat', 'image']) {
        const expected = mode === 'missing' ? app.t('noDefault') : mode === 'id' ? `${capability}-model` : `<${capability === 'chat' ? 'Chat' : 'Image'} & ${mode}>`
        const field = app.elements(node => node.props['data-testid'] === `model-service-${capability}-default`)
        assert.equal(field.length, 1)
        assert.equal(app.text(field[0]), `${app.t(`${capability}Default`)}: ${expected}`)
      }
      assert.equal(app.elements(node => node.type === 'select' || node.type === 'input').length, 0)
      const toggles = app.elements(node => node.props['data-testid'] === 'model-service-image-models-toggle')
      assert.equal(toggles.length, 1)
      assert.equal(app.elements(node => node.props['data-testid'] === 'model-service-image-models').length, 0, 'models stay collapsed until requested')
      toggles[0].props.onClick()
      app.render()
      assert.equal(app.elements(node => node.props['data-testid'] === 'model-service-image-models').flatMap(node => node.props.children).length, mode === 'alias' ? 2 : 0)
      if (mode === 'alias') assert.deepEqual(app.elements(node => node.props['data-testid'] === 'model-service-image-models').flatMap(node => node.props.children).map(node => node.props.children), ['Catalog image-model', 'Catalog image-model-two'])
      assert.equal(app.html().includes('pengbao-default-chat'), false)
      assert.equal(app.html().includes('pengbao-default-image'), false)
      assert.equal(app.html().includes('parametersLegacy'), false)
      assert.equal(app.html().includes('Image parameters'), false)
      assert.equal(app.html().includes('图片参数'), false)
      const order = app.elements(node => ['model-service-chat-card', 'model-service-image-card', 'plugin-configuration-assistant'].includes(node.props['data-testid'])).map(node => node.props['data-testid'])
      assert.deepEqual(order, ['model-service-chat-card', 'model-service-image-card', 'plugin-configuration-assistant'])
      assert.deepEqual(app.elements(node => node.type === 'button').map(app.text), [app.t('refresh'), app.t('viewAllModels'), app.t('hideModels'), app.t('assistantRefresh'), app.t('assistantAnalyze')])
      assert.equal(/Server selected|由服务器选择|Preview changes|预览变更/.test(app.html()), false)
      assert.deepEqual(app.calls.filter(call => !call.endpoint.startsWith('configuration.')).map(call => call.endpoint), ['overview'])
      app.dispose()
    }
  }
})

test('refresh updates displayed server defaults without planning a change', async () => {
  let initial = overview()
  const app = mount({ request(endpoint, payload, next) { return endpoint === 'overview' ? initial : next(endpoint, payload) } })
  await app.settle()
  initial = { ...initial, defaults: { chat: { provider: 'pengbao', model: 'new-chat', name: 'New chat alias' }, image: { id: 'new-image', name: 'New image alias' } } }
  await app.button('refresh').props.onClick()
  await app.settle()
  assert.equal(app.elements(node => node.props['data-testid'] === 'model-service-chat-default').map(app.text).join(''), 'Chat default model: New chat alias')
  assert.equal(app.elements(node => node.props['data-testid'] === 'model-service-image-default').map(app.text).join(''), 'Image default model: New image alias')
  assert.deepEqual(app.calls.filter(call => !call.endpoint.startsWith('configuration.')).map(call => call.endpoint), ['overview', 'overview'])
  app.dispose()
})

const assistantPlugins = () => [
  { entryId: 'fixture-provider', packageName: 'fixture-provider', packageVersion: '1.2.3', supported: true, reason: 'available' },
  { entryId: 'unsupported', packageName: 'unsupported-plugin', packageVersion: '0.1.0', supported: false, reason: 'unsupported-schema' }
]

for (const language of ['en', 'zh']) {
  test(`assistant reviews escaped host preview and requires explicit ${language} confirmation`, async () => {
    const app = mount({ language, plugins: assistantPlugins() })
    await app.settle()
    assert.equal(app.elements(node => node.props['data-testid'] === 'plugin-configuration-assistant').length, 1)
    const select = app.elements(node => node.type === 'select')[0]
    assert.equal(select.props.value, 'fixture-provider')
    assert.equal(app.elements(node => node.type === 'option' && node.props.value === 'unsupported')[0].props.disabled, true)
    assert.equal(app.calls.find(call => call.endpoint === 'configuration.inventory').options.method, 'GET')
    await app.button('assistantAnalyze').props.onClick()
    await app.settle()
    assert.equal(app.elements(node => node.props['data-testid'] === 'plugin-configuration-preview').length, 1)
    assert.equal(app.elements(node => node.props.role === 'dialog').length, 0, 'assistant uses in-place review, not an unfocused dialog')
    assert.ok(app.html().includes('Pengbao gateway'))
    assert.ok(app.html().includes('••••••••'))
    assert.ok(app.html().includes('&lt;actual-model-id&gt;'))
    assert.equal(app.button('assistantSave').props.disabled, true)
    await app.button('assistantSave').props.onClick()
    assert.equal(app.calls.some(call => call.endpoint === 'configuration.apply'), false)
    app.elements(node => node.type === 'input' && node.props.type === 'checkbox')[0].props.onChange({ target: { checked: true } })
    app.render()
    assert.equal(app.button('assistantSave').props.disabled, false)
    await app.button('assistantSave').props.onClick()
    await app.settle()
    assert.ok(app.html().includes(app.t('assistantSaved')))
    assert.deepEqual(app.calls.find(call => call.endpoint === 'configuration.analyze').payload, { entryId: 'fixture-provider' })
    assert.deepEqual(app.calls.find(call => call.endpoint === 'configuration.apply').payload, { planId: 'assistant-plan-1' })
    assert.equal(app.elements(node => node.props['data-testid'] === 'plugin-configuration-preview').length, 0)
    await app.button('assistantRollback').props.onClick()
    await app.settle()
    assert.deepEqual(app.calls.find(call => call.endpoint === 'configuration.rollback').payload, { receiptId: 'assistant-receipt-1' })
    assert.ok(app.html().includes(app.t('assistantRolledBack')))
    assert.ok(app.calls.filter(call => call.endpoint.startsWith('configuration.')).every(call => call.url.startsWith('/api/model-service.configuration.') && call.options.credentials === 'same-origin' && call.options.cache === 'no-store'))
    app.dispose()
  })
}

test('assistant cancels pending analysis and ignores late output', async () => {
  const pending = deferred()
  const app = mount({ plugins: assistantPlugins(), request(endpoint, payload, next) {
    return endpoint === 'configuration.analyze' ? pending.promise : next(endpoint, payload)
  } })
  await app.settle()
  app.button('assistantAnalyze').props.onClick()
  app.render()
  assert.ok(app.html().includes(app.t('assistantAnalyzing')))
  const analyzing = app.calls.find(call => call.endpoint === 'configuration.analyze')
  await app.button('assistantCancel').props.onClick()
  await app.settle()
  assert.equal(analyzing.options.signal.aborted, true)
  assert.deepEqual(app.calls.find(call => call.endpoint === 'configuration.cancel').payload, {})
  pending.resolve({ planId: 'late', entryId: 'fixture-provider', writes: [], expiresAt: Date.now() + 60_000 })
  await app.settle()
  assert.equal(app.elements(node => node.props['data-testid'] === 'plugin-configuration-preview').length, 0)
  assert.equal(app.calls.some(call => call.endpoint === 'configuration.apply'), false)
  assert.equal(app.button('assistantAnalyze').props.disabled, false)
  app.dispose()
})

test('assistant aborts requests and cancels the host analysis on unmount', async () => {
  const pending = deferred()
  const app = mount({ plugins: assistantPlugins(), request(endpoint, payload, next) {
    return endpoint === 'configuration.analyze' ? pending.promise : next(endpoint, payload)
  } })
  await app.settle()
  app.button('assistantAnalyze').props.onClick()
  const analyzing = app.calls.find(call => call.endpoint === 'configuration.analyze')
  app.dispose()
  assert.equal(analyzing.options.signal.aborted, true)
  assert.deepEqual(app.calls.find(call => call.endpoint === 'configuration.cancel').payload, {})
  pending.resolve({})
  await app.settle()
  assert.equal(app.calls.some(call => call.endpoint === 'configuration.apply'), false)
})

test('assistant shows empty inventory and localized loading failures with retry', async () => {
  const empty = mount()
  await empty.settle()
  assert.ok(empty.html().includes(empty.t('assistantEmpty')))
  assert.equal(empty.button('assistantAnalyze').props.disabled, true)
  empty.dispose()
  let failed = true
  const app = mount({ plugins: assistantPlugins(), request(endpoint, payload, next) {
    return endpoint === 'configuration.inventory' && failed ? Response.json({}, { status: 503 }) : next(endpoint, payload)
  } })
  await app.settle()
  assert.ok(app.html().includes(app.t('assistantInventoryFailed')))
  failed = false
  await app.button('assistantRefresh').props.onClick()
  await app.settle()
  assert.equal(app.button('assistantAnalyze').props.disabled, false)
  assert.equal(app.html().includes(app.t('assistantInventoryFailed')), false)
  app.dispose()
})

test('assistant refuses expired plans and never sends renderer-supplied writes', async () => {
  const app = mount({ plugins: assistantPlugins(), request(endpoint, payload, next) {
    const result = next(endpoint, payload)
    return endpoint === 'configuration.analyze' ? { ...result, expiresAt: Date.now() - 1 } : result
  } })
  await app.settle()
  await app.button('assistantAnalyze').props.onClick()
  await app.settle()
  app.elements(node => node.type === 'input')[0].props.onChange({ target: { checked: true } })
  app.render()
  await app.button('assistantSave').props.onClick()
  await app.settle()
  assert.ok(app.html().includes(app.t('assistantExpired')))
  assert.equal(app.calls.some(call => call.endpoint === 'configuration.apply'), false)
  app.dispose()
})

test('assistant keeps verification failure distinct from saved-active and offers receipt rollback', async () => {
  const app = mount({ plugins: assistantPlugins(), request(endpoint, payload, next) {
    return endpoint === 'configuration.apply' || endpoint === 'configuration.rollback'
      ? { status: 'verification-failed', receiptId: 'failed-receipt' } : next(endpoint, payload)
  } })
  await app.settle()
  await app.button('assistantAnalyze').props.onClick()
  await app.settle()
  app.elements(node => node.type === 'input')[0].props.onChange({ target: { checked: true } })
  app.render()
  await app.button('assistantSave').props.onClick()
  await app.settle()
  assert.ok(app.html().includes(app.t('assistantVerificationFailed')))
  assert.equal(app.html().includes(app.t('assistantSaved')), false)
  await app.button('assistantRollback').props.onClick()
  await app.settle()
  assert.ok(app.html().includes(app.t('assistantVerificationFailed')))
  assert.equal(app.html().includes(app.t('assistantRolledBack')), false)
  assert.deepEqual(app.calls.find(call => call.endpoint === 'configuration.rollback').payload, { receiptId: 'failed-receipt' })
  app.dispose()
})

test('assistant reports each host-side apply failure with its own message', async () => {
  const cases = [['FORBIDDEN', 'assistantNotApproved'], ['RECOVERY_REQUIRED', 'assistantRecoveryRequired'],
    ['PLAN_EXPIRED', 'assistantExpired'], ['VERIFICATION_FAILED', 'assistantVerificationFailed']]
  for (const [code, key] of cases) {
    const app = mount({ plugins: assistantPlugins(), request(endpoint, payload, next) {
      return endpoint === 'configuration.apply' ? Response.json({ code }, { status: 409 }) : next(endpoint, payload)
    } })
    await app.settle()
    await app.button('assistantAnalyze').props.onClick()
    await app.settle()
    app.elements(node => node.type === 'input')[0].props.onChange({ target: { checked: true } })
    app.render()
    await app.button('assistantSave').props.onClick()
    await app.settle()
    assert.ok(app.html().includes(app.t(key)), `expected ${key} for ${code}`)
    assert.equal(app.html().includes(app.t('assistantFailed')), false, `unexpected generic message for ${code}`)
    app.dispose()
  }
})

test('assistant review cancel never applies and remains available when the overview fails', async () => {
  const app = mount({ plugins: assistantPlugins(), request(endpoint, payload, next) {
    return endpoint === 'overview' ? Response.json({}, { status: 503 }) : next(endpoint, payload)
  } })
  await app.settle()
  assert.ok(app.html().includes(app.t('unavailable')))
  await app.button('assistantAnalyze').props.onClick()
  await app.settle()
  await app.button('assistantCancel').props.onClick()
  await app.settle()
  assert.equal(app.calls.some(call => call.endpoint === 'configuration.apply'), false)
  assert.equal(app.elements(node => node.props['data-testid'] === 'plugin-configuration-preview').length, 0)
  app.dispose()
})

test('server-only image catalog stays informational and video never offers a connection', async () => {
  const initial = overview()
  initial.imageSelection = 'server-only'
  initial.imageCatalogStatus = 'models-unavailable'
  const app = mount({ initial })
  await app.settle()
  assert.equal(app.elements(node => node.type === 'select').length, 0)
  assert.equal(app.html().includes('默认模型由鹏宝服务器管理'), false)
  assert.equal(app.html().includes('Defaults are managed by the Pengbao server'), false)
  assert.ok(app.html().includes(app.t('imageModelsUnavailable')))
  assert.equal(app.elements(node => node.props['data-testid'] === 'model-service-image-default').map(app.text).join(''), 'Image default model: Image')
  assert.equal(app.html().includes('Server selected'), false)

  assert.equal(app.elements(node => node.type === 'button' && /video/i.test(app.text(node))).length, 0)
  app.dispose()
})
