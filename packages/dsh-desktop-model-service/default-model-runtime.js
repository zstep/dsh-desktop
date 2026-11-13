import { identifier } from './common.js'

/** Pengbao account provider registered by the desktop model service handoff. */
const PROVIDER = 'pengbao'
const MAX_DEFAULTS = 256

function modelIds(models) {
  if (!Array.isArray(models)) return []
  const ids = []
  for (const model of models) {
    const id = typeof model === 'string' ? model : model?.id
    if (identifier(id) && !ids.includes(id)) ids.push(id)
  }
  return ids
}

function listedProvider(provider, providers) {
  if (!Array.isArray(providers)) return false
  return providers.some(item => (typeof item === 'string' ? item : item?.id) === provider)
}

function currentSelection(agentDefaultModel) {
  try {
    const value = agentDefaultModel.currentSelection()
    if (value === null || typeof value !== 'object') return undefined
    const { provider, model } = value
    return identifier(provider) && identifier(model) ? { provider, model } : undefined
  } catch { return undefined }
}

async function routable(llm, selection) {
  if (!selection || typeof llm?.listProviders !== 'function' || typeof llm?.listModels !== 'function') return false
  try {
    if (!listedProvider(selection.provider, await llm.listProviders())) return false
    return modelIds(await llm.listModels(selection.provider)).includes(selection.model)
  } catch { return false }
}

/**
 * Point the foundation default model at the account's first usable server default
 * when the current selection cannot be routed (for example, the base composition
 * default from a provider this account has no credential for). A valid selection
 * from any routable provider is preserved, and no catalog-order fallback is used.
 */
export async function initializeDefaultModel({ llm, agentDefaultModel } = {}, serverDefaultModels) {
  if (!agentDefaultModel || typeof agentDefaultModel.saveSelection !== 'function') return undefined
  if (!Array.isArray(serverDefaultModels)) return undefined
  const current = currentSelection(agentDefaultModel)
  if (await routable(llm, current)) return current
  const defaults = [...new Set(serverDefaultModels.filter(identifier))].slice(0, MAX_DEFAULTS)
  if (!defaults.length) return undefined
  let models
  try { models = modelIds(await llm.listModels(PROVIDER)) }
  catch { return undefined }
  const model = defaults.find(id => models.includes(id))
  if (model === undefined) return undefined
  await agentDefaultModel.saveSelection({ provider: PROVIDER, model })
  return { provider: PROVIDER, model }
}