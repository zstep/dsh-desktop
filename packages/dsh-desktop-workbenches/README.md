# dsh-desktop-workbenches

Desktop host plugin for the Awesome DSH Workbench market, local workbench state, navigation and the native conversation frame.

Market metadata comes exclusively from the published Awesome protocol v2 index. Runtime providers register their component without a caller-supplied ID. Local packages may omit `repository`: the host derives `local:<npm package name>` from the actual client package, including `local:@scope/name`. Local development, installation, and use require no GitHub account, URL, or repository creation. Version or directory changes preserve identity; package renames create a new identity. Existing valid repository attribution keeps `owner/repo`. Later market publication does not automatically migrate local sessions or overwrite local identity; migration must be explicit. Registration failures appear in Workbench management with package, stage, and reason and emit console warnings; successful reload clears the matching diagnostic. A provider that wants to be recognized as the installed form of an Awesome entry must include the canonical GitHub URL in its registration descriptor's `repository` field.

The host does not bundle a separate catalog or third-party workbench packages. It installs, updates and uninstalls catalog entries on the user's request through Desktop's isolated-generation boundary (`desktopPnpm.installWorkbenchGeneration`) and records them in `market-installs.json`; see `docs/workbenches.md`.

## 桌面内置文档

桌面客户端通过本地 `/api/desktop-workbenches/` 路由提供中英文开发规范、市场验收规范及六步速览。打包副本里的交叉链接也指向本地路由；本地读取失败时应报告错误，不回退原厂网站。`docs/workbench-*.md` 仍是独立网站文档的来源，`--site` 生成的网站页面及 URL 不因桌面副本改变。市场目录未配置时，不请求默认原厂目录，也不能在桌面端执行市场投稿查询或安装；用户主动安装本地工作台仍按既有插件权限流程进行。

修改文档来源后运行 `node scripts/build-workbench-guide.mjs` 更新桌面副本，或使用 `--check` 核对；网站生成另用 `--site <目录>`，两者不可混同。
