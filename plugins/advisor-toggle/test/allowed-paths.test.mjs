// 模型 A 的路径级授权：edit/write/apply_patch 受 allowedPaths 硬约束；
// 命令类工具（pwsh/decompress/...）只认 allowShell 声明，不承诺写入范围。
// 跑法: node --test test/allowed-paths.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

const mod = await import('../index.js')
const { evaluateDecision, normalizeAllowedPaths, pathTargets, targetInside, realpathEscape, makeGrant, setResolved, DEFAULTS } =
  mod.__test

const WS = await mkdtemp(join(tmpdir(), 'advisor-paths-'))
await mkdir(join(WS, 'plugins', 'advisor-toggle'), { recursive: true })
await mkdir(join(WS, 'docs'), { recursive: true })
const OUTSIDE = await mkdtemp(join(tmpdir(), 'advisor-outside-'))
await writeFile(join(OUTSIDE, 'secret.txt'), 'x')
// docs 做成指向外部的 junction/符号链接（Windows 上 symlink 需要权限，失败就跳过该用例）
let linkOk = true
try {
  await symlink(OUTSIDE, join(WS, 'docs-link'), 'junction')
} catch {
  linkOk = false
}

setResolved({ workspace: { state: 'ready', path: WS }, bridge: { state: 'unconfigured' } })

function grant(over = {}) {
  const now = Date.now()
  return {
    id: 'g1',
    planId: 'plan-1',
    version: 'v1',
    digest: 'd1',
    toolSnapshotDigest: 'snap',
    at: now,
    expiresAt: now + 60000,
    maxOps: 10,
    used: 0,
    totalOpsLimit: 100,
    totalUsed: 0,
    renewalCount: 0,
    maxRenewals: 3,
    totalDeadline: now + 600000,
    idleTimeout: 60000,
    lastActivityAt: now,
    allowedPaths: normalizeAllowedPaths(['plugins/advisor-toggle']),
    allowShell: false,
    ...over,
  }
}

function state(over = {}) {
  return {
    enabled: true,
    paused: false,
    phase: 'executing',
    activePlanId: 'plan-1',
    toolSnapshotDigest: 'snap',
    toolSnapshotTrusted: true,
    planDigest: 'pd',
    grant: grant(),
    verdict: 'GO',
    ...over,
  }
}

test('pathTargets 取出目标路径（含数组与 toFile）', () => {
  assert.deepEqual(pathTargets({ path: 'a' }), ['a'])
  assert.deepEqual(pathTargets({ file_path: 'b' }), ['b'])
  assert.deepEqual(pathTargets({ paths: ['c', 'd'] }), ['c', 'd'])
  assert.deepEqual(pathTargets({ toFile: 'e' }), ['e'])
  assert.deepEqual(pathTargets({ message: 'no path here' }), [])
})

test('targetInside 逐段比较，兄弟目录不算命中', () => {
  const allowed = normalizeAllowedPaths(['plugins'])
  assert.equal(targetInside(join(WS, 'plugins', 'x.js'), allowed), true)
  assert.equal(targetInside(join(WS, 'plugins-evil', 'x.js'), allowed), false)
  assert.equal(targetInside(join(WS, '..', 'etc', 'passwd'), allowed), false)
})

test('计划内路径放行', () => {
  const d = evaluateDecision(state(), 'edit', 'v1', Date.now(), {
    trusted: true,
    params: { file_path: join(WS, 'plugins', 'advisor-toggle', 'index.js') },
  })
  assert.equal(d.allow, true, JSON.stringify(d))
})

test('计划外路径拒绝（path-not-allowed/outside）', () => {
  const d = evaluateDecision(state(), 'edit', 'v1', Date.now(), {
    trusted: true,
    params: { file_path: join(WS, 'docs', 'x.md') },
  })
  assert.equal(d.allow, false)
  assert.equal(d.reason, 'path-not-allowed')
  assert.equal(d.why, 'outside')
})

test('.. 穿越拒绝', () => {
  const d = evaluateDecision(state(), 'write', 'v1', Date.now(), {
    trusted: true,
    params: { path: 'plugins/../../etc/passwd' },
  })
  assert.equal(d.allow, false)
  assert.equal(d.reason, 'path-not-allowed')
})

test('未声明 allowedPaths 时一律拒（fail-closed）', () => {
  const d = evaluateDecision(state({ grant: grant({ allowedPaths: [] }) }), 'write', 'v1', Date.now(), {
    trusted: true,
    params: { path: join(WS, 'plugins', 'advisor-toggle', 'x.js') },
  })
  assert.equal(d.allow, false)
  assert.equal(d.why, 'none-declared')
})

test('取不到目标路径 → no-target', () => {
  const d = evaluateDecision(state(), 'write', 'v1', Date.now(), { trusted: true, params: {} })
  assert.equal(d.allow, false)
  assert.equal(d.why, 'no-target')
})

test('pwsh 未声明 allowShell → shell-not-declared；声明后放行', () => {
  const denied = evaluateDecision(state(), 'pwsh', 'v1', Date.now(), { trusted: true, params: { command: 'node --test' } })
  assert.equal(denied.allow, false)
  assert.equal(denied.reason, 'shell-not-declared')
  const allowed = evaluateDecision(state({ grant: grant({ allowShell: true }) }), 'pwsh', 'v1', Date.now(), {
    trusted: true,
    params: { command: 'node --test' },
  })
  assert.equal(allowed.allow, true, JSON.stringify(allowed))
})

test('decompress 的 toFile 也受路径约束', () => {
  const ok = evaluateDecision(state(), 'decompress', 'v1', Date.now(), {
    trusted: true,
    params: { toFile: join(WS, 'plugins', 'advisor-toggle', 'out.md') },
  })
  assert.equal(ok.allow, true, JSON.stringify(ok))
  const bad = evaluateDecision(state({ grant: grant({ allowShell: true }) }), 'decompress', 'v1', Date.now(), {
    trusted: true,
    params: { toFile: join(WS, 'docs', 'out.md') },
  })
  assert.equal(bad.allow, false)
  assert.equal(bad.why, 'outside')
})

test('符号链接指向允许目录之外 → realpathEscape 命中', async (t) => {
  if (!linkOk) {
    t.skip('当前环境无法创建 junction/symlink')
    return
  }
  const allowed = normalizeAllowedPaths(['plugins'])
  assert.equal(await realpathEscape(join(WS, 'docs-link', 'x.md'), allowed), true)
  assert.equal(await realpathEscape(join(WS, 'plugins', 'advisor-toggle', 'new.js'), allowed), false)
})

test('makeGrant 把计划声明抄进 permit', () => {
  const st = state({ planPaths: normalizeAllowedPaths(['plugins', 'docs']), planShell: true })
  const g = makeGrant({ state: st, version: 'v1', planId: 'plan-1', round: 1 })
  assert.equal(g.allowedPaths.length, 2)
  assert.equal(g.allowShell, true)
  assert.ok(g.allowedPaths.every((p) => p === p.toLowerCase() || sep !== '\\'))
})

test.after(async () => {
  await rm(WS, { recursive: true, force: true }).catch(() => {})
  await rm(OUTSIDE, { recursive: true, force: true }).catch(() => {})
})
