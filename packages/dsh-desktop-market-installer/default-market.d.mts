export interface DefaultMarketIntent {
  version: 1
  status: 'pending' | 'completed' | 'adopted' | 'skipped'
  versionSpec: string
  reason?: string
  application?: string
}
export const DEFAULT_MARKET_VERSION: '1.66.47'
export const MARKET_PACKAGE: 'dshmarket'
export function readDefaultMarketIntent(directory: string): Promise<DefaultMarketIntent | undefined>
export function prepareDefaultMarketIntent(home: string, options?: { fresh?: boolean; removed?: boolean }): Promise<DefaultMarketIntent>
export function markDefaultMarketInstalled(directory: string, application?: string): Promise<DefaultMarketIntent>
export function markDefaultMarketRemoved(directory: string): Promise<DefaultMarketIntent>
