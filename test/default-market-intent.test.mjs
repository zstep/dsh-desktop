import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_MARKET_VERSION,
  prepareDefaultMarketIntent,
  readDefaultMarketIntent,
} from '../packages/dsh-desktop-market-installer/default-market.mjs'

const homes = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })

async function fixture(manifest = {}, patch = '[]\n') {
  const home = await mkdtemp(join(process.cwd(), '.tmp-default-market-'))
  homes.push(home)
  const profile = join(home, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify(manifest))
  await writeFile(join(profile, 'cordis.patch.yml'), patch)
  return { home, profile }
}

describe('default dsh-market intent', () => {
  it('queues a fresh profile at the exact verified market version', async () => {
    const f = await fixture({ dependencies: {}, dsh: { profile: { bundles: [] } } })
    const intent = await prepareDefaultMarketIntent(f.home, { fresh: true })
    expect(intent).toEqual({ version: 1, status: 'pending', versionSpec: DEFAULT_MARKET_VERSION, reason: 'fresh-profile' })
    expect(await readDefaultMarketIntent(f.profile)).toEqual(intent)
  })

  it('does not queue when market is explicitly disabled or indexes are explicitly empty', async () => {
    const disabled = await fixture({ dependencies: {}, dsh: { profile: { bundles: [] } } })
    await mkdir(join(disabled.profile, '.dsh-market'), { recursive: true })
    await writeFile(join(disabled.profile, '.dsh-market', 'state.json'), JSON.stringify({ disabled: ['dshmarket'] }))
    expect((await prepareDefaultMarketIntent(disabled.home, { fresh: true })).status).toBe('skipped')

    const empty = await fixture({ dependencies: {}, dsh: { profile: { bundles: [] } } }, '- id: plugin-market\n  config:\n    indexes: []\n')
    const intent = await prepareDefaultMarketIntent(empty.home, { fresh: true })
    expect(intent.status).toBe('skipped')
    expect(intent.reason).toBe('user-configured-indexes')
  })

  it('still queues the market when the user has custom discovery indexes', async () => {
    const f = await fixture({ dependencies: {}, dsh: { profile: { bundles: [] } } }, '- id: plugin-market\n  config:\n    indexes: [https://company.example/index.json]\n')
    expect((await prepareDefaultMarketIntent(f.home, { fresh: true })).status).toBe('pending')
  })

  it('adopts an already declared installation and never replaces it', async () => {
    const f = await fixture({ dependencies: { dshmarket: '^1.70.0' }, dsh: { profile: { bundles: ['dshmarket'] } } })
    const intent = await prepareDefaultMarketIntent(f.home, { fresh: true })
    expect(intent).toEqual({ version: 1, status: 'adopted', versionSpec: DEFAULT_MARKET_VERSION })
  })

  it('preserves an explicit uninstall tombstone across later launches', async () => {
    const f = await fixture({ dependencies: {}, dsh: { profile: { bundles: [] } } })
    await prepareDefaultMarketIntent(f.home, { fresh: true, removed: true })
    const second = await prepareDefaultMarketIntent(f.home, { fresh: true })
    expect(second.status).toBe('skipped')
    expect(second.reason).toBe('user-removed')
  })
})
