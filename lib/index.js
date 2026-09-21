/**
 * dsh-file-menu 宿主半端：为 Web 侧的右键菜单提供原生能力。
 *
 * 路由（挂在 webServer 上，受桌面端网络门禁保护；仅接受绝对路径）：
 *   GET  /file-menu/ping                可用性探测
 *   POST /file-menu/reveal    { path }  在文件管理器中定位（Windows explorer /select，macOS open -R，Linux xdg-open）
 *   POST /file-menu/open      { path }  用系统默认应用打开
 *   POST /file-menu/clipboard { text }  写入系统剪贴板（渲染进程剪贴板权限不可靠时的兜底）
 */
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'

export const name = 'file-menu'
export const inject = ['webServer']

/** 宿主半端版本；与客户端半端各自独立，便于对照排查。 */
const HOST_VERSION = '0.4.0'

/**
 * 运行时统计：客户端每次加载/弹菜单/执行操作都会回报，便于在无法查看
 * 浏览器控制台时确认「客户端到底跑没跑、跑的哪个版本、点了什么」。
 */
const runtimeStats = {
  hello: 0,
  clientVersion: '',
  lastHelloAt: '',
  menuShown: 0,
  clipboard: 0,
  reveal: 0,
  open: 0,
  lastError: '',
  diag: 0,
}

/** 最近 40 条客户端行为记录（右键目标、识别到的路径、菜单项、点击项）。 */
const diagLog = []

/** 统一的 JSON 响应。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 读取并解析请求体（上限 1 MiB，长文本复制也能过）。 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1024 * 1024) {
        resolve(undefined)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => resolve(undefined))
  })
}

/** 取出并校验绝对路径。 */
function absolutePathOf(body) {
  const value = body !== null && typeof body === 'object' && typeof body.path === 'string' ? body.path.trim() : ''
  return value !== '' && isAbsolute(value) ? value : ''
}

/** 启动一个分离的原生进程（explorer 的退出码不可靠，只等 spawn）。 */
function spawnDetached(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/**
 * 在系统文件管理器中定位路径。
 *   win32  资源管理器 /select 选中该文件（目录则直接打开）
 *   darwin Finder `open -R` 选中
 *   linux  xdg-open 没有「选中」语义，退而打开所在目录
 */
async function revealInFileManager(target, isDirectory) {
  if (process.platform === 'win32') {
    await spawnDetached('explorer.exe', [isDirectory ? target : `/select,"${target}"`])
    return
  }
  if (process.platform === 'darwin') {
    await spawnDetached('open', isDirectory ? [target] : ['-R', target])
    return
  }
  await spawnDetached('xdg-open', [isDirectory ? target : dirname(target)])
}

/** 用系统默认应用打开路径。 */
async function openWithDefaultApp(target) {
  if (process.platform === 'win32') {
    await spawnDetached('cmd.exe', ['/c', 'start', '', target])
    return
  }
  if (process.platform === 'darwin') {
    await spawnDetached('open', [target])
    return
  }
  await spawnDetached('xdg-open', [target])
}

/** 用 PowerShell 的 Set-Clipboard 写系统剪贴板（文本经 base64 传递，避免编码与引号问题）。 */
function clipboardViaPowerShell(text) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(text, 'utf8').toString('base64')
    const script = `Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))`
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve('powershell')
      else reject(new Error(`Set-Clipboard 退出码 ${String(code)}${stderr === '' ? '' : `: ${stderr.trim()}`}`))
    })
  })
}

/** 优先用 Electron 主进程的 clipboard，退回 PowerShell。 */
async function writeClipboard(text) {
  try {
    const electron = await import('electron')
    const clipboard = electron?.clipboard
    if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
      clipboard.writeText(text)
      return 'electron'
    }
  } catch {
    /* 非 Electron 环境（或 ELECTRON_RUN_AS_NODE），退回 PowerShell */
  }
  return await clipboardViaPowerShell(text)
}

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/file-menu',
        handler: async (req, res) => {
          const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
          const action = pathname.slice('/file-menu/'.length)
          if (action === 'ping') {
            sendJson(res, 200, { ok: true, platform: process.platform, hostVersion: HOST_VERSION })
            return
          }
          if (action === 'status' && (req.method === 'GET' || req.method === 'HEAD')) {
            sendJson(res, 200, {
              ok: true,
              hostVersion: HOST_VERSION,
              platform: process.platform,
              stats: runtimeStats,
              diag: diagLog.slice(-40),
            })
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const body = await readJsonBody(req)

          // 客户端自报：加载成功与弹菜单次数，用于在没有浏览器控制台时确认状态。
          if (action === 'hello') {
            runtimeStats.hello += 1
            runtimeStats.clientVersion = body !== null && typeof body === 'object' && typeof body.version === 'string' ? body.version : ''
            runtimeStats.lastHelloAt = new Date().toISOString()
            sendJson(res, 200, { ok: true, hostVersion: HOST_VERSION })
            return
          }
          if (action === 'menu') {
            runtimeStats.menuShown += 1
            sendJson(res, 200, { ok: true })
            return
          }
          // 客户端行为全量记录：右键目标、识别路径、菜单项、点击项。
          if (action === 'diag') {
            runtimeStats.diag += 1
            diagLog.push(
              Object.assign({ at: new Date().toISOString(), seq: runtimeStats.diag }, body !== null && typeof body === 'object' ? body : {}),
            )
            if (diagLog.length > 200) diagLog.splice(0, diagLog.length - 200)
            sendJson(res, 200, { ok: true })
            return
          }

          if (action === 'clipboard') {
            const text = body !== null && typeof body === 'object' && typeof body.text === 'string' ? body.text : ''
            if (text === '') {
              sendJson(res, 400, { ok: false, error: '缺少 text' })
              return
            }
            try {
              const via = await writeClipboard(text)
              runtimeStats.clipboard += 1
              sendJson(res, 200, { ok: true, via, length: text.length })
            } catch (error) {
              runtimeStats.lastError = error instanceof Error ? error.message : String(error)
              sendJson(res, 500, { ok: false, error: runtimeStats.lastError })
            }
            return
          }

          const target = absolutePathOf(body)
          if (target === '') {
            sendJson(res, 400, { ok: false, error: '需要绝对路径' })
            return
          }
          if (!existsSync(target)) {
            sendJson(res, 404, { ok: false, error: '路径不存在' })
            return
          }
          try {
            if (action === 'reveal') {
              await revealInFileManager(target, statSync(target).isDirectory())
              runtimeStats.reveal += 1
              sendJson(res, 200, { ok: true, action: 'reveal', path: target, platform: process.platform })
              return
            }
            if (action === 'open') {
              await openWithDefaultApp(target)
              runtimeStats.open += 1
              sendJson(res, 200, { ok: true, action: 'open', path: target })
              return
            }
            sendJson(res, 404, { ok: false, error: '未知操作' })
          } catch (error) {
            runtimeStats.lastError = error instanceof Error ? error.message : String(error)
            sendJson(res, 500, { ok: false, error: runtimeStats.lastError })
          }
        },
      }),
    'file-menu: routes',
  )
}
