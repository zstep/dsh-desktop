import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as desktop from '../packages/dsh-desktop-client-ui/index.js'

const roots = []
afterEach(async () => { for (const ctx of roots.splice(0)) await ctx.fiber.dispose() })

async function fixture() {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SystemPrompt, { personaPrefix: 'Keep the user persona.' })
  // No preset runtime is needed to exercise prompt assembly; preserve the host
  // registration seam while using the real Cordis/SystemPrompt lifecycle.
  ctx.provide('agentPresets', { register: async () => () => {} })
  const plugin = ctx.plugin(desktop)
  await plugin
  return { ctx, plugin }
}

it('adds the Pengbao product identity to the real global prompt without replacing tools or persona', async () => {
  const { ctx } = await fixture()
  ctx.systemPrompt.section({ name: 'fixture:safety', order: 500, text: 'Keep approval and sandbox boundaries.' })
  ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'fixture_tool', description: 'Fixture tool', parameters: { type: 'object' } }] }))
  const assembly = await ctx.systemPrompt.assemble()
  const prompt = renderPrompt(assembly)
  expect(prompt).toContain('你是鹏宝 AI')
  expect(prompt).toContain('Pengbao AI')
  expect(prompt).toContain('Keep the user persona.')
  expect(prompt).toContain('Keep approval and sandbox boundaries.')
  expect(assembly.tools.map(tool => tool.name)).toEqual(['fixture_tool'])
})

it('inherits product identity in agent scopes and removes it on plugin disposal without duplication on reload', async () => {
  const { ctx, plugin } = await fixture()
  const scope = createScope(ctx, { id: 'fixture-agent' })
  try {
    const identitySections = async () => (await ctx.systemPrompt.assemble({ scope })).sections.filter(section => section.text.includes('你是鹏宝 AI'))
    expect(await identitySections()).toHaveLength(1)
    await plugin.dispose()
    expect(await identitySections()).toHaveLength(0)
    await ctx.plugin(desktop)
    expect(await identitySections()).toHaveLength(1)
  } finally { await scope.dispose() }
})
