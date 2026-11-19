#!/usr/bin/env node
// 自检：证明"这个包装到别人机器上不会指回我的机器"，并且证明「验的是独立分发副本」。
// 不 import 入口（apply 有副作用），只做静态扫描 + 配置行为 + 分发完整性检查。
import { readFile, readdir, realpath, stat, mkdir, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, isAbsolute, join, relative, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { resolveConfig, resolveHome } from '../config.js'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]scripts$/, '')

// 要被扫描「机器绝对路径」的运行时代码与配置：与 checkDist() 的必需文件集同源，避免两处漂移。
export const SCAN_TARGETS = ['index.js', 'config.js', 'client.js', 'cordis.patch.yml', 'package.json', 'README.md']

// 四条独立正则：单反斜杠盘符、POSIX 用户目录、UNC、本机 DSH_HOME。
// UNC 必须带主机名（\\server\share），否则 `[\\/:*?"<>|]` 这类 JS 转义会被误判成路径。
export const PATTERNS = [
  { name: 'windows-drive', re: /[A-Za-z]:\\/ },
  { name: 'posix-home', re: /\/Users\/[^/]+\// },
  { name: 'unc', re: /\\\\[A-Za-z0-9._-]+\\[A-Za-z0-9._-]+/ },
  { name: 'dsh-home', re: /DeepSeekHarness[\\/](database|logs)/i },
]

// ── 路径判定（顾问 GO 里点名的实现要求） ───────────────────────────────────────

// 扩展长度前缀 \\?\C:\x → C:\x；\\?\UNC\server\share → \\server\share。
// 只做规范化，不能因为"去掉前缀了"就认为安全——边界判定统一走 isInsideNormalized。
export function stripExtendedPath(input) {
  const text = String(input || '')
  if (!text.startsWith('\\\\?\\')) return text
  const rest = text.slice(4)
  if (/^UNC\\/i.test(rest)) return `\\\\${rest.slice(4)}`
  return rest
}

// 驱动器相对路径（C:foo、C:..\outside）不是绝对路径，一律拒绝当 workspace 或 candidate。
export function isDriveRelative(input) {
  return /^[A-Za-z]:(?![\\/])/.test(String(input || ''))
}

export function isWindows() {
  return process.platform === 'win32'
}

// 平台化比较键：Windows 大小写不敏感、分隔符统一；POSIX 保持原样。
function compareKey(input) {
  const text = stripExtendedPath(input)
  if (!isWindows()) return text
  return text.replace(/\//g, '\\').toLowerCase()
}

// UNC 共享根：\\server\share。不同共享根之间不能互为子目录。
function uncRoot(input) {
  const hit = /^\\\\([^\\]+)\\([^\\]+)/.exec(stripExtendedPath(input))
  return hit ? `\\\\${hit[1]}\\${hit[2]}` : ''
}

// 纯字符串的边界判定（调用方必须已经 realpath 过）。
// 不用 startsWith：`C:\work` 不能匹配 `C:\workspace-escape\x`。
export function isInsideNormalized(root, candidate) {
  const a = String(root || '')
  const b = String(candidate || '')
  if (!a || !b) return false
  if (!isAbsolute(stripExtendedPath(a)) || !isAbsolute(stripExtendedPath(b))) return false
  if (isDriveRelative(a) || isDriveRelative(b)) return false
  const rootUnc = uncRoot(a)
  const candUnc = uncRoot(b)
  if (rootUnc && candUnc && compareKey(rootUnc) !== compareKey(candUnc)) return false
  const rel = relative(stripExtendedPath(a), stripExtendedPath(b))
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  const first = rel.split(/[\\/]/)[0]
  if (first === '..') return false
  // 兜底：分隔符边界（不同卷时 relative() 会返回绝对路径，上面已拦）。
  const keyRoot = compareKey(a).replace(/[\\/]+$/, '')
  const keyCand = compareKey(b)
  return keyCand === keyRoot || keyCand.startsWith(`${keyRoot}\\`)
}

// 目标可能还不存在（gpt-notes 目录、config.json 文件）：沿最近存在的祖先 realpath 后再拼回剩余段，
// 免得"文件还没建"被误判成"逃出 workspace"。符号链接仍然按真实目标解析。
export async function realpathLoose(input) {
  const original = resolve(stripExtendedPath(input))
  let current = original
  const tail = []
  for (let guard = 0; guard < 64; guard += 1) {
    try {
      const real = await realpath(current)
      return tail.length ? join(real, ...tail.reverse()) : real
    } catch {
      const parent = dirname(current)
      if (parent === current) return original
      tail.push(basename(current))
      current = parent
    }
  }
  return original
}

// 走真实路径：符号链接/junction 必须按实际目标判定。
export async function isInside(root, candidate) {
  const rootReal = await realpathLoose(root)
  const candReal = await realpathLoose(candidate)
  // 根本身必须真实存在，否则"内部"没有意义。
  const rootExists = await stat(rootReal).then((info) => info.isDirectory()).catch(() => false)
  if (!rootExists) return false
  return isInsideNormalized(rootReal, candReal)
}

export function scanText(text, file = '') {
  const hits = []
  const lines = String(text).split(/\r?\n/)
  lines.forEach((line, index) => {
    for (const pattern of PATTERNS) {
      if (pattern.re.test(line)) hits.push({ file, line: index + 1, pattern: pattern.name, text: line.trim().slice(0, 160) })
    }
  })
  return hits
}

async function listScanTargets(root) {
  const targets = [...SCAN_TARGETS]
  const localeDir = join(root, 'locale')
  targets.push(...(await collect(localeDir, 'locale')).map((rel) => rel))
  return targets
}

// 递归收集：locale 目录缺失或读不了都要报错（不许静默跳过）。
async function collect(dir, prefix) {
  const out = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const rel = join(prefix, entry.name)
    if (entry.isDirectory()) out.push(...(await collect(join(dir, entry.name), rel)))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

export async function scanPlugin(root = PLUGIN_DIR) {
  const hits = []
  const problems = []
  let targets
  try {
    targets = await listScanTargets(root)
  } catch (error) {
    return { hits, problems: [`scan-targets-unreadable:${error.code || error.message}`] }
  }
  for (const rel of targets) {
    let text
    try {
      text = await readFile(join(root, rel), 'utf8')
    } catch (error) {
      // 目标缺失/不可读 = 失败，不是跳过
      problems.push(`target-unreadable:${rel}:${error.code || error.message}`)
      continue
    }
    hits.push(...scanText(text, rel))
  }
  return { hits, problems }
}

async function checkStructure(root) {
  const problems = []
  let pkg = null
  try {
    pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  } catch (error) {
    return [`package-json-unreadable:${error.code || error.message}`]
  }
  if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') problems.push('package.json: dsh.bundle.patch 缺失')
  if (pkg.dsh?.client?.platform !== 'web') problems.push('package.json: dsh.client.platform 必须为 web')
  if (!Array.isArray(pkg.dsh?.client?.inject) || !pkg.dsh.client.inject.length) problems.push('package.json: dsh.client.inject 不能为空')
  const exp = pkg.exports || {}
  for (const key of ['.', './client', './icon']) if (!exp[key]) problems.push(`package.json: exports 缺 ${key}`)
  if (!exp['./locale/*.json']) problems.push('package.json: exports 缺 ./locale/*.json')
  for (const rel of ['index.js', 'config.js', 'client.js', 'cordis.patch.yml', 'locale/zh.json', 'locale/en.json']) {
    const info = await stat(join(root, rel)).catch(() => null)
    if (!info) problems.push(`缺少文件：${rel}`)
  }
  const icon = await stat(join(root, 'icon.svg')).catch(() => null)
  if (!icon) problems.push('缺少 icon.svg')
  else if (icon.size > 256 * 1024) problems.push('icon.svg 超过 256KiB')
  let zh = ''
  try {
    zh = await readFile(join(root, 'locale', 'zh.json'), 'utf8')
  } catch {
    /* 已在上面报缺文件 */
  }
  if (zh && !/"title"/.test(zh)) problems.push('locale/zh.json 缺 meta.title')
  const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8').catch(() => '')
  if (patch && !/workspace:/.test(patch)) problems.push('cordis.patch.yml 缺 workspace 配置项（应显式留空并注释）')
  return problems
}

// 三态 × 桥状态的行为检查：在临时目录里真跑一遍 resolveConfig。
async function checkConfigBehavior() {
  const problems = []
  const base = join(tmpdir(), `adv-selfcheck-${Date.now().toString(36)}`)
  await mkdir(join(base, 'ws'), { recursive: true })
  // 同名前缀的兄弟目录：`ws-escape` 不能被当成 `ws` 的内部（startsWith 会误判）。
  await mkdir(join(base, 'ws-escape'), { recursive: true })
  const blankEnv = { DSH_HOME: join(base, 'home') }
  try {
    const unconfigured = await resolveConfig({ workspace: '', bridgeConfigPath: '' }, blankEnv)
    if (unconfigured.workspace.state !== 'unconfigured') problems.push(`未配置时 workspaceState=${unconfigured.workspace.state}（应为 unconfigured）`)
    if (unconfigured.bridge.state !== 'unconfigured') problems.push(`未配置时 bridgeState=${unconfigured.bridge.state}（应为 unconfigured）`)

    const invalid = await resolveConfig({ workspace: 'relative/path' }, blankEnv)
    if (invalid.workspace.state !== 'invalid') problems.push('相对路径应判为 invalid')

    const ready = await resolveConfig({ workspace: join(base, 'ws') }, blankEnv)
    if (ready.workspace.state !== 'ready') problems.push(`临时目录应判为 ready，实际 ${ready.workspace.state}: ${ready.workspace.reason}`)
    // 用解析后的真实路径做边界判断：临时目录可能是 8.3 短名，realpath 会展开成长名。
    const rootReal = await realpath(ready.workspace.path).catch(() => '')
    if (!rootReal) problems.push('workspace realpath 解析失败')
    const insideChecks = [
      ['notesDir', ready.workspace.notesDir],
      ['bridgeConfigPath', ready.workspace.bridgeConfigPath],
    ]
    for (const [label, value] of insideChecks) {
      const ok = await isInside(rootReal || ready.workspace.path, value)
      if (!ok) problems.push(`${label} 未落在 workspace 内（实际 ${value}）`)
    }
    // 兄弟前缀目录必须被拒绝（回归 P1-1）。
    if (isInsideNormalized(rootReal || ready.workspace.path, join(base, 'ws-escape', 'notes'))) {
      problems.push('同名前缀兄弟目录被误判为 workspace 内部（路径边界判断失效）')
    }
    if (ready.bridge.state !== 'unconfigured') problems.push(`没有桥配置时 bridgeState=${ready.bridge.state}（应为 unconfigured）`)
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {})
  }
  return problems
}

async function checkHome() {
  const problems = []
  const base = join(tmpdir(), `adv-home-${Date.now().toString(36)}`)
  await mkdir(base, { recursive: true })
  try {
    const withVar = resolveHome({ DSH_HOME: join(base, 'h1') })
    if (!withVar.logDir.startsWith(join(base, 'h1'))) problems.push('DSH_HOME 存在时未按它推导日志目录')
    const withoutVar = resolveHome({})
    if (!withoutVar.logDir) problems.push('没有 DSH_HOME 时没有兜底日志目录')
    // 日志目录不可创建（父路径是文件）：不能抛错，只能降级
    const blocker = join(base, 'blocked')
    await writeFile(blocker, 'x')
    const broken = resolveHome({ DSH_HOME: join(blocker, 'database') })
    if (!broken.logDir) problems.push('日志目录不可用时应降级而不是崩溃')
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {})
  }
  return problems
}

// --dist 必须验「独立分发目录」：不能退回源码目录，否则等于什么也没证明。
// 源码目录不能靠 import.meta.url 推断——在分发副本里运行时它就是副本自己（这正是 P0-2 的复现路径），
// 所以要求显式 --source 指向源码树；没给就判失败，不许猜。
async function checkDist(root, sourceDir) {
  const problems = []
  if (!sourceDir) return { problems: ['source-root-unknown: --dist 需要 --source 指向源码目录，不能用脚本自身位置推断'] }
  const sourceReal = await realpath(sourceDir).catch(() => '')
  const distReal = await realpath(root).catch(() => '')
  if (!distReal) problems.push(`dist-root-unreadable:${root}`)
  else if (sourceReal && compareKey(sourceReal) === compareKey(distReal)) {
    problems.push('dist-root-same-as-source: --root 指向了源码目录，没有验证独立产物')
  }
  for (const rel of ['index.js', 'client.js', 'config.js', 'cordis.patch.yml', 'package.json', 'locale/zh.json', 'icon.svg', 'README.md']) {
    const info = await stat(join(root, rel)).catch(() => null)
    if (!info) problems.push(`分发目录缺必需文件：${rel}`)
  }
  if (problems.length === 0) {
    problems.push(...(await checkStructure(root)))
    // 入口只做语法检查（node --check 语义），绝不 import：apply 会注册工具、清授权、连桥。
    for (const rel of ['index.js', 'client.js', 'config.js']) {
      const result = await new Promise((resolveCheck) => {
        execFile(process.execPath, ['--check', join(root, rel)], (error, _stdout, stderr) => resolveCheck({ ok: !error, stderr }))
      })
      if (!result.ok) problems.push(`语法检查失败：${rel} ${String(result.stderr || '').slice(0, 200)}`)
    }
  }
  return { problems, distReal, sourceReal }
}

export async function runSelfcheck({ root = PLUGIN_DIR, dist = false, sourceDir = '' } = {}) {
  const problems = []
  problems.push(...(await checkStructure(root)))
  const scan = await scanPlugin(root)
  problems.push(...scan.problems)
  for (const hit of scan.hits) problems.push(`机器绝对路径：${hit.file}:${hit.line} [${hit.pattern}] ${hit.text}`)
  problems.push(...(await checkConfigBehavior()))
  problems.push(...(await checkHome()))
  let distReal = ''
  if (dist) {
    const checked = await checkDist(root, sourceDir)
    problems.push(...checked.problems)
    distReal = checked.distReal || ''
  }
  return { ok: problems.length === 0, problems, hits: scan.hits.length, distReal }
}

function argValue(argv, name) {
  const index = argv.findIndex((item) => item === name || item.startsWith(`${name}=`))
  if (index < 0) return ''
  const hit = argv[index]
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1)
  const next = argv[index + 1]
  return next && !next.startsWith('--') ? next : ''
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2)
  const dist = argv.includes('--dist')
  const rootArg = argValue(argv, '--root')
  const sourceArg = argValue(argv, '--source')
  if (dist && !rootArg) {
    console.log('selfcheck: FAILED (--dist 需要 --root 指向独立分发目录，不允许退回源码目录)')
    process.exit(2)
  }
  const root = rootArg ? resolve(rootArg) : PLUGIN_DIR
  const sourceDir = sourceArg ? resolve(sourceArg) : PLUGIN_DIR
  const result = await runSelfcheck({ root, dist, sourceDir })
  console.log(`selfcheck: ${result.ok ? 'OK' : 'FAILED'} (pattern hits: ${result.hits})`)
  console.log(`  root: ${root}`)
  if (dist) console.log(`  dist realpath: ${result.distReal || '(unresolved)'}  source: ${sourceDir}`)
  for (const problem of result.problems) console.log(`  - ${problem}`)
  process.exitCode = result.ok ? 0 : 1
}
