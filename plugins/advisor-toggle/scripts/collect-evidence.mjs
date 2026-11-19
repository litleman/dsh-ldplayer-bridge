// 采集分发包证据：逐文件语法检查、27 文件哈希对照、配置三态、全量测试、selfcheck。
// 只读源码 + 写 docs/dist-evidence.txt；不改任何生产逻辑。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const PLUGIN_DIR = 'D:\\Administrator\\allWorkFiles\\ds-workspace\\plugins\\advisor-toggle'
const DIST_DIR = 'D:\\Administrator\\allWorkFiles\\Work\\dsh-ldplayer-bridge\\plugins\\advisor-toggle'
const DIST_REPO = 'D:\\Administrator\\allWorkFiles\\Work\\dsh-ldplayer-bridge'
const EVIDENCE = join(PLUGIN_DIR, 'docs', 'dist-evidence.txt')

const lines = []
const steps = []
let failed = false

function record(step, { cwd, exit, stdout = '', stderr = '', result }) {
  steps.push({ step, cwd, exit, stdout, stderr, result })
  if (result !== 'PASS') failed = true
}

function run(cmd, args, cwd) {
  const out = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { code: out.status, stdout: out.stdout || '', stderr: out.stderr || '' }
}

// PowerShell Get-FileHash：避免假设 sha256sum 存在
function fileHash(path) {
  const r = run('powershell', ['-NoProfile', '-Command', `(Get-FileHash -Algorithm SHA256 -LiteralPath '${path}').Hash.ToLower()`], PLUGIN_DIR)
  const hash = (r.stdout || '').trim()
  return r.code === 0 && /^[0-9a-f]{64}$/.test(hash) ? hash : ''
}

async function walk(dir, base = dir, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, base, acc)
    else acc.push(relative(base, full).replaceAll('\\', '/'))
  }
  return acc
}

// ---- A. 逐文件语法检查 ----
for (const file of ['index.js', 'client.js', 'config.js']) {
  const r = run(process.execPath, ['--check', file], PLUGIN_DIR)
  record(`node --check ${file}`, { cwd: PLUGIN_DIR, exit: r.code, stdout: r.stdout, stderr: r.stderr, result: r.code === 0 ? 'PASS' : 'FAIL' })
}

// ---- B. 版本一致性 ----
const head = run('git', ['rev-parse', '--short', 'HEAD'], PLUGIN_DIR)
const dirty = run('git', ['status', '--porcelain', '--', '.'], PLUGIN_DIR)
record('git rev-parse HEAD (source version)', { cwd: PLUGIN_DIR, exit: head.code, stdout: head.stdout.trim(), result: head.code === 0 ? 'PASS' : 'FAIL' })
record('git status --porcelain plugins/advisor-toggle', { cwd: PLUGIN_DIR, exit: dirty.code, stdout: dirty.stdout.trim() || '(clean)', result: dirty.code === 0 ? 'PASS' : 'FAIL' })

