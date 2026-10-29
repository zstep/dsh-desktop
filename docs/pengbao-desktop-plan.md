# 鹏宝 AI 桌面端集成计划

## Context

将本仓库 `dsh-desktop` 改造成鹏宝 AI 桌面端。用户已确认：**本地智能助手、邮箱／密码登录、Windows + macOS**；生产地址为 <https://pengbao.ecombus.net>。

目标是复用 Harness 的本地文件、终端、项目操作及会话能力，由鹏宝提供账号认证和模型服务。不是网页套壳，也不重写 Agent runtime。主要工作在 dsh-desktop；open-webui 现有接口作为协议依据，默认不修改后端。

实施已获授权，仅在 `prod` 分支推进，保持 `main` 不变。认证、独立账号窗口、模型代理和 Harness 工作区接缝已加入；当前固定 Harness `0.2.1-rc.3`。兄弟 deepseek-harness 源码版本不同，不能代替锁定发布包的验收。

## 推荐架构

```text
独立的本地账号窗口 → 窄 IPC → Electron main：鹏宝认证 + 安全存储
                                      │
Harness UI → 本地 Harness Agent → pi-ai → main 中受限模型代理
                  │                           │ Bearer JWT / HTTPS
           本地工具执行与审批                  ▼
                                     鹏宝 /api/v1/models
                                     鹏宝 /api/v1/chat/completions
```

- 本地 Harness token/cookie 与鹏宝 JWT 分开管理。
- JWT 仅由 main 持有，持久化采用 Electron safeStorage 加密；密码不保存。renderer、Harness YAML、普通 localStorage 和工具进程环境均不接收 JWT。
- main 代理只服务当前账号和当前 runtime，Harness 使用运行期随机能力令牌，退出／重启后失效；禁止任意地址转发。
- 会话保存在按账号划分的本地 DSH_HOME。第一版不做网页聊天同步、飞书 SSO、云端工具混合编排及知识库 UI；不自动迁移旧 DSH 凭据或导入网页会话。
- 文件和工具结果会随模型上下文发往鹏宝，首次使用须明确说明；“本地执行”不等于内容不出本机。

## 当前实施状态

- 已新增认证客户端、加密会话存储、账号路径、受限模型代理、账号生命周期控制器、可信窗口 IPC 与专用 preload，并接入账号窗口启动；`PRIVATE_MODEL_HANDOFF_VERIFIED` 已在真实锁定包闭环通过后解除，登录后的 `activateAccount` 可以继续进入账号工作区。
- 生命周期覆盖恢复验证、MFA、待审核、内存会话、退出清理失败时阻止切换，以及部分启动失败时阻止新账号进入；密码错误 HTTP 400 已按凭据错误展示，MFA 可重试错误保留本地 challenge 并在账号窗口继续显示验证码表单，页面脚本的 CSP 摘要有测试守护。真实 Electron 生命周期尚未验证。
- 模型链路已完成窄范围闭环：锁定的 `@deepseek-ai/dsh-llm-pi-ai@0.2.1-rc.3` 通过可重放补丁提供一次性、进程内 provider credential 接缝；真实 gateway + pi-ai adapter 测试覆盖带 tools 的第一轮 tool-call、assistant tool-call 与 tool result 的第二轮关联，以及上游 JWT。Node spawn 和真实 macOS Electron `utilityProcess` 交接均通过，能力令牌不进入 argv、环境、Profile、日志或工具子进程环境。
- 远程更新服务尚未配置；诊断捕获保留本地报告，但生产 DesktopService 已显式禁用上传与旧厂商更新策略请求，历史报告不会自动发送或清空。旧厂商地址仍保存在兼容服务实现和旧测试中，仅供未来迁移前参考；远程诊断服务尚未配置，不能宣称已有鹏宝故障上报。
- macOS x64 开发包已生成：`dist-dev/pengbao-ai-dev-mac-x64.dmg` 与 `.zip`；electron-builder 已验证 Harness/bootstrap/native modules、依赖清单和 Office 转换资源，包内包含 `pengbao-account.html`、`harness-node-entry.mjs`、pi-ai 接缝和 Office runtime。当前未签名，因为机器没有有效 Developer ID 证书。定向鹏宝测试 9 文件 67 项通过、真实 utilityProcess 8 项通过；`npm run typecheck`、`npm run build`、`npm ci`（含补丁重放）和 `git diff --check` 通过。完整 `npm test` 仍有 7 个环境或既有回归失败，包括 Windows Python API、Office Kit 超时、远程 market、PPT UI/校验及签名测试；不能把完整回归报告为通过。
- 生产账号 `zstep@qq.com` 已通过真实服务验收：登录返回普通 session（无 MFA／待审核），会话角色为 `user`，`/api/v1/models` 返回 9 个模型。`gpt-6.1-sol` 流式请求返回 200、SSE 正常结束并包含 usage；线上真实工具两轮也通过，第一轮生成 `read_local_file` 调用，第二轮以同一 `tool_call_id` 回传模拟结果并收到最终文本。打包版主进程已用独立 `PengbaoAI-dev` 数据目录启动；因 CUA 当前无法读取该 Electron 窗口，未把这次启动记为 UI 手工交互验收。Windows 安装包、Developer ID 签名、公证和正式发布仍未验收。
- 已修复打包版启动时主窗口显示“窗口暂时无法显示”的问题：账号工作区使用隔离的 Electron session，而 `dsh-desktop://` 协议此前只注册在默认 session，导致 Harness shell 在账号 session 中反复 `ERR_FAILED`。现在同一受限协议处理器会注册到账号 session；新包实际启动日志已确认 Harness `ready`、主页面加载完成并稳定进入 `running`，未再出现 renderer load failure。Windows 安装包、Developer ID 签名、公证和正式发布仍未验收。

