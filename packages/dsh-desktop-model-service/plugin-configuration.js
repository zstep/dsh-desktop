import { randomUUID } from 'node:crypto'
import { collectPluginEvidence, listConfigurablePlugins, analyzePluginConfiguration, materializeProposal } from './plugin-config-analysis.js'
import { configurationDigest, getPluginConfigurationRuntime, pluginConfigurationReference,
  readPluginConfigurations, writePluginConfigurations } from './plugin-configuration-runtime.js'

const TTL = 10 * 60_000
const clone = value => structuredClone(value)
const equal = (left, right) => configurationDigest(left) === configurationDigest(right)
/** Loader reports an absent config as undefined; the raw layer stores {} for it. */
const configOf = entry => entry.options.config ?? {}
const fail = code => { throw Object.assign(new Error(code), { code }) }
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const badKeys = new Set(['__proto__', 'constructor', 'prototype', '__jsExpr'])

function writeValue(config, write) {
  const { path, value, append } = write
  let cursor = config
  for (const [index, key] of path.entries()) {
    if (badKeys.has(key)) fail('INVALID_CONFIGURATION')
    const last = index === path.length - 1
    if (!cursor || typeof cursor !== 'object') fail('INVALID_CONFIGURATION')
    if (Array.isArray(cursor) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) > cursor.length)) fail('INVALID_CONFIGURATION')
    if (last) cursor[key] = clone(value)
    else {
      // An append write creates its array container when the plugin has no
      // stored configuration for it; other missing containers stay objects.
      if (!Object.hasOwn(cursor, key)) cursor[key] = append && index + 1 === path.length - 1 ? [] : {}
      cursor = cursor[key]
    }
  }
}
function candidateConfig(current, writes) {
  const next = clone(current)
  if (!plain(next)) fail('INVALID_CONFIGURATION')
  for (const write of writes) writeValue(next, write)
  if (Buffer.byteLength(JSON.stringify(next)) > 1024 * 1024) fail('INVALID_CONFIGURATION')
  return next
}
function catalogSnapshot(catalog) {
  return { defaults: catalog.defaults, imageDefaultModel: catalog.imageDefaultModel,
    imageSelection: catalog.imageSelection, models: catalog.models.map(({ id, name, capabilities }) => ({ id, name, capabilities })) }
}
function hostValues(catalog, bindingId, current) {
  const chatModel = catalog.defaults?.['chat.completions']
  const imageModel = catalog.defaults?.['image.generate']
  if (!chatModel) fail('MODEL_UNAVAILABLE')
  const values = { bindingId, current, chatModel, label: 'Pengbao',
    endpoint: pluginConfigurationReference(bindingId, 'endpoint'),
    credential: pluginConfigurationReference(bindingId, 'credential') }
  // Materialization validates values as bounded JSON, where an undefined
  // property is invalid. A chat-only catalog legitimately has no image default,
  // and an image proposal is already rejected above as MODEL_UNAVAILABLE, so
  // the key is simply absent instead of explicitly undefined.
  if (imageModel !== undefined) values.imageModel = imageModel
  return values
}
function publicValue(value, bindingId) {
  if (value === pluginConfigurationReference(bindingId, 'credential')) return '••••••••'
  if (value === pluginConfigurationReference(bindingId, 'endpoint')) return 'Pengbao gateway'
  if (Array.isArray(value)) return value.map(child => publicValue(child, bindingId))
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, publicValue(child, bindingId)]))
  return value
}

