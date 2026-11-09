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

### 2026-10-30 恢复原版公共工作台目录

- 按用户要求，在默认 Desktop patch 中显式配置 `catalogUrl: https://market.dshdesktop.com/index.json`，恢复原版公共工作台市场；保留自定义目录接缝，未配置的独立插件实例仍不回退原厂地址。`dsh-market` 插件市场入口未改，不自动安装任何社区插件；原厂更新与诊断上传继续禁用。
- 新增行为回归：从实际发布配置读取目录地址并通过插件路由加载，缓存读取不触发网络，浏览不触发安装；自定义地址不会被公共默认覆盖。相关 7 文件 363 项通过，类型检查和构建通过。公开目录实测可下载并通过当前格式校验，包含 7 个分类、22 个工作台。
- 本次未重新生成安装包、未做真实 UI 或 Windows 验收、未运行完整测试套件；已安装旧包不会因源码修改自动生效。

### 2026-10-30 启用插件发现市场

- 普通账号 `web` Profile 在维护成功后一次性启用安装包已携带的 `@deepseek-ai/dsh-experimental-plugin-market-bundle`，在“插件 → 发现”提供市场浏览，默认索引为 `https://dshmarket.com/index.json`。不下载 `dshmarket` 管理器，也不自动安装目录中的社区插件；既有社区管理器安装入口保留。原厂更新和诊断上传继续禁用。
- 初始化只修改该账号的 Profile bundle 选择及用户可编辑的市场配置；已有 Profile／home 市场配置（包括空索引）、包级禁用状态和后续用户修改均保留。YAML 先原子写入，manifest 与一次性标记最后原子写入，支持中断后重试；维护冻结、延迟或 Safe Mode 不运行初始化。加载解析以当前 Harness 安装为基准，缺包或初始化失败保留诊断，不执行安装或清空用户配置。仅配置变化不伪造依赖安装完成标记。
- 新增 `test/plugin-market-defaults.test.ts`（10 项）和 `test/plugin-market-runtime.test.ts`（1 项）：覆盖真实 bundle 组合、已有配置与禁用选择、幂等／中断重试、缺包／非法 YAML、Safe Mode 不加载市场，以及真实 Harness 子进程搜索、浏览不安装、设置修改与重启持久化。连同工作台和恢复回归共 10 文件 375 项通过，类型检查、构建及 `git diff --check` 通过。
- 线上插件索引已用锁定版本解析器校验，通过 format 1，实测包含 3917 个插件条目；这是目录格式验证，不代表插件经过安全审查或全部兼容。本次未重新打包、未做真实 GUI／Windows 验收、未运行完整测试套件；已安装旧包需重建更新后才会获得默认入口。

### 2026-10-30 合并预览包与生图保存兼容

- 已将 `prod` 快进到 `82c7894`，保留本地工作台／插件市场改动，并生成 `dist-dev/combined-preview-20261030/` 下的 macOS x64 DMG 和 ZIP。合并后定向回归 20 文件 471 项通过、1 项跳过；类型检查、构建、包内 Harness/bootstrap/原生模块/终端及 692 份依赖清单、Office 转换门禁通过。仍为未签名、未公证的开发包，未上传或发布，未对该包做真实 GUI 验收。
- 用户反馈生图设置保存时报模型不可访问。源码确认 OpenAI 模式强制调用单模型元数据接口，未兼容只提供模型列表的服务。现仅在单模型接口返回 HTTP 404／405 时回退至同一地址的 `GET /models`，要求列表包含未停用的精确模型 ID；不对鉴权、限流、网络或服务端错误回退，不发生成请求，不跳过 TLS／重定向限制，校验失败不覆盖原配置或 Key。截图中第三方服务的实际响应尚未使用用户凭据核验，不能据此断定该服务根因。
- `test/image-generation.test.mjs` 新增列表回退成功、缺失／停用／不匹配模型、非法响应、非兼容错误不回退、列表鉴权失败／重定向拒绝及自定义 ID 回归；与设置 UI 测试共 2 文件 64 项通过，类型检查和 `git diff --check` 通过。未运行完整测试套件，未做真实第三方服务生图或 GUI 复验；此前预览包不包含此修复。

### 2026-10-30 默认启用鹏宝生图