### 2026-10-29 打包版模型错误排查

- 在真实打包版界面复现了模型请求失败：`claude-opus-5-5` 请求包含 46 个本地工具、7 条消息、约 53 KB，上游约 15.9 秒返回 HTTP `504`，正文为 `stream timeout`。原桌面 gateway 将除 401/403 外的上游失败统一映射成 `502 Gateway request failed`，掩盖了超时来源。
- 同一开发包、同一账号和模型后续成功完成真实 UI 请求，约 8.2 秒返回 `OK`（请求仍携带 46 个工具）。因此不是持续性的登录、私有凭据交接或工具 schema 拒绝；不能把一次成功视为间歇性超时已经消失。诊断期间重启导致的一轮“任务已停止”属于人工中断，不是新发现的网关崩溃。
- 已修改桌面 gateway：保留上游 HTTP 4xx/5xx，504 显示模型服务超时，429 显示限流；仍不透传上游错误正文、响应头或凭据。本地诊断仅记录失败类别、HTTP 状态和耗时，不记录模型请求内容、JWT 或 capability token。
- 最终相关回归 6 文件 73 项全部通过（已启用真实 Electron utilityProcess 验证）；覆盖上游错误脱敏、状态保留、504 后路由恢复及不自动重放请求。类型检查及 `git diff --check` 通过。未重跑完整测试套件，既有完整回归限制仍适用。
- 已重新生成 `dist-dev/pengbao-ai-dev-mac-x64.dmg` 和 `.zip`，打包资源、原生依赖及 Office 转换检查通过，仍为未签名开发包。新打包版真实界面复验通过：同一模型携带 46 个工具、15 条消息，上游约 3.5 秒返回 200，界面约 4 秒完成并显示 `OK`。应用保留运行；旧会话中的历史失败记录未删除。
- 后端源码未发现针对非空 tools 的固定 15 秒超时；显式 `tools: []` 和非空 tools 均跳过网页工具解析。部署的实际 aiohttp timeout、模型通道和前置网关策略尚未核验，未修改远端部署；桌面错误分类修复不等于服务端超时根因修复。

### 2026-10-29 Windows x64 开发包