/** Full ConfigEditor transactions. No live configuration is returned over the wire. */
export function createPluginConfigurationController(ctx, service) {
  const plans = new Map()
  const receipts = new Map()
  let analysis
  let generation = 0
  let disposed = false
  let queue = Promise.resolve()
  const profileDir = ctx.profileContext.dir
  const runtime = () => getPluginConfigurationRuntime(ctx) ?? fail('UNAVAILABLE')
  const serial = work => { const task = queue.then(work); queue = task.catch(() => {}); return task }
  const prune = map => { for (const [id, item] of map) if (item.expiresAt < Date.now()) map.delete(id) }
  const take = (map, id) => { prune(map); const item = map.get(id); if (!item) fail('PLAN_EXPIRED'); return item }
  const rowFor = async entryId => {
    const rows = (await ctx.configEditor.configuration()).filter(row => row.entry.options.id === entryId)
    if (rows.length !== 1 || rows[0].entry.disabled || rows[0].entry.fiber?.state !== 2) fail('PLUGIN_UNAVAILABLE')
    return rows[0]
  }
  const assertLive = () => { if (disposed) fail('UNAVAILABLE') }
  return Object.freeze({
    async inventory() {
      assertLive()
      const plugins = await listConfigurablePlugins(ctx)
      return { plugins, available: !!getPluginConfigurationRuntime(ctx) }
    },
    async analyze(input) {
      assertLive()
      if (!exact(input, ['entryId']) || typeof input.entryId !== 'string' || input.entryId.length > 128) fail('INVALID_REQUEST')
      runtime()
      analysis?.abort()
      const controller = new AbortController()
      analysis = controller
      const epoch = ++generation
      plans.clear()
      const current = () => { assertLive(); controller.signal.throwIfAborted(); if (generation !== epoch) fail('ANALYSIS_CANCELLED') }
      try {
        const row = await rowFor(input.entryId)
        const raw = clone(row.entry.options.config ?? {})
        const evidence = await collectPluginEvidence(ctx, input.entryId)
        const catalog = await service.catalog({ signal: controller.signal })
        current()
        const proposal = await analyzePluginConfiguration(ctx, evidence, { signal: controller.signal,
          selection: { provider: 'pengbao', model: catalog.defaults?.['chat.completions'] } })
        current()
        const bindingId = randomUUID()
        const values = hostValues(catalog, bindingId, raw)
        if (proposal.capabilities.includes('image.generate') && (!values.imageModel || catalog.imageSelection !== 'request-local')) fail('MODEL_UNAVAILABLE')
        const writes = materializeProposal(proposal, values)
        const candidate = candidateConfig(raw, writes)
        const planId = randomUUID()
        const identity = { bindingId, entryId: input.entryId, namespace: input.entryId, packageName: evidence.identity.packageName,
          packageVersion: evidence.identity.packageVersion, revision: evidence.revision, schemaDigest: evidence.identity.schemaDigest, evidenceDigest: evidence.identity.evidenceDigest }
        const policy = { bindingId, entryId: input.entryId, packageName: identity.packageName, packageVersion: identity.packageVersion,
          capabilities: [...proposal.capabilities], models: [...new Set(proposal.capabilities.map(scope => scope === 'chat.completions' ? values.chatModel : values.imageModel))] }
        const plan = { planId, entry: row.entry, identity, policy, evidence, raw, candidate,
          catalog: catalogSnapshot(catalog), expiresAt: Date.now() + TTL }
        plans.set(planId, plan)
        return { planId, entryId: input.entryId, packageName: identity.packageName, packageVersion: identity.packageVersion,
          expiresAt: plan.expiresAt, capabilities: [...proposal.capabilities],
          writes: writes.map(write => ({ path: [...write.path], value: publicValue(write.value, bindingId) })) }
      } finally { if (analysis === controller) analysis = undefined }
    },
    cancel(input) {
      if (!exact(input, [])) fail('INVALID_REQUEST')
      generation++
      analysis?.abort()
      plans.clear()
      return { status: 'cancelled' }
    },
    apply(input) {
      return serial(async () => {
        assertLive()
        if (!exact(input, ['planId']) || typeof input.planId !== 'string') fail('INVALID_REQUEST')
        const plan = take(plans, input.planId)
        plans.delete(input.planId)
        const row = await rowFor(plan.identity.entryId)
        const fresh = await collectPluginEvidence(ctx, plan.identity.entryId)
        const catalog = await service.catalog()
        if (row.entry !== plan.entry || !equal(configOf(row.entry), plan.raw) || fresh.revision !== plan.identity.revision
          || fresh.identity.schemaDigest !== plan.identity.schemaDigest || fresh.identity.evidenceDigest !== plan.identity.evidenceDigest
          || !equal(catalogSnapshot(catalog), plan.catalog)) fail('CONFLICT')
        assertLive()
        const beforeBindings = await readPluginConfigurations(profileDir)
        if (beforeBindings.some(item => item.identity?.entryId === plan.identity.entryId)) fail('CONFLICT')
        const record = { identity: plan.identity, policy: plan.policy, files: plan.evidence.identity.files,
          configDigest: configurationDigest(plan.raw) }
        let approvalStaged = false
        let activationStaged = false
        try {
          await writePluginConfigurations(profileDir, [...beforeBindings, record])
          approvalStaged = true
          await runtime().activate(record, configurationDigest(plan.candidate))
          activationStaged = true
          assertLive()
          await ctx.configEditor.edit(row.entry, current => {
            assertLive()
            if (!equal(current, plan.raw)) fail('CONFLICT')
            return clone(plan.candidate)
          })
          const after = await rowFor(plan.identity.entryId)
          if (!equal(configOf(after.entry), plan.candidate)) fail('VERIFICATION_FAILED')
          await writePluginConfigurations(profileDir, [...beforeBindings, { ...record, configDigest: configurationDigest(plan.candidate) }])
          prune(receipts)
          if (receipts.size >= 32) receipts.delete(receipts.keys().next().value)
          const receiptId = randomUUID()
          receipts.set(receiptId, { ...plan, entry: after.entry, beforeBindings, expiresAt: Date.now() + TTL })
          return { status: 'saved-active', receiptId }
        } catch (error) {
          // Recovery can replace the surfaced code; keep the original classification in a
          // fixed-vocabulary diagnostic so a masked cause stays traceable without values.
          const original = typeof error?.code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(error.code) ? error.code : 'ERROR'
          let recoveryFailed = false
          try {
            const live = await rowFor(plan.identity.entryId)
            if (equal(configOf(live.entry), plan.candidate)) {
              await ctx.configEditor.edit(live.entry, current => {
                if (!equal(current, plan.candidate)) fail('CONFLICT')
                return clone(plan.raw)
              })
            } else if (!equal(configOf(live.entry), plan.raw)) recoveryFailed = true
          } catch { recoveryFailed = true }
          if (recoveryFailed) throw Object.assign(new Error('RECOVERY_REQUIRED'), { code: 'RECOVERY_REQUIRED', detail: original })
          if (approvalStaged) {
            try { await writePluginConfigurations(profileDir, beforeBindings) }
            catch { fail('RECOVERY_REQUIRED') }
          }
          if (activationStaged) {
            try { await runtime().deactivate(plan.identity.bindingId) }
            catch { fail('RECOVERY_REQUIRED') }
          }
          throw error
        }
      })
    },
    rollback(input) {
      return serial(async () => {
        assertLive()
        if (!exact(input, ['receiptId']) || typeof input.receiptId !== 'string') fail('INVALID_REQUEST')
        const receipt = take(receipts, input.receiptId)
        const row = await rowFor(receipt.identity.entryId)
        const evidence = await collectPluginEvidence(ctx, receipt.identity.entryId)
        if (row.entry !== receipt.entry || evidence.identity.evidenceDigest !== receipt.identity.evidenceDigest
          || !equal(configOf(row.entry), receipt.candidate)) fail('CONFLICT')
        const bindings = await readPluginConfigurations(profileDir)
        const approved = bindings.find(item => item.identity?.bindingId === receipt.identity.bindingId)
        if (!approved || approved.configDigest !== configurationDigest(receipt.candidate)) fail('CONFLICT')
        let configChanged = false
        let bindingsRemoved = false
        try {
          await ctx.configEditor.edit(row.entry, current => {
            assertLive()
            if (!equal(current, receipt.candidate)) fail('CONFLICT')
            return clone(receipt.raw)
          })
          configChanged = true
          const after = await rowFor(receipt.identity.entryId)
          if (!equal(configOf(after.entry), receipt.raw)) fail('VERIFICATION_FAILED')
          await writePluginConfigurations(profileDir, bindings.filter(item => item.identity.bindingId !== receipt.identity.bindingId))
          bindingsRemoved = true
          await runtime().deactivate(receipt.identity.bindingId)
          receipts.delete(input.receiptId)
          return { status: 'rolled-back' }
        } catch (error) {
          if (bindingsRemoved) {
            try { await writePluginConfigurations(profileDir, bindings) }
            catch { fail('RECOVERY_REQUIRED') }
          }
          let recoveryFailed = false
          try {
            const live = await rowFor(receipt.identity.entryId)
            if (configChanged || !equal(configOf(live.entry), receipt.candidate)) {
              if (equal(configOf(live.entry), receipt.raw)) {
                await ctx.configEditor.edit(live.entry, current => {
                  if (!equal(current, receipt.raw)) fail('CONFLICT')
                  return clone(receipt.candidate)
                })
              } else if (!equal(configOf(live.entry), receipt.candidate)) recoveryFailed = true
            }
          } catch { recoveryFailed = true }
          if (recoveryFailed) fail('RECOVERY_REQUIRED')
          throw error
        }
      })
    },
    dispose() { disposed = true; generation++; analysis?.abort(); plans.clear(); receipts.clear() }
  })
}