- 普通 Profile 在缺少宿主开关状态时默认启用内置生图工具；已有 version-1 显式关闭、已保存的手动服务商／模型／Key、只读和坏配置状态均保留。仍参与加载的同名 Profile 市场包优先，宿主不重复插入，也不交接私有生图能力；单条 patch 行禁用不等于包级退出。来源选择、启动预检、旧 disabled 行恢复和脱敏状态 IPC 共用该规则。Safe Mode 不增加生图插件。
- 新增独立的图片 capability lease，经现有父子私有 IPC 注册到安装包自有生图模块的单次内存 registry；不进入 argv、环境、Profile、renderer 或日志。按 Harness 启动周期签发，stop、子进程退出／error、启动失败、握手失败和超时均撤销；账号 gateway 停止时撤销全部 lease。图片与聊天 capability 不能互访路由。同进程插件不是安全沙箱，这条接缝用于避免意外泄漏和错误交接。
- main 通过普通用户 `/api/config` 和 `/api/v1/auths/` 查询全局开关及有效权限，生成时提交 `{prompt,n:1}`，并仅在用户明确要求像素尺寸时附带经过校验的 `size: WIDTHxHEIGHT` 到 `/api/v1/images/generations`；未指定时由后台选择尺寸。桌面不读取含密钥的管理员 `/images/config`，不下载上游 Key，不为界面展示而猜模型。只接受唯一且严格匹配的相对 Files 描述符，main 下载后交付最多 20 MiB PNG/JPEG/WebP；拒绝任意 URL／文件代理、编码逃逸、重定向及秘密响应透传。图片并发独立默认 2，总代理期限上限 230 秒，不自动重试生成。
- 插件无持久化服务商选择且存在私有桥时，计算默认“鹏宝统一配置”，读取不写配置、不要求 Key；显式手动选择优先，切换鹏宝保留原 profiles 和 revision 原子冲突检查。UI 展示鹏宝服务地址、模型由服务器选择、关闭／权限／认证／网络状态、刷新和取消，以及云端文件和本地副本说明。设置页不增加尺寸配置；工具调用仅在用户明确要求时传递 `size`，未指定时使用后台默认。提示词组装只后台刷新脱敏状态，不让图片网络故障阻塞文本聊天。生成继续沿用工作区权限预检、图片规范化和沙箱 PNG 写入，返回 `model_selection: server-managed`，不伪造模型 ID。
- 实际检查：尺寸改动后定向图片／bridge／gateway／真实 Harness 回归 4 文件 149 项通过；真实 Harness fixture 同时覆盖未指定尺寸省略 `size` 与明确 `1024x512` 透传。`npm run typecheck` 与 `git diff --check` 通过；随后使用 `CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:dev:mac:x64 -- --config.directories.output=dist-dev/pengbao-size-20261030` 完成 macOS x64 target 验证、构建和 afterPack 门禁。未重跑完整测试套件，历史全量失败记录仍适用。
- 新增 `test/pengbao-image-runtime.test.ts`，使用锁定 Harness `0.2.1-rc.3`、临时 home／工作区和注入上游验证：无手动配置默认鹏宝、真实沙箱生成 PNG／保留透明度／校验 SHA-256、正常停止与重启再生图、child 退出撤销旧 lease。`DSH_TEST_MANAGED_IMAGE_GUI=1` 额外启动安全设置不放宽的真实 Electron 窗口，实际打开内置生图卡片、切换 OpenAI 再切回鹏宝、保存、刷新、重启后确认选择保留；已查看截图。初次 GUI 驱动误点侧栏“插件”而非设置“内置插件”导致等待超时，修正导航后通过；截图等待操作结束，避免把 pending 画面当最终状态。
- GUI 为实际 Harness 页面加隔离 Electron BrowserWindow，不等同于完整桌面主入口／专用账号窗口验收；未验证真实模型从对话发起生图／取消、生产账号切换、Windows 或打包安装升级。未调用线上收费生图、未修改后端或线上配置、未读取真实凭据、未提交推送、未签名公证或发布。本节新功能的 macOS x64 未签名开发包为 `dist-dev/pengbao-size-20261030/pengbao-ai-dev-mac-x64.dmg`（368,838,401 字节，SHA-256 `22a583fce7fce5e76845f6010505a8804069f564b0c09acb879d7537fad6f727`）和 `dist-dev/pengbao-size-20261030/pengbao-ai-dev-mac-x64.zip`（369,688,614 字节，SHA-256 `d4e1f81815972de94d2275505627e76c1e4ec68a62c212df357c94288274bb4c`）；未签名、未公证、未上传或发布。

### 2026-10-30 第三方绘画页编辑请求超时

- 用户反馈 `@copylee/dsh-image-gen@0.2.0` 绘画页生成正常、带参考图编辑显示泛化 HTTP 502。该插件当前使用独立的 OpenAI 兼容服务 `api.gmodel.io`，不经过鹏宝图片 gateway；编辑走 multipart `/v1/images/edits`，不能将问题归为鹏宝后台生图配置。
- 获得直接排查授权后，仅通过现有本地 Harness 登录态发起一次真实单图编辑，没有读取供应商 Key 或自动重试。同模型 `gpt-image-2.5-sunburst`、`size: 2048x1360`、`quality: auto` 请求在 90.207 秒后返回 HTTP 200，图片和图库记录已保存并查看。参考图取自图库最新一张浮岛图，并非截图中的山湖狗图，因此不是截图原图的精确重放；服务实际返回 1537×1023，也不能称为精确尺寸验收。
- 源码与先失败后通过的回归确认：桌面 `HarnessShell` 原先对所有代理请求统一只等 30 秒响应头，超时取消并返回纯文本 502；绘画接口需完成编辑和存储后才返回 JSON。这是已复现的本地传输缺陷，与截图中的泛化报错相符，但没有保留截图历史请求的原始响应，不能称为该次历史请求抓包结论。
- 仅精确 `POST /plugins/copylee-image-gen/paint` 的响应头等待期限改为 240 秒；普通接口、认证和 boot 仍为 30 秒。超时返回安全的 JSON 504，并提醒图片可能已生成或计费、不要自动重试。继续保留 renderer 取消、shell reset／账号生命周期中断和拒绝迟到结果；上游错误状态原样保留，不重放请求、不修改插件或供应商配置。
- 定向回归 `harness-shell`／`desktop-protocol` 共 2 文件 39 项通过，随后扩展 shell／boot payload／boot bridge／cover 集成回归共 6 文件 69 项通过，覆盖 90 秒延迟成功、精确路由期限、400／401／429／502 透传、取消和 reset；类型检查及 `git diff --check` 通过。隔离临时 userData、启用 sandbox／contextIsolation 的真实 Electron 窗口通过 `dsh-desktop://harness` 发起延迟 fixture 请求，31.028 秒后收到 HTTP 200，后端只调用一次，已查看成功截图；不等同于完整桌面入口或插件 UI 验收。首次驱动受继承的 `ELECTRON_RUN_AS_NODE` 影响未启动 GUI，移除该测试进程环境变量后通过，未放宽安全设置。未重跑完整测试套件，先前全量失败记录仍适用。当前运行的旧包不会因源码修改自动获得修复。

