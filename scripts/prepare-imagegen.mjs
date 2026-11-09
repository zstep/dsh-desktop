import { readFile, mkdir, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const upstream = dirname(require.resolve('@dickpy/dsh-imagegen/package.json'))
const manifest = JSON.parse(await readFile(join(upstream, 'package.json'), 'utf8'))
if (manifest.version !== '1.11.0') throw new Error('Unexpected imagegen upstream version')
const output = join(root, 'packages/dsh-desktop-imagegen/.generated')
// Remove obsolete output first: a failed preparation must not load an old client.
await rm(output, { recursive: true, force: true })
const [client, server] = await Promise.all([
  readFile(join(upstream, 'lib/client.js'), 'utf8'),
  readFile(join(upstream, 'lib/index.js'), 'utf8')
])
const adapter = await readFile(join(upstream, 'lib/host-adapter.js'), 'utf8')
if (!server.includes('applyWithHost') || !client.includes('desktopImageMode') || !client.includes('managedParameterInvalid') || !adapter.includes('safeManagedDiagnostic')) throw new Error('Managed imagegen parameter patch is missing; apply the authoritative 1.11.0 patch before prepare')
const identity = 'id: "@dickpy/dsh-imagegen"'
if (client.split(identity).length !== 2) throw new Error('Unexpected imagegen client module identity')
const generated = client.replace(identity, 'id: "dsh-desktop-imagegen"').replace(/\n\/\/# sourceMappingURL=.*(?:\n|$)/g, '\n')
await mkdir(output, { recursive: true })
await writeFile(join(output, 'client.js'), generated)
console.log('Prepared imagegen 1.11.0 Desktop client')
