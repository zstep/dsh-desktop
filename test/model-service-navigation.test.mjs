import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

it('shares the model foundation component between the primary settings section and legacy plugins tab', () => {
  const source = readFileSync(new URL('../packages/dsh-desktop-model-service/client.js', import.meta.url), 'utf8')
  let module
  runInNewContext(source, { window: { __ModuleLoader__: { load(value) { module = value } } } })
  const plugin = module.factory(name => {
    if (name === 'react') return { createElement() {} }
    throw new Error(`Unexpected module ${name}`)
  })
  const registrations = []
  const ctx = { effect() {}, locale: { bind: () => key => key }, slots: { inject: (_name, apply) => apply(), register: (options, component) => { registrations.push({ options, component }) } } }
  plugin.apply(ctx)
  expect(registrations.map(value => [value.options.name, value.options.id])).toEqual([
    ['settings.section', 'desktop-model-service'],
    ['settings.plugins.tab', 'desktop-model-service']
  ])
  expect(registrations[0].component).toBeDefined()
  expect(registrations[1].component).toBe(registrations[0].component)
  for (const registration of registrations) expect(registration.options.inject().callApi).toBeDefined()
  expect(registrations[0].options.label()).toBe('title')
  expect(registrations[1].options.label()).toBe('legacyTitle')
  expect(source).toContain('鹏宝模型底座')
  expect(source).not.toContain('parametersLegacy')
})