- 已完成独立 macOS x64 开发包 `dist-dev/copylee-edit-timeout-20261030/`，原生目标验证、构建、包内 Harness/bootstrap/原生模块/终端与 692 份依赖清单、Office 编写及 DOCX/PPTX/XLSX 转 PDF 门禁均通过；已核验实际 `app.asar` 包含绘画路由及超时说明。DMG 为 368,847,061 字节，SHA-256 `c2da9aeec6655237c2455be830c2213a942de4e3464ebc185d1849686543a284`；ZIP 为 369,688,881 字节，SHA-256 `e1ed6f2ea98866ae6b88056878b7870e10c1c50bc895b563cd06076f22acb8d8`。未签名、未公证、未上传或发布，未安装替换用户正在运行的旧应用；未完成新包安装升级、完整插件 UI 编辑或 Windows 验收。

### 2026-10-31 对话图片显示兼容修复（独立开发包已构建）

- 已精确定位历史“灯塔与小狐狸”会话：当时调用的是后来已移除的 `dsh-media-gen`，不是当前宿主内置工具。工具成功保存 1254×1254 PNG；工作区副本与 attachment 对象均为 2,684,274 字节且 SHA-256 相同。只读认证 `/api/file` 返回 200、PNG 与相同摘要，没有重新生成或修改历史消息。
- 历史答案的 Markdown 使用工作区相对图片路径，解析器支持该语法；缺陷是 Chat `fileMediaUrl` 只允许 HTTP(S) 与旧 `dsh-app://app/`，拒绝当前 `dsh-desktop://harness/`，使组件只显示 alt。已在版本管理补丁中加入精确宿主前缀，primitives 的 vocabulary fallback 同步仅允许该宿主的 `/api/file?`；不开放任意 scheme、伪造 host、内嵌凭据或 `file://`。
- 独立核对锁定 rc.3 的真实工具结果生产链路后，修复自有内置插件的两个契约错误：native `tool/result` 的 content/isError 直接位于 `data.message`，而非首个内容块；生成图片组件改用当前 `renderFactorySlot('conversation.images.content', ...)`。客户端 projector 与服务端预览授权同步解析扁平结果，并支持实际 `tool/ptc-dispatch`，保留旧 `tool/code-dispatch` 的兼容识别。保持同会话成功工具调用、规范路径、文件类型、大小、摘要、symlink 防护、取消、重试和 Blob URL 撤销。
- 补充回归先复现 8 项失败，修复后使用隔离依赖副本执行图片、设置、文件预览、shell/protocol 与真实 Harness fixture 共 7 文件 146 项全部通过，类型检查和 `git diff --check` 通过。两份持久化补丁已在隔离副本中先逆向还原原补丁，再检查并重放新补丁；没有通过测试脚本修改实际依赖。首次测试驱动的函数提取及工作目录错误、一次补丁 hunk 行数错误和类型声明问题均已纠正；未运行完整测试套件。
- 隔离 Electron（sandbox/contextIsolation 开启、nodeIntegration 关闭）实际使用 shipped Markdown/Lightbox、当前图库组件及修复后的内置插件，验证流式结束后两张测试图加载、打开预览并关闭，已查看截图。最初测试页缺少主题变量，遮罩透明；补齐仅测试页主题环境后图片居中、背景遮罩和关闭正常，未据此修改产品 Lightbox。测试页使用测试 ModuleLoader/eval 且产生 CSP 警告，不等于生产主入口、安全策略或真实账号端到端验收。
- 初次权限层拒绝修改两个实际依赖文件；没有换用其他工具绕过。用户授权并继续后，专用 Edit 已成功应用到实际依赖，随后不使用隔离依赖路径重跑上述 7 文件 146 项、类型检查和差异检查均通过，实际文件与持久化补丁的逆向检查通过。以实际 Chat 模块重新构建隔离 Electron 测试页，再次验证两张图片加载、预览打开和关闭，已查看最终截图。原 `copylee-edit-timeout-20261030` 包不包含本节改动。未关闭用户应用、未读取供应商 Key、未重复收费生图、未修改线上配置、未提交推送或发布。
- 已完成独立 macOS x64 开发包 `dist-dev/image-display-fix-20261031/`，原生目标验证、构建、包内 Harness/bootstrap/原生模块/终端与 692 份依赖清单、Office 编写及 DOCX/PPTX/XLSX 转 PDF 门禁均通过；逐项核验实际 `app.asar` 包含 Chat/primitives 的桌面图片地址兼容、内置插件扁平 native 结果解析、当前图库 Factory、PTC 识别及服务端会话预览解析，并保留此前 copylee 绘画超时修复。DMG 为 368,847,185 字节，SHA-256 `9d6a09357973b7cd105a2b657759da5bdce20eb97cf81acb2b4b80968081ba70`；ZIP 为 369,687,072 字节，SHA-256 `063ad6f6982b69bbf472a9a7de2efbdd7beae0c1f58bd0f987325c133cbb275b`。未签名、未公证、未上传或发布，未安装替换用户应用；未完成新包安装升级、真实账号历史会话重放或 Windows 验收。

