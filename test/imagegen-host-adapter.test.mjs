import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
// Extraction tests can validate staged patch inputs without modifying installed dependencies.
const inputLib = process.env.DSH_IMAGEGEN_TEST_LIB ?? fileURLToPath(new URL('../node_modules/@dickpy/dsh-imagegen/lib/', import.meta.url))
const {
  generateWithHost,
  enhanceWithHost,
  hostImageActive,
  hostImageModel,
  hostPromptActive,
  hostDescriptor,
  hostChannel
} = await import(pathToFileURL(join(inputLib, 'host-adapter.js')).href)
// Full runtime coverage requires the installed patch; staging runs only extract owned functions.
const { ImageGenerationRuntime, makeRoutes } = process.env.DSH_IMAGEGEN_TEST_LIB ? {} : await import('../node_modules/@dickpy/dsh-imagegen/lib/index.js')

test('desktop image seam validates managed request and returns plugin image result', async () => {
  const calls = []
  const channel = {
    status: async () => ({ ready: true }),
    generate: async (request, signal) => {
      calls.push({ request, signal })
      return { b64: 'ZmFrZQ==', mime: 'image/png' }
    }
  }
  const signal = new AbortController().signal
  const result = await generateWithHost(channel, {
    mode: 'text', prompt: 'a red kite', model: 'desktop-managed', size: 'auto',
    quality: 'auto', n: 1, detail: ''
  }, signal)
  assert.deepEqual(result, { images: [{ b64: 'ZmFrZQ==', mime: 'image/png' }] })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].signal, signal)
  await assert.rejects(() => generateWithHost(channel, {
    mode: 'edit', prompt: 'edit', model: 'desktop-managed', size: 'auto',
    quality: 'auto', n: 1, detail: '', image: 'data:image/png;base64,ZmFrZQ=='
  }), /supports text generation/)
  await assert.rejects(() => generateWithHost(channel, {
    mode: 'text', prompt: 'two', model: 'desktop-managed', size: 'auto',
    quality: 'auto', n: 2, detail: ''
  }), /supports text generation/)
})

test('desktop prompt seam preserves mode and forwards cancellation signal', async () => {
  const calls = []
  const signal = new AbortController().signal
  const host = {
    prompt: {
      status: async () => ({ ready: true }),
      enhance: async (request, forwarded) => {
        calls.push({ request, signal: forwarded })
        return `expanded: ${request.prompt}`
      }
    }
  }
  assert.equal(await enhanceWithHost(host, { prompt: 'blue room', mode: 'polish' }, signal), 'expanded: blue room')
  assert.deepEqual(calls[0].request, { prompt: 'blue room', mode: 'polish' })
  assert.equal(calls[0].signal, signal)
})

test('host inheritance only applies with no explicit custom settings', () => {
  const host = { image: {}, prompt: {} }
  assert.equal(hostImageActive({}, host), true)
  assert.equal(hostImageActive({ channels: [{ id: 'custom' }] }, host), false)
  assert.equal(hostImageActive({ desktopImageMode: 'custom' }, host), false)
  assert.equal(hostPromptActive({}, host), true)
  assert.equal(hostPromptActive({ promptModel: 'custom-model' }, host), false)
  assert.equal(hostPromptActive({ desktopPromptMode: 'off' }, host), false)
})

test.skipIf(!!process.env.DSH_IMAGEGEN_TEST_LIB)('runtime queue uses instance managed generator and original history append', async () => {
  const appended = []
  let generated = 0
  const channel = { id: 'desktop-managed', name: 'Desktop image', managed: true,
    status: async () => ({ ready: true }), generate: async () => {
      generated += 1
      return { b64: 'ZmFrZQ==', mime: 'image/png' }
    }
  }
  const runtime = new ImageGenerationRuntime(() => ({ channels: [channel], defaultChannelId: channel.id }), {
    append: async entry => { appended.push(entry); return entry }
  })
  const finished = new Promise(resolve => {
    const dispose = runtime.queue.subscribe(task => {
      if (task.status === 'completed' || task.status === 'failed') { dispose(); resolve(task) }
    })
  })
  runtime.queue.submit({ mode: 'text', prompt: 'test', model: channel.name,
    channelId: channel.id, channel: channel.name, size: 'auto', quality: 'auto', detail: '', n: 1 })
  const task = await finished
  assert.equal(task.status, 'completed')
  assert.equal(generated, 1)
  assert.equal(appended.length, 1)
  assert.equal(appended[0].channelId, channel.id)
  assert.equal(task.result.history.id, appended[0].id)
})