- 已在原生 Windows x64 上生成 `0.12.1` NSIS 安装器：`dist-dev/pengbao-ai-dev-windows-x64-setup.exe`，284,487,799 字节（271.31 MiB），SHA-256 为 `c095427a8c20fa43a0d1c89b27f16ef34fc3367f1e58337406f4004520cea51a`。产品名为 `Pengbao AI Dev`，应用 ID 为 `net.ecombus.pengbao.desktop.dev`；Authenticode 检查确认未签名，未上传或正式发布。
- 修复 Windows 构建中的图标生成：保留 macOS 原生工具路径，Windows 使用现有 sharp 依赖生成 ICO，并增加尺寸、透明度、目录偏移和源文件不变的行为测试。
- 修复 Word worker 清理环境后导致 ACL runner 回退到系统目录的问题：Windows 仅额外保留 `TMP` / `TEMP`，不恢复凭据或其他环境变量；沙箱限制和 afterPack 门禁保持启用。环境白名单测试覆盖凭据及 `NODE_OPTIONS` 清除。
- `npm ci`（含 postinstall 补丁重放）、`verify-target win32 x64`、`npm run build`、`npm run typecheck` 和 `git diff --check` 通过。包内 Harness、认证 HTML/bootstrap 执行注册、原生模块、终端、692 份依赖清单、PPT 门禁及 Office 原生 Word 工作流、Python 依赖检查、DOCX/PPTX/XLSX 转 PDF 门禁全部通过。
- 定向回归包括鹏宝/启动/图标等 13 文件 117 项通过、1 项跳过；Windows 专项 7 文件 29 项通过；Safe Mode/插件启动 4 文件 22 项通过。Word 原生沙箱回归在应用自带 Electron 43.0.0 / Node 24.17.0 下 14 项全部通过；系统 Node 22.16.0 下其中 11 项因 Windows Job runner 错误失败，不将该执行报告为通过。另一次图标、环境和 Office 打包门禁定向执行 4 项通过、19 项未选中。
- 完整 Windows 回归 `CI=true npm test -- --reporter=dot` 已完成：284 文件中 257 通过、22 失败、5 跳过；2892 项中 2805 通过、70 失败、17 跳过。失败包含系统 `python3` 缺失、symlink 权限、系统 Node 下的 Windows Job runner，以及手机桥接、图片生成、发布脚本和工作台契约等尚未逐项归因的问题；不将全部失败笼统认定为环境问题，完整回归未通过。该轮测试在下述账号窗口修复前启动，不替代该修复的定向验证。
- 用户提供 Windows 实际截图：主工作区已显示，但账号窗口残留在“已登录，正在打开工作区”。已补充主工作区成功连接且导航仍有效后销毁账号窗口；失败/过期导航不关闭，保留原窗口聚焦策略，并防止延迟的 `ready-to-show` 操作已销毁窗口。新增 `test/pengbao-account-window.test.ts` 行为回归，与账号 controller/IPC、窗口聚焦共 4 文件 30 项通过；类型检查、构建、差异检查通过。独立临时 userData 下的真实 Electron 账号页面交互及窗口销毁验证通过，但不是生产账号端到端登录复验。
- 含账号窗口修复的新安装器已生成：`dist-dev/account-window-fix/pengbao-ai-dev-windows-x64-setup.exe`，284,487,690 字节（271.31 MiB），SHA-256 为 `89f8ecd082fc6c6759be3703f8cb6535d66d7bc458fe6441cbde18f635624273`。原生目标检查和全部 afterPack 门禁通过，Authenticode 确认未签名；未上传或正式发布。原 `win-unpacked` 目录被占用，因此改用独立输出目录，未强制关闭用户应用或删除原包。上列原安装器及其 SHA-256 不包含此修复。尚未完成 Windows 安装器的安装/升级、生产账号登录后的窗口关闭及模型工具闭环验收；包内门禁通过不替代这些验收。macOS 图标路径本次未复验。

### 2026-10-29 Windows 启动恢复页与账号切换

