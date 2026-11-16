import test from 'node:test'
import assert from 'node:assert/strict'
import z from '@deepseek-ai/schemastery'
import { validateConfigurationProposal, materializeProposal, materializedProposalModels } from '../plugin-config-analysis.js'

test('generic assistant maps video arrays and authorizes only host-owned video substitutions', () => {
  const schema = z.object({ apiUrl: z.string(), apiKey: z.string().role('secret'),
    videoModels: z.array(z.object({ alias: z.string(), id: z.string() })), defaultVideoModel: z.string(),
    imageModel: z.string() })
  const proposal = { contractVersion: 1, protocol: 'openai', capabilities: ['video.generate'], writes: [
    { path: ['apiUrl'], value: { $semantic: 'endpoint' }, evidenceIds: ['e1'] },
    { path: ['apiKey'], value: { $semantic: 'credential' }, evidenceIds: ['e1'] },
    { path: ['videoModels'], value: [{ alias: { $semantic: 'video-model' }, id: { $semantic: 'video-model' } }], evidenceIds: ['e1'] },
    { path: ['defaultVideoModel'], value: { $semantic: 'video-model' }, evidenceIds: ['e1'] }
  ] }
  const accepted = validateConfigurationProposal(proposal, schema.toJSON(), ['e1'])
  const writes = materializeProposal(accepted, { endpoint: 'http://127.0.0.1:43127/v1', credential: 'synthetic-key',
    videoModel: 'seedance-2-0', videoModels: ['seedance-2-0', 'wan3.0-video-prime'] })
  assert.deepEqual(writes[2].value, [
    { alias: 'seedance-2-0', id: 'seedance-2-0' }, { alias: 'wan3.0-video-prime', id: 'wan3.0-video-prime' }
  ])
  assert.deepEqual(materializedProposalModels(writes)['video.generate'], ['seedance-2-0', 'wan3.0-video-prime'])
  assert.throws(() => validateConfigurationProposal({ ...proposal, writes: [
    ...proposal.writes, { path: ['imageModel'], value: { $semantic: 'video-model' }, evidenceIds: ['e1'] }
  ] }, schema.toJSON(), ['e1']), { code: 'INVALID_PROPOSAL' })
})