### 2026-10-31 插件市场索引下载超时修复（独立开发包已构建并核验）

- 只读认证 RPC 从当前运行应用确认：`pluginMarket/listIndexes` 保存 `dshmarket.com/index.json` 下载超时；刷新搜索在 15,013 ms 返回 `plugin-market/fetch-failed`。公开索引返回 200，3,269,490 字节完整下载约 38.4 秒，当前锁定解析器验证成功、4092 个插件；一次 curl 下载在 25 秒仅收到约 522 KB。已复现的失败是默认 15 秒期限，不是索引格式损坏或已安装插件丢失。
- 已将 `@deepseek-ai/dsh-plugin-market@0.2.1-rc.3` 的默认 `fetchTimeoutMs` 改为 90 秒，保留显式用户值及原有安全/缓存/取消逻辑；最小可重放补丁已在隔离原始状态副本重放，结果与实际依赖一致，逆向一致性检查通过。这不替代全新 `npm ci` 验收。首次实际依赖 Edit 被权限层拒绝，未绕过；用户明确授权后专用 Edit 成功。待上游默认期限适配慢速完整索引后评估删除此补丁，不升级 Harness。
- 桌面代理已仅为精确 `POST /api/pluginMarket/search` 增加 100 秒响应头期限；图片编辑仍 240 秒，其余 30 秒，保留取消/reset、迟到结果拒绝和无自动重试。锁定版无 Remote getPlugin/entry，不为猜测路径延长期限。
- 回归先复现 5 项失败（4 项代理期限、1 项真实 Harness 下载期限）。完整修复后 `harness-shell`、`desktop-protocol`、`plugin-market-defaults`、`plugin-market-runtime` 共 4 文件 60 项通过，类型检查与差异检查通过。真实锁定 Harness 在临时 Profile 中通过认证搜索 RPC 经桌面 shell 完成 31 秒延迟 body 的索引解析，并验证缓存/刷新、默认 90 秒、显式 100 ms 期限仍超时、无安装副作用和源配置重启持久化。短期限 fixture 最初使用 launcher config 替换整份 config，遗漏 indexes 导致 unknown-index；补齐仅测试 config 后通过，未改产品配置合并逻辑。随后扩展图片显示、生成、设置、文件预览与 shell/protocol 回归共 8 文件 166 项通过，确认此前图片修复未被破坏。未运行完整测试套件，也未完成生产 GUI/安装升级或 Windows 验收。
- 独立 macOS x64 开发包已完成于 `dist-dev/market-timeout-fix-20261031/`。darwin/x64 原生目标、构建、包内 Harness/bootstrap/原生模块/终端与 692 份依赖清单，以及 Office 编写和 DOCX/PPTX/XLSX 转 PDF 门禁均通过；实际 `app.asar` 的 10 项检查全部通过，包含市场默认 90 秒、精确搜索路由及 100 秒代理期限、此前图片显示/预览修复与 copylee 编辑期限。DMG 为 368,847,185 字节，SHA-256 `3f4944d15d058c2a3baa51a824a0649fe0dd22bbfec67ee7390cc894e57a2e52`；ZIP 为 369,685,638 字节，SHA-256 `9684c6044857b77ebb1f0a064f56643238a67c2b8223c0c3433a2a2e20c31c47`。构建仍提示现有 renderer config 缺失，仅按项目当前 main/preload 构建方式完成，不声称新增 renderer 构建验收。未签名、未公证、未上传或发布，未安装替换用户应用；未更改用户市场源列表、Profile 或已安装插件，未停止用户应用、未清理数据、未收费生图。先前图片修复包不包含本节改动；当前运行旧应用不因本次构建自动恢复。

### 2026-11-02 默认集成 `@dickpy/dsh-imagegen@1.11.0`（独立开发包已构建并核验）

