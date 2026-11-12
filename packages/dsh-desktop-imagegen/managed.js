import { imageDiagnostic, parseImageParameters } from 'dsh-desktop-model-service/image-contract'

const MAX_PROMPT = 8000
const MAX_OUTPUT = 16_000
// Match the existing OpenAI-compatible host translation, not a resolution guarantee.
const PIXELS = Object.freeze({ '1:1': '1024x1024', '3:4': '1024x1536', '4:3': '1536x1024', '9:16': '1024x1792', '2:3': '1024x1536', '3:2': '1536x1024', '16:9': '1792x1024', '21:9': '1792x1024' })
function imageSize(value) {
  if (value === undefined || value === 'auto') return undefined
  if (typeof value !== 'string') throw new Error('IMAGE_INVALID_REQUEST')
  if (Object.hasOwn(PIXELS, value)) return PIXELS[value]
  // OpenWebUI image APIs may use named resolution tiers such as 1K/2K/4K.
  // Keep the value intact so the configured API, not this adapter, interprets it.
  if (/^(?:1|2|4)K$/.test(value)) return value
  if (!/^\d{2,4}x\d{2,4}$/.test(value)) throw new Error('IMAGE_INVALID_REQUEST')
  const [width, height] = value.split('x').map(Number)
  if (width < 64 || height < 64 || width > 4096 || height > 4096) throw new Error('IMAGE_INVALID_REQUEST')
  return value
}
const PROMPTS = Object.freeze({
  enhance: 'You are an expert image-prompt editor. Expand the user request into one vivid, specific image-generation prompt. Preserve intent and language. Add only useful visual detail: subject, composition, lighting, materials, color, camera/style and quality. Return only the finished prompt, with no preface or markdown.',
  polish: '你是电商生图提示词编辑。请在保持图片用途、商品事实、平台、语言和原有结构不变的前提下，润色文字并补充可执行的视觉细节，减少重复和空泛表达。只输出最终提示词，不要解释、标题或 Markdown。'
})

function promptText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_PROMPT) throw new Error('IMAGE_INVALID_REQUEST')
  return value
}

function visibleText(value) {
  const closed = value.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const dangling = /<think>/i.exec(closed)
  return (dangling ? closed.slice(0, dangling.index) : closed).trim()
}

function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  throw new Error('IMAGE_RESPONSE')
}

/**
 * Instance-bound operations; no credential or endpoint is part of the contract.
 * @param {{getBridge: () => {status: () => Promise<{available: boolean, reason: string}>,
 *   models?: () => Promise<{models: {id: string, name: string}[], selection: 'request-local'|'server-only', defaultModel?: {id: string, name: string}|null, catalogStatus?: 'available'|'default-only'}>,
 *   generate: (prompt: string, options: {model?: string, size?: string, signal?: AbortSignal}) => Promise<Buffer>}|undefined,
 *   getSelection: () => {provider: string, model: string, reasoningEffort?: string},
 *   stream: (options: object) => AsyncIterable<object>,
 *   listModels?: (provider: string) => Promise<readonly {provider: string, id: string, name: string}[]>}} services
 */
