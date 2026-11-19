// 配置解析与状态判定：全部纯函数式，方便测试；不读 process.cwd() 兜底。
// 设计约束（顾问 GO 的方案，勿随意放宽）：
// - workspace 未配置 ⇒ unconfigured，禁止一切受保护写入；
// - 提供了值但不合法（相对路径/不存在/非目录/逃逸）⇒ invalid('workspace-*')；
// - notesDir / bridgeConfigPath 必须落在 workspace 内，符号链接逃逸一律拒绝；
// - 桥状态与路径推导解耦：路径只是"我们会去哪里找"，状态看实际文件内容与健康探测。
import { realpath as fsRealpath, stat as fsStat, readFile as fsReadFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir, tmpdir } from 'node:os'

export const WORKSPACE_STATES = ['ready', 'unconfigured', 'invalid']
export const BRIDGE_STATES = ['ready', 'unconfigured', 'unreachable']

function blank(value) {
  return value === undefined || value === null || String(value).trim() === ''
}

// 目标自身 realpath；不存在时取最近存在祖先，再拼回剩余段后重新校验。
// 只对父目录做 realpath 是不够的：gpt-notes 或 config.json 本身可能就是指向 workspace 外的符号链接。
export function resolveInside(root, target) {
  // 先把 root 自己 realpath：调用方可能拿到 8.3 短名，而目标的 realpath 是长名，直接比会误判逃逸。
  return fsRealpath(root).then((rootReal) => resolveInsideReal(rootReal, target))
}

function resolveInsideReal(rootReal, target) {
  const abs = isAbsolute(target) ? target : resolve(rootReal, target)
  return fsRealpath(abs).then(
    (real) => ({ ok: inside(rootReal, real), resolved: real, reason: inside(rootReal, real) ? '' : 'path-escape' }),
    async (error) => {
      if (error && error.code !== 'ENOENT') return { ok: false, resolved: abs, reason: `path-unreadable:${error.code}` }
      // 不存在：逐级向上找最近存在祖先
      const segments = []
      let cursor = abs
      for (;;) {
        const parent = resolve(cursor, '..')
        if (parent === cursor) return { ok: false, resolved: abs, reason: 'path-no-ancestor' }
        segments.unshift(cursor.slice(parent.length).replace(/^[\\/]+/, ''))
        cursor = parent
        try {
          const realAnc = await fsRealpath(cursor)
          if (!inside(rootReal, realAnc)) return { ok: false, resolved: abs, reason: 'path-escape' }
          const rebuilt = join(realAnc, ...segments)
          return { ok: rebuilt === rootReal || inside(rootReal, rebuilt), resolved: rebuilt, reason: inside(rootReal, rebuilt) ? '' : 'path-escape' }
        } catch (ancError) {
          if (ancError && ancError.code !== 'ENOENT') return { ok: false, resolved: abs, reason: `path-unreadable:${ancError.code}` }
        }
      }
    },
  )
}

export function inside(rootReal, candidate) {
  const rel = relative(rootReal, candidate)
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))
}

// DSH_HOME 契约：变量优先，其次本机常见位置，最后临时目录；日志失败绝不能让 apply 失败。
export function resolveHome(env = process.env) {
  const candidates = [env.DSH_HOME, join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'DeepSeekHarness', 'database'), join(tmpdir(), 'dsh-database')]
  const home = candidates.find((value) => !blank(value))
  return { home, logDir: join(home, 'logs') }
}

export function workspaceConfig(raw = {}, env = process.env) {
  const fromConfig = blank(raw.workspace) ? '' : String(raw.workspace).trim()
  const fromEnv = blank(env.DSH_WORKSPACE) ? '' : String(env.DSH_WORKSPACE).trim()
  // 空值不是显式错误，只是"未提供"：空串/纯空白继续尝试环境变量。
  const chosen = fromConfig || fromEnv
  if (!chosen) return { state: 'unconfigured', reason: 'workspace-unconfigured', path: '', source: '' }
  const source = fromConfig ? 'config' : 'env'
  if (!isAbsolute(chosen)) return { state: 'invalid', reason: 'workspace-not-absolute', path: chosen, source }
  return fsRealpath(chosen).then(
    async (real) => {
      const info = await fsStat(real).catch(() => null)
      if (!info) return { state: 'invalid', reason: 'workspace-missing', path: chosen, source }
      if (!info.isDirectory()) return { state: 'invalid', reason: 'workspace-not-directory', path: chosen, source }
      const notes = await resolveInside(real, join(real, 'gpt-notes'))
      if (!notes.ok) return { state: 'invalid', reason: `notes-${notes.reason}`, path: chosen, source }
      const bridgeFile = await resolveInside(real, join(real, '雷电bridge', 'windows-bridge', 'config.json'))
      if (!bridgeFile.ok) return { state: 'invalid', reason: `bridge-config-${bridgeFile.reason}`, path: chosen, source }
      return {
        state: 'ready',
        reason: '',
        path: real,
        source,
        notesDir: notes.resolved,
        bridgeConfigPath: bridgeFile.resolved,
      }
    },
    (error) => ({ state: 'invalid', reason: 'workspace-missing', path: chosen, source, detail: error && error.code }),
  )
}

// 桥状态只看实际内容：文件缺失/JSON 坏/缺 token ⇒ unconfigured；连不上 ⇒ unreachable；能连 ⇒ ready。
export async function bridgeConfig(path, env = process.env, { timeoutMs = 3000, fetchImpl = fetch } = {}) {
  let rawText = ''
  if (path) {
    try {
      rawText = await fsReadFile(path, 'utf8')
    } catch (error) {
      if (error && error.code !== 'ENOENT') return { state: 'unconfigured', reason: 'bridge-config-unreadable', detail: error.code }
    }
  }
  let parsed = {}
  if (rawText.trim()) {
    try {
      parsed = JSON.parse(rawText)
    } catch (error) {
      return { state: 'unconfigured', reason: 'bridge-config-invalid-json' }
    }
  }
  const token = String(parsed.token || env.DSH_BRIDGE_TOKEN || '').trim()
  const baseUrl = String(parsed.baseUrl || env.DSH_BRIDGE_URL || '').trim() || 'http://127.0.0.1:18765'
  if (!token) return { state: 'unconfigured', reason: 'bridge-token-missing', baseUrl }
  const controller = new AbortController()
  // 不只依赖 fetch 尊重 signal：用 Promise.race 保证 3 秒上限对任何实现都成立。
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(Object.assign(new Error('bridge health timeout'), { name: 'TimeoutError' }))
    }, timeoutMs)
  })
  try {
    const response = await Promise.race([
      fetchImpl(`${baseUrl}/v1/health`, { headers: { 'X-DSH-Token': token }, signal: controller.signal }),
      timeout,
    ])
    if (!response || !response.ok) return { state: 'unreachable', reason: `bridge-health-${response ? response.status : 'no-response'}`, token, baseUrl }
    return { state: 'ready', reason: '', token, baseUrl }
  } catch (error) {
    return { state: 'unreachable', reason: `bridge-unreachable:${(error && error.name) || 'error'}`, token, baseUrl }
  } finally {
    clearTimeout(timer)
  }
}

export async function resolveConfig(raw = {}, env = process.env) {
  const { home, logDir } = resolveHome(env)
  const workspace = await workspaceConfig(raw, env)
  const bridge = await bridgeConfig(workspace.state === 'ready' ? workspace.bridgeConfigPath : '', env, { fetchImpl: raw.fetchImpl })
  return { home, logDir, workspace, bridge }
}
