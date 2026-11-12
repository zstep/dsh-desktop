# 外部插件兼容补丁

这里保存不属于 Desktop npm 依赖的可选插件补丁，使用 `.diff` 后缀，避免被 `patch-package` 递归识别为 Desktop 依赖补丁。它们不参与根目录 postinstall；仅重新打包 Desktop 不会修复用户已安装的插件。

## dsh-hyperframes 0.11.3：npm 定位

目标：该版本发布包的 `lib/media-workbench.js`，只调整 npmCli() 及相关 Node 内置导入。

问题：Electron Helper 的相邻目录不包含 npm；原函数遍历 PATH 时遗漏 `../lib/node_modules/npm/bin/npm-cli.js`，也没有解析 `npm` 符号链接，因而标准 Node/n 安装与 Homebrew 链接可能误报 npm 缺失。

修复：

- 保留原有 executable-adjacent、PATH 与 Windows APPDATA 布局。
- 补齐每个绝对 PATH 项的标准 lib 布局，以及指向 npm-cli.js 的 npm 链接。
- 候选必须是文件；断链或不存在的候选继续查找，不执行 shell/shim，不读取 npm 配置或凭据。
- 不改运行时、安装参数、registry、环境过滤、浏览器或渲染逻辑。

### 验证

从仓库根运行：

```sh
rtk npx vitest run test/hyperframes-npm-lookup.test.ts test/patch-hunk-counts.test.ts
rtk npm run typecheck
rtk git diff --check
```

2026-11-02：2 文件 14 项通过，类型检查与差异检查通过。npm 回归在临时目录重放实际 diff 并验证逆向逐字节恢复，覆盖标准 prefix、Electron、Homebrew 链接、原有布局、断链、目录伪装、缺失 npm、不执行 shim 和 Windows 路径语义。Windows 用模拟路径/文件系统断言，不是原生 Windows 验收。

另以当前安装包完整 JS 的临时副本验证补丁正反向重放；修复后的函数在当前运行 Electron Helper 路径与终端 PATH 下选中现有 npm，Helper 使用 `ELECTRON_RUN_AS_NODE=1` 执行 `--version` 返回 10.9.4。原安装文件摘要保持不变，没有运行 install、准备渲染环境或调用网络。

### 交付边界与移除条件

用户插件属于不可变 generation，不能在活动 generation 中直接运行 git apply。安全交付应由插件上游发布修复版本，或另行设计并授权新 generation 的安装/切换，保留原版本用于回滚。本补丁没有连接自动安装或加载流程，不修改用户 Profile、系统 Node/npm 或全局链接，不自动重载应用。

此版本补丁只应在核验包名/版本且 `git apply --check` 成功的独立副本或上游源码中使用。升级不得强行模糊套用。上游提供等价修复后，验证真实 Electron 启动下的 npm 定位与环境准备，再删除本补丁及不再需要的回归。未执行全新 npm ci、完整回归、真实应用激活、渲染环境下载或视频导出，不将上述离线验证当作这些验收。