test.skipIf(!!process.env.DSH_IMAGEGEN_TEST_LIB)('host-managed update routes refuse before fetching or installing', async () => {
  let status
  let result
  const routes = makeRoutes({ resolve: () => ({ apiUrl: '', apiKey: '' }), settings: {}, resolveHost: async () => ({}) })
  const req = { method: 'POST', headers: { host: 'localhost:1234' }, socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]() { throw new Error('managed update must not consume request/install input') }
  }
  const res = { writeHead(value) { status = value }, end(value) { result = JSON.parse(value) } }
  for (const path of ['/api/dsh-imagegen/update/check', '/api/dsh-imagegen/update/apply']) {
    await routes.find(route => route.path === path).handler(req, res)
    assert.equal(status, 200)
    assert.equal(result.code, 'host-managed')
    assert.equal(result.ok, false)
  }
})

test('shipped client suppresses automatic updater only for managed host', async () => {
  const marker = 'if (scope.getSnapshot().host !== void 0) return;'
  const guard = client.indexOf(marker)
  const start = client.lastIndexOf('(0, react.useEffect)(() => {', guard)
  const end = client.indexOf('}, [api]);', guard) + '}, [api]);'.length
  assert.ok(guard > 0 && end > start)
  let checks = 0
  let timers = 0
  let visibility = 0
  const execute = host => runInNewContext(client.slice(start, end), {
    react: { useEffect: effect => effect() },
    scope: { getSnapshot: () => ({ host }) },
    api: { updateCheck: async () => { checks += 1; return { updateAvailable: false } } },
    setUpdate() {}, setUpdateOpen() {}, UPDATE_CHECK_INTERVAL_MS: 100,
    window: { setInterval() { timers += 1 }, clearInterval() {} },
    document: { addEventListener() { visibility += 1 }, removeEventListener() {} }
  })
  execute({})
  assert.equal(checks, 0)
  assert.equal(timers, 0)
  execute(undefined)
  assert.equal(checks, 1)
  assert.equal(timers, 1)
  assert.equal(visibility, 1)
  await Promise.resolve()
})

const client = readFileSync(join(inputLib, 'client.js'), 'utf8')
function shippedClientFunction(name, nextName, globals = {}) {
  const start = client.indexOf(`function ${name}(`)
  const end = client.indexOf(`function ${nextName}(`, start)
  assert.ok(start >= 0 && end > start)
  return runInNewContext(`(${client.slice(start, end).trim()})`, globals)
}

const choiceFromConfig = shippedClientFunction('managedModelChoice', 'saveManagedModelChoice')
function projectStudio() {
  return shippedClientFunction('studioHostConfig', 'useConfig', { managedModelChoice: choiceFromConfig })
}

test('managed preference is isolated from custom settings and rejects malformed IDs', () => {
  const host = { image: { label: 'Current Friendly Name' } }
  for (const id of [undefined, '', 'image-b', 'removed-model', 'Current Friendly Name', 'Pengbao / Server default']) {
    const config = { desktopImageModelId: id }
    assert.equal(hostImageActive(config, host), true)
    assert.equal(hostImageModel(config, host), choiceFromConfig(config))
    assert.equal(hostImageModel(config, host), id || 'desktop-managed')
  }
  for (const id of [null, 7, {}, ' image-b', 'image-b ', 'bad\nmodel', 'x'.repeat(257), 'desktop-managed']) {
    assert.ok(hostImageModel({ desktopImageModelId: id }, host).startsWith('\u0000'))
    assert.equal(choiceFromConfig({ desktopImageModelId: id }), hostImageModel({ desktopImageModelId: id }, host))
  }
  assert.equal(hostImageActive({ desktopImageModelId: 'image-b', defaultModel: 'custom' }, host), false)
  assert.equal(projectStudio()({ value: { desktopImageModelId: 'removed-model' }, host: { image: { ...host.image, id: 'desktop-managed', active: true } } }).defaultModel, 'removed-model')
  assert.equal(projectStudio()({ value: { desktopImageModelId: 'image-b', defaultModel: 'custom' }, host: { image: { ...host.image, active: false } } }).defaultModel, 'custom')
})

