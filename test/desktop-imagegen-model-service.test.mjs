import { beforeEach, expect, it, vi } from 'vitest'

const adapter = vi.hoisted(() => vi.fn())
vi.mock('@dickpy/dsh-imagegen', () => ({ Config: {}, applyWithHost: adapter }))
import { apply } from '../packages/dsh-desktop-imagegen/index.js'

beforeEach(() => adapter.mockReset())

it('keeps offline settings available without reviving an absent consumer grant', async () => {
  const ctx = { modelService: { forConsumer: () => { throw Object.assign(new Error('unregistered'), { code: 'CONSUMER_UNAVAILABLE' }) } },
    effect: vi.fn(), agentDefaultModel: { currentSelection: vi.fn() }, llm: {} }
  apply(ctx, {})
  const host = adapter.mock.calls[0][2]
  expect(await host.image.status()).toEqual({ ready: false, reason: 'unavailable' })
  await expect(host.image.generate({ prompt: 'fixture' })).rejects.toThrow('IMAGE_REVOKED')
  expect(ctx.effect).toHaveBeenCalledTimes(1)
})

it('does not hide unrelated service activation failures', () => {
  const ctx = { modelService: { forConsumer: () => { throw new Error('fixture failure') } } }
  expect(() => apply(ctx, {})).toThrow('fixture failure')
  expect(adapter).not.toHaveBeenCalled()
})
