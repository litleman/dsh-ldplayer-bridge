// v4 三态许可：executing / paused / delivering 与"用完即焚"的收尾许可、写入日志。
// 这些用例对应顾问 2026-11-23 评审的 M1（三态）、M2（累计额度/续期上限）、M3（写入日志）、
// M4（收尾许可没有技术定义 = 没收权）。
// 跑法: node --test test/permit.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'

const mod = await import('../index.js')
const { gateDecision, finalizeTarget, journalAppend, journalAudit, makeGrant, DEFAULTS } = mod.__test

function permitState(overrides = {}) {
  const now = Date.now()
  return {
    enabled: true,
    phase: 'executing',
    activePlanId: 'plan-1',
    toolSnapshotDigest: 'snap-1',
    toolSnapshotTrusted: true,
    planDigest: 'digest',
    degradedAt: 0,
    journal: [],
    grant: {
      id: 'p1', planId: 'plan-1', version: 'v1', toolSnapshotDigest: 'snap-1',
      at: now, expiresAt: now + 60000, maxOps: 300, used: 0,
      renewalCount: 0, maxRenewals: 3, totalUsed: 0, totalOpsLimit: 600,
      totalDeadline: now + 4 * 3600 * 1000, idleTimeout: 60000, lastActivityAt: now,
    },
    ...overrides,
  }
}

test('M1 三态：paused 阶段没有任何写权限，且理由要说清"这不是否决"', () => {
  const state = permitState({ phase: 'paused', grant: null })
  const d = gateDecision(state, 'pwsh', 'v1', Date.now(), { trusted: true })
  assert.equal(d.allow, false)
  assert.equal(d.why, 'paused')
  assert.match(d.reason, /暂停/)
  assert.match(d.reason, /advisor_plan/)
  // 明确写出"不要重试同一个调用"，避免模型原地打转
  assert.match(d.reason, /不要重试/)
})

test('M2 执行阶段：允许写、累计用量与活跃时间都要推进', () => {
  const state = permitState()
  const before = state.grant.totalUsed
  const d = gateDecision(state, 'write', 'v1', Date.now(), { trusted: true })
  assert.equal(d.allow, true)
  assert.equal(state.grant.used, 1)
  assert.equal(state.grant.totalUsed, before + 1)
  assert.ok(state.grant.lastActivityAt >= state.grant.at)
})

test('M2 累计额度到顶：即使单窗口还有余量也必须停', () => {
  const state = permitState()
  state.grant.totalUsed = 600
  const d = gateDecision(state, 'write', 'v1', Date.now(), { trusted: true })
  assert.equal(d.allow, false)
  assert.equal(state.grant, null)
  assert.match(d.reason, /累计写入已达上限/)
})

test('M2 总期限到点：作废并说明要重新开计划', () => {
  const state = permitState()
  state.grant.totalDeadline = Date.now() - 1000
  const d = gateDecision(state, 'write', 'v1', Date.now(), { trusted: true })
  assert.equal(d.allow, false)
  assert.equal(state.grant, null)
  assert.match(d.reason, /累计执行窗口/)
})

test('M4 收尾许可：git 提交与 docs 文档放行，pwsh 与源码路径不放行', () => {
  const now = Date.now()
  assert.equal(finalizeTarget({ command: 'git commit -m "x"' }).ok, true)
  assert.equal(finalizeTarget({ command: 'git status' }).ok, true)
  assert.equal(finalizeTarget({ command: 'rm -rf /' }).ok, false)
  assert.equal(finalizeTarget({ file_path: 'docs/threat-model.md' }).ok, true)
  assert.equal(finalizeTarget({ file_path: 'plugins/advisor-toggle/index.js' }).ok, false)
  assert.equal(finalizeTarget({}).ok, false)

  const state = permitState({
    phase: 'delivering',
    grant: null,
    finalizePermit: { id: 'f1', planId: 'plan-1', at: now, expiresAt: now + 60000, maxOps: 2, used: 0 },
  })
  const ok = gateDecision(state, 'edit', 'v1', now, { trusted: true, params: { file_path: 'docs/anomaly-report.txt' } })
  assert.equal(ok.allow, true)
  assert.equal(ok.why, 'finalize')
  assert.equal(state.finalizePermit.used, 1)

  const denied = gateDecision(state, 'edit', 'v1', now, { trusted: true, params: { file_path: 'plugins/advisor-toggle/index.js' } })
  assert.equal(denied.allow, false)
  assert.equal(denied.why, 'finalize-scope')
})

test('M4 收尾许可用完即焚：额度耗尽后不再保留', () => {
  const now = Date.now()
  const state = permitState({
    phase: 'delivering',
    grant: null,
    finalizePermit: { id: 'f2', planId: 'plan-1', at: now, expiresAt: now + 60000, maxOps: 1, used: 0 },
  })
  const d = gateDecision(state, 'edit', 'v1', now, { trusted: true, params: { file_path: 'docs/x.md' } })
  assert.equal(d.allow, true)
  assert.equal(state.finalizePermit, null, '最后一格用完必须立刻销毁许可')
  assert.equal(state.phase, 'idle')

  const again = gateDecision(state, 'edit', 'v1', now, { trusted: true, params: { file_path: 'docs/x.md' } })
  assert.equal(again.allow, false)
})

test('M4 收尾许可过期：拒绝并清理', () => {
  const now = Date.now()
  const state = permitState({
    phase: 'delivering',
    grant: null,
    finalizePermit: { id: 'f3', planId: 'plan-1', at: now - 700000, expiresAt: now - 1000, maxOps: 5, used: 0 },
  })
  const d = gateDecision(state, 'edit', 'v1', now, { trusted: true, params: { file_path: 'docs/x.md' } })
  assert.equal(d.allow, false)
  assert.equal(d.why, 'finalize-expired')
  assert.equal(state.finalizePermit, null)
})

test('M3 写入日志：记路径、能发现"不属于本计划"的条目', () => {
  const state = permitState()
  journalAppend(state, { toolName: 'write', params: { file_path: 'plugins/x/index.js' }, versionBefore: 'v0', versionAfter: 'v1' })
  journalAppend(state, { toolName: 'edit', params: { file_path: 'docs/y.md' }, versionBefore: 'v1' })
  const audit = journalAudit(state)
  assert.equal(audit.count, 2)
  assert.deepEqual(audit.paths, ['plugins/x/index.js', 'docs/y.md'])
  assert.equal(audit.unexplained.length, 0)

  // 换了计划号之后，旧条目就变成"本计划无法解释的改动"
  state.activePlanId = 'plan-2'
  const audit2 = journalAudit(state)
  assert.equal(audit2.unexplained.length, 2)
})

test('新计划签发的许可必须自带累计层字段（不是 0/未定义）', () => {
  const state = permitState()
  const grant = makeGrant({ state, version: 'v'.repeat(64), planId: 'plan-2', round: 1 })
  assert.equal(grant.totalUsed, 0)
  assert.equal(grant.totalOpsLimit, Number(DEFAULTS.totalOpsPerPlan))
  assert.equal(grant.renewalCount, 0)
  assert.equal(grant.maxRenewals, Number(DEFAULTS.maxRenewals))
  assert.ok(grant.totalDeadline - grant.at === Number(DEFAULTS.totalWindowMs))
})