test('managed picker writes only dedicated IDs and exposes save failures', async () => {
  const save = shippedClientFunction('saveManagedModelChoice', 'studioHostConfig', { managedModelChoice: choiceFromConfig })
  const operations = []
  let tail = Promise.resolve()
  const scope = { mutateOps(ops) { const task = tail.then(() => { operations.push(JSON.parse(JSON.stringify(ops))) }); tail = task; return task } }
  const image = { active: true, id: 'desktop-managed', models: [
    { alias: 'desktop-managed', id: 'desktop-managed', name: 'Current Image' }, { alias: 'image-b', id: 'image-b', name: 'Image B' }
  ] }
  await Promise.all(['image-b', 'desktop-managed', 'image-b'].map(model => save(scope, { channelId: image.id, model }, image)))
  assert.deepEqual(operations.map(ops => ops[0]), [
    { op: 'set', path: ['desktopImageModelId'], value: 'image-b' },
    { op: 'set', path: ['desktopImageModelId'], value: '' },
    { op: 'set', path: ['desktopImageModelId'], value: 'image-b' }
  ])
  await save(scope, { channelId: 'custom', model: 'image-b' }, image)
  assert.equal(operations.length, 3)
  await assert.rejects(save(scope, { channelId: image.id, model: 'removed' }, image), /unavailable/)
  await assert.rejects(save({ mutateOps: () => Promise.reject(new Error('save failed')) }, { channelId: image.id, model: 'image-b' }, image), /save failed/)
})

test('shipped picker preserves stale managed IDs instead of silently choosing the default', () => {
  const resolve = shippedClientFunction('resolveModelChoice', 'modelChoiceLabel')
  const groups = [{ id: 'desktop-managed', models: ['desktop-managed'] }]
  assert.equal(resolve(groups, { channelId: 'desktop-managed', model: 'removed-model' }).model, 'removed-model')
  assert.equal(resolve([], { channelId: 'desktop-managed', model: 'removed-model' }).model, 'removed-model')
  assert.equal(resolve(groups, undefined).model, 'desktop-managed')
  assert.equal(resolve([{ id: 'custom', models: ['first'] }], { channelId: 'custom', model: 'removed-model' }).model, 'first')
  const marker = 'if (config?.host?.image?.active && modelChannelId === "desktop-managed" && model !== "") return;'
  const guard = client.indexOf(marker)
  const start = client.lastIndexOf('(0, react.useEffect)(() => {', guard)
  const end = client.indexOf('const filteredGallery', guard)
  assert.ok(guard > start && start > 0 && end > guard)
  let changed = false
  runInNewContext(client.slice(start, end).trim(), {
    react: { useEffect: effect => effect() }, modelChannelId: 'desktop-managed', model: 'removed-model',
    modeGroups: groups, defaultModel: undefined, config: { host: { image: { active: true } } },
    setModel() { changed = true }, setModelChannelId() { changed = true }
  })
  assert.equal(changed, false)
})

test('managed selection hydrates once without writing and keeps stale persisted IDs', () => {
  const marker = 'if (config?.host?.image?.active && modelChannelId === "desktop-managed" && model !== "") return;'
  const guard = client.indexOf(marker)
  const start = client.lastIndexOf('(0, react.useEffect)(() => {', guard)
  const end = client.indexOf('const filteredGallery', guard)
  const resolve = shippedClientFunction('resolveModelChoice', 'modelChoiceLabel')
  for (const id of ['', 'image-b', 'removed-model', '\ninvalid']) {
    let selected, channel
    const config = { desktopImageModelId: id, host: { image: { id: 'desktop-managed', active: true } } }
    runInNewContext(client.slice(start, end), {
      react: { useEffect: effect => effect() }, modelChannelId: '', model: '', config,
      modeGroups: [{ id: 'desktop-managed', models: ['desktop-managed', 'image-b'] }],
      modeModels: ['desktop-managed', 'image-b'], defaultModel: 'desktop-managed', defaultChannelId: 'desktop-managed',
      managedModelChoice: choiceFromConfig, resolveModelChoice: resolve,
      setModel(value) { selected = value }, setModelChannelId(value) { channel = value },
      setCompareModels() {},
      scope: { mutateOps() { assert.fail('hydration must not write preferences') } }
    })
    assert.equal(selected, choiceFromConfig(config))
    assert.equal(channel, 'desktop-managed')
  }
})