- 普通 Profile 默认插入并启用本地 `dsh-desktop-imagegen` 包，逻辑 Loader ID 为 `imagegen`；现有 Profile 已安装同逻辑插件时由 Profile 保持所有权，Safe Mode 不注入。`dsh-image-generation` Office 工具继续保留，不与第三方插件重复注册。包装包只依赖精确版本 `@dickpy/dsh-imagegen@1.11.0`，并通过 `patches/@dickpy+dsh-imagegen+1.11.0.patch` 增加实例级 host adapter；`scripts/prepare-imagegen.mjs` 从锁定发布包生成 ignored 的客户端入口，不能手工维护第二份 bundle。
- 默认图片服务显示为“鹏宝／服务端默认图片模型”，只读取普通用户配置和权限状态，由后台选择实际图片模型；不读取管理员 `/images/config`、不下载供应商 Key、不把模型名或 JWT 写入插件配置。受管生成仅支持单张文生图和可选 `WIDTHxHEIGHT`，明确拒绝图生图、参考图、多图、非默认 quality/detail；不支持的请求在出站前失败。生成结果仍走插件原有队列、取消、预览和历史链路。
- 提示词增强沿用插件现有 Enhance/Polish 按钮；每次点击动态读取当前桌面默认聊天 provider/model，使用受限 LLM stream，只收集可见文本 delta 并拒绝 reasoning、空结果、异常 finish 和超长结果。单纯点击 Generate 不自动先调用增强。设置页提供图片服务和提示词服务的“继承桌面默认／自定义／关闭”选择；自定义 channels、endpoint、model、secret 或显式关闭均优先，合成的 managed channel 仅用于运行时投影，不回写持久化配置。宿主模式同时屏蔽第三方自动更新检查和安装，独立运行的上游插件仍保留原行为。
- 图片能力通过每个 Harness runtime 的可撤销 lease 传递，仅暴露 status/generate 绑定操作；启动失败、握手失败、退出、停止、超时和账号 gateway 停止都会撤销。JWT 仍只由 main 持有，插件、renderer、YAML、argv/env 和日志均不接收凭据。固定 HTTPS、无重定向、响应大小／媒体类型和并发／超时限制沿用现有图片 gateway；超时不自动重试，并提示请求可能仍在服务端完成或计费。
- 验证：图片 host adapter、managed 操作、设置投影／更新门禁／队列 history、插件闭包、来源选择／状态／预检和 lease 回归共 77 项通过；锁定 Harness 的真实临时 Profile 集成通过，覆盖 host descriptor、无 model override 的图片出站、默认聊天模型切换、多图拒绝、历史结果和停止后 lease 撤销。另有 `DSH_TEST_IMAGEGEN_GUI=1` 的临时 Electron mock 路径可驱动工作台 Enhance/Generate 和主预览；fixture 图片与聊天响应均为本地 mock，不代表真实线上模型质量或收费验收。
- 补丁维护：已在独立临时副本中将实际安装文件逆向还原，再检查并正向重放 Imagegen 补丁，三个 lib 文件与当前安装逐字节一致；根依赖与 lockfile 对应一致，第三方 tarball 固定 npm registry 来源及 integrity。此检查不替代全新 `npm ci`／完整 postinstall 验收。上游提供等价的实例级 host 图片／增强操作、免 Key 就绪描述和宿主更新控制后，应迁移到公开接缝，删除本补丁及客户端派生适配，重新验证独立和宿主两种运行方式。
- 打包前复验：11 文件 153 项通过，包含真实临时 Harness 路径；类型检查与 `git diff --check` 通过。本次未重跑全量测试，前次全量结果为 3146 通过、7 失败、6 跳过；失败涉及 Python `contextlib.chdir`、Office cache 清理、插件市场超时、workbench 状态、PPT 模板预览和 enterprise menu fixture，尚未全部定位，不能报告全量通过。未做真实账号生图／增强、Windows、正式安装升级、签名、公证、发布或线上配置变更。当前运行中的旧包不会因源码修改自动获得本集成。
- 独立 macOS x64 开发包已完成于 `dist-dev/imagegen-default-20261102-r2/`，身份为 Pengbao AI Dev。原生目标验证、完整 build、包内 Harness/bootstrap/原生模块/终端与 695 份依赖清单、Office 编写及 DOCX/PPTX/XLSX 转 PDF 门禁均通过。另以包内 Helper 和实际 app.asar 启动临时 Harness、本地 mock，验证 wrapper／派生客户端、普通默认 patch 插入、受管图片、显式默认聊天增强、Generate 不调用增强、history、宿主更新门禁及 fixture capability 不进入日志／HTML／设置。该 smoke 显式向隔离测试 Profile 插入插件，不代表产品 Safe Mode 默认启用，也不等于完整桌面主入口 GUI／真实账号验收。
- 安装包完整性：DMG 为 374,763,579 字节，SHA-256 `0a6dc5ae5fe2b09853be3c562bfd74f32673d71599eb25f66ff9ebb7b028db3c`；ZIP 为 375,569,571 字节，SHA-256 `9a9c55b6579243742e182a79d6b0e04d9db656990007762f3e03345f1dacf852`。`hdiutil verify` 和 ZIP 全数据检查通过，`codesign -dv` 确认未签名。未公证、未上传或发布、未安装替换用户应用。
- 打包期间先后遇到 CLI 将 `afterSign=null` 当脚本路径、API 合并完整配置导致 Office extraResources 重复软链接；最终使用独立 JS 配置的真正 null 和新输出目录解决，保留全部 afterPack 门禁且未删除旧输出或 Office 资源。包内 smoke 初次将 `--patch` 放在 app 参数后导致 unknown option，调整测试脚本参数顺序后通过，未改产品 CLI；本机 Python 不支持 `hashlib.file_digest`，改用 Node 流式 SHA-256 完成校验。构建仍有现有 renderer config 缺失提示，不声称新增 renderer 构建验收。

### 2026-11-02 模型目录与视觉能力传递（源码及离线回归完成）

