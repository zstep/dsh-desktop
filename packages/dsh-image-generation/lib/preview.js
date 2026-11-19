import { ImageError } from './provider.js'
import { readSessionGeneratedImage } from './session-image.js'
export { imageResult } from './session-image.js'

export async function previewImage(ctx, request) {
  try {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('session')
    const sha = url.searchParams.get('asset')
    const { data } = await readSessionGeneratedImage(ctx, sessionId, sha, request.signal)
    ctx.logger.info('image-generation: preview allowed; session=%s asset=%s', sessionId, sha)
    return new Response(data, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(data.length), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline; filename="generated-image.png"' } })
  } catch (error) {
    ctx.logger.info('image-generation: preview unavailable')
    return Response.json({ code: 'PREVIEW', error: 'Image preview is unavailable.' }, { status: error instanceof ImageError && error.code === 'PREVIEW' ? error.status : 404, headers: { 'Cache-Control': 'no-store' } })
  }
}
