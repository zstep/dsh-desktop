import test from 'node:test'
import assert from 'node:assert/strict'
import { createModelService } from '../service.js'
import { registerModelServiceConsumers, registerModelServiceImage } from '../private.js'
import { parseImageParameters, validateImageParameters, imageDiagnostic } from '../image-contract.js'
import { safeImageGenerationError } from '../common.js'

const revision = 'a'.repeat(64)
const generationParameters = { contractVersion: 1, revision, models: [{ id: 'picture', maxImages: 4, qualities: ['auto', 'high'], details: [''] }] }
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=', 'base64')
let calls = []
let pendingBatch
let capabilities = generationParameters
registerModelServiceConsumers([{ id: 'pictures', version: '0.1.0', status: 'declared', capabilities: ['image.generate'] }])
registerModelServiceImage({
  status: async () => ({ available: true, reason: 'available' }),
  models: async () => ({ selection: 'request-local', models: [{ id: 'picture', name: 'Picture' }], defaultModel: { id: 'picture', name: 'Picture' }, generationParameters: capabilities }),
  generate: async () => PNG,
  generateMany: async (prompt, options) => { calls.push({ prompt, options }); if (pendingBatch) return pendingBatch; return { requested: options.n, images: [{ index: 0, data: PNG, mime: 'image/png' }], failures: [{ index: 1, code: 'IMAGE_UPSTREAM_TIMEOUT' }], complete: false } }
})
const create = () => createModelService({ getBindings: () => ({ pictures: { enabled: true } }) })
const options = { n: 2, quality: 'high', parameterContractVersion: 1, parameterRevision: revision }

test('strict bounded parameter contract and safe diagnostic copying', () => {
  assert.deepEqual(parseImageParameters(generationParameters), generationParameters)
  for (const malformed of [{ ...generationParameters, contractVersion: 2 }, { ...generationParameters, revision: 'unsafe' }, { ...generationParameters, models: [{ ...generationParameters.models[0], maxImages: 5 }] }]) assert.throws(() => parseImageParameters(malformed))
  assert.throws(() => validateImageParameters(generationParameters, 'picture', { ...options, quality: 'medium' }))
  const diagnostic = { requestId: `pb-${'b'.repeat(32)}`, stage: 'generation', code: 'IMAGE_TIMEOUT', elapsedMs: 123 }
  assert.deepEqual(imageDiagnostic({ ...diagnostic, jwt: 'secret' }), diagnostic)
  assert.equal(imageDiagnostic({ ...diagnostic, elapsedMs: -1 }), undefined)
})
test('scoped batch API rechecks capabilities and preserves partial results without retry', async () => {
  calls = []
  const service = create()
  try {
    const scope = service.forConsumer('pictures')
    assert.deepEqual((await scope.image.models()).generationParameters, generationParameters)
    assert.deepEqual((await scope.catalog()).imageParameters, generationParameters)
    const result = await scope.image.generateMany('fixture', options)
    assert.equal(result.complete, false)
    assert.deepEqual(result.images[0].data, PNG)
    assert.equal(result.failures[0].code, 'IMAGE_UPSTREAM_TIMEOUT')
    assert.equal(calls.length, 1)
    await assert.rejects(scope.image.generateMany('fixture', { ...options, parameterRevision: 'b'.repeat(64) }), { code: 'IMAGE_PARAMETERS_UNSUPPORTED' })
    assert.equal(calls.length, 1)
    assert.deepEqual(await scope.image.generate('legacy'), PNG)
    scope.dispose()
    await assert.rejects(scope.image.generateMany('fixture', options), { code: 'DISPOSED' })
  } finally { service.dispose() }
})
test('malformed advanced metadata does not break legacy generation', async () => {
  capabilities = { ...generationParameters, contractVersion: 2 }
  const service = create()
  try {
    const scope = service.forConsumer('pictures')
    assert.equal((await scope.image.models()).generationParameters, undefined)
    assert.deepEqual(await scope.image.generate('legacy'), PNG)
    await assert.rejects(scope.image.generateMany('fixture', options), { code: 'IMAGE_PARAMETERS_UNSUPPORTED' })
  } finally { capabilities = generationParameters; service.dispose() }
})
test('cancellation and scope revocation reject late batches without retry', async () => {
  for (const cancel of ['caller', 'scope']) {
    const service = create()
    let resolve
    pendingBatch = new Promise(done => { resolve = done })
    try {
      const scope = service.forConsumer('pictures')
      const controller = new AbortController()
      const start = calls.length
      const result = scope.image.generateMany('late', { ...options, signal: controller.signal })
      for (let turn = 0; calls.length === start && turn < 30; turn++) await new Promise(done => setImmediate(done))
      assert.equal(calls.length, start + 1)
      if (cancel === 'caller') controller.abort(); else scope.dispose()
      await assert.rejects(result, { code: cancel === 'caller' ? 'IMAGE_CANCELLED' : 'IMAGE_REVOKED' })
      resolve({ requested: 2, images: [0, 1].map(index => ({ index, data: PNG, mime: 'image/png' })), failures: [], complete: true })
      assert.equal(calls.length, start + 1)
    } finally { pendingBatch = undefined; service.dispose() }
  }
})
test('all three timeout classifications survive safe service mapping', () => {
  for (const code of ['IMAGE_TIMEOUT', 'IMAGE_UPSTREAM_TIMEOUT', 'IMAGE_TIMEOUT_UNKNOWN']) {
    const diagnostic = { requestId: `pb-${'b'.repeat(32)}`, stage: 'generation', code, elapsedMs: 123 }
    const error = safeImageGenerationError({ code, message: 'secret', diagnostic: { ...diagnostic, jwt: 'secret' } })
    assert.equal(error.code, code)
    assert.deepEqual(error.diagnostic, diagnostic)
    assert.doesNotMatch(error.message, /secret/)
  }
})