export function createManagedOperations({ getBridge, getSelection, stream, listModels }) {
  let catalog = { models: [], selection: 'server-only' }
  const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim() && !/[\p{C}\p{Zl}\p{Zp}]/u.test(value)
  function imageLabel() {
    const model = catalog.defaultModel
    return identifier(model?.id) ? (identifier(model.name) ? model.name : model.id) : '默认模型名称暂不可用'
  }
  function imageModels() {
    const models = catalog.selection === 'request-local' && Array.isArray(catalog.models)
      ? [...new Map(catalog.models.filter(model => identifier(model?.id) && model.id !== 'desktop-managed').map(model => [model.id, model])).values()] : []
    const nameOf = model => identifier(model.name) ? model.name : model.id
    return [{ alias: 'desktop-managed', id: 'desktop-managed', name: imageLabel() },
      ...models.map(model => ({ alias: model.id, id: model.id,
        name: models.some(other => other.id !== model.id && nameOf(other) === nameOf(model))
          ? `${nameOf(model)} (${model.id})` : nameOf(model) }))]
  }
  function parameters(value) {
    try { return parseImageParameters(value) } catch { return undefined }
  }
  function selection() {
    try {
      const selected = getSelection()
      if (!identifier(selected?.provider) || !identifier(selected?.model)) return undefined
      return { provider: selected.provider, model: selected.model,
        ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }) }
    } catch { return undefined }
  }
  return Object.freeze({
    image: Object.freeze({
      id: 'desktop-managed',
      channelName: 'Pengbao',
      get label() { return imageLabel() },
      get models() { return imageModels() },
      async status() {
        const bridge = getBridge()
        if (!bridge) { catalog = { models: [], selection: 'server-only' }; return { ready: false, reason: 'unavailable' } }
        let status
        try { status = await bridge.status() }
        catch { catalog = { models: [], selection: 'server-only' }; return { ready: false, reason: 'unavailable' } }
        if (!status.available) { catalog = { models: [], selection: 'server-only' }; return { ready: false, reason: status.reason } }
        try {
          const discovered = bridge.models ? await bridge.models() : undefined
          catalog = { selection: discovered?.selection === 'request-local' ? 'request-local' : 'server-only',
            models: Array.isArray(discovered?.models) ? discovered.models.filter(model => identifier(model?.id)).map(model => ({ id: model.id, name: identifier(model.name) ? model.name : model.id })) : [],
            defaultModel: identifier(discovered?.defaultModel?.id) ? { id: discovered.defaultModel.id,
              name: identifier(discovered.defaultModel.name) ? discovered.defaultModel.name : discovered.defaultModel.id } : null,
            ...(['available', 'default-only'].includes(discovered?.catalogStatus) ? { catalogStatus: discovered.catalogStatus } : {}),
            ...(typeof bridge.generateMany === 'function' && parameters(discovered?.generationParameters) ? { generationParameters: parameters(discovered.generationParameters) } : {}) }
          return { ready: true, reason: catalog.selection === 'request-local' ? status.reason : 'server-only',
            label: imageLabel(), models: catalog.models, selection: catalog.selection,
            ...(identifier(catalog.defaultModel?.id) ? { defaultModel: { id: catalog.defaultModel.id,
              name: identifier(catalog.defaultModel.name) ? catalog.defaultModel.name : catalog.defaultModel.id } } : { defaultModel: null }),
            ...(['available', 'default-only'].includes(catalog.catalogStatus) ? { catalogStatus: catalog.catalogStatus } : {}),
            ...(catalog.generationParameters ? { generationParameters: catalog.generationParameters } : {}) }
        } catch {
          catalog = { models: [], selection: 'server-only' }
          // Catalog failure must not silently substitute the default for an explicit selection.
          return { ready: true, reason: 'models-unavailable', models: [], selection: 'server-only' }
        }
      },
      async generate(request, signal) {
        if (!request || typeof request !== 'object') throw new Error('IMAGE_INVALID_REQUEST')
        const prompt = promptText(request.prompt)
        if ((request.mode !== undefined && request.mode !== 'text') || request.image || request.images?.length || request.referenceImages?.length) throw new Error('IMAGE_UNSUPPORTED_OPERATION')
        const n = request.n === undefined ? 1 : request.n
        const quality = request.quality === undefined ? 'auto' : request.quality
        const detail = request.detail === undefined ? '' : request.detail
        if (!Number.isInteger(n) || n < 1 || n > 4 || typeof quality !== 'string' || quality.length > 64 || /[\p{C}\p{Zl}\p{Zp}]/u.test(quality) || typeof detail !== 'string' || detail.length > 64 || /[\p{C}\p{Zl}\p{Zp}]/u.test(detail)) throw new Error('IMAGE_INVALID_REQUEST')
        const bridge = getBridge()
        if (!bridge) throw new Error('IMAGE_REVOKED')
        const model = request.model
        if (model !== undefined && model !== 'desktop-managed' && !identifier(model)) throw new Error('IMAGE_INVALID_REQUEST')
        const size = imageSize(request.size)
        const options = { signal,
          ...(model === undefined || model === 'desktop-managed' ? {} : { model }),
          ...(size === undefined ? {} : { size }),
          // Omission is meaningful to OpenWebUI: sending the default values
          // switches the request into its versioned parameter-contract path.
          ...(quality === 'auto' ? {} : { quality }),
          ...(detail === '' ? {} : { detail }) }
        const contract = catalog.generationParameters
        const effectiveModel = model === undefined || model === 'desktop-managed' ? catalog.defaultModel?.id : model
        const capability = contract?.models.find(item => item.id === effectiveModel)
        if ((request.parameterContractVersion !== undefined || request.parameterRevision !== undefined) && (request.parameterContractVersion !== 1 || !contract || request.parameterRevision !== contract.revision)) throw new Error('IMAGE_PARAMETER_CONTRACT_STALE')
        if (typeof bridge.generateMany === 'function' && (n > 1 || quality !== 'auto' || detail !== '')) {
          const result = await bridge.generateMany(prompt, { ...options, n,
            ...(contract ? { parameterContractVersion: 1, parameterRevision: contract.revision } : {}) })
          if (!result || result.requested !== n || !Array.isArray(result.images) || !Array.isArray(result.failures) || typeof result.complete !== 'boolean'
            || result.images.length + result.failures.length !== n) throw new Error('IMAGE_RESPONSE')
          const indexes = new Set()
          let total = 0
          const validIndex = index => Number.isInteger(index) && index >= 0 && index < n && !indexes.has(index) && indexes.add(index)
          const images = result.images.map(image => {
            if (!validIndex(image?.index) || !(image.data instanceof Uint8Array) || image.data.length > 20 * 1024 * 1024) throw new Error('IMAGE_RESPONSE')
            const bytes = Buffer.from(image.data)
            total += bytes.length
            if (total > 64 * 1024 * 1024 || imageMime(bytes) !== image.mime) throw new Error('IMAGE_RESPONSE')
            return { index: image.index, b64: bytes.toString('base64'), mime: image.mime }
          })
          const failures = result.failures.map(failure => {
            if (!validIndex(failure?.index) || typeof failure.code !== 'string' || !/^IMAGE_[A-Z0-9_]{1,64}$/.test(failure.code)) throw new Error('IMAGE_RESPONSE')
            const diagnostic = imageDiagnostic(failure.diagnostic)
            return { index: failure.index, code: failure.code,
              ...(diagnostic?.code === failure.code ? { diagnostic } : {}) }
          })
          if (result.complete !== (images.length === n && failures.length === 0)) throw new Error('IMAGE_RESPONSE')
          return { requested: n, images, failures, complete: result.complete }
        }
        if (n !== 1 || quality !== 'auto' || detail !== '') throw new Error('IMAGE_UNSUPPORTED_OPERATION')
        const bytes = await bridge.generate(prompt, options)
        if (!(bytes instanceof Uint8Array) || bytes.length > 20 * 1024 * 1024) throw new Error('IMAGE_RESPONSE')
        const buffer = Buffer.from(bytes)
        return { b64: buffer.toString('base64'), mime: imageMime(buffer) }
      }
    }),
    prompt: Object.freeze({
      get label() { return selection()?.model ?? '—' },
      async models() {
        const selected = selection()
        if (!selected || !listModels) throw new Error('IMAGE_PROMPT_MODEL_UNAVAILABLE')
        let timer
        try {
          const models = await Promise.race([
            Promise.resolve().then(() => listModels(selected.provider)),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('IMAGE_PROMPT_MODELS_UNAVAILABLE')), 10_000) })
          ])
          if (!Array.isArray(models)) throw new Error('IMAGE_PROMPT_MODELS_UNAVAILABLE')
          return [...new Set(models.filter(model => model?.provider === selected.provider && identifier(model.id)).map(model => model.id))]
        } catch { throw new Error('IMAGE_PROMPT_MODELS_UNAVAILABLE') }
        finally { clearTimeout(timer) }
      },
      async status() {
        const selected = selection()
        let label = selected?.model ?? '—'
        if (selected && listModels) {
          let timer
          try {
            // Catalogs are advisory: a slow or failed lookup must not block status.
            const models = await Promise.race([
              Promise.resolve().then(() => listModels(selected.provider)),
              new Promise(resolve => { timer = setTimeout(() => resolve([]), 1000) })
            ])
            const model = Array.isArray(models) ? models.find(entry => entry?.provider === selected.provider && entry?.id === selected.model) : undefined
            if (identifier(model?.name)) label = model.name
          } catch { /* Keep the validated raw ID, never provider error details. */ }
          finally { clearTimeout(timer) }
        }
        return { ready: selected !== undefined, reason: 'default-model', label,
          ...(selected ? { provider: selected.provider, model: selected.model } : {}) }
      },
      async enhance({ prompt, mode }, requestSignal) {
        promptText(prompt)
        if (mode !== undefined && mode !== 'enhance' && mode !== 'polish') throw new Error('IMAGE_INVALID_REQUEST')
        const selected = selection()
        if (!selected) throw new Error('IMAGE_PROMPT_MODEL_UNAVAILABLE')
        const signal = AbortSignal.any([AbortSignal.timeout(60_000), ...(requestSignal ? [requestSignal] : [])])
        let text = ''
        let stopped = false
        try {
          for await (const chunk of stream({
            provider: selected.provider, model: selected.model,
            ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
            system: mode === 'polish' ? PROMPTS.polish : PROMPTS.enhance,
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
            tools: [], temperature: mode === 'polish' ? 0.35 : 0.7, maxTokens: 4096, signal
          })) {
            signal.throwIfAborted()
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
              text += chunk.text
              if (text.length > MAX_OUTPUT) throw new Error('IMAGE_PROMPT_TOO_LARGE')
            }
            if (chunk.type === 'finish') {
              if (chunk.reason?.kind !== 'stop') throw new Error('IMAGE_PROMPT_FAILED')
              stopped = true
            }
          }
          signal.throwIfAborted()
          const answer = visibleText(text)
          if (!stopped || !answer) throw new Error('IMAGE_PROMPT_FAILED')
          return answer
        } catch (error) {
          if (signal.aborted) throw new Error('IMAGE_PROMPT_CANCELLED')
          // Provider errors may contain request bodies or credentials. Keep the
          // public failure stable instead of reflecting arbitrary error text.
          if (error instanceof Error && error.message === 'IMAGE_PROMPT_TOO_LARGE') throw error
          throw new Error('IMAGE_PROMPT_FAILED')
        }
      }
    })
  })
}
