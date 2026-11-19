import { open, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { assetDirectory } from './assets.js'
import { ImageError, MAX_IMAGE_BYTES } from './provider.js'

const IMAGE_TOOLS = new Set(['image_generate', 'image_edit'])
const MAX_EVENTS = 20_000

/** Canonical immutable PNG result, shared by previews and edit admission. */
export function imageResult(content) {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length > 16384) continue
    let value
    try { value = JSON.parse(block.text) } catch { continue }
    if (value && /^[a-f0-9]{64}$/.test(value.sha256) && value.asset_id === `sha256:${value.sha256}`
      && value.workspace_path === `.workbuddy/generated-images/${value.sha256}.png` && value.media_type === 'image/png'
      && Number.isInteger(value.width) && value.width > 0 && Number.isInteger(value.height) && value.height > 0
      && Number.isInteger(value.bytes) && value.bytes > 0 && value.bytes <= MAX_IMAGE_BYTES) return value
  }
}

function referencedImage(events, sha, signal) {
  const calls = new Map()
  for (const event of events) {
    signal.throwIfAborted()
    if (event.type === 'tool/call') calls.set(event.data.callId, event.data.name)
    let result
    if (event.type === 'tool/result' && event.surfaceOp === 'append' && IMAGE_TOOLS.has(calls.get(event.data.message?.source?.callId))) result = event.data.message
    if ((event.type === 'tool/ptc-dispatch' || event.type === 'tool/code-dispatch') && IMAGE_TOOLS.has(event.data.name)) result = event.data
    if (result && !result.isError) {
      const image = imageResult(result.content)
      if (image?.sha256 === sha) return image
    }
  }
}

/** No path/URL from the caller is trusted; the session result grants one PNG. */
export async function readSessionGeneratedImage(ctx, sessionId, sha, callerSignal) {
  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 1024 || /[\u0000-\u001f\u007f]/.test(sessionId) || !/^[a-f0-9]{64}$/.test(sha ?? '')) {
    throw new ImageError('PREVIEW', 'Invalid image reference.', 400)
  }
  const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(callerSignal ? [callerSignal] : [])])
  let observation, file
  try {
    signal.throwIfAborted()
    observation = await ctx.sessionQuery.observeSession(sessionId, { signal, projectionMode: 'none' })
    signal.throwIfAborted()
    // A live observation lazily copies events. Refuse excessive history first;
    // cold-source preparation can already have replayed it inside sessionQuery.
    if (!Number.isInteger(observation.cursor) || observation.cursor >= MAX_EVENTS) throw new ImageError('PREVIEW', 'Image history exceeds the preview limit.', 413)
    const events = observation.events
    if (!Array.isArray(events) || events.length > MAX_EVENTS) throw new ImageError('PREVIEW', 'Image history exceeds the preview limit.', 413)
    const image = referencedImage(events, sha, signal)
    if (!image || !observation.header?.cwd) throw new ImageError('PREVIEW', 'Image is unavailable in this session.', 404)
    const root = await realpath(observation.header.cwd)
    const directory = await assetDirectory(root)
    const target = path.join(directory, `${sha}.png`)
    file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = await file.stat()
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES || info.size !== image.bytes || await realpath(target) !== target) throw new ImageError('PREVIEW', 'Image file is unavailable.', 404)
    const data = Buffer.alloc(info.size)
    let offset = 0
    while (offset < data.length) {
      signal.throwIfAborted()
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    signal.throwIfAborted()
    if (offset !== data.length || createHash('sha256').update(data).digest('hex') !== sha || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new ImageError('PREVIEW', 'The generated image has changed.', 404)
    return { image, data, root }
  } finally {
    try { await file?.close() } finally { observation?.[Symbol.dispose]() }
  }
}