async function readInput(request, origin) {
  if (request.headers.get('origin') && request.headers.get('origin') !== origin) fail('FORBIDDEN')
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
    || request.headers.has('content-encoding') || !request.body) fail('INVALID_REQUEST')
  const reader = request.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 4096) fail('INVALID_REQUEST')
      chunks.push(value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { fail('INVALID_REQUEST') }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export function setupPluginConfiguration(ctx, service) {
  const controller = createPluginConfigurationController(ctx, service)
  for (const action of ['inventory', 'analyze', 'cancel', 'apply', 'rollback']) {
    ctx.connection.fetch.register({ path: `/api/model-service.configuration.${action}`, methods: [action === 'inventory' ? 'GET' : 'POST'], requestBody: 'buffered',
      async fetch(request) {
        try {
          const origin = ctx.webServer.getOrigin()
          if (request.headers.get('origin') && request.headers.get('origin') !== origin) fail('FORBIDDEN')
          const result = await controller[action](action === 'inventory' ? undefined : await readInput(request, origin))
          return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
        } catch (error) {
          const allowed = ['INVALID_REQUEST', 'FORBIDDEN', 'CONFLICT', 'UNAVAILABLE', 'PLAN_EXPIRED', 'PLUGIN_UNAVAILABLE', 'MODEL_UNAVAILABLE',
            'ANALYSIS_UNAVAILABLE', 'ANALYSIS_CANCELLED', 'ANALYSIS_TIMEOUT', 'ANALYSIS_LIMIT', 'INVALID_PROPOSAL', 'ANALYSIS_FAILED', 'VERIFICATION_FAILED', 'RECOVERY_REQUIRED']
          const code = error?.name === 'AbortError' ? 'ANALYSIS_CANCELLED' : allowed.includes(error?.code) ? error.code : 'UNAVAILABLE'
          // Diagnostics only: the client wire still carries an opaque code. Keep the raw internal
          // code in the log so a collapsed UNAVAILABLE can be traced without exposing any values.
          const detail = typeof error?.detail === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(error.detail) ? ` [${error.detail}]` : ''
          console.warn(`[model-service] configuration.${action} failed: ${code}${error?.code && error.code !== code ? ` (${error.code})` : ''}${detail}`)
          // Only a host approval denial may carry a fixed-vocabulary reason to the client.
          const rejection = code === 'FORBIDDEN' && typeof error?.detail === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(error.detail) ? error.detail : undefined
          return Response.json({ code, ...(rejection ? { detail: rejection } : {}) }, { status: code === 'INVALID_REQUEST' ? 400 : code === 'FORBIDDEN' ? 403 : 409,
            headers: { 'Cache-Control': 'no-store' } })
        }
      } })
  }
  ctx.effect(() => () => controller.dispose(), 'plugin configuration assistant')
  return controller
}
