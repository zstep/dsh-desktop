import { ImageError } from './provider.js'
import { PENGBAO_SERVICE_URL } from './desktop-bridge.js'

export const unavailableManagedStatus = () => ({ available: false, reason: 'unavailable', serviceUrl: PENGBAO_SERVICE_URL, modelSelection: 'server-managed' })

export async function managedStatus(bridge, signal) {
  if (!bridge) return unavailableManagedStatus()
  try { return await bridge.status({ signal }) }
  catch { signal?.throwIfAborted(); return unavailableManagedStatus() }
}

export function requireManagedAvailable(status) {
  if (status.available) return
  const errors = {
    disabled: ['IMAGE_DISABLED', 'Pengbao image generation is disabled. Ask your administrator to enable it.', 403],
    forbidden: ['IMAGE_FORBIDDEN', 'Your Pengbao account cannot generate images. Contact your administrator.', 403],
    unauthenticated: ['IMAGE_AUTH', 'Sign in to Pengbao again to generate images.', 401],
    unavailable: ['IMAGE_NETWORK', 'Pengbao image generation is temporarily unavailable.', 503],
  }
  throw new ImageError(...(errors[status.reason] || errors.unavailable))
}

export function validateImageSize(size) {
  if (size === undefined) return undefined
  if (typeof size !== 'string' || !/^[1-9]\d{0,3}x[1-9]\d{0,3}$/.test(size)) throw new ImageError('SIZE', 'Enter image dimensions as width x height, up to 8192 pixels per side.')
  const dimensions = size.split('x').map(Number)
  const width = dimensions[0] ?? 0
  const height = dimensions[1] ?? 0
  if (width > 8192 || height > 8192 || width * height > 64_000_000) throw new ImageError('SIZE', 'Image dimensions exceed the 8192-pixel side or 64-megapixel limit.')
  return size
}

/** Model selection stays server-managed; size is sent only when explicitly requested. */
export function managedPrompt(args) {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  const style = typeof args.style_context === 'string' ? args.style_context.trim() : ''
  const ratio = args.aspect_ratio ?? '1:1'
  if (!['1:1', '16:9', '9:16', '4:3', '3:4'].includes(ratio)) throw new ImageError('RATIO', 'Choose a supported image aspect ratio.')
  if (args.purpose !== undefined && !['general', 'presentation', 'document', 'web', 'marketing'].includes(args.purpose)) throw new ImageError('PROMPT', 'Choose a supported image purpose.')
  validateImageSize(args.size)
  const result = [prompt, style && `Art direction: ${style}`, args.purpose && `Intended use: ${args.purpose}`, `Compose for ${ratio}. Keep important subjects inside the safe central area for cropping.`].filter(Boolean).join('\n\n')
  if (!prompt || result.length > 8000) throw new ImageError('PROMPT', 'Enter an image description of up to 8000 characters including style and composition context.')
  return result
}
