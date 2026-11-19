#!/usr/bin/env node
// 自检：证明"这个包装到别人机器上不会指回我的机器"。
// 不 import 入口（apply 有副作用），只做静态扫描 + 配置行为 + 分发完整性检查。
import { readFile, readdir, stat, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { resolveConfig, resolveHome } from '../config.js'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]scripts$/, '')

// 四条独立正则：单反斜杠盘符、POSIX 用户目录、UNC、本机 DSH_HOME。
// UNC 必须带主机名（\\server\share），否则 `[\\/:*?"<>|]` 这类 JS 转义会被误判成路径。
export const PATTERNS = [
  { name: 'windows-drive', re: /[A-Za-z]:\\/ },
  { name: 'posix-home', re: /\/Users\/[^/]+\// },
  { name: 'unc', re: /\\\\[A-Za-z0-9._-]+\\[A-Za-z0-9._-]+/ },
  { name: 'dsh-home', re: /DeepSeekHarness[\\/](database|logs)/i },
]

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
  const targets = ['index.js', 'client.js', 'cordis.patch.yml', 'package.json', 'README.md']
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
  for (const rel of ['index.js', 'client.js', 'cordis.patch.yml', 'locale/zh.json', 'locale/en.json']) {
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
  const blankEnv = { DSH_HOME: join(base, 'home') }
  try {
    const unconfigured = await resolveConfig({ workspace: '', bridgeConfigPath: '' }, blankEnv)
    if (unconfigured.workspace.state !== 'unconfigured') problems.push(`未配置时 workspaceState=${unconfigured.workspace.state}（应为 unconfigured）`)
    if (unconfigured.bridge.state !== 'unconfigured') problems.push(`未配置时 bridgeState=${unconfigured.bridge.state}（应为 unconfigured）`)

    const invalid = await resolveConfig({ workspace: 'relative/path' }, blankEnv)
    if (invalid.workspace.state !== 'invalid') problems.push('相对路径应判为 invalid')

    const ready = await resolveConfig({ workspace: join(base, 'ws') }, blankEnv)
    if (ready.workspace.state !== 'ready') problems.push(`临时目录应判为 ready，实际 ${ready.workspace.state}: ${ready.workspace.reason}`)
    // 用解析后的真实路径比较：临时目录可能是 8.3 短名，realpath 会展开成长名。
    const root = (ready.workspace.path || '').toLowerCase()
    const under = (value) => root !== '' && String(value || '').toLowerCase().startsWith(root)
    if (!under(ready.workspace.notesDir)) problems.push('notesDir 未落在 workspace 内')
    if (!under(ready.workspace.bridgeConfigPath)) problems.push('bridgeConfigPath 未落在 workspace 内')
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

async function checkDist(root) {
  const problems = []
  for (const rel of ['index.js', 'client.js', 'config.js', 'cordis.patch.yml', 'package.json', 'locale/zh.json', 'icon.svg', 'README.md']) {
    const info = await stat(join(root, rel)).catch(() => null)
    if (!info) problems.push(`分发目录缺必需文件：${rel}`)
  }
  if (problems.length === 0) {
    problems.push(...(await checkStructure(root)))
    // 入口只做语法检查（node --check 语义），绝不 import：apply 会注册工具、清授权、连桥。
    const { execFile } = await import('node:child_process')
    for (const rel of ['index.js', 'client.js', 'config.js']) {
      const result = await new Promise((resolve) => {
        execFile(process.execPath, ['--check', join(root, rel)], (error, _stdout, stderr) => resolve({ ok: !error, stderr }))
      })
      if (!result.ok) problems.push(`语法检查失败：${rel} ${String(result.stderr || '').slice(0, 200)}`)
    }
  }
  return problems
}

export async function runSelfcheck({ root = PLUGIN_DIR, dist = false } = {}) {
  const problems = []
  problems.push(...(await checkStructure(root)))
  const scan = await scanPlugin(root)
  problems.push(...scan.problems)
  for (const hit of scan.hits) problems.push(`机器绝对路径：${hit.file}:${hit.line} [${hit.pattern}] ${hit.text}`)
  problems.push(...(await checkConfigBehavior()))
  problems.push(...(await checkHome()))
  if (dist) problems.push(...(await checkDist(root)))
  return { ok: problems.length === 0, problems, hits: scan.hits.length }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dist = process.argv.includes('--dist')
  const root = dist ? PLUGIN_DIR : PLUGIN_DIR
  const result = await runSelfcheck({ root, dist })
  console.log(`selfcheck: ${result.ok ? 'OK' : 'FAILED'} (pattern hits: ${result.hits})`)
  for (const problem of result.problems) console.log(`  - ${problem}`)
  process.exitCode = result.ok ? 0 : 1
}
