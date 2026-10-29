# 鹏宝 AI B2 品牌资源设计

## 背景

附件 `/Users/zstep/Downloads/Gemini_Generated_Image_sxdu72sxdu72sxdu (1).jpeg` 是鹏宝 AI 品牌规范拼图。中间的 B2「Teal on Black」是黑底青绿色线稿鸟标。整张规范图不能直接作为应用图标，因为其中包含 B2 标题、说明文字、拼图边框和其他候选方案。

## 目标

- 保留 B2 的鸟形和青绿色作为鹏宝 AI 的主图形。
- 生成可用于 macOS、Windows、网页 favicon 和桌面 UI 的独立资源。
- 让打包产物真实携带新图标，并通过现有图标生成器生成 `icns` 和 `ico`。
- 不影响当前账号、Profile、Harness 启动和更新逻辑；品牌资源失败时构建应直接失败而不是静默使用旧资源。

## 方案

采用 B2「Teal on Black」派生双资源：

1. 从 B2 方块中裁剪鸟标，移除 B2 标签、Transparency Indicator 说明、拼图边框和 JPEG 黑底边缘。
2. 生成透明背景的青绿色线稿鸟标，用于 `logo-dark.png` 和 Web UI 深色主题。
3. 生成透明背景的深色/黑色单色鸟标，用于 `logo-light.png` 和浅色主题；鸟形保持一致，避免橙色在浅色小尺寸上失去对比度。
4. 生成 1024x1024 的应用图标：近黑色圆角方底，居中放置青绿色鸟标，保留足够安全边距，不包含文字。
5. 将同一透明鸟标同步到启动页、更新提示和 loader，避免不同启动阶段显示旧的鲸鱼图形。

## 资源边界

- 权威输入是仓库内的 `build/pengbao-b2-source.jpeg` 和 `scripts/generate-brand-assets.mjs`；`build/pengbao-b2-mark.png`、`build/app-icon.png`、`build/logo-light.png`、`build/logo-dark.png` 与 `build/brand-mark.svg` 是由它们生成的维护资源。
- 通过 `scripts/generate-app-icons.mjs` 从 `build/app-icon.png` 生成 `build/icon.icns`、`build/icon.ico`。
- 通过 `scripts/install-brand-assets.mjs` 将三份 PNG 安装到 Harness Web 前端资源目录，并更新 favicon 和 manifest 图标。
- 不修改 `src/main` 的协议、账号隔离或启动路径；只验证这些路径仍能读取新的打包图标。

## 处理与质量要求

- 裁剪以原图 2048x2048 的 B2 方块为边界，使用像素检查排除文字和外部边框。
- 背景移除后，鸟标外沿不能有明显 JPEG 黑边；线稿颜色保持青绿色的渐变观感。
- PNG 必须保留 alpha 通道；应用图标必须为 1024x1024，logo 资源保持现有 336x192 尺寸契约。
- 透明资源在浅色和深色背景各检查一次；应用图标检查 macOS Finder/DMG 预览和 Windows ICO 多尺寸内容。

## 验收

1. 用图像工具检查尺寸、颜色通道、alpha 边界和非透明内容的安全边距。
2. 运行 `npm run brand:generate`、`npm run icons:generate` 和品牌资源安装脚本，确认生成文件存在且 manifest/favicon 指向新资源。
3. 运行相关品牌、发布配置、启动协议回归测试，随后执行 `npm run typecheck`、`git diff --check` 和 `npm run build`。
4. 在 macOS 上生成开发包并启动，确认应用图标、启动页品牌标记、主页面品牌标记和更新提示图标都显示 B2；记录未执行的 Windows 安装验收或签名/公证状态。

## 回滚

如果视觉验收发现裁剪质量不足，保留本设计文档和原有资源的 Git 版本，重新生成 B2 资源后再运行同一套图像与打包验收；不删除用户 Profile、会话或账号数据。
