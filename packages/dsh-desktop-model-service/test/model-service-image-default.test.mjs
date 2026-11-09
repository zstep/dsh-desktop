import test from 'node:test'
import assert from 'node:assert/strict'
import { createModelService } from '../service.js'
import { registerModelServiceConsumers, registerModelServiceImage } from '../private.js'

registerModelServiceConsumers([{ id: 'image-consumer', version: '1.0.0', status: 'declared', capabilities: ['image.generate'] }])
let selection = 'request-local'
const calls = []
registerModelServiceImage({
  status: async () => ({ available: true, reason: 'available' }),
  models: async () => ({ selection, models: selection === 'request-local' ? [{ id: 'server-model', name: 'Server' }, { id: 'saved-model', name: 'Saved' }] : [], defaultModel: { id: 'server-model', name: 'Server' } }),
  generate: async (prompt, options) => { calls.push({ prompt, model: options.model }); return Buffer.from([1, 2, 3]) }
})

const create = () => createModelService({ getBindings: () => ({ 'image-consumer': { enabled: true } }) })

test('image server metadata supplies the request-local default', async () => {
  const service = create()
  const scope = service.forConsumer('image-consumer')
  const catalog = await scope.catalog()
  assert.equal(catalog.defaults['image.generate'], 'server-model')
  await scope.image.generate('fixture')
  assert.equal(calls.at(-1).model, undefined)
  await scope.image.generate('explicit', { model: 'saved-model' })
  assert.equal(calls.at(-1).model, 'saved-model')
  service.dispose()
})

test('server-only image metadata remains display-only and never becomes a selectable model', async () => {
  selection = 'server-only'
  const service = create()
  const catalog = await service.catalog()
  assert.equal(catalog.imageDefaultModel.id, 'server-model')
  assert.equal(catalog.defaults['image.generate'], undefined)
  const scope = service.forConsumer('image-consumer')
  await scope.image.generate('fixture')
  assert.equal(calls.at(-1).model, undefined)
  await assert.rejects(scope.image.generate('explicit', { model: 'server-model' }), { code: 'UNSUPPORTED' })
  service.dispose()
  selection = 'request-local'
})