- 只读认证查询当前运行 Harness 的 `session/modelCatalog` 成功，鹏宝组有 9 个模型、无 failed provider，默认仍为 `pengbao/claude-opus-5-5`。运行中的旧受管 overlay 只列 id/name，没有逐模型 input；modelCatalog 响应本身也不含 inputModalities，不能据此断言这 9 个模型实际都只支持文本。未读取真实线上各模型的 vision 值，未做收费视觉推理。
- 桌面 main 启动账号时直接读取固定 HTTPS `/api/v1/models`，生成最后加载的受管 provider overlay；Harness 聊天和自定义模型发现使用 main 的随机 loopback gateway。其精确 `GET /v1/models`、`POST /v1/chat/completions` 分别映射到鹏宝 `/api/v1/models`、`/api/v1/chat/completions`，账号 JWT 仍只由 main 持有，Harness 仅使用内存交接的本地 capability；端口每次启动可变，不硬编码截图地址。
- 已修复 client 只保留模型 id/name 而丢失能力声明的问题：仅 `info.meta.capabilities.vision === true` 规范化为 `[text, image]`；false、缺失和畸形元数据均为 `[text]`。不依据模型名称、顶层 capabilities 或图片输出能力推断视觉输入；保留模型顺序、first-wins 去重和默认选择。overlay 对每个模型显式写 input，旧构造点缺失或空 input 同样回退文本；只传 id/name/input，不透传上游 endpoint、Key 或任意配置。
- 锁定 pi-ai 实际按非空模型 input → 同 provider 内置 catalog input → provider defaultInput 解析。因而此前 `defaultInput: [text]` 并不能证明全部模型都被强制文本；本次通过逐模型显式声明消除这类不确定继承，不删除能力检查。真实 Session prompt 对文本模型拒绝图片并返回 `MODEL_DOES_NOT_SUPPORT_IMAGES`；底层 LLM stream 对文本模型另有图片转文本占位的投影，不能用直接 stream 测试代替会话准入验证。
- 设置页“获取可用模型”是按当前表单的 provider/baseURL/API 发起 host-side 候选发现，再由用户选择导入，并非实时运行目录镜像；同 ID 已有项优先保留。锁定 pi-ai 的网络 discovery `readListing()` 仍未解析该 vision 元数据，本次未修改依赖发现逻辑。截图中的空编辑列表根因尚未证实，不把能力传递修复称为设置页空列表修复，也不建议手工修改会在启动时重建的受管 YAML。
- 定向回归分两批共 10 文件 107 项通过、1 项真实 Electron utilityProcess 可选测试跳过（本轮未启用）；包含账号认证/controller/IPC 消费模型目录的回归，类型检查与 `git diff --check` 通过。新增真实锁定 Harness 临时 Profile 回归：client → overlay → 实际 adapter 的混合能力解析、显式文本覆盖内置视觉 catalog、缺失/空 input 文本兜底、认证 `session/prompt` 在上游调用为 0 时拒绝文本模型图片，以及有效 8×8 PNG 经临时附件服务、adapter 序列化为 image_url、gateway 转发到 mock 并正常结束 SSE。仅检查 fixture 凭据不出现在 overlay/日志；不把该离线结果当成线上视觉能力验收。
- 新 fixture 初次直接调用 LLM stream 时因其文本投影语义而未拒绝，已改用真实会话 RPC；随后修正 RPC 的 request 参数包装，并补齐 mock SSE finish_reason，未为测试改变产品 guard。未运行完整测试套件，未做 GUI、Windows 或真实账号视觉理解验收；未修改当前运行应用、用户 Profile 或线上配置，未打包安装、重启、提交推送或发布。当前运行旧包不会因源码修改自动获得本节修复。

### 2026-11-04 实际图片默认名称与供应商目录（本地源码，尚未上线）

