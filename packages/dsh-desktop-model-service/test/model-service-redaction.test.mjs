import test from 'node:test'
import assert from 'node:assert/strict'
import z from '@deepseek-ai/schemastery'
import { redactSecrets } from '@deepseek-ai/dsh-settings'
import { imageSettingsConflict } from '../image-settings.js'

test('real settings redaction distinguishes empty schema defaults without disclosing credentials', () => {
  const schema = z.object({ apiKey: z.string().role('secret').default('') })
  for (const [apiKey, nonempty] of [['', false], ['  ', false], ['fixture-only-private-value', true]]) {
    const redacted = redactSecrets(schema, { apiKey })
    assert.deepEqual(redacted.value, {})
    assert.deepEqual(redacted.secrets, [{ path: ['apiKey'], set: true, nonempty }])
    assert.equal(imageSettingsConflict(redacted), nonempty)
    assert.equal(JSON.stringify(redacted).includes('fixture-only-private-value'), false)
  }
})
