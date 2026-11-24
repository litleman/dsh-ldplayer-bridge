// v11 许可语义：paused 是独立布尔、收尾阶段纯只读、累计额度/总期限/续期上限、写入日志。
// 跑法: node --test test/permit.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'

const mod = await import('../index.js')
const { gateDecision, journalAppend, journalAudit, makeGrant, DEFAULTS } = mod.__test

const NOW = 1_800_000_000_000

function permitState(overrides = {}) {
  return {
    enabled: true,
    paused: false,
    phase: 'executing',
    activePlanId: 'plan-1',
    toolSnapshotDigest: 'snap-1',
    toolSnapshotTrusted: true,
    journal: [],
    grant: {
      id: 'b1',
      planId: 'plan-1',
      version: 'v1',
      digest: 'd'.repeat(64),
      toolSnapshotDigest: 'snap-1',
      at: NOW - 1000,
      expiresAt: NOW + 30 * 60_000,
      totalDeadline: NOW + 4 * 3600_000,
      maxOps: 5,
      used: 0,
      totalOpsLimit: 50,
      totalUsed: 0,
      renewalCount: 0,
      maxRenewals: 3,
      idleTimeout: 30 * 60_000,
      allowShell: true,
      allowedPaths: [],
      lastActivityAt: NOW - 1000,
    },
    ...overrides,
  }
}

test('M1：paused 是独立布尔，优先于阶段判定，且说明"这不是否决"', () => {
  const s = permitState({ paused: true })
  const d = gateDecision(s, 'pwsh', 'v1', NOW, { trusted: true })
  assert.equal(d.allow, false)
  assert.equal(d.reason, 'paused')
  assert.match(d.message, /重新 advisor_plan/)
  assert.match(d.message, /不要重试/)
})

test('M1：paused 时只读工具仍然放行（不能把人锁死到连读都读不了）', () => {
  const s = permitState({ paused: true })
  assert.equal(gateDecision(s, 'read', 'v1', NOW, { trusted: true }).allow, true)
})

test('M2：累计额度到顶 → quota-exhausted（即使单窗口还有余量）', () => {
  const s = permitState()
  s.grant.used = 1
  s.grant.totalUsed = 50
  const d = gateDecision(s, 'pwsh', 'v1', NOW, { trusted: true })
  assert.equal(d.reason, 'quota-exhausted')
})

test('M2：总期限到点 → grant-expired', () => {
  const s = permitState()
  s.grant.totalDeadline = NOW - 1
  assert.equal(gateDecision(s, 'pwsh', 'v1', NOW, { trusted: true }).reason, 'grant-expired')
})

test('M2：续期次数用尽 → quota-exhausted', () => {
  const s = permitState()
  s.grant.renewalCount = 3
  assert.equal(gateDecision(s, 'pwsh', 'v1', NOW, { trusted: true }).reason, 'quota-exhausted')
})

test('v11：收尾阶段（delivering）没有任何写权限', () => {
  const s = permitState({ phase: 'delivering', grant: null })
  const d = gateDecision(s, 'pwsh', 'v1', NOW, { trusted: true })
  assert.equal(d.allow, false)
  assert.equal(d.reason, 'phase-not-executing')
})

test('v11：插件不再注册任何收尾写工具', async () => {
  const tools = await import('../index.js')
  assert.equal(typeof tools.__test.finalizeCreate, 'undefined')
  assert.equal(typeof tools.__test.trustedRoots, 'undefined')
  assert.equal(typeof tools.__test.finalizeDecision, 'undefined')
})

test('M3：写入日志记 planId / 工具 / 路径，并能被 plan 核对', () => {
  const s = permitState()
  journalAppend(s, { toolName: 'write', params: { file_path: 'plugins/advisor-toggle/index.js' }, versionBefore: 'v1', versionAfter: 'v2' })
  const audit = journalAudit(s)
  assert.equal(audit.count, 1)
  assert.ok(audit.paths.includes('plugins/advisor-toggle/index.js'))
})

test('makeGrant：累计层字段齐全，且拒收不可信快照', () => {
  const state = { toolSnapshotDigest: 'snap-1', toolSnapshotTrusted: true, planDigest: '' }
  const g = makeGrant({ state, version: 'v1', planId: 'plan-1', round: 1 })
  assert.equal(g.planId, 'plan-1')
  assert.equal(g.totalUsed, 0)
  assert.equal(g.totalOpsLimit, Number(DEFAULTS.totalOpsPerPlan))
  assert.equal(g.maxRenewals, Number(DEFAULTS.maxRenewals))
  assert.ok(g.totalDeadline > g.at)
  assert.throws(
    () => makeGrant({ state: { toolSnapshotDigest: 'snap-1', toolSnapshotTrusted: false }, version: 'v1', planId: 'p', round: 1 }),
    /工具快照不可信/,
  )
})