- 桌面优先读取普通图片权限下的 `/api/v1/images/metadata`，只接收 `{models, defaultModel, selection, catalogStatus}`；仅明确 404/405 时兼容旧 `/images/models`，认证、网络或格式错误不伪装成旧端点。开放显式选择要求正文 `selection: request-local` 与精确能力头 `X-Image-Model-Selection: request-local-v1` 同时成立；缺失能力头时保持仅服务端默认。
- 默认选项仅显示实际模型名称，不附加“跟随默认”等后缀；其内部身份固定为 `desktop-managed`、偏好仍存空字符串，生成省略 `model`。其他选项以精确上游 ID 保存和出站，即使 ID 等于当前默认 ID 或显示名称也保持显式选择；同名选项附加 ID。刷新后台默认只改变显示，不保存偏好；受管服务生效时隐藏空自定义渠道提示，不要求用户选择引擎。
- 供应商发现、有效默认及回退规则由 Open WebUI 后端的共享解析器负责，不能把聊天模型目录或首个图片候选当作默认。详细后端契约见 sibling Open WebUI 项目的 `docs/integrations/PENGBAO_DESKTOP_BACKEND_CONTRACT.md`；旧后端无元数据时明确显示默认名称暂不可用，不猜测型号。
- 图片失败诊断独立于聊天回调，仅记录本地产生的关联 ID、固定阶段、安全错误码、耗时及可选数字 HTTP 状态。不得记录 prompt、模型 ID、URL、凭据、供应商错误正文或图片内容；回调异常不改变请求结果。新增日志接线尚未进入当前运行应用，不能据此声称已取得线上失败证据。
- 本地网关／bridge／lease 等 6 文件回归 230 项通过、1 项跳过；开发依赖更新后，额外的 gateway／lease／host 回归 12 文件 288 项通过、1 项跳过，类型检查通过。权威第三方补丁已在隔离 pristine 1.11.0 基线上验证重放，`git diff --check` 通过。本轮全量 `npm test` 在 pretest 阶段因两个任务并发准备 Office 缓存导致目录冲突，没有获得新的全量测试结果；随后串行完整构建和打包成功，不修改 Office 产品代码来掩盖该失败。
- 用户指定的 `gpt-image-2.5-sunburst`、`gpt-image-2.5-flare`、`gpt-image-2`、`gemini-3-pro-image`、`gemini-3.1-flash-image` 已补充精确 ID 回归：OpenAI 兼容目录可混合返回这些模型，无需让用户切换引擎。后端 metadata／旧目录／显式生成校验 128 项离线测试通过；桌面包装层及新包临时 Harness 的 mock 验证覆盖五项显示、保存和精确透传，未硬编码候选到产品目录。这证明代码兼容性，不代表线上实际目录已返回全部五项或真实生成可用。
- 新 macOS Intel 开发包位于 `dist-dev/imagegen-model-names-20261104/`。target 验证、完整 build、包内 Harness/bootstrap/原生模块/终端、695 份依赖清单及 Office 编写和 DOCX/PPTX/XLSX 转 PDF 门禁通过。包内 Helper／app.asar 配合临时 Profile 和本地 mock 验证默认仅显示实际名称、默认省略 model、显式模型跨 Harness 重启保留、增强使用当前聊天模型、失效模型零派发、history、更新门禁及 fixture capability 不泄漏。仍有既有 renderer config 缺失提示；不替代完整桌面主入口和真实账号验收。
- DMG 为 374,726,052 字节，SHA-256 `724dfd303fd1be867ff9dfc09e64ff67115045cc6e6e3de4670ec86b5dcbcb0c`；ZIP 为 375,568,792 字节，SHA-256 `427229b06c1bf918d0e0c5a6c6475d49aa711bbaab49349f93b28236db27a69d`。`hdiutil verify` 与 ZIP 全数据校验通过。构建显式跳过签名，未公证、未发布、未安装替换用户应用。包从保留其他 WIP 的完整开发工作树构建，本次选择性提交只包含生图集成，二者不能称为同一干净提交树的纯净构建。
- 权限层最初拒绝直接修改已安装的 `@dickpy/dsh-imagegen/lib/{client,index,host-adapter}.js`，当时仅维护独立副本和权威补丁，未换工具绕过。用户随后明确授权更新这三个开发依赖文件并打包；依赖更新和 `imagegen:prepare` 已完成，使用实际安装依赖的 6 文件 231 项回归及类型检查通过。
- 没有发送真实生图。服务端额外参数可覆盖客户端 `n:1`，且尚未建立获准的安全 UI 自动化路径；无法保证单张预算时不发请求，不读取管理员配置或提取凭据绕过。默认生图失败根因仍未确认。用户已另行要求提交和重新打包；没有改真实 Profile、关闭／重启用户应用、部署后端、改线上配置、推送、签名／公证／发布。

### 2026-11-04 图片渠道继承与 Pengbao 显示修复

- 修复 `channels: []` 时孤立的 `defaultChannelId`、`defaultModel` 或 `channelSecrets` 被误判为已配置自定义服务的问题。旧逻辑会读到实际默认模型名，却将受管服务标为 inactive，导致渠道和可用模型列表为空；隔离回放已复现这三类旧行为。尚未读取用户真实 Profile，不能断言线上具体由哪个残留字段触发。真正的自定义 channels、旧 apiUrl/apiKey/imageModels，以及显式 custom/off 仍优先；不删除或重写原有偏好与 secrets。
- 渠道名称固定显示 `Pengbao`，模型名称独立显示实际默认或显式选择，例如 `Pengbao/gpt-image-2.5-sunburst`。内部渠道和默认模型身份仍是 `desktop-managed`，默认偏好为空且出站省略 model；显式模型继续保存和转发精确上游 ID。第三方 host 未提供 channelName 时保留 label 兼容回退。
- 统一定向验证：类型检查、补丁正反向回放和安装文件逐字节比较、6 个测试文件共 239 项通过，`git diff --check` 通过。临时 Profile 的真实 Electron 界面中，五个指定模型均可逐个选择并保存，完整刷新后保留最后的 `gemini-3.1-flash-image`；本轮 GUI 验证限于目录与选择持久化，不代替增强、预览或真实供应商生成验收。补丁回放不是全新 npm ci。
- GUI fixture 最初把用户偏好放入高优先级启动 overlay，正确触发 ConfigEditor 的不可编辑覆盖保护，出现保存失败。已将 fixture 偏好移入正常可编辑 Profile，启动 overlay 仅插入插件；未放宽配置保护、移除 revision fence 或改动用户真实配置。
- 完整 `npm test` 实际结果：294 个测试文件通过、7 个失败、1 个跳过；3300 项通过、8 项失败、6 项跳过。失败包括 enterprise menu fixture 的 requestAccountSwitch 缺失（2 项）、本机 Python 缺少 contextlib.chdir、workbench 状态返回 503、PPT 模板预览断言，以及插件市场、host-disabled 插件和 PPT 模板导入超时。未为全绿修改这些范围外代码，不报告完整套件通过。
- 新 macOS Intel 开发包位于 `dist-dev/imagegen-activation-20261104/`。原生目标验证、完整 build、包内 Harness/bootstrap/原生模块/终端和 695 份依赖清单、Office 编写及 DOCX/PPTX/XLSX 转 PDF 门禁均通过。实际包内 Helper/app.asar 配合临时 Profile、本地 mock 验证：三类孤立残留不阻断 Pengbao、默认省略 model、五个精确 ID 均可保存和派发、重启 Harness 后保留最后选择，原有孤立偏好仍在且 fixture capability 不持久化。包内 smoke 首次漏填 mock 状态响应的 serviceUrl/modelSelection 被严格校验拒绝；补齐 fixture 后通过，未修改产品 guard。
- DMG 为 374,725,329 字节，SHA-256 `bd0238cb445e4d9bf412fc2005363881ec62f31e33b3527c6b201d5c9bde4fe9`；ZIP 为 375,573,549 字节，SHA-256 `62bf010af83ab6b065f62e72d61d325dde65ab736be7842fe836e843d262a010`。hdiutil verify 和 ZIP 全数据校验通过，codesign 确认未签名；构建仍有既有 renderer config 缺失提示。包来自保留其他 WIP 的完整工作树，不是仅本次提交的干净树构建。
- 本轮修改保持唯一权威第三方补丁和 managed 包输入，派生客户端由 imagegen:prepare 生成。未做真实收费生图，未修改线上配置、用户 Profile 或现有应用安装；未推送桌面仓库、签名、公证或发布。