test('managed UI blocks unsupported workflows before dispatch and leaves custom text generation available', async () => {
  const evaluateHandler = (name, next, globals) => {
    const start = client.indexOf(`const ${name} = `)
    const end = client.indexOf(next, start)
    assert.ok(start > 0 && end > start)
    return runInNewContext(`(${client.slice(start + `const ${name} = `.length, end).trim().replace(/;$/, '')})`, globals)
  }
  let blocked = 0
  const common = { config: { host: { image: { active: true } } }, setError() { blocked++ }, tt: key => key }
  evaluateHandler('openTab', 'const addEntryToCanvas', common)('edit')
  evaluateHandler('addPreviewToEdit', 'const historyPanel', common)()
  evaluateHandler('acceptEcommerceFiles', '/** Run one generation.', common)([])
  await evaluateHandler('handleGenerate', 'const handleEcommerceGenerate', { ...common, managedSelected: true, tab: 'edit' })()
  await evaluateHandler('handleEcommerceGenerate', '/** Start over', { ...common, managedEcommerceUnsupported: true })()
  assert.equal(blocked, 5)
  const start = client.indexOf('const managedEcommerceUnsupported = ')
  const end = client.indexOf('const ecommerceGenerateDisabled', start)
  const unsupported = globals => runInNewContext(`${client.slice(start, end)} managedEcommerceUnsupported`, globals)
  const valid = { managedSelected: true, quality: 'auto', detail: '', ecommerceAssets: [], ecommerceSlots: [{ key: 'detail', count: 3 }] }
  assert.equal(unsupported(valid), false)
  assert.equal(unsupported({ ...valid, ecommerceAssets: [{}] }), true)
  assert.equal(unsupported({ ...valid, quality: 'high' }), true)
  assert.equal(unsupported({ ...valid, ecommerceSlots: [{ key: 'main' }, { key: 'detail' }] }), true)
  assert.equal(unsupported({ ...valid, managedSelected: false, quality: 'high', ecommerceAssets: [{}] }), false)
})

test('shipped client renders localized host mode controls and forwards edits', () => {
  const jsx = (type, props) => ({ type, props })
  const render = shippedClientFunction('HostServiceField', 'ImageGenSettingsSection', {
    react_jsx_runtime: { jsx, jsxs: jsx }, settings_card_module_css_default: {}
  })
  let selected
  const tree = render({ kind: 'image', label: 'Default image service',
    service: { label: 'Desktop image', active: true, ready: true },
    field: { text: 'inherit' }, disabled: false, t: key => key,
    onChange: value => { selected = value }
  })
  const select = tree.props.children[0].props.children[1]
  assert.equal(select.type, 'select')
  assert.deepEqual(Array.from(select.props.children, option => option.props.value), ['inherit', 'custom', 'off'])
  assert.equal(select.props.children[0].props.children, 'settings.hostInherit')
  select.props.onChange({ target: { value: 'off' } })
  assert.equal(selected, 'off')
  assert.match(tree.props.children[1].props.children, /Desktop image.*channels.statusReady/)
  assert.equal(render({}), null)
})

test('shipped studio projection never mutates persisted settings or secrets', () => {
  const project = projectStudio()
  const value = { channels: [], channelSecrets: {}, desktopImageMode: 'inherit' }
  const host = { image: { id: 'desktop-managed', label: 'Desktop image', active: true, ready: true } }
  const projected = project({ value, host })
  assert.equal(projected.channels[0].id, 'desktop-managed')
  assert.equal(projected.channels[0].apiUrl, '')
  assert.equal(projected.channels[0].apiKey, undefined)
  assert.deepEqual(value, { channels: [], channelSecrets: {}, desktopImageMode: 'inherit' })
  assert.equal(project({ value }), value)
  assert.equal(project({ value: { ...value, desktopImageMode: 'off' }, host }).channels.length, 0)
})

test('managed projection exposes discovered models and maps aliases to exact upstream IDs', async () => {
  const calls = []
  const models = [{ alias: 'desktop-managed', id: 'desktop-managed', name: 'Friendly Image' }, { alias: 'image-b', id: 'image-b', name: 'Image B' }]
  const host = { image: { label: 'Friendly Image', models, status: async () => ({ ready: true }),
    generate: async request => { calls.push(request); return { b64: 'ZmFrZQ==', mime: 'image/png' } } },
    prompt: { label: 'obsolete', status: async () => ({ ready: true, label: 'claude-opus-5-5', secret: 'never-send' }) } }
  const view = await hostDescriptor({}, host)
  assert.deepEqual(view.image.models, models)
  assert.equal(view.prompt.label, 'claude-opus-5-5')
  assert.ok(!JSON.stringify(view).includes('never-send'))
  const project = projectStudio()
  assert.deepEqual(project({ value: {}, host: view }).channels[0].models, models)
  await generateWithHost(hostChannel(host), { mode: 'text', n: 1, model: 'desktop-managed', upstream: 'desktop-managed' })
  assert.equal(calls[0].model, 'desktop-managed')
  await generateWithHost(hostChannel(host), { mode: 'text', n: 1, model: 'image-b', upstream: 'image-b' })
  assert.equal(calls[1].model, 'image-b')
  // A display-name-equal upstream ID stays explicit even without a separate upstream field.
  await generateWithHost(hostChannel(host), { mode: 'text', n: 1, model: 'Friendly Image' })
  assert.equal(calls[2].model, 'Friendly Image')
  await generateWithHost(hostChannel(host), { mode: 'text', n: 1, model: 'desktop-managed' })
  assert.equal(calls[3].model, 'desktop-managed')
})

