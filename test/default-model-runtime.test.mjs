import { describe, expect, it, vi } from 'vitest'
import { initializeDefaultModel } from '../packages/dsh-desktop-model-service/default-model-runtime.js'

function llmFixture() {
  const catalogs = new Map([
    ['pengbao', [{ id: 'server-model' }, { id: 'another-model' }]],
    ['other-provider', [{ id: 'user-model' }]]
  ])
  return {
    listProviders: () => [...catalogs.keys()].map(id => ({ id, name: id })),
    listModels: vi.fn(async provider => catalogs.get(provider) ?? [])
  }
}

describe('Pengbao default model bootstrap', () => {
  it('saves the first server-declared model that is present in the validated catalog when the selection is stale', async () => {
    const llm = llmFixture()
    const agentDefaultModel = {
      currentSelection: () => ({ provider: 'missing-provider', model: 'missing-model' }),
      saveSelection: vi.fn(async () => {})
    }

    await initializeDefaultModel({ llm, agentDefaultModel }, ['stale-server-model', 'server-model', 'another-model'])

    expect(agentDefaultModel.saveSelection).toHaveBeenCalledOnce()
    expect(agentDefaultModel.saveSelection).toHaveBeenCalledWith({ provider: 'pengbao', model: 'server-model' })
  })

  it('preserves a valid selection from another routable provider', async () => {
    const llm = llmFixture()
    const agentDefaultModel = {
      currentSelection: () => ({ provider: 'other-provider', model: 'user-model' }),
      saveSelection: vi.fn(async () => {})
    }

    await initializeDefaultModel({ llm, agentDefaultModel }, ['server-model'])

    expect(agentDefaultModel.saveSelection).not.toHaveBeenCalled()
  })

  it('does not choose an arbitrary catalog model when no server-declared model is available', async () => {
    const llm = llmFixture()
    const agentDefaultModel = {
      currentSelection: () => ({ provider: 'missing-provider', model: 'missing-model' }),
      saveSelection: vi.fn(async () => {})
    }

    await initializeDefaultModel({ llm, agentDefaultModel }, ['not-in-catalog'])

    expect(agentDefaultModel.saveSelection).not.toHaveBeenCalled()
  })

  it('keeps the saved selection after a simulated restart', async () => {
    const llm = llmFixture()
    let savedSelection = { provider: 'missing-provider', model: 'missing-model' }
    const agentDefaultModel = {
      currentSelection: () => savedSelection,
      saveSelection: vi.fn(async next => { savedSelection = { ...next } })
    }

    await initializeDefaultModel({ llm, agentDefaultModel }, ['server-model'])
    await initializeDefaultModel({ llm, agentDefaultModel }, ['server-model'])

    expect(savedSelection).toEqual({ provider: 'pengbao', model: 'server-model' })
    expect(agentDefaultModel.saveSelection).toHaveBeenCalledOnce()
  })
})
