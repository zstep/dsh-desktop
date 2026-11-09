import { describe, expect, it } from 'vitest'
import {
  MODEL_SERVICE_CONTRACT_VERSION,
  parseModelServiceCatalog,
  readModelServiceConsumerDeclaration
} from '../src/shared/model-service'
import { planModelServiceConnection } from '../src/shared/model-service-planner'

const catalog = {
  contractVersion: MODEL_SERVICE_CONTRACT_VERSION,
  models: [
    { id: 'chat-model', name: 'Chat Model', capabilities: ['chat.completions'] },
    { id: 'vision-model', name: 'Vision Model', capabilities: ['chat.completions'], parameters: ['temperature'] },
    { id: 'image-model', name: 'Image Model', capabilities: ['image.generate'], parameters: ['size'] }
  ],
  defaults: { 'chat.completions': 'chat-model', 'image.generate': 'image-model' }
}

describe('model service contract', () => {
  it('copies valid catalog data and defaults only to models with the capability', () => {
    const parsed = parseModelServiceCatalog(catalog)
    expect(parsed).toEqual(catalog)
    expect(parsed.models).not.toBe(catalog.models)
  })

  it('rejects unknown fields, duplicate model IDs, and invalid model capability defaults', () => {
    expect(() => parseModelServiceCatalog({ ...catalog, jwt: 'secret' })).toThrow('Invalid model service catalog')
    expect(() => parseModelServiceCatalog({ ...catalog, models: [...catalog.models, catalog.models[0]] })).toThrow('Invalid model service catalog')
    expect(() => parseModelServiceCatalog({ ...catalog, defaults: { 'chat.completions': 'image-model' } })).toThrow('Invalid model service catalog')
    expect(() => parseModelServiceCatalog({ ...catalog, models: [{ ...catalog.models[0], capabilities: ['chat.completions', 'video.generate'] }] })).toThrow('Invalid model service catalog')
  })

  it('accepts only fully validated availability metadata', () => {
    const withAvailability = { ...catalog, availability: {
      chat: { available: true, reason: 'available' },
      image: { available: false, reason: 'models-unavailable' }
    } }
    expect(parseModelServiceCatalog(withAvailability).availability).toEqual(withAvailability.availability)
    expect(() => parseModelServiceCatalog({ ...withAvailability, availability: {
      ...withAvailability.availability, chat: { available: false, reason: 'available' }
    } })).toThrow('Invalid model service catalog')
    expect(() => parseModelServiceCatalog({ ...withAvailability, availability: {
      ...withAvailability.availability, image: { available: false, reason: 'unavailable', jwt: 'secret' }
    } })).toThrow('Invalid model service catalog')
  })

  it('copies bounded image parameter declarations without changing the consumer contract version', () => {
    const imageParameters = { contractVersion: 1, revision: 'a'.repeat(64), models: [{ id: 'image-model', maxImages: 4, qualities: ['auto', 'high'], details: [''] }] }
    const parsed = parseModelServiceCatalog({ ...catalog, imageParameters })
    expect(parsed.imageParameters).toEqual(imageParameters)
    expect(parsed.imageParameters).not.toBe(imageParameters)
    expect(() => parseModelServiceCatalog({ ...catalog, imageParameters: { ...imageParameters, contractVersion: 2 } })).toThrow()
  })

  it('accepts only explicit, versioned consumer declarations', () => {
    expect(readModelServiceConsumerDeclaration({ dsh: { modelService: { contractVersion: 1, capabilities: ['chat.completions'] } } }))
      .toEqual({ contractVersion: 1, capabilities: ['chat.completions'] })
    expect(readModelServiceConsumerDeclaration({ dsh: { bundle: { patch: './cordis.patch.yml' } } })).toBeUndefined()
    expect(() => readModelServiceConsumerDeclaration({ dsh: { modelService: { contractVersion: 2, capabilities: ['image.generate'] } } }))
      .toThrow('Invalid model service consumer declaration')
    expect(() => readModelServiceConsumerDeclaration({ dsh: { modelService: { contractVersion: 1, capabilities: ['chat.completions'], apiKey: 'secret' } } }))
      .toThrow('Invalid model service consumer declaration')
  })
})
