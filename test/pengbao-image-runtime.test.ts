import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { expect, it } from 'vitest'
import { startPengbaoGateway } from '../src/main/enterprise/gateway'
import { HarnessRuntime } from '../src/main/runtime/harness-runtime'
import { resolveTestNodeExecutable } from './node-executable'

it('uses private managed defaults in the locked Harness and saves a sandboxed PNG across restart', async () => {
  const project = resolve(import.meta.dirname, '..')
  const home = await mkdtemp(join(tmpdir(), 'pengbao-image-runtime-'))
  const workspace = join(home, 'workspace')
  await mkdir(workspace)
  const png = await sharp({ create: { width: 128, height: 96, channels: 4, background: '#45678980' } }).png().toBuffer()
  const jwt = 'runtime-fixture-jwt-not-a-real-credential'
  const generations: unknown[] = []
  const gateway = await startPengbaoGateway({ jwt, fetch: async (input, init) => {
    const url = new URL(input.toString())
    expect(url.origin).toBe('https://pengbao.ecombus.net')
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${jwt}`)
    if (url.pathname === '/api/config') return Response.json({ features: { enable_image_generation: true } })
    if (url.pathname === '/api/v1/auths/') return Response.json({ role: 'user', permissions: { features: { image_generation: true } }, token: jwt })
    if (url.pathname === '/api/v1/images/generations') {
      generations.push(JSON.parse(String(init?.body)))
      return Response.json([{ id: 'runtime-image', url: '/api/v1/files/runtime-image/content' }])
    }
    if (url.pathname === '/api/v1/files/runtime-image/content') return new Response(png, { headers: { 'content-type': 'image/png' } })
    throw new Error('Unexpected fixture route')
  } })
  const probe = join(home, 'probe.mjs')
  await writeFile(probe, `
import { imageTool } from ${JSON.stringify(pathToFileURL(join(project, 'packages/dsh-image-generation/index.js')).href)};
import { createSettings } from ${JSON.stringify(pathToFileURL(join(project, 'packages/dsh-image-generation/lib/settings.js')).href)};
export const inject = ['credentials', 'connection', 'sandbox', 'subprocess'];
export function apply(ctx) {
  const services = { credentials:ctx.credentials, sandbox:ctx.sandbox, subprocess:ctx.subprocess, logger:ctx.logger,
    sandboxPolicy:{resolve:()=>({mode:'workspace-write',workspaceRoot:${JSON.stringify(workspace)}})} };
  const tool = imageTool(services, createSettings(services));
  ctx.connection.fetch.register({path:'/api/managed-image-fixture',methods:['POST'],fetch:async request=> {
    try {
      const raw = await request.text()
      const input = raw ? JSON.parse(raw) : {}
      return Response.json(await tool.execute({prompt:'A blue flower',aspect_ratio:'16:9', ...(input?.size ? {size:input.size} : {})},
        {agent:{session:{header:{cwd:${JSON.stringify(workspace)}}}},signal:request.signal}))
    }
    catch(error) { return Response.json({code:error.code}, {status:500}); }
  }});
}
`)
  const patch = join(home, 'image.patch.yml')
  await writeFile(patch, `${await readFile(join(project, 'build/dsh-desktop-safe.patch.yml'), 'utf8')}\n- insert:\n    - id: dsh-image-generation\n      name: dsh-image-generation\n    - id: managed-image-fixture\n      name: ${JSON.stringify(pathToFileURL(probe).href)}\n`)
  const leases: ReturnType<typeof gateway.createImageLease>[] = []
  const children: ChildProcess[] = []
  const runtime = new HarnessRuntime({
    dshEntryPath: join(project, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
    nodeEntryPath: join(project, 'build/harness-node-entry.mjs'), nodeExecutablePath: resolveTestNodeExecutable(),
    dshPatchPath: patch, dshSafePatchPath: join(project, 'build/dsh-desktop-safe.patch.yml'),
    dshHome: home, logPath: join(home, 'runtime.log'), preferredPort: 0, startupTimeoutMs: 30_000,
    privateModelHandoff: () => ({ gatewayUrl: gateway.url, capabilityToken: gateway.capabilityToken }),
    privateImageLease: () => {
      const lease = gateway.createImageLease(); leases.push(lease)
      return { gatewayUrl: gateway.url, ...lease }
    },
    launchProcess: (executable, args, options) => {
      const child = spawn(executable, args, options); children.push(child); return child
    }, onChanged() {}
  })
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await runtime.start(workspace)
      const snapshot = runtime.snapshot()
      expect(snapshot.phase, snapshot.logs.join('\n')).toBe('ready')
      if (!snapshot.url || !snapshot.authToken) throw new Error('Missing runtime endpoint')
      const login = await fetch(`${snapshot.url}/?token=${encodeURIComponent(snapshot.authToken)}`, { redirect: 'manual' })
      const headers = { Cookie: login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') }
      const settings = await fetch(`${snapshot.url}/api/image-generation.settings`, { headers })
      expect(await settings.json()).toMatchObject({ revision: attempt === 1 && process.env.DSH_TEST_MANAGED_IMAGE_GUI === '1' ? 1 : 0, provider: 'pengbao', managed: { available: true, modelSelection: 'server-managed' } })
      const response = await fetch(`${snapshot.url}/api/managed-image-fixture`, { method: 'POST', headers, ...(attempt === 1 ? { body: JSON.stringify({ size: '1024x512' }) } : {}) })
      const asset = await response.json()
      expect(response.status, JSON.stringify(asset) + '\n' + runtime.snapshot().logs.join('\n')).toBe(200)
      expect(asset).toMatchObject({ provider: 'pengbao', model_selection: 'server-managed', media_type: 'image/png', width: 128, height: 96 })
      expect(asset).not.toHaveProperty('model')
      const data = await readFile(join(workspace, asset.workspace_path))
      expect(createHash('sha256').update(data).digest('hex')).toBe(asset.sha256)
      expect((await sharp(data).metadata()).hasAlpha).toBe(true)
      if (attempt === 0 && process.env.DSH_TEST_MANAGED_IMAGE_GUI === '1') {
        await driveSettings(project, home, `${snapshot.url}/?token=${encodeURIComponent(snapshot.authToken)}`)
      }
      if (attempt === 0) {
        await runtime.stop()
      } else {
        const child = children.at(-1)
        if (!child) throw new Error('Missing Harness child')
        const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited
        expect(runtime.snapshot().phase).toBe('failed')
      }
      const lease = leases[attempt]
      if (!lease) throw new Error('Missing image lease')
      expect((await fetch(`${gateway.url}/v1/image-generation/status`, { headers: { Authorization: `Bearer ${lease.capabilityToken}` } })).status).toBe(401)
      expect(await readFile(join(home, 'runtime.log'), 'utf8')).not.toContain(lease.capabilityToken)
    }
    expect(generations).toHaveLength(2)
    expect(generations[0]).toEqual({ prompt: expect.stringContaining('A blue flower'), n: 1 })
    expect(generations[1]).toEqual({ prompt: expect.stringContaining('A blue flower'), size: '1024x512', n: 1 })
    expect(await readFile(join(home, 'runtime.log'), 'utf8')).not.toContain(jwt)
  } finally {
    await runtime.stop()
    await gateway.stop()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 90_000)

async function driveSettings(project: string, home: string, url: string) {
  const electron: unknown = createRequire(import.meta.url)('electron')
  if (typeof electron !== 'string') throw new Error('Native Electron executable required')
  const screenshot = join(tmpdir(), `pengbao-image-settings-${Date.now()}.png`)
  const script = join(home, 'gui.cjs')
  await writeFile(script, `
const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(join(home, 'gui-data'))});
app.enableSandbox();
app.whenReady().then(async()=>{
  const window=new BrowserWindow({width:1200,height:900,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  window.webContents.on('console-message',event=>console.log('GUI '+event.message));
  await window.loadURL(${JSON.stringify(url)});
  const wait=async(fn)=>{for(let i=0;i<100;i++){if(await fn()) return;await new Promise(r=>setTimeout(r,100));}throw Error('UI condition timed out')};
  const click=async(text)=>window.webContents.executeJavaScript('(()=>{const e=[...document.querySelectorAll("button,a,[role=button],[role=menuitem],[role=tab]")].find(e=>(e.innerText||e.getAttribute("aria-label")||e.title||"").trim() === '+JSON.stringify(text)+');if(e){e.click();return true}return false})()');
  await wait(()=>window.webContents.executeJavaScript('document.querySelectorAll("button").length>0'));
  console.log('GUI-CONTROLS '+await window.webContents.executeJavaScript('JSON.stringify([...document.querySelectorAll("button,a,[role=button],[role=menuitem],[role=tab]")].map(e=>({text:e.innerText,label:e.getAttribute("aria-label"),title:e.title})))'));
  await wait(()=>click('Settings').then(async ok=>ok||await click('设置')));
  console.log('GUI-SETTINGS '+await window.webContents.executeJavaScript('document.body.innerText'));
  await wait(()=>click('Built-in plugins').then(async ok=>ok||await click('内置插件')));
  await wait(()=>window.webContents.executeJavaScript('(()=>{const e=document.querySelector(".dshImageHeader");if(!e)return false;if(e.getAttribute("aria-expanded")!=="true")e.click();return true})()'));
  await wait(()=>window.webContents.executeJavaScript('document.body.innerText.includes("Model selected by the server")||document.body.innerText.includes("模型由服务器选择")'));
  const openProvider=()=>window.webContents.executeJavaScript('(()=>{const e=document.querySelector("button[name=provider]");if(!e)return false;if(e.getAttribute("aria-expanded")!=="true")e.click();return true})()');
  await wait(openProvider);
  await wait(()=>click('OpenAI'));
  await wait(()=>window.webContents.executeJavaScript('!!document.querySelector("input[name=apiKey]")'));
  await wait(openProvider);
  await wait(()=>click('Pengbao unified configuration').then(async ok=>ok||await click('鹏宝统一配置')));
  await wait(()=>window.webContents.executeJavaScript('!!document.querySelector("input[name=serviceUrl]")&&!document.querySelector("input[name=apiKey]")'));
  await wait(()=>click('Save').then(async ok=>ok||await click('保存')));
  await wait(()=>window.webContents.executeJavaScript('document.body.innerText.includes("Pengbao configuration saved")||document.body.innerText.includes("已保存鹏宝统一配置")'));
  await wait(()=>click('Refresh service status').then(async ok=>ok||await click('刷新服务状态')));
  await wait(()=>window.webContents.executeJavaScript('document.querySelector(".dshImageBody")?.getAttribute("aria-busy")==="false" && (document.body.innerText.includes("鹏宝生图可用")||document.body.innerText.includes("Pengbao image generation is available"))'));
  const image=await window.webContents.capturePage();require('fs').writeFileSync(${JSON.stringify(screenshot)},image.toPNG());
  console.log('GUI-SCREENSHOT '+${JSON.stringify(screenshot)});app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
setTimeout(()=>app.exit(2),25000);
`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [script], { cwd: project, env, signal: AbortSignal.timeout(35_000), stdio: 'pipe' })
  let output = ''
  child.stdout.on('data', part => { output += String(part) })
  child.stderr.on('data', part => { output += String(part) })
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  console.log(output)
  expect(code, output).toBe(0)
}
