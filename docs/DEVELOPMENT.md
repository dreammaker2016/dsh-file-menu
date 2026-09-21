# 开发与排查记录（dsh-file-menu）

本文是给维护者看的：客户端半端为何写成这样、踩过哪些坑、没有浏览器控制台时怎么定位问题。
面向用户的安装与功能说明见 [README.zh.md](../README.zh.md)。

## 组成

| 文件 | 说明 |
|---|---|
| `lib/index.js` | 宿主半端：`webServer` 前缀路由 `/file-menu`（`ping` `status` `hello` `menu` `diag` `clipboard` `reveal` `open`） |
| `lib/client.js` | 客户端半端：捕获阶段监听 `contextmenu`，纯 DOM 菜单（不依赖 React） |
| `cordis.patch.yml` | bundle 补丁：向宿主插入一行 |
| `install.ps1` / `uninstall.ps1` | 本地开发期安装 / 卸载（正常用户用 `dsh plugin add`，不需要这两个脚本；脚本以 `$PSScriptRoot` 为包根，必须留在仓库根目录） |

## 踩坑记录（血泪，改代码前务必看）

1. **HMR 会重新实例化客户端模块，安装必须跨实例幂等。**
   每推一次新版本，浏览器里就会多一份模块实例，旧实例的 DOM 监听器不会自动消失。
   本插件的做法：监听表存 `window.__dshFileMenuListeners`，新实例启动时按引用逐个 `removeEventListener`；
   同时用 `window.__dshFileMenuGeneration` 代际号，让任何残留的旧监听器在入口处自我禁用。
   **不给这两层保护，一次右键会被 N 套监听器同时处理**，弹出多个同 ID 菜单、命中测试用错矩形（现象：菜单能弹但点了没反应）。
2. **`apply()` 里必须调用 `ensureStyle()`。** 漏掉它菜单仍会创建但没有 CSS，会渲染成页面底部一条无样式裸 div（现象：右键"全没东西"）。
3. **菜单项激活不要依赖 `click`。** 上游可能在捕获阶段 `stopPropagation` 把 click 吞掉。
   本插件在 `window` 捕获阶段监听 `pointerdown`，用 `elementFromPoint` + `data-index` 命中并直接激活，随后吞掉 mouseup/click 防止误触下层。
4. **window 与 document 双注册时要用事件标记去重**（`event.__dshFmPd` 等），否则同一事件被处理两遍，重复弹菜单。
5. **`blur` 监听要判断 `event.target === window`**：元素失焦也会冒泡到 window 捕获，否则一点菜单就自己关掉。
6. **客户端改动能热更新、宿主端不能**：`lib/client.js` 改完刷新页面即生效（HMR 还会自动推送）；
   `lib/index.js` 改完必须重启 DSH（未重启时新路由返回 405）。
7. **没有浏览器控制台时的调试法**：客户端把右键目标、识别路径、菜单矩形、顶层元素、点击项、异常全部 POST 到
   `/file-menu/diag`，服务端 `GET /file-menu/status` 就能读到 —— 本插件能定位到具体行就是靠这个。
8. 文件路径来自元素 `title` / `data-path` / `dataset.*path` / 选中文本；DSH 的"生成文件"芯片是
   `<button class="...producedChip" title="<绝对路径>">`，消息内联文件引用是 `<code><button class="...fileMention" title="<绝对路径>">`。

## 原理与注意

1. **客户端 bundle 下发**：宿主 `dsh-client-modules` 会扫描声明了 `dsh.client` 的宿主条目并自动下发客户端 bundle，所以插件只需要出现在宿主 loader 里。
   本地开发期通过 profile 的 `cordis.patch.yml` 插入行注册（不动 `package.json`，避免触发 pnpm `--frozen-lockfile` 校验）；作为正式插件安装时则由包内 `cordis.patch.yml` 生效。
2. **右键事件可能被吞**：某些元素在 `mousedown` 里 `preventDefault()` 会让 Chromium 不派发 `contextmenu`。
   客户端因此额外用 `pointerdown`/`pointerup` 记录右键手势做兜底，180ms 内没有收到 `contextmenu` 就自己弹菜单。
3. **改宿主代码后必须重启 DSH**：profile patch 的热重载只会更新既有行的配置，不会新增插件行。
4. **跨平台**：`reveal` / `open` 按 `process.platform` 分支——Windows `explorer /select` + `cmd /c start`，
   macOS `open -R` + `open`，Linux `xdg-open`（`xdg-open` 没有"选中"语义，退而打开所在目录）。
   只有 Windows 与 macOS 能真正"选中"文件。
5. **剪贴板优先级**：Electron 主进程 `clipboard.writeText` → PowerShell `Set-Clipboard`（文本走 base64，避免编码与引号问题）→ 渲染进程 `document.execCommand('copy')`。