test('managed display names reach picker, comparison labels, title and aria without changing string identities', () => {
  const label = shippedClientFunction('modelChoiceLabel', 'ModelPicker')
  const groups = [{ id: 'desktop-managed', name: 'Actual Image', models: ['desktop-managed', 'image-a'],
    modelNames: { 'desktop-managed': 'Actual Image', 'image-a': 'Actual Image (image-a)' } }]
  assert.equal(label(groups[0], 'desktop-managed'), 'Actual Image')
  assert.equal(label(groups[0], 'image-a'), 'Actual Image (image-a)')
  assert.equal(label({ models: ['custom'] }, 'custom'), 'custom')
  assert.equal(label({ modelNames: { custom: 'unsafe\nname' } }, 'custom'), 'custom')
  const jsx = (type, props) => ({ type, props })
  const render = shippedClientFunction('ModelPicker', 'FlowBackground', {
    resolveModelChoice: shippedClientFunction('resolveModelChoice', 'modelChoiceLabel'), modelChoiceLabel: label,
    react: { useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}], useRef: () => ({ current: null }), useEffect() {} },
    react_jsx_runtime: { jsx, jsxs: jsx }, model_picker_module_css_default: {}
  })
  const tree = render({ groups, value: { channelId: 'desktop-managed', model: 'desktop-managed' }, ariaLabel: 'Image model', emptyLabel: 'Empty' })
  const trigger = tree.props.children[0]
  assert.match(trigger.props.title, /Actual Image/)
  assert.match(trigger.props['aria-label'], /Actual Image/)
  assert.ok(!JSON.stringify(tree).includes('Server default'))
  assert.match(client, /title: modelChoiceLabel\(group, option\)/)
  assert.match(client, /"aria-label": modelChoiceLabel\(group, option\)/)
  assert.match(client, /children: modelChoiceLabel\(group, option\)/)
})

test('metadata display refresh is read-only and retains runtime naming fields', () => {
  const value = { desktopImageModelId: '' }
  const project = projectStudio()
  for (const name of ['First Image', 'Next Image']) {
    const host = { image: { active: true, id: 'desktop-managed', label: name,
      models: [{ alias: 'desktop-managed', id: 'desktop-managed', name: `${name}` }, { alias: 'current-default-id', id: 'current-default-id', name }] } }
    const config = project({ value, host })
    const optionsStart = client.indexOf('function imageModelOptions(')
    const optionsEnd = client.indexOf('//#endregion', optionsStart)
    const options = runInNewContext(`(${client.slice(optionsStart, optionsEnd).trim()})`)(config)
    assert.deepEqual(Array.from(options.groups[0].models), ['desktop-managed', 'current-default-id'])
    assert.equal(options.groups[0].modelNames['desktop-managed'], `${name}`)
    assert.equal(config.defaultModel, 'desktop-managed')
    assert.equal(config.channels[0].models[1].id, 'current-default-id')
    assert.equal(config.channels[0].models[0].name, `${name}`)
    assert.deepEqual(value, { desktopImageModelId: '' })
    const index = readFileSync(join(inputLib, 'index.js'), 'utf8')
    const start = index.indexOf('const channelsView = () => {')
    const end = index.indexOf('setStorageSyncHandler', start)
    const channelsView = runInNewContext(`${index.slice(start, end)} channelsView`, { resolve: () => ({ channels: config.channels, defaultModel: config.defaultModel }) })
    assert.equal(channelsView().channels[0].models[0].name, `${name}`)
  }
  assert.match(client, /channels.length === 0 \? state.host\?\.image\?\.active \? null/)
})

test('host descriptor rereads readiness without including credentials', async () => {
  let ready = false
  const host = { image: { label: 'Desktop image', status: async () => ({ ready, secret: 'never-send' }) } }
  assert.equal((await hostDescriptor({}, host)).image.ready, false)
  ready = true
  const view = await hostDescriptor({}, host)
  assert.equal(view.image.ready, true)
  assert.ok(!JSON.stringify(view).includes('never-send'))
})
