window.__ModuleLoader__.load({
  id: 'dsh-image-generation',
  factory: require => {
    const React = require('react')
    const { IconChevronDownOutlineRegular, Menu } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const NS = 'settings.imageGeneration'
    const zh = {
      managed: '鹏宝统一配置', managedModel: '模型由服务器选择', managedHint: '模型和服务地址由鹏宝后台管理，无需单独填写 API Key。', serviceUrl: '服务地址',
      cloudNotice: '提示词会发送到鹏宝及其配置的生图服务；生成图会保存到当前账号的云端文件，并在本地工作区保存副本。不会创建网页聊天或自动删除云端文件。',
      managedSaved: '已保存鹏宝统一配置', managedSaving: '正在保存…', refresh: '刷新服务状态', cancel: '取消',
      managed_available: '鹏宝生图可用', managed_disabled: '管理员已关闭生图服务，请联系管理员开启。', managed_forbidden: '当前账号没有生图权限，请联系管理员。',
      managed_unauthenticated: '登录已失效，请重新登录鹏宝。', managed_unavailable: '暂时无法连接鹏宝生图服务，请刷新重试。文本聊天不受影响。',
      IMAGE_DISABLED: '鹏宝生图已关闭，请联系管理员。', IMAGE_FORBIDDEN: '当前账号没有鹏宝生图权限。', IMAGE_AUTH: '请重新登录鹏宝。', IMAGE_NETWORK: '鹏宝生图暂不可用，请重试。',
      IMAGE_TIMEOUT: '鹏宝生图超时；服务器仍可能已生成并计费。', IMAGE_RESPONSE: '鹏宝返回的图片无效。', IMAGE_TOO_LARGE: '生成的图片超过 20 MiB。', IMAGE_INVALID_REQUEST: '图片描述无效。', IMAGE_BUSY: '鹏宝生图繁忙，请稍后重试。', IMAGE_REVOKED: '生图会话已结束，请重新连接。',
      effective_market: '当前使用市场版本；此开关仍仅控制内置版本偏好。', effective_disabled: '内置版本当前未生效。',
      previewLoading: '正在加载图片…', previewRetry: '重新加载图片', generatedImage: '生成的图片', title: '生图工具', description: '接入生图，有生图能力的模型', provider: '服务商', bytedance: 'Seedream', openai: 'OpenAI',
      apiKey: 'API Key', keyPlaceholder: '输入服务商的 API Key', savedKey: '输入新 Key 可替换',
      advanced: '高级设置', model: '模型 ID', baseUrl: 'API 地址',
      save: '保存', saving: '正在校验…', saved: '已保存，连接校验通过', loading: '正在读取配置…', reload: '重新读取配置', readOnly: '当前配置由管理员管理。',
      setupHint: '尚未配置。选择服务商，填写 API Key 后保存，即可在对话和 PPT 中生图。',
      configuredHint: '已保存 API Key。更换模型将沿用当前 Key；输入新 Key 可替换。',
      LOAD_FAILED: '暂时无法确认已保存的配置状态，请点击重新读取后再修改。',
      modelSelect: '生图模型', fetchModels: '获取模型', fetchingModels: '正在获取…', customModel: '自定义模型 / 接入点', emptyModels: '此 Key 的列表未返回工具支持的生图模型，可检查权限或填写自定义模型。',
      builtInEnabled: '启用内置生图工具', builtInHint: '关闭后重启 Harness，内置插件将跳过加载，可以使用市场版本。', builtInRestart: '重启 Harness 使更改生效', builtInFailed: '无法更改内置插件状态，请重试。',
      MODEL_DISCOVERY: '当前服务商使用内置模型或自定义接入点。',
      AUTH: 'API Key 无效或已过期，请检查后重新保存。', PERMISSION: '当前 Key 无权访问，请确认模型已开通及账号已完成所需认证。',
      MODEL: '无法访问所选模型，请检查模型 ID、接入点或模型开通状态。', KEY_REQUIRED: '请填写 API Key；更换服务地址后需要重新填写。',
      QUOTA: '服务商额度不足或请求受限，请检查账户后重试。', ENDPOINT: '请填写有效的 API 基础地址，例如以 /v1 或 /api/v3 结尾的 HTTPS 地址。',
      TIMEOUT: '连接超时，请检查网络后重新保存。', CONFLICT: '配置已在其他窗口更新，请重新打开此卡片后保存。',
      READ_ONLY: '当前凭据存储为只读，请联系管理员。', RESPONSE: '服务商返回了无法识别的结果，请检查 API 地址。',
      PARAMETERS: '服务商未通过连接检查，请确认 API 地址、模型 ID 及接入点配置。',
      UNAVAILABLE: '连接失败，请检查网络和 API 地址后重新保存。', CANCELLED: '校验已取消，可以重新保存。', PROVIDER_ERROR: '服务商暂时不可用，请稍后重新保存。',
    }
    const en = {
      managed: 'Pengbao unified configuration', managedModel: 'Model selected by the server', managedHint: 'Pengbao manages the model and service address. No separate API key is needed.', serviceUrl: 'Service address',
      cloudNotice: 'Prompts are sent to Pengbao and its configured image service. Generated images are saved to your account cloud files and copied to the local workspace. No web chat is created and cloud files are not automatically deleted.',
      managedSaved: 'Pengbao configuration saved', managedSaving: 'Saving…', refresh: 'Refresh service status', cancel: 'Cancel',
      managed_available: 'Pengbao image generation is available', managed_disabled: 'Image generation is disabled. Ask your administrator to enable it.', managed_forbidden: 'Your account cannot generate images. Contact your administrator.',
      managed_unauthenticated: 'Your session expired. Sign in to Pengbao again.', managed_unavailable: 'Pengbao image generation is temporarily unavailable. Refresh to retry. Text chat is unaffected.',
      IMAGE_DISABLED: 'Pengbao image generation is disabled. Contact your administrator.', IMAGE_FORBIDDEN: 'Your account cannot generate images.', IMAGE_AUTH: 'Sign in to Pengbao again.', IMAGE_NETWORK: 'Pengbao image generation is unavailable. Try again.',
      IMAGE_TIMEOUT: 'Image generation timed out; the server may still have generated and charged for the image.', IMAGE_RESPONSE: 'Pengbao returned an invalid image.', IMAGE_TOO_LARGE: 'The image exceeds 20 MiB.', IMAGE_INVALID_REQUEST: 'Invalid image description.', IMAGE_BUSY: 'Pengbao image generation is busy. Try again later.', IMAGE_REVOKED: 'The image session ended. Reconnect to try again.',
      effective_market: 'The market version is active; this switch still controls only the built-in preference.', effective_disabled: 'The built-in version is not currently active.',
      previewLoading: 'Loading image…', previewRetry: 'Reload image', generatedImage: 'Generated image', title: 'Image generation', description: 'Connect models with image generation capabilities.', provider: 'Provider', bytedance: 'Seedream', openai: 'OpenAI',
      apiKey: 'API Key', keyPlaceholder: 'Enter your provider API key', savedKey: 'Enter a new key to replace it',
      advanced: 'Advanced settings', model: 'Model ID', baseUrl: 'API URL',
      save: 'Save', saving: 'Validating…', saved: 'Saved. Connection validated.', loading: 'Loading settings…', reload: 'Reload settings', readOnly: 'These settings are managed by your administrator.',
      setupHint: 'Not configured yet. Choose a provider, enter an API key, and save to enable image generation in chat and presentations.',
      configuredHint: 'An API key is already saved. Changing the model reuses it; enter a new key only if you want to replace it.',
      LOAD_FAILED: 'Could not confirm the saved settings. Reload before making changes.',
      modelSelect: 'Image model', fetchModels: 'Fetch models', fetchingModels: 'Fetching…', customModel: 'Custom model / endpoint', emptyModels: 'No supported image models were returned. Check access or enter a custom model.',
      builtInEnabled: 'Enable built-in image generation', builtInHint: 'Restart Harness after turning this off to skip the built-in plugin and use the market version.', builtInRestart: 'Restart Harness to apply', builtInFailed: 'Could not change the built-in plugin state. Try again.',
      MODEL_DISCOVERY: 'Use a built-in model or a custom endpoint for this provider.',
      AUTH: 'The API key is invalid or expired.', PERMISSION: 'Check model access and account verification.', MODEL: 'Check the model ID, inference endpoint and model access.',
      KEY_REQUIRED: 'Enter an API key. A new API origin requires you to enter the key again.', QUOTA: 'Check provider quota and rate limits.',
      ENDPOINT: 'Enter an HTTPS API base URL, normally ending in /v1 or /api/v3.', TIMEOUT: 'The connection timed out. Check your network and save again.',
      CONFLICT: 'Settings changed in another window. Reopen this card before saving.', READ_ONLY: 'The credential store is read-only.',
      RESPONSE: 'The provider returned an invalid response. Check the API URL.', UNAVAILABLE: 'Connection failed. Check your network and API URL.',
      PARAMETERS: 'The provider did not confirm the connection check. Verify the API URL and model ID.',
      CANCELLED: 'Validation was cancelled. Save again to retry.', PROVIDER_ERROR: 'The provider is temporarily unavailable. Save again later.',
    }
    const css = `
      /* Match the Host PluginCard design contract; its component is internal. */
      @media(prefers-reduced-motion:reduce){.dshImageCard,.dshImageChevron{transition:none}}
      .dshImageCard{list-style:none;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;transition:border-color .16s,background .16s}
      .dshImageCard:hover{border-color:var(--dsw-alias-label-dimmed)}.dshImageCardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
      .dshImageHeader{appearance:none;display:flex;align-items:center;gap:12px;width:100%;padding:14px 16px;background:transparent;border:0;border-radius:12px;text-align:left;color:inherit;font:inherit;cursor:pointer}
      .dshImageHeading{display:flex;flex:1;flex-direction:column;gap:4px;min-width:0}.dshImageTitle{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
      .dshImageDescription{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
      .dshImageChevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}.dshImageHeader[aria-expanded=true] .dshImageChevron{transform:rotate(180deg)}
      .dshImageBody{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px;display:flex;flex-direction:column;gap:12px}.dshImageFields{border:0;margin:0;padding:0;display:flex;flex-direction:column;min-width:0}
      .dshImageField{display:flex;flex-direction:column;gap:6px;padding:12px 0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}.dshImageField+.dshImageField{border-top:.5px solid var(--dsw-alias-border-l2)}.dshImageField input,.dshImageSelectTrigger{box-sizing:border-box;width:100%;min-width:0;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-weight:400}
      .dshImageSelect{width:100%;min-width:0}.dshImageSelectTrigger{display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;text-align:left}.dshImageSelectValue{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.dshImageSelectTrigger:disabled{opacity:.4;cursor:default}
      .dshImageField input::placeholder{color:var(--dsw-alias-label-tertiary)}
      .dshImageAdvanced{margin-top:12px}.dshImageAdvanced summary{cursor:pointer;font-size:13px;color:var(--dsw-alias-label-secondary)}.dshImageAdvanced[open]{display:flex;flex-direction:column}
      .dshImageHint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);margin:0}.dshImageActions{border-top:.5px solid var(--dsw-alias-border-l2);display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;flex-wrap:wrap}
      .dshImageSave{appearance:none;font:inherit;font-size:13px;line-height:1.5;border:1px solid transparent;border-radius:8px;padding:5px 14px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);cursor:pointer}.dshImageSave:disabled{opacity:.4;cursor:default}
      .dshImageStatus{margin:0;font-size:12px;line-height:1.5}.dshImageError{color:var(--dsw-alias-state-error-primary)}
      .dshImageCard :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
      .dshImageHeader:focus-visible{outline-offset:-2px}.dshImageSave:focus-visible{outline-offset:1px}
      .dshImageFetch{appearance:none;align-self:flex-start;font:inherit;font-size:13px;line-height:1.5;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 14px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}.dshImageFetch:disabled{opacity:.4;cursor:default}
      .dshImageHostControl{border-bottom:.5px solid var(--dsw-alias-border-l2);padding:12px 0;display:flex;flex-direction:column;gap:8px}.dshImageHostControl label{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);cursor:pointer}.dshImageHostControl input{accent-color:var(--dsw-alias-brand-primary)}
    `
    const emptyDrafts = {
      bytedance: { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedream-4-5-251128', configured: false, validation: null, apiKey: '' },
      openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1.5', configured: false, validation: null, apiKey: '' },
    }
    const emptyCatalogs = {
      openai: { source: 'builtin', canFetch: true, models: [emptyDrafts.openai.model] },
      bytedance: { source: 'builtin', canFetch: false, models: [emptyDrafts.bytedance.model] },
    }
    function ImageSelect({ name, label, value, options, onChange, disabled }) {
      const [open, setOpen] = React.useState(false)
      const trigger = React.useRef(null)
      const labels = React.useRef(new Map())
      const id = React.useId()
      const close = restoreFocus => { setOpen(false); if (restoreFocus) trigger.current?.focus() }
      React.useEffect(() => { if (disabled) setOpen(false) }, [disabled])
      React.useEffect(() => {
        if (!open) return
        // The shared portaled Menu completes its measurement before focus moves.
        const frame = requestAnimationFrame(() => (labels.current.get(value) || labels.current.get(options[0]?.id))?.closest('button')?.focus())
        return () => cancelAnimationFrame(frame)
      }, [open])
      const keyDown = event => {
        if (disabled) return
        if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(true); return }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault(); event.stopPropagation()
        if (!open) { setOpen(true); return }
        const buttons = options.map(option => labels.current.get(option.id)?.closest('button')).filter(Boolean)
        const current = buttons.indexOf(document.activeElement)
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[index]?.focus()
      }
      return h('div', { className: 'dshImageField', onKeyDown: keyDown }, h('span', { id: `${id}-label` }, label),
        h(Menu, { open: open && !disabled, onClose: () => close(false), selectedId: value, portal: true, dense: true, className: 'dshImageSelect',
          items: options.map(option => ({ ...option, disabled, label: h('span', { ref: node => { if (node) labels.current.set(option.id, node); else labels.current.delete(option.id) } }, option.label) })),
          onSelect: selected => { if (!disabled) { close(true); onChange(selected) } },
          anchor: h('button', { ref: trigger, name, type: 'button', disabled, className: 'dshImageSelectTrigger', 'aria-labelledby': `${id}-label ${id}-value`,
            'aria-haspopup': 'menu', 'aria-expanded': open && !disabled, onClick: () => setOpen(previous => !previous) },
            h('span', { id: `${id}-value`, className: 'dshImageSelectValue' }, options.find(option => option.id === value)?.label || value), h(IconChevronDownOutlineRegular)) }))
    }
    function ImageCard({ t, callApi }) {
      const [expanded, setExpanded] = React.useState(false)
      const [saved, setSaved] = React.useState(null)
      const [drafts, setDrafts] = React.useState({})
      const [provider, setProvider] = React.useState('bytedance')
      const [status, setStatus] = React.useState('')
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(true)
      const [busy, setBusy] = React.useState(false)
      const [fetching, setFetching] = React.useState(false)
      const [catalogs, setCatalogs] = React.useState({})
      const [customModels, setCustomModels] = React.useState({})
      const [loadFailed, setLoadFailed] = React.useState(false)
      const [hostEnabled, setHostEnabled] = React.useState(null)
      const [hostEffective, setHostEffective] = React.useState(null)
      const operation = React.useRef(null)
      const [hostPending, setHostPending] = React.useState(false)
      const [hostBusy, setHostBusy] = React.useState(false)
      const [hostError, setHostError] = React.useState(false)
      const inFlight = React.useRef(false)
      const lifetime = React.useRef(null)
      const lastGood = React.useRef(null)
      const id = React.useId()
      const applySettings = result => {
        lastGood.current = result
        setSaved(result); setProvider(result.provider)
        setCatalogs({}); setCustomModels(Object.fromEntries(Object.entries(result.profiles).map(([key, value]) => [key, !result.catalogs[key].models.includes(value.model)])))
        setDrafts(Object.fromEntries(Object.entries(result.profiles).map(([key, value]) => [key, { ...value, apiKey: '' }])))
      }
      const seedDrafts = () => {
        setSaved(null)
        setCatalogs({})
        setCustomModels({})
        setDrafts(Object.fromEntries(Object.entries(emptyDrafts).map(([key, value]) => [key, { ...value }])))
      }
      const load = React.useCallback(async signal => {
        setLoading(true); setError('')
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const result = await callApi('settings', {}, signal)
            if (signal.aborted) return
            applySettings(result)
            if (!signal.aborted) {
              setLoadFailed(false)
              setLoading(false)
            }
            return
          } catch {
            if (signal.aborted) return
            if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)))
          }
        }
        if (signal.aborted) return
        if (lastGood.current) applySettings(lastGood.current)
        else seedDrafts()
        setLoadFailed(true)
        setError('LOAD_FAILED')
        setLoading(false)
      }, [callApi])
      React.useEffect(() => {
        const controller = new AbortController(); lifetime.current = controller
        void load(controller.signal)
        return () => { controller.abort(); operation.current?.abort() }
      }, [load])
      React.useEffect(() => {
        const desktop = globalThis.dshDesktop
        if (!desktop?.getBuiltInImageGenerationStatus) return
        let active = true
        void desktop.getBuiltInImageGenerationStatus().then(result => {
          if (active) { setHostEnabled(result.enabled); setHostEffective(result) }
        }, () => { if (active) setHostError(true) })
        return () => { active = false }
      }, [])
      const toggleHost = async event => {
        const enabled = event.target.checked
        setHostBusy(true); setHostError(false)
        try {
          const result = await globalThis.dshDesktop.setBuiltInImageGenerationEnabled(enabled)
          if (!result.ok) throw new Error(result.reason)
          setHostEnabled(enabled); setHostPending(result.restartRequired === true)
          if (result.restartRequired === true) window.dispatchEvent(new CustomEvent('dsh-desktop-restart-required', { detail: { source: 'image', restartRequired: true } }))
        } catch { setHostError(true) }
        finally { setHostBusy(false) }
      }
      const restartHost = async () => {
        setHostBusy(true); setHostError(false)
        try {
          const result = await globalThis.dshDesktop.restartHarness()
          if (!result.ok) setHostError(true)
        } catch { setHostError(true) }
        finally { setHostBusy(false) }
      }
      const managed = provider === 'pengbao'
      const draft = drafts[provider]
      const catalog = catalogs[provider] || saved?.catalogs[provider] || emptyCatalogs[provider]
      const writable = saved?.writable !== false && Boolean(saved) && !loadFailed
      const edit = (key, value) => {
        setDrafts(previous => ({ ...previous, [provider]: { ...previous[provider], [key]: value } }))
        if (key === 'apiKey' || key === 'baseUrl') setCatalogs(previous => ({ ...previous, [provider]: undefined }))
        setStatus(''); setError('')
      }
      const fetchModels = async () => {
        if (inFlight.current || !saved || loadFailed) return
        inFlight.current = true; setFetching(true); setError(''); setStatus('')
        const controller = new AbortController(); operation.current = controller
        const signal = AbortSignal.any([lifetime.current.signal, controller.signal])
        try {
          const result = await callApi('models', { revision: saved.revision, provider, model: draft.model || undefined, baseUrl: draft.baseUrl, apiKey: draft.apiKey }, signal)
          if (signal.aborted) return
          setCatalogs(previous => ({ ...previous, [provider]: result }))
          setCustomModels(previous => ({ ...previous, [provider]: !result.models.includes(draft.model) }))
        } catch (error) { if (!lifetime.current.signal.aborted) setError(error.code || 'UNAVAILABLE') }
        finally { inFlight.current = false; if (!lifetime.current.signal.aborted) setFetching(false) }
      }
      const save = async event => {
        event.preventDefault()
        if (inFlight.current) return
        if (!saved || loadFailed) { setError('LOAD_FAILED'); return }
        const nextKey = (draft?.apiKey || '').trim()
        const reuseKey = Boolean(draft?.configured || saved.profiles?.[provider]?.configured)
        if (!managed && !nextKey && !reuseKey) { setError('KEY_REQUIRED'); return }
        inFlight.current = true; setBusy(true); setError(''); setStatus('')
        const controller = new AbortController(); operation.current = controller
        const signal = AbortSignal.any([lifetime.current.signal, controller.signal])
        try {
          const payload = managed ? { revision: saved.revision, provider } : { revision: saved.revision, provider, model: draft.model, baseUrl: draft.baseUrl, apiKey: nextKey }
          const result = await callApi('save', payload, signal)
          if (signal.aborted) return
          applySettings(result)
          setStatus(managed ? 'managedSaved' : 'saved')
        } catch (error) { if (!lifetime.current.signal.aborted) setError(signal.aborted ? 'CANCELLED' : error.code || 'UNAVAILABLE') }
        finally { inFlight.current = false; if (!lifetime.current.signal.aborted) setBusy(false) }
      }
      const refreshManaged = async () => {
        if (inFlight.current) return
        inFlight.current = true; setFetching(true); setError('')
        const controller = new AbortController(); operation.current = controller
        const signal = AbortSignal.any([lifetime.current.signal, controller.signal])
        try {
          const result = await callApi('settings', {}, signal)
          if (signal.aborted) return
          setSaved(previous => ({ ...previous, managed: result.managed }))
        } catch (error) { if (!lifetime.current.signal.aborted) setError(signal.aborted ? 'CANCELLED' : error.code || 'IMAGE_NETWORK') }
        finally { inFlight.current = false; if (!lifetime.current.signal.aborted) setFetching(false) }
      }
      const field = (key, label, type = 'text', placeholder) => h('label', { className: 'dshImageField', key },
        t(label), h('input', { name: key, type, value: draft[key], placeholder, autoComplete: 'off', spellCheck: false, onChange: event => edit(key, event.target.value) }))
      return h('section', { className: `dshImageCard${expanded ? ' dshImageCardOpen' : ''}`, 'data-testid': 'image-generation-card' },
        h('button', { className: 'dshImageHeader', type: 'button', 'aria-expanded': expanded, 'aria-controls': `${id}-body`, onClick: () => setExpanded(value => !value) },
          h('span', { className: 'dshImageHeading' }, h('span', { className: 'dshImageTitle' }, t('title')), h('span', { className: 'dshImageDescription' }, t('description'))),
          h(IconChevronDownOutlineRegular, { className: 'dshImageChevron' })),
        expanded && h('form', { id: `${id}-body`, className: 'dshImageBody', onSubmit: save, 'aria-busy': busy || fetching || loading },
          hostEnabled !== null && h('div', { className: 'dshImageHostControl' },
            h('label', null, h('input', { type: 'checkbox', role: 'switch', checked: hostEnabled, disabled: hostBusy, onChange: toggleHost }), t('builtInEnabled')),
            h('p', { className: 'dshImageHint' }, t('builtInHint')),
            hostEffective?.effectiveSource === 'profile' && h('p', { className: 'dshImageHint' }, t('effective_market')),
            hostEffective?.effectiveSource !== 'profile' && hostEffective?.effectiveEnabled === false && h('p', { className: 'dshImageHint' }, t('effective_disabled')),
            hostPending && h('button', { className: 'dshImageFetch', type: 'button', disabled: hostBusy, onClick: restartHost }, t('builtInRestart'))),
          hostError && h('p', { className: 'dshImageStatus dshImageError', role: 'alert' }, t('builtInFailed')),
          loading ? h('p', { className: 'dshImageHint' }, t('loading')) : (managed || draft) && h(React.Fragment, null,
            !loadFailed && h('p', { className: 'dshImageHint' }, t(managed ? 'managedHint' : draft.configured ? 'configuredHint' : 'setupHint')),
            h('fieldset', { className: 'dshImageFields', disabled: busy || fetching || !writable },
              h(ImageSelect, { name: 'provider', label: t('provider'), value: provider, disabled: busy || fetching || !writable,
                options: [...(saved?.managed ? [{ id: 'pengbao', label: t('managed') }] : []), { id: 'bytedance', label: t('bytedance') }, { id: 'openai', label: t('openai') }],
                onChange: value => { setProvider(value); setStatus(''); setError('') } }),
              managed ? h(React.Fragment, null,
                h('label', { className: 'dshImageField' }, t('serviceUrl'), h('input', { name: 'serviceUrl', value: 'https://pengbao.ecombus.net', readOnly: true })),
                h('p', { className: 'dshImageHint' }, t('managedModel')),
                h('p', { className: 'dshImageHint' }, t('cloudNotice')),
                h('p', { className: 'dshImageStatus', role: 'status', 'aria-live': 'polite' }, t(`managed_${saved?.managed?.reason || 'unavailable'}`))) : h(React.Fragment, null,
              field('apiKey', 'apiKey', 'password', t(draft.configured ? 'savedKey' : 'keyPlaceholder')),
              h(ImageSelect, { name: 'model', label: t('modelSelect'), value: customModels[provider] || !catalog.models.includes(draft.model) ? '__custom__' : draft.model, disabled: busy || fetching || !writable,
                options: [...catalog.models.map(model => ({ id: model, label: model })), { id: '__custom__', label: t('customModel') }],
                onChange: value => { const custom = value === '__custom__'; setCustomModels(previous => ({ ...previous, [provider]: custom })); if (!custom) edit('model', value) } }),
              (customModels[provider] || !catalog.models.includes(draft.model)) && field('model', 'model'),
              catalog.canFetch && h('button', { className: 'dshImageFetch', type: 'button', disabled: !(draft.apiKey || '').trim() && !draft.configured, onClick: fetchModels }, t(fetching ? 'fetchingModels' : 'fetchModels')),
              catalog.source === 'provider' && catalog.models.length === 0 && h('p', { className: 'dshImageHint', role: 'status' }, t('emptyModels')),
              h('details', { className: 'dshImageAdvanced' }, h('summary', null, t('advanced')), field('baseUrl', 'baseUrl')))),
            h('div', { className: 'dshImageActions' },
              managed && h('button', { className: 'dshImageFetch', type: 'button', disabled: busy || fetching, onClick: refreshManaged }, t(fetching ? 'loading' : 'refresh')),
              (busy || fetching) && h('button', { className: 'dshImageFetch', type: 'button', onClick: () => operation.current?.abort() }, t('cancel')),
              h('button', { className: 'dshImageSave', type: 'submit', disabled: busy || fetching || !writable || (!managed && !(draft.model || '').trim()) }, t(busy ? managed ? 'managedSaving' : 'saving' : 'save')),
              error === 'LOAD_FAILED' && h('button', { className: 'dshImageFetch', type: 'button', onClick: () => load(lifetime.current.signal) }, t('reload')),
              status && h('p', { className: 'dshImageStatus', role: 'status' }, t(status))),
            saved && !saved.writable && h('p', { className: 'dshImageHint' }, t('readOnly'))),
          error && h('p', { className: 'dshImageStatus dshImageError', role: 'alert' }, t(Object.hasOwn(en, error) ? error : 'UNAVAILABLE'))))
    }
    function generatedResult(event) {
      const native = event.type === 'tool/result' && event.surfaceOp === 'append'
      const dispatched = (event.type === 'tool/ptc-dispatch' || event.type === 'tool/code-dispatch') && event.data.name === 'image_generate'
      if (!native && !dispatched) return
      const result = native ? event.data.message : event.data
      const id = native ? event.data.message?.source?.callId : event.data.subCallId
      if (!id || result?.isError || !Array.isArray(result?.content)) return
      for (const block of result.content) {
        if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length > 16384) continue
        let image
        try { image = JSON.parse(block.text) } catch { continue }
        if (image && /^[a-f0-9]{64}$/.test(image.sha256) && image.asset_id === `sha256:${image.sha256}`
          && image.workspace_path === `.workbuddy/generated-images/${image.sha256}.png` && image.media_type === 'image/png'
          && Number.isInteger(image.width) && image.width > 0 && Number.isInteger(image.height) && image.height > 0
          && Number.isInteger(image.bytes) && image.bytes > 0) return { id: `${native ? 'call' : 'dispatch'}:${id}`, image }
      }
    }
    const imageDefinition = {
      kind: 'generated-image', target: 'chat',
      match(event) { const value = generatedResult(event); return value ? { id: value.id, role: 'start' } : null },
      start(_context, match) { return generatedResult(match.event).image },
      update(context) { return context.state },
      buildViewNode(context) {
        if (!context.start || !context.state) return null
        const location = context.start.location
        // Completed images belong beside the answer, after the folded process.
        const turn = location.kind === 'turn' || location.kind === 'step' ? location.turn : undefined
        const closing = turn?.data.get('turn-tail')?.closing
        const anchorSeq = closing ? closing.finalNode.seq + 0.025 : turn?.end ? turn.end.seq - 0.25 : context.start.event.seq
        return { key: context.key, id: context.id, kind: 'generated-image', target: 'chat',
          anchorSeq, location, visibility: 'visible', data: context.state }
      },
    }
    function GeneratedImage({ node, loadImage, renderFactorySlot, t }) {
      const image = node.data
      const [url, setUrl] = React.useState(null)
      const [error, setError] = React.useState(false)
      const [attempt, setAttempt] = React.useState(0)
      React.useEffect(() => {
        const controller = new AbortController()
        let objectUrl
        setUrl(null); setError(false)
        void loadImage(image.sha256, controller.signal).then(blob => {
          if (controller.signal.aborted) return
          objectUrl = URL.createObjectURL(blob); setUrl(objectUrl)
        }, () => { if (!controller.signal.aborted) setError(true) })
        return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
      }, [loadImage, image.sha256, attempt])
      if (error) return h('button', { type: 'button', className: 'dshImageFetch', onClick: () => setAttempt(value => value + 1) }, t('previewRetry'))
      if (!url) return h('p', { className: 'dshImageHint', role: 'status' }, t('previewLoading'))
      return renderFactorySlot('conversation.images.content', { images: [{ preview: { url, width: image.width, height: image.height, name: t('generatedImage') } }], align: 'start' })
    }
    function previewLoader(sessionId) {
      return async (sha, signal) => {
        if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('Invalid image reference')
        const response = await fetch(`/api/image-generation.preview?session=${encodeURIComponent(sessionId)}&asset=${sha}`,
          { cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) })
        if (!response.ok || response.headers.get('content-type') !== 'image/png') throw new Error('Image preview unavailable')
        return response.blob()
      }
    }
    return {
      inject: ['slots', 'locale', 'uiConversation'],
      apply(ctx) {
        const callApi = async (endpoint, payload, signal) => {
          const settings = endpoint === 'settings'
          const response = await fetch(`/api/image-generation.${endpoint}`, {
            method: settings ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal,
            ...(settings ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload ?? {}) }),
          })
          const text = await response.text()
          let data
          try { data = text ? JSON.parse(text) : {} } catch {
            throw { code: endpoint === 'settings' ? 'LOAD_FAILED' : 'UNAVAILABLE' }
          }
          if (!response.ok) throw data.code ? data : { code: endpoint === 'settings' ? 'LOAD_FAILED' : 'UNAVAILABLE' }
          return data
        }
        ctx.uiConversation.events.register(imageDefinition)
        ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
          name: 'conversation.chat.node', key: 'generated-image', locale: NS,
          inject: sessionId => ({ loadImage: previewLoader(sessionId) }),
        }, GeneratedImage))
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'image-generation locale')
        ctx.effect(() => {
          const style = document.createElement('style'); style.dataset.pluginCss = 'dsh-image-generation'; style.textContent = css
          document.head.appendChild(style)
          return () => style.remove()
        }, 'image-generation styles')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab', id: 'image-generation', order: -100, locale: NS,
          label: () => t('title'),
          inject: () => ({ callApi }),
        }, ImageCard))
      },
    }
  },
})
