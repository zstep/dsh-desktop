import { describe, expect, it, vi } from 'vitest'
import { createManagedOperations } from '../packages/dsh-desktop-imagegen/managed.js'

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function fixture(listModels) {
  let selection = { provider: 'pengbao', model: 'chat-a', reasoningEffort: 'medium' }
  const generate = vi.fn(async () => png)
  const stream = vi.fn(async function* (options) {
    yield { type: 'text-delta', text: 'A vivid ' }
    yield { type: 'reasoning-delta', text: 'hidden' }
    yield { type: 'text-delta', text: '<think>private</think>flower' }
    yield { type: 'finish', reason: { kind: 'stop' } }
    expect(options.messages[0].content[0].text).toBe('prompt')
  })
  const bridge = { status: vi.fn(async () => ({ available: true, reason: 'available' })), generate }
  const host = createManagedOperations({ getBridge: () => bridge, getSelection: () => selection, stream, listModels })
  return { host, bridge, generate, stream, setSelection(value) { selection = value } }
}

describe('Desktop imagegen managed operations', () => {
  it('uses only the bound server-default image operation and never enhances generation', async () => {
    const { host, bridge, generate, stream } = fixture()
    expect(host.image.channelName).toBe('Pengbao')
    const result = await host.image.generate({ prompt: 'blue flower', mode: 'text', size: '1024x768', n: 1, quality: 'auto', detail: '' }, new AbortController().signal)

    expect(result).toEqual({ b64: png.toString('base64'), mime: 'image/png' })
    expect(generate).toHaveBeenCalledWith('blue flower', expect.objectContaining({ size: '1024x768' }))
    expect(bridge.status).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()
  })

  it.each([
    { mode: 'edit' }, { n: 2 }, { quality: 'high' }, { detail: 'high' }, { image: 'data:image/png;base64,AA==' }
  ])('rejects unsupported managed requests before dispatch: %o', async unsupported => {
    const { host, generate } = fixture()
    await expect(host.image.generate({ prompt: 'blue flower', ...unsupported })).rejects.toThrow('IMAGE_UNSUPPORTED_OPERATION')
    expect(generate).not.toHaveBeenCalled()
  })

  it('follows the current chat selection on every explicit enhancement click', async () => {
    const { host, setSelection, stream } = fixture()
    expect(await host.prompt.status()).toMatchObject({ ready: true, label: 'chat-a', provider: 'pengbao', model: 'chat-a' })
    expect(host.prompt.label).toBe('chat-a')
    await expect(host.prompt.enhance({ prompt: 'prompt', mode: 'enhance' })).resolves.toBe('A vivid flower')
    expect(stream.mock.calls[0]?.[0]).toMatchObject({ provider: 'pengbao', model: 'chat-a', reasoningEffort: 'medium', temperature: 0.7 })

    setSelection({ provider: 'pengbao', model: 'chat-b' })
    expect(await host.prompt.status()).toMatchObject({ label: 'chat-b', model: 'chat-b' })
    expect(host.prompt.label).toBe('chat-b')
    await host.prompt.enhance({ prompt: 'prompt', mode: 'polish' })
    expect(stream.mock.calls[1]?.[0]).toMatchObject({ provider: 'pengbao', model: 'chat-b', temperature: 0.35 })
  })

  it('uses only an exact provider/model catalog name while keeping the label getter raw', async () => {
    const listModels = vi.fn(async () => [
      { provider: 'other', id: 'chat-a', name: 'Wrong provider' },
      { provider: 'pengbao', id: 'chat-a-extra', name: 'Wrong model' },
      { provider: 'pengbao', id: 'chat-a', name: 'Chat A · Friendly' }
    ])
    const { host } = fixture(listModels)
    expect(host.prompt.label).toBe('chat-a')
    expect(listModels).not.toHaveBeenCalled()
    expect(await host.prompt.status()).toMatchObject({ ready: true, label: 'Chat A · Friendly', provider: 'pengbao', model: 'chat-a' })
    expect(listModels).toHaveBeenCalledExactlyOnceWith('pengbao')
    expect(host.prompt.label).toBe('chat-a')
  })

  it.each(['', ' ', ' padded ', 'unsafe\nname', 'unsafe\u0000name', 'unsafe\u007fname', 'unsafe‮name', 'unsafe name', 'unsafe name', 'x'.repeat(257), undefined, 42])('falls back to the raw ID for unsafe catalog names: %j', async name => {
    const { host } = fixture(async () => [{ provider: 'pengbao', id: 'chat-a', name }])
    expect(await host.prompt.status()).toMatchObject({ ready: true, label: 'chat-a', model: 'chat-a' })
  })

  it.each([
    [],
    [{ provider: 'other', id: 'chat-a', name: 'Wrong provider' }],
    [{ provider: 'pengbao', id: 'chat-a-extra', name: 'Wrong model' }],
    [{ id: 'chat-a', name: 'Missing provider' }],
    undefined
  ])('falls back when the exact catalog entry is absent: %j', async models => {
    const { host } = fixture(async () => models)
    expect(await host.prompt.status()).toMatchObject({ ready: true, label: 'chat-a', model: 'chat-a' })
  })

  it.each([
    () => { throw new Error('private catalog details') },
    async () => { throw new Error('private catalog details') }
  ])('falls back without exposing catalog lookup failures', async listModels => {
    const { host } = fixture(listModels)
    expect(await host.prompt.status()).toEqual({ ready: true, reason: 'default-model', label: 'chat-a', provider: 'pengbao', model: 'chat-a' })
  })

  it('bounds catalog lookup time without delaying enhancement dispatch', async () => {
    vi.useFakeTimers()
    try {
      const listModels = vi.fn(() => new Promise(() => {}))
      const { host, stream } = fixture(listModels)
      const status = host.prompt.status()
      await expect(host.prompt.enhance({ prompt: 'prompt' })).resolves.toBe('A vivid flower')
      expect(stream).toHaveBeenCalledTimes(1)
      expect(listModels).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(await status).toMatchObject({ ready: true, label: 'chat-a', model: 'chat-a' })
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('keeps status identity and label on the detached selection captured before lookup', async () => {
    let resolveModels
    const listModels = vi.fn(() => new Promise(resolve => { resolveModels = resolve }))
    const { host, setSelection } = fixture(listModels)
    const selected = { provider: 'pengbao', model: 'chat-a' }
    setSelection(selected)
    const status = host.prompt.status()
    await Promise.resolve()
    selected.provider = 'other'
    selected.model = 'chat-b'
    resolveModels([
      { provider: 'pengbao', id: 'chat-a', name: 'Chat A' },
      { provider: 'other', id: 'chat-b', name: 'Chat B' }
    ])
    expect(await status).toMatchObject({ provider: 'pengbao', model: 'chat-a', label: 'Chat A' })
    expect(listModels).toHaveBeenCalledExactlyOnceWith('pengbao')
    expect(host.prompt.label).toBe('chat-b')
  })

  it('does not send enhancement requests when no default model is available', async () => {
    const { stream } = fixture()
    const empty = createManagedOperations({
      getBridge: () => undefined, getSelection: () => ({ provider: '', model: '' }), stream
    })
    expect(await empty.prompt.status()).toMatchObject({ ready: false })
    await expect(empty.prompt.enhance({ prompt: 'prompt' })).rejects.toThrow('IMAGE_PROMPT_MODEL_UNAVAILABLE')
    expect(stream).not.toHaveBeenCalled()
  })

  it('discovers request-local models without persisting endpoints and forwards an explicit ID', async () => {
    const { host, bridge, generate } = fixture()
    bridge.models = vi.fn(async () => ({ selection: 'request-local', models: [{ id: 'image-b', name: 'Image B' }] }))
    expect(await host.image.status()).toMatchObject({ ready: true, selection: 'request-local' })
    expect(host.image.models).toEqual([{ alias: 'desktop-managed', id: 'desktop-managed', name: '默认模型名称暂不可用' }, { alias: 'image-b', id: 'image-b', name: 'Image B' }])
    await host.image.generate({ prompt: 'bird', model: 'image-b' })
    expect(generate).toHaveBeenLastCalledWith('bird', expect.objectContaining({ model: 'image-b' }))
    await host.image.generate({ prompt: 'bird', model: 'desktop-managed' })
    expect(generate.mock.calls.at(-1)[1]).not.toHaveProperty('model')
    bridge.models.mockResolvedValue({ selection: 'server-only', models: [{ id: 'image-b', name: 'Image B' }] })
    await host.image.status()
    expect(host.image.models).toHaveLength(1)
  })

  it('lists all five configured image models and forwards each exact selection without guessing a provider', async () => {
    const ids = ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2', 'gemini-3-pro-image', 'gemini-3.1-flash-image']
    const { host, bridge, generate, stream } = fixture()
    bridge.models = vi.fn(async () => ({ selection: 'request-local', catalogStatus: 'available',
      defaultModel: { id: ids[0], name: ids[0] }, models: ids.map(id => ({ id, name: id })) }))
    expect(await host.image.status()).toMatchObject({ ready: true, label: ids[0] })
    expect(host.image.models).toEqual([
      { alias: 'desktop-managed', id: 'desktop-managed', name: ids[0] },
      ...ids.map(id => ({ alias: id, id, name: id }))
    ])
    for (const model of ids) {
      await host.image.generate({ prompt: 'fixture flower', model })
      expect(generate).toHaveBeenLastCalledWith('fixture flower', expect.objectContaining({ model }))
    }
    expect(generate).toHaveBeenCalledTimes(5)
    expect(stream).not.toHaveBeenCalled()
    await host.image.generate({ prompt: 'fixture flower', model: 'desktop-managed' })
    expect(generate.mock.calls.at(-1)[1]).not.toHaveProperty('model')
  })

  it('clears discovery after status failure and does not expose provider errors', async () => {
    const { host, bridge, generate } = fixture()
    bridge.models = async () => ({ selection: 'request-local', models: [{ id: 'image-b', name: 'Image B' }] })
    await host.image.status()
    bridge.status.mockRejectedValue(new Error('private provider details'))
    expect(await host.image.status()).toEqual({ ready: false, reason: 'unavailable' })
    expect(host.image.models).toHaveLength(1)
    expect(generate).not.toHaveBeenCalled()
  })

  it('never exposes upstream IDs that collide with the managed default', async () => {
    const { host, bridge } = fixture()
    bridge.models = async () => ({ selection: 'request-local', models: [
      { id: 'desktop-managed', name: 'Collision' }, { id: 'Pengbao / Server default', name: 'Alias collision' },
      { id: 'safe-image', name: 'Safe image' }
    ] })
    await host.image.status()
    expect(host.image.models).toEqual([
      { alias: 'desktop-managed', id: 'desktop-managed', name: '默认模型名称暂不可用' }, { alias: 'Pengbao / Server default', id: 'Pengbao / Server default', name: 'Alias collision' }, { alias: 'safe-image', id: 'safe-image', name: 'Safe image' }
    ])
  })

  it('separates actual default display from exact explicit identities across metadata refreshes', async () => {
    const { host, bridge, generate } = fixture()
    bridge.models = vi.fn(async () => ({ selection: 'request-local', catalogStatus: 'available',
      defaultModel: { id: 'image-a', name: 'Friendly Image' }, models: [
        { id: 'image-a', name: 'Friendly Image' }, { id: 'image-b', name: 'Friendly Image' },
        { id: 'Friendly Image', name: 'Other' }
      ] }))
    expect(await host.image.status()).toMatchObject({ label: 'Friendly Image', defaultModel: { id: 'image-a', name: 'Friendly Image' }, catalogStatus: 'available' })
    expect(host.image.models).toEqual([
      { alias: 'desktop-managed', id: 'desktop-managed', name: 'Friendly Image' },
      { alias: 'image-a', id: 'image-a', name: 'Friendly Image (image-a)' },
      { alias: 'image-b', id: 'image-b', name: 'Friendly Image (image-b)' },
      { alias: 'Friendly Image', id: 'Friendly Image', name: 'Other' }
    ])
    await host.image.generate({ prompt: 'bird', model: 'image-a' })
    expect(generate.mock.calls.at(-1)[1]).toHaveProperty('model', 'image-a')
    await host.image.generate({ prompt: 'bird', model: 'Friendly Image' })
    expect(generate.mock.calls.at(-1)[1]).toHaveProperty('model', 'Friendly Image')
    bridge.models.mockResolvedValue({ selection: 'request-local', defaultModel: { id: 'image-b', name: 'Next Image' }, models: [] })
    await host.image.status()
    expect(host.image.label).toBe('Next Image')
    expect(host.image.models[0]).toMatchObject({ alias: 'desktop-managed', id: 'desktop-managed', name: 'Next Image' })
    await host.image.generate({ prompt: 'bird', model: 'desktop-managed' })
    expect(generate.mock.calls.at(-1)[1]).not.toHaveProperty('model')
  })

  it.each(['bad\nname', 'x'.repeat(257), undefined])('uses a safe default ID for invalid names without guessing the first model: %j', async name => {
    const { host, bridge } = fixture()
    bridge.models = async () => ({ selection: 'request-local', defaultModel: { id: 'actual-id', name }, models: [{ id: 'first', name: 'Not the default' }] })
    await host.image.status()
    expect(host.image.label).toBe('actual-id')
    bridge.models = async () => ({ selection: 'request-local', models: [{ id: 'first', name: 'Not the default' }] })
    await host.image.status()
    expect(host.image.label).toBe('默认模型名称暂不可用')
  })

  it('captures one detached selection per enhancement and rejects malformed selections', async () => {
    let reads = 0
    const selected = { provider: 'pengbao', model: 'claude-opus-5-5', reasoningEffort: 'medium' }
    const stream = vi.fn(async function* (options) {
      selected.model = 'changed'
      expect(options.model).toBe('claude-opus-5-5')
      yield { type: 'text-delta', text: 'ready' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const listModels = vi.fn(async () => [])
    const host = createManagedOperations({ getBridge: () => undefined, getSelection: () => { reads++; return selected }, stream, listModels })
    expect(await host.prompt.enhance({ prompt: 'bird' })).toBe('ready')
    expect(reads).toBe(1)
    expect(listModels).not.toHaveBeenCalled()
    selected.model = 'bad\nmodel'
    expect(await host.prompt.status()).toMatchObject({ ready: false, label: '—' })
    expect(host.prompt.label).toBe('—')
    await expect(host.prompt.enhance({ prompt: 'bird' })).rejects.toThrow('IMAGE_PROMPT_MODEL_UNAVAILABLE')
    expect(stream).toHaveBeenCalledTimes(1)
    expect(listModels).not.toHaveBeenCalled()
  })

  it('requires a successful stop and visible nonempty text', async () => {
    const failing = createManagedOperations({
      getBridge: () => undefined, getSelection: () => ({ provider: 'p', model: 'm' }),
      stream: async function* () { yield { type: 'finish', reason: { kind: 'error' } } }
    })
    await expect(failing.prompt.enhance({ prompt: 'prompt' })).rejects.toThrow('IMAGE_PROMPT_FAILED')
  })
})
