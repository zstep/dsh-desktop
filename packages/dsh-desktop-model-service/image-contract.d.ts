export interface ImageParameterModel {
  id: string
  maxImages: number
  qualities: ('auto' | 'low' | 'medium' | 'high')[]
  details: ('' | 'standard' | 'high')[]
}
export interface ImageParameterContract {
  contractVersion: 1
  revision: string
  models: ImageParameterModel[]
}
export interface ImageBackendDiagnostic {
  phase: 'provider-request' | 'provider-response' | 'image-fetch' | 'store'
  elapsedMs: number
  providerStatus?: number
}
export interface ImageDiagnostic {
  requestId: string
  stage: 'status' | 'catalog' | 'generation' | 'descriptor' | 'download' | 'bitmap'
  code: string
  elapsedMs: number
  upstreamStatus?: number
  backend?: ImageBackendDiagnostic
}
export const IMAGE_BATCH_BYTES: number
export const IMAGE_MAX_COUNT: number
export function parseImageParameters(value: unknown): ImageParameterContract | undefined
export function validateImageParameters(contract: unknown, modelId: string | undefined, input: {parameterContractVersion?: number; parameterRevision?: string; n?: number; quality?: string; detail?: string}): ImageParameterModel
export function imageDiagnostic(value: unknown): ImageDiagnostic | undefined