- 用户安装目录中的实际启动日志连续多次显示：后端 `ready` 后又发生一次 `launch requested (web profile)`，随后首页 IPC 报 `Harness page boot was superseded`，进入未知插件恢复流程。源码确认 `bootstrapHarnessAfterVerifiedHandoff()` 已负责首次普通／Safe Mode 启动，`activateAccount()` 返回前又调用一次 `launchHarness()`。已删除第二次启动，保留真实后端／客户端失败的原恢复路径，不清空用户 Profile 或修改插件启用状态。
- 当前版本没有可达的鹏宝退出入口；新增中英文“切换账号…”原生命令，覆盖 Windows 标题栏“应用”菜单、托盘及原生应用菜单。先确认停止任务，再调用现有 controller 注销；只有最终本地状态为 `signed-out` 才请求应用重启。远端注销未确认会提示，本地清理失败则阻止重启并允许重试。原凭据 IPC 仍只允许专用账号窗口调用，不向 Harness renderer 暴露 JWT。
- 切换期间抑制销毁最后窗口触发的提前退出、旧恢复页的退出动作及重新启动；将 gateway 停止纳入 15 秒清理上限，失败保留停止句柄供重试。正常“退出应用”仍保留登录，不等同于“切换账号”。账号本地会话、配置和项目文件不删除。
- 新增 `test/pengbao-startup.test.ts`、`test/pengbao-account-switch.test.ts` 和 `test/pengbao-account-teardown.test.ts`，并更新账号窗口测试的导航上下文。最终定向验证 10 文件 71 项通过、1 项跳过；类型检查及 `git diff --check` 通过。未重跑完整测试套件，上节记录的完整 Windows 回归失败仍适用。
- 最终构建在独立临时 appData/userData 下，真实 Windows Electron + Harness 的普通 Profile 与 Safe Mode 均完成已保存测试账号恢复、bootstrap/UI 挂载、取消切换保留登录、确认切换停止子进程并清除本机测试登录信息；两轮均无 renderer error，已查看实际截图。普通模式截图仍显示工作台加载提示，不将其记为全部工作台就绪。认证为注入的测试响应，实际 `app.relaunch` 被观察而未执行第二进程，因此不替代生产账号 A→B→A、安装升级及重启后登录页验收。未停止或注销用户正在运行的应用，未清除其数据。
- 含本节启动与账号切换修复的新安装器：`dist-dev/startup-account-fix/pengbao-ai-dev-windows-x64-setup.exe`，284,571,926 字节（271.39 MiB），SHA-256 为 `b5c09b6b8fcdfe7f3384bd55327ad36ccfb616ca63d4a1e062225ffffbb1787f`。`verify-target win32 x64`、最终构建、包内 Harness/bootstrap/原生模块/终端及 692 份依赖清单、Office 文档编写和 DOCX/PPTX/XLSX 转 PDF 门禁全部通过。下载 Electron 时曾遇 HTTPS 超时，最终使用已锁定且目标检查通过的本地 Electron 43.0.0 分发目录打包，未跳过 afterPack。Authenticode 确认未签名，未上传或发布；上节两个旧安装器均不含本节修复。

## 实施顺序

### 1. 固定协议与产品配置

- 仅在 dsh-desktop 的 prod 分支实施，保持 main 不变；保留当前依赖、补丁及宿主架构，不顺带升级 Harness。
- 新增集中产品配置：鹏宝显示名、独立应用身份／数据根、服务 base URL、可选更新／诊断地址。生产只允许配置的 HTTPS 服务；拒绝 URL 内嵌凭据、非预期重定向，不禁用 TLS 验证。
- 生产服务已固定为 <https://pengbao.ecombus.net>；不从机器凭据猜测地址。测试通过依赖注入使用 loopback/mock。
- 获批执行后运行 npm ci，确认 postinstall 补丁重放成功；核验锁定 rc.3 包的 provider 配置、凭据引用和模型能力结构。不要将较新兄弟仓库的 API 当成现成能力。

### 2. 邮箱密码登录与安全会话

新增 main/enterprise 模块，按职责拆分 client、session-store、account-controller、config；index.ts 仅组装。

复用后端协议：

| 操作 | 接口 | 要点 |
| --- | --- | --- |
| 登录 | POST /api/v1/auths/signin | `{email,password}`；成功包含 token、expires_at、id、role、permissions |
| 检查会话 | GET /api/v1/auths/ | Bearer；返回原 token，不是刷新接口 |
| 登出 | POST /api/v1/auths/signout | Bearer；服务端撤销，失败仍清本地授权并提示远端未确认 |
| 模型目录 | GET /api/v1/models | 使用当前用户身份，权限以服务端结果为准 |

- 状态明确区分未登录、认证中、MFA、待审核、已登录、网络失败、过期。只有完整 token 且 role 为 user/admin 才可启动可用工作区；HTTP 200 不等于登录完成。
- 有效期根据 expires_at 处理；启动恢复时请求服务端校验，401/凭据失效后重新登录。网络错误、403、429 不统一当作密码错误；不发明 refresh token，不无限重试登录或已开始输出的生成。
- 密码登录的 MFA challenge 留在 main 内存，renderer 仅提交验证码／恢复码，调用现有 /api/v1/auths/mfa/verify（main.py 已确认挂载前缀）。首次 MFA 注册引导到固定鹏宝网页完成，然后重新登录；不绕过 MFA、不使用仅供浏览器 cookie 的 /challenge 引导。
- 登录使用独立的本地受信窗口与最小 preload，不依赖已启动的账号 Harness。凭据输入仅存在该页面及短时 IPC 请求中，随后清空；工作区插件只接收脱敏状态和触发打开账号窗口的能力。
- safeStorage 不可用或解密失败时不回退明文；进入需重新登录／仅内存模式并解释原因。所有日志和诊断脱敏，服务响应中的 token 不原样穿透 IPC。