// ---- C. 分发文件清单（以公开仓库 HEAD 为准） ----
// 清单里的文件数不是常量：插件自己会新增脚本/文档。用"工作副本实际文件集"来比对，
// 而不是写死 27——写死会让加文件后的采集无端 FAIL，也会掩盖"分发包缺文件"。
const listed = run('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'plugins/advisor-toggle'], DIST_REPO)
const manifest = listed.stdout.split(/\r?\n/).filter(Boolean).map((p) => p.replace(/^plugins\/advisor-toggle\//, '')).sort()
const localFiles = (await walk(PLUGIN_DIR)).sort()
const setDiff = [
  ...localFiles.filter((f) => !manifest.includes(f)).map((f) => `NOT-IN-HEAD: ${f}`),
  ...manifest.filter((f) => !localFiles.includes(f)).map((f) => `NOT-IN-WORKTREE: ${f}`),
]
record('git ls-tree manifest (dist repo HEAD)', {
  cwd: DIST_REPO,
  exit: listed.code,
  stdout: `${manifest.length} files in HEAD / ${localFiles.length} files in worktree`,
  stderr: setDiff.length ? setDiff.join('\n') : '(file sets identical)',
  result: listed.code === 0 && manifest.length > 0 && setDiff.length === 0 ? 'PASS' : 'FAIL',
})

// ---- D. 哈希对照 ----
// 证据文件本身是这份报告的产物：每次生成都会变，不能拿它自己跟自己比。
const GENERATED = new Set(['docs/dist-evidence.txt'])
const rows = []
let hashBad = 0
for (const rel of manifest) {
  if (GENERATED.has(rel)) {
    rows.push(`${rel}\t(generated)\t-\tSKIP`)
    continue
  }
  const srcHash = fileHash(join(PLUGIN_DIR, rel))
  const distHash = fileHash(join(DIST_DIR, rel))
  const ok = Boolean(srcHash) && srcHash === distHash
  if (!ok) hashBad += 1
  rows.push(`${rel}\t${srcHash || 'MISSING'}\t${distHash || 'MISSING'}\t${ok ? 'MATCH' : 'MISMATCH'}`)
}
const distFiles = (await walk(DIST_DIR)).sort()
const extras = distFiles.filter((f) => !manifest.includes(f))
const missingInDist = manifest.filter((f) => !distFiles.includes(f))
record('hash compare (dist manifest files)', {
  cwd: PLUGIN_DIR,
  exit: hashBad,
  stdout: rows.join('\n'),
  stderr: `EXTRA-FILES: ${extras.length ? extras.join(', ') : 'none'}\nMISSING: ${missingInDist.length ? missingInDist.join(', ') : 'none'}`,
  result: hashBad === 0 && extras.length === 0 && missingInDist.length === 0 ? 'PASS' : 'FAIL',
})

// ---- E. 配置三态（真实 config.js，隔离环境） ----
const { resolveConfig } = await import(new URL('../config.js', import.meta.url).href)
const sandbox = await mkdtemp(join(tmpdir(), 'adv-evidence-'))
const isoEnv = { LOCALAPPDATA: join(sandbox, 'appdata'), TEMP: sandbox, TMP: sandbox }

async function threeState() {
  const out = []
  const unconf = await resolveConfig({}, isoEnv)
  out.push(`unconfigured  input={"config":{},"env":${JSON.stringify(Object.keys(isoEnv))}} state=${unconf.workspace.state} reason=${unconf.workspace.reason}`)

  const invalid = await resolveConfig({ workspace: 'relative/dir' }, isoEnv)
  out.push(`invalid       input={"config":{"workspace":"relative/dir"}} state=${invalid.workspace.state} reason=${invalid.workspace.reason}`)

  const ws = join(sandbox, 'workspace')
  await mkdir(join(ws, 'gpt-notes'), { recursive: true })
  await mkdir(join(ws, '雷电bridge', 'windows-bridge'), { recursive: true })

  const requests = []
  let server
  try {
    server = createServer((req, res) => {
      requests.push({ method: req.method, url: req.url, token: req.headers['x-dsh-token'] })
      if (req.method === 'GET' && req.url === '/v1/health' && req.headers['x-dsh-token'] === 'test-token') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const port = server.address().port
    await writeFile(join(ws, '雷电bridge', 'windows-bridge', 'config.json'), JSON.stringify({ token: 'test-token', baseUrl: `http://127.0.0.1:${port}` }), 'utf8')
    const ready = await resolveConfig({ workspace: ws }, isoEnv)
    const healthReq = requests.filter((r) => r.method === 'GET' && r.url === '/v1/health')
    out.push(`ready         input={"config":{"workspace":"<tmp>/workspace"}} state=${ready.workspace.state} bridge=${ready.bridge.state} healthRequests=${healthReq.length} token=${healthReq[0] ? healthReq[0].token : 'none'}`)
    const ok = unconf.workspace.state === 'unconfigured'
      && unconf.workspace.reason === 'workspace-unconfigured'
      && invalid.workspace.state === 'invalid'
      && invalid.workspace.reason === 'workspace-not-absolute'
      && ready.workspace.state === 'ready'
      && ready.bridge.state === 'ready'
      && healthReq.length === 1
      && healthReq[0].token === 'test-token'
    record('config.js three states (isolated env, fake health server)', {
      cwd: PLUGIN_DIR,
      exit: ok ? 0 : 1,
      stdout: out.join('\n'),
      stderr: `allRequests=${JSON.stringify(requests)}`,
      result: ok ? 'PASS' : 'FAIL',
    })
  } finally {
    if (server) await new Promise((r) => server.close(r))
  }
}
await threeState()

// ---- F. 全量测试 ----
const testFiles = (await readdir(join(PLUGIN_DIR, 'test'))).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => join('test', f))
const test = run(process.execPath, ['--test', ...testFiles], PLUGIN_DIR)
const passLine = (test.stdout.match(/(?:^|\n)\s*(?:#|ℹ)\s*pass\s+(\d+)/) || [])[1] || '0'
const failLine = (test.stdout.match(/(?:^|\n)\s*(?:#|ℹ)\s*fail\s+(\d+)/) || [])[1] || '0'
record(`node --test (${testFiles.length} files)`, {
  cwd: PLUGIN_DIR,
  exit: test.code,
  stdout: `${test.stdout}\n\n[parsed] pass=${passLine} fail=${failLine}`,
  stderr: test.stderr,
  result: test.code === 0 && failLine === '0' ? 'PASS' : 'FAIL',
})

// ---- G. selfcheck（工作副本与分发副本） ----
for (const [label, dir] of [['working copy', PLUGIN_DIR], ['dist copy', DIST_DIR]]) {
  const sc = run(process.execPath, ['scripts/selfcheck.mjs', '--dist'], dir)
  record(`selfcheck --dist (${label})`, { cwd: dir, exit: sc.code, stdout: sc.stdout, stderr: sc.stderr, result: sc.code === 0 ? 'PASS' : 'FAIL' })
}

// ---- 输出 ----
lines.push('advisor-toggle 分发证据（自动采集）')
lines.push(`采集时间: ${new Date().toISOString()}`)
lines.push(`工作副本: ${PLUGIN_DIR}`)
lines.push(`分发副本: ${DIST_DIR}`)
lines.push(`清单文件数: ${manifest.length}`)
lines.push('')
steps.forEach((s, i) => {
  lines.push(`STEP ${i + 1}: ${s.step}`)
  lines.push(`CWD: ${s.cwd}`)
  lines.push(`EXIT: ${s.exit}`)
  lines.push('STDOUT:')
  lines.push(s.stdout || '(empty)')
  lines.push('STDERR:')
  lines.push(s.stderr || '(empty)')
  lines.push(`RESULT: ${s.result}`)
  lines.push('')
})
lines.push(`OVERALL: ${failed ? 'FAIL' : 'PASS'}`)
lines.push(`(# pass ${passLine.replace('# pass ', '')} / # fail ${failLine.replace('# fail ', '')})`)

await writeFile(EVIDENCE, lines.join('\n'), 'utf8')
await rm(sandbox, { recursive: true, force: true })
console.log(lines.slice(-2).join('\n'))
console.log(`evidence: ${EVIDENCE} (${(await stat(EVIDENCE)).size} bytes)`)
process.exit(failed ? 1 : 0)
