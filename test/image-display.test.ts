// @vitest-environment jsdom
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const React = require('react')
const { act } = React
const { createRoot } = require('react-dom/client')
import { describe, expect, it, vi } from 'vitest'
import { patchPath, projectRoot } from './patch-path'

// A separate patched-copy root can validate patches without editing installed dependencies.
const bundle = (name: string, file = 'client.js') => readFile(path.join(process.env.DSH_IMAGE_TEST_ROOT || projectRoot, 'node_modules/@deepseek-ai', name, 'lib', file), 'utf8')

async function mediaHelpers() {
  const source = await bundle('dsh-client-ui-chat')
  const helpers = ['isWindowsStylePath', 'isAbsoluteWorkspacePath', 'resolveWorkspacePath', 'fileMediaUrl']
    .map(name => source.match(new RegExp(`^(\\t*)function ${name}\\([^]*?^\\1\\}`, 'm'))?.[0]).join('\n')
  return new Function(`${helpers}; return {fileMediaUrl, resolveWorkspacePath}`)() as {
    fileMediaUrl(base: string, path: string): string | undefined
    resolveWorkspacePath(cwd: string, path: string): string
  }
}

describe('desktop image transport', () => {
  it.each(['dsh-desktop://harness/', 'dsh-app://app/', 'http://127.0.0.1:43130/', 'https://example.com/prefix/'])(
    'resolves settled workspace images on %s', async base => {
      const { fileMediaUrl, resolveWorkspacePath } = await mediaHelpers()
      const file = resolveWorkspacePath('/workspace', 'generate/image/lighthouse.png')
      expect(fileMediaUrl(base, file)).toBe(new URL(`api/file?path=${encodeURIComponent(file)}`, base).href)
    })

  it.each(['dsh-desktop://harness.evil/', 'dsh-desktop://user@harness/', 'dsh-desktop://harness:123/', 'dsh-desktop://desktop/', 'file:///tmp/', 'javascript:alert(1)'])(
    'rejects unsupported file transports %s', async base => {
      expect((await mediaHelpers()).fileMediaUrl(base, '/workspace/image.png')).toBeUndefined()
    })

  it.each(['relative.png', '//server/image.png', '\\\\server\\image.png', '/workspace/bad\n.png'])(
    'retains file path restrictions for %j', async file => {
      expect((await mediaHelpers()).fileMediaUrl('dsh-desktop://harness/', file)).toBeUndefined()
    })

  it('restricts rewritten desktop sources to the authenticated file endpoint', async () => {
    const source = await bundle('dsh-client-ui-primitives', 'index.js')
    const helper = source.match(/function vocabularyImageUrl\([^]*?\n\}/)?.[0]
    const allow = new Function(`${helper}; return vocabularyImageUrl`)()
    expect(allow('dsh-desktop://harness/api/file?path=%2Fworkspace%2Fa.png')).toBe('dsh-desktop://harness/api/file?path=%2Fworkspace%2Fa.png')
    for (const url of ['dsh-desktop://harness.evil/api/file?path=x', 'dsh-desktop://user@harness/api/file?path=x', 'dsh-desktop://harness/api/other?path=x', 'file:///tmp/a.png']) expect(allow(url)).toBeUndefined()
    expect(await readFile(patchPath('@deepseek-ai/dsh-client-ui-chat'), 'utf8')).toContain('dsh-desktop://harness/')
    expect(await readFile(patchPath('@deepseek-ai/dsh-client-ui-primitives'), 'utf8')).toContain('dsh-desktop://harness/api/file?')
  })
})

it.each([false, true])('mounts the built-in generated image using the current gallery factory and revokes its preview (retry=%s)', async retry => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  const source = await readFile(path.join(projectRoot, 'packages/dsh-image-generation/client.js'), 'utf8')
  let plugin: any
  new Function('window', source)({ __ModuleLoader__: { load({ factory }: any) {
    plugin = factory((name: string) => name === 'react' ? React : {})
  } } })
  const entries: any[] = [], disposers: (() => void)[] = []
  let definition: any
  plugin.apply({
    uiConversation: { events: { register(value: any) { definition = value } } },
    locale: { register() {}, bind: () => (key: string) => key },
    effect(fn: () => any) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    slots: { inject(_name: string, fn: () => void) { fn() }, register(options: any, Component: any) { entries.push({ options, Component }) } }
  })
  const image = { sha256: 'a'.repeat(64), asset_id: `sha256:${'a'.repeat(64)}`, workspace_path: `.workbuddy/generated-images/${'a'.repeat(64)}.png`, media_type: 'image/png', bytes: 100, width: 128, height: 96 }
  const content = [{ type: 'text', text: 'saved' }, { type: 'text', text: JSON.stringify(image) }]
  const native = { type: 'tool/result', surfaceOp: 'append', data: { message: { source: { callId: 'fixture' }, content, isError: false } } }
  expect(definition.match(native)).toEqual({ id: 'call:fixture', role: 'start' })
  expect(definition.start(null, { event: native })).toEqual(image)
  expect(definition.match({ ...native, data: { message: { ...native.data.message, isError: true } } })).toBeNull()
  expect(definition.match({ ...native, surfaceOp: 'replace' })).toBeNull()
  for (const type of ['tool/ptc-dispatch', 'tool/code-dispatch']) {
    expect(definition.match({ type, data: { name: 'image_generate', subCallId: 'sub', content } })).toEqual({ id: 'dispatch:sub', role: 'start' })
    expect(definition.match({ type, data: { name: 'other_tool', subCallId: 'sub', content } })).toBeNull()
  }
  const { Component, options } = entries.find(entry => entry.options.key === 'generated-image')
  const create = vi.fn(() => 'blob:fixture-image'), revoke = vi.fn()
  vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke })
  const fetchMock = vi.fn(async (_url: string, _options: unknown) => ({ ok: true, headers: new Headers({ 'content-type': 'image/png' }), blob: async () => new Blob(['fixture'], { type: 'image/png' }) }))
  vi.stubGlobal('fetch', fetchMock)
  if (retry) fetchMock.mockRejectedValueOnce(new Error('Preview unavailable'))
  const gallery = vi.fn((_name: string, props: any) => React.createElement('img', { src: props.images[0].preview.url }))
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(React.createElement(Component, {
      node: { data: { sha256: 'a'.repeat(64), width: 128, height: 96 } },
      ...options.inject('session/fixture'), renderFactorySlot: gallery, t: (key: string) => key
    })))
    if (retry) {
      expect(container.querySelector('button')?.textContent).toBe('previewRetry')
      await act(async () => container.querySelector('button')!.click())
    }
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:fixture-image')
    expect(gallery).toHaveBeenCalledWith('conversation.images.content', {
      images: [{ preview: { url: 'blob:fixture-image', width: 128, height: 96, name: 'generatedImage' } }], align: 'start'
    })
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/image-generation.preview?session=session%2Ffixture&asset=${'a'.repeat(64)}`)
  } finally {
    await act(async () => root.unmount()); container.remove(); disposers.reverse().forEach(dispose => dispose()); vi.unstubAllGlobals()
  }
  expect(revoke).toHaveBeenCalledWith('blob:fixture-image')
})