### 3. 账号数据隔离与退出生命周期

- 账号根采用 `userData/accounts/<hash(规范化服务baseURL + user.id)>/harness`，不用邮箱或显示名做目录名；独立 Electron session partition、desktop-storage、恢复资料及手机配对状态。普通／Safe Mode 可共享同一账号数据，不能跨账号共享。
- 第一版采用**受控应用重启切换账号**，不实现多账号并行或复杂热切换。只有验证身份后才选定账号数据根；过期账号不能误进入另一个账号的 runtime。
- 退出顺序：封锁新请求 → 作废代理能力及账号 generation、取消在途请求 → 停止 Harness 和工具任务 → 停止手机桥接／隧道 → reset shell、销毁旧窗口／清理活动认证状态 → 清本地 JWT → 进入登录界面或受控重启。
- 清理必须有超时及失败恢复，不允许旧进程未停却进入新账号；晚到的登录／模型响应不可覆盖新 generation。
- 保留账号本地会话和用户项目文件；登出不是删除历史。旧 DSH 的单用户数据不自动归属第一个鹏宝账号，不自动复制 .credentials.yaml。
- 复用 `HarnessRuntime.stop()`、`HarnessShell.reset()`、手机 bridge.stop()、`DesktopStorageManager`；Profile 名称切换不能替代 DSH_HOME 隔离。

### 4. 受限模型代理与本地工具闭环

- main 启动仅绑定 127.0.0.1 的受限代理，限定认证、Host／Origin、方法、路由、请求大小、并发、超时；禁止宽松 CORS。安全拒绝跨源浏览器调用及请求指定上游。
- 路由仅 GET /v1/models、POST /v1/chat/completions，映射至固定鹏宝服务 /api/v1/...；main 附加当前 JWT，不透传调用方 Authorization、Cookie 或任意代理头；不传本地 Harness session header。禁止跨域重定向携带授权。
- 使用现有 pi-ai 的 `openai-completions` 专用 `pengbao` provider；通过锁版本支持的 Settings/ConfigEditor 或宿主配置接缝注入模型目录、endpoint、运行期能力，不另建模型 SDK 或 Agent loop。
- 显式发送 tools，有工具传定义，无工具传 `[]`；保留 messages 内 assistant.tool_calls、tool_call_id 和 reasoning replay。只排除顶层网页编排字段 chat_id、session_id、id、parent_id、tool_ids、tool_servers 等，不误删工具调用内部 ID。使用允许字段构建请求，避免 metadata 绕过限制。
- 代理流式转发并支持背压、取消和错误；不得缓冲整个回答。核验锁定 pi-ai 对 tool-call 参数碎片、并行调用、usage、sources、无 choices 的 error 帧、[DONE] 的处理；若缺失，只在窄兼容层修正并补行为测试。
- 模型目录按账号权限过滤；工具／reasoning／上下文能力仅采用已确认配置，不能从模型名或列表存在推断。先验收一个已知支持 tools 的模型，再扩展模型兼容。
- 普通模式与 Safe Mode 同时配置最小鹏宝接入能力；安全模式不依赖市场下载、第三方插件或损坏的普通 Profile。

### 5. 品牌、权限提示与独立分发

- 复用宿主 branding slots 改名称／标识，以及托盘、窗口标题、启动／恢复页面和安装包资源；不另写整套前端，不用 preload 大规模改 DOM。中英文文案同批维护，沿用 locale 与主题 token。
- 账号状态、重登、退出等工作区入口放自有宿主插件，使用实际存在的 slot；缺少接缝时才加最小可重放补丁，不能假设未知 slot。
- 保持现有本地工具审批及可用沙箱，不扩大 renderer 权限。核查工具和插件访问应用内部凭据／配置的边界；同 OS 用户任意代码执行不是强隔离，不能宣称目录划分或 safeStorage 可抵御所有本地恶意代码。
- 鹏宝拥有独立 appId、产品名、userData、打包产物和签名配置。不要贸然重命名全部 dsh-* 内部协议／包名。
- 统一检查自动更新、历史版本下载、回滚、灰度、崩溃上报：鹏宝服务未配置时禁用旧厂商远程更新／诊断，保留本地日志和不依赖旧服务的恢复能力，不能悄悄退回原厂地址。
- 保留 MIT 及依赖许可证声明；不复制 Open WebUI 前端来绕开其品牌限制。实际签名、公证、发布和部署另需授权与发布凭据，不在本轮自动执行。