### 2026-11-05 鹏宝模型底座与兼容插件连接（源码完成，未打包发布）

- 新增内置 `dsh-desktop-model-service@0.1.0`；入口为“设置 → 内置插件 → 模型连接”。集中展示聊天／图片目录、共享默认模型和连接状态；图片工作台与声明式消费者读取同一图片偏好，聊天沿用 `agent-default-model`。默认值支持预览、显式应用、刷新后保留及条件撤销，不另存第二份凭据或默认模型配置。
- 新插件通过 `dsh.modelService` v1 声明 `chat.completions`／`image.generate` 后调用 `ctx.modelService.forConsumer(id)`；已审核适配器严格绑定安装来源和版本。发现仅静态读取 manifest 与惰性 YAML，使用 Harness 实际 patch 顺序；不执行插件探测、不猜 `apiKey` 等字段语义、不复制密钥。无声明的未知插件显示需适配，已审核的基础设施 bundle 不误列为消费者。
- 一键连接全部仅修改同一底座 namespace 中无冲突的 facade 绑定，支持跳过／重新纳入、revision 冲突保护和 10 分钟进程内预览／撤销凭据。内置适配器保留现有连接；真正自定义图片渠道、非空密钥和 custom/off 设置仍优先，不自动清除。设置脱敏 sidecar 新增非空布尔标记，避免把空默认密钥误报为自定义配置；不返回密钥内容。浏览器写操作以实际 listener origin 校验，不信任内部 carrier URL 或 Host/Forwarded。
- JWT 继续仅由 main 持有；能力令牌经私有 IPC 交接、不进入 argv／普通环境／YAML。registry 在工作区服务启动时冻结，新安装或启用插件需重启工作区服务；刷新仅更新状态和模型目录，不宣称热扫描生效。同进程插件能力绑定不是恶意代码沙箱。无授权的离线工作区保持配置可打开，但受管生成不可用，不能反向补发授权。
- 视频保持“未审核”，没有启用生成能力。未验证部署合同与普通用户授权前，不因本地存在视频 router 就声称可用。
- 最终定向 Vitest：13 文件 378 项通过、1 项可选验证跳过；包内 Node 测试 35 项通过；类型检查和两个仓库差异空白检查通过。真实临时 Harness + 隔离 Electron 联合验证通过：聊天／图片共享默认切换、facade 实际调用、连接全部、跳过／重新纳入、应用、完整刷新、条件撤销；生图工作台增强、显式模型刷新持久化、PNG 主预览、history 和停止后 lease 撤销。已查看最终截图；所有上游均为本地 mock，不代表线上收费生成验收。
- 本轮完整 Vitest 实际执行 304 文件：293 通过、10 失败、1 跳过；3339 项中 3319 通过、14 失败、6 跳过。该执行启动后仍修复了图片默认 namespace 和无授权图片插件阻断启动问题；后续上述定向与 GUI 均通过，另将 host-disabled／Office／workbench install／market 四组运行时集成串行复跑，19 项通过。未重新获得全量全绿结果；剩余失败涉及菜单测试未提供 requestAccountSwitch、本机 Python 缺少 contextlib.chdir、工作台状态 503、PPT 内存超时及文本导入断言，不能统称已验证为环境原因。初次混用 Node runner 执行 Vitest 文件报错，已按实际 runner 分开重跑。
- 本地包锁文件与 manifest 的依赖、peer 及 link 元数据一致。dsh／app-boot／settings 三份权威补丁均通过 Git 与 patch-package 语法、临时副本重放及 JS 语法检查；app-boot 使用匹配锁文件 SHA-512 的原始缓存包，另两份使用安装副本反向还原并核对已有原始 blob；settings 声明文件缺少原始 blob，未取得该文件的独立 pristine 证明。本次未执行全新 npm ci／完整 postinstall，不能将局部补丁重放等同于全新安装验收。
- 未读取真实供应商密钥、改线上配置、部署后端、自动收费测试、关闭用户应用或清除数据；未构建新安装包、提交推送、签名、公证或发布。现有安装包不会自动获得这些源码变更。

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
