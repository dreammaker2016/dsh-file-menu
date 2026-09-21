# dsh-file-menu

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web 界面补上**右键菜单**。

DSH 的 Web 客户端本身没有任何 `contextmenu` 处理，在应用里点右键没有任何有用反应——没有复制、没有粘贴、没有"打开文件位置"。
本插件补上一个 Codex 风格的右键菜单，菜单内容随点击位置的元素类型变化。

[English](README.md) | 简体中文

## 功能

按点击位置智能生成菜单：

| 右键位置 | 菜单项 |
|---|---|
| 选中的文字 | 复制 |
| 普通段落（无选中） | 复制此段文字 |
| 输入框 / 编辑区 | 剪切 · 复制 · 粘贴 · 全选 |
| 文件引用（交付文件卡片、"生成的文件"芯片、消息里的内联文件引用） | 复制路径 · **打开文件位置** · 用默认应用打开 |
| 超链接 | 复制链接地址 · 在浏览器中打开 |
| Alt + 右键 | 诊断：复制元素信息（排查用） |

- **复制**：优先走宿主路由 `/file-menu/clipboard`（Electron 主进程剪贴板，失败退回 PowerShell `Set-Clipboard`），
  不依赖渲染进程的剪贴板权限；宿主路由不可用时，客户端退回浏览器本地 `document.execCommand('copy')`。
- **打开文件位置**：在系统支持"选中"的平台上会真正选中该文件——Windows 资源管理器 `/select`、macOS Finder `open -R`；
  Linux 的 `xdg-open` 没有选中语义，退而打开所在目录。宿主路由完全不可用时，客户端退回 DSH 自带的 `/open-in-app/open`（打开所在文件夹）。
- 文件路径识别来源：元素的 `title` / `data-path` / `data-file-path` / `dataset.*path`、**元素自身的文本**
  （DSH 工具行的 fileLink 按钮没有任何路径属性，路径只在文本里）、或选中的绝对路径。
  DSH 对**工作区内**的文件引用显示的是**相对路径**（`dsh-plugins/x/README.md`、`@docs/plan.md`），
  因此相对路径会用**当前会话的工作区根**解析——客户端从 DSH 的 `sessions` 服务读取
  （`list.getSnapshot()` → `byId[current].cwd`），`~/...` 由宿主半端展开。取不到工作区根时不猜，
  直接不显示文件操作行。

## 安装

```sh
dsh plugin --profile web add dsh-file-menu
```

profile 名写你实际在用的那个（Web 客户端是 `web`，DSH Desktop 用你自己的 profile 名）。装完**重启 DSH** 才会加载。

## 卸载

```sh
dsh plugin --profile web remove dsh-file-menu
```

## 限制

- 出现在正文里的相对路径，只有**单个 token**（不含空白）、**含路径分隔符**且**末段带文件扩展名**时才会被识别。
  带空格的路径、只有文件名（没有目录）、没有扩展名的目录会被跳过——这正是「复制/粘贴」这类正常文字不会长出文件操作行的原因。
- 相对路径依赖当前会话的工作区根。如果读不到 DSH 的 `sessions` 服务，就不显示文件操作行，而不是瞎猜。
- 两端版本各自独立：客户端半端（`lib/client.js`）跟随包版本，宿主半端版本从 `GET /file-menu/status` 读取。

## 原理

- **宿主半端** `lib/index.js`：`webServer` 前缀路由 `/file-menu`，提供
  `ping`、`status`、`hello`、`menu`、`diag`、`clipboard`、`reveal`、`open`。
  `reveal` / `open` 接收 `{ path, base }`：绝对路径直接用、`~/...` 展开到家目录、相对路径按 `base`
  （会话工作区根）拼接，最后只对真实存在的路径动手。
- **客户端半端** `lib/client.js`：捕获阶段监听 `contextmenu` + 纯 DOM 菜单（不依赖 React）；
  用 `pointerdown` + `elementFromPoint` 命中激活，避免上游 `stopPropagation` 把点击吞掉。
- `cordis.patch.yml`：注册宿主半端的那一行。宿主条目声明了 `dsh.client`，客户端 bundle 由 DSH 自动下发。

维护者笔记（HMR 踩坑、事件被吞、没有浏览器控制台时怎么排查）见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 许可

MIT