## 关键文件

以下除后端参照外均相对于 dsh-desktop：

| 区域 | 修改／新增路径 |
|---|---|
| 新增账号与代理 | src/main/enterprise/{config,client,session-store,account-controller,gateway}.ts；src/shared/ 的账号契约 |
| 登录窗口／窄IPC | 独立本地账号页面与最小 preload；src/preload/index.ts；src/main/index.ts 组装入口；构建入口按现有规范纳入 |
| 运行时／隔离 | src/main/runtime/harness-runtime.ts；src/main/harness-shell.ts；src/main/state/desktop-storage.ts；src/main/state/safe-mode-profile.ts；手机桥接生命周期 |
| 账号插件／品牌 | 新增 packages/dsh-desktop-account/；packages/dsh-desktop-client-ui/client.js；scripts/install-brand-assets.mjs；build/dsh-desktop.patch.yml、dsh-desktop-safe.patch.yml |
| 产品与发布 | package.json 及必要锁文件；src/main/update/{version-catalog,update-manager}.ts；src/main/desktop-service/service.ts；开发／发布文档 |
| 必要兼容补丁 | patches/@deepseek-ai+dsh-llm-pi-ai+0.2.1-rc.3.patch 等，仅在真实锁版本行为缺口被验证后修改 |

后端只读协议依据：open-webui 的 backend/open_webui/routers/auths.py、routers/mfa.py、utils/auth.py、main.py、utils/middleware.py。重点复用 create_signin_response/create_session_response，以及 middleware 显式 tools 跳过云端工具解析的分支。不要给本地工具请求加网页聊天 ID 来实现落库。

## 验证与验收

### 自动化

- 新增账号协议、safeStorage失败、MFA/pending、401/403/429、登出失败、迟到响应、隔离目录和受控切换测试；不使用真实用户凭据。
- 新增固定上游代理契约测试：鉴权／跨源拒绝、重定向泄露防护、字段约束、流式取消与背压、错误帧，以及真实两轮 tool-call/result 完整关联。
- 扩展现有 test/harness-shell.test.ts、runtime.test.ts、desktop-storage.test.ts、safe-mode-runtime.test.ts、desktop-plugin-closure.test.ts、pi-ai-session-headers.test.ts、pi-ai-terminal-replay.test.mjs、update.test.ts、desktop-service.test.ts 等相关回归。
- 使用隔离测试账号针对鹏宝实际服务复核登录、模型权限和本地工具循环；mock 成功不替代服务端契约验证。
- 仓库根运行（所有命令使用 rtk）：npm test -- test/<相关测试>；npm run typecheck；npm run build；npm test；git diff --check。没有既有 lint/format 脚本，不报告其通过。注意 build/test 前置脚本会生成构建资源，只在批准实施后运行。

### 真实应用及安装包

1. 冷启动登录 → 模型列表 → 流式回答 → 用户批准本地工具 → 回传结果 → 最终回答；断网、取消、过期可恢复且不重复执行工具。
2. A 登录创建会话 → 登出 → B 登录看不到 A 会话／工作区注册／附件 → A 重登恢复自己的数据；在途流、旧窗口、旧手机配对均失效。
3. 正常模式／Safe Mode 都能登录和使用鹏宝模型；坏插件恢复不依赖账号之外的共享数据。
4. Windows 与 macOS 分别验证终端、路径、凭据恢复、崩溃后启动、安装／升级和用户数据保留。按发布目标做原生 verify-target、签名／公证验收；本机 macOS 不能替代 Windows 结果。
5. 检查网络请求不再访问原厂更新／诊断地址，Token 不出现在日志、renderer存储、Profile YAML和工具环境。

## 交付门禁与仍需输入

第一里程碑是“账号登录 → 受控模型代理 → 本地工具两轮闭环 → 退出与重登隔离”；通过后再完成品牌包装和双平台发行验证。

联调前仍需要隔离测试账号及已知支持 tools 的模型（凭据通过安全渠道配置，不写计划／fixture）；生产服务地址已固定为 <https://pengbao.ecombus.net>。正式发行前需要鹏宝图标、应用标识、签名／公证材料和更新策略。未提供更新服务时保持禁用，不影响本地开发和手动安装测试。
