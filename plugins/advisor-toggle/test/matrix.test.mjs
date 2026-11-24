// v11 门禁矩阵：纯判定 evaluateDecision() 是唯一判定内核，gateDecision() = 纯判定 + 副作用。
// 覆盖：disabled / read-only / paused / phase / planId / 版本可信度与漂移 / 期限与倒挂 /
// 单窗口额度、累计额度、续期次数 / 闲置超时转续期 / 工具快照 / 拒绝时的作废语义。
// 跑法: node --test test/matrix.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'

const mod = await import('../index.js')
const { evaluateDecision, gateDecision, writeSurface, DEFAULTS } = mod.__test

const NOW = 1_800_000_000_000

function stateOf(overrides = {}) {
  const grant = {
    id: 'b1',
    planId: 'plan-A',
    version: 'v1',
    digest: 'd'.repeat(64),
    toolSnapshotDigest: 'snap',
    at: NOW - 60_000,
    expiresAt: NOW + 30 * 60_000,
    totalDeadline: NOW + 4 * 3600_000,
    maxOps: 10,
    used: 0,
    totalOpsLimit: 600,
    totalUsed: 0,
    renewalCount: 0,
    maxRenewals: Number(DEFAULTS.maxRenewals),
    idleTimeout: 30 * 60_000,
    allowShell: true,
    allowedPaths: [],
    lastActivityAt: NOW - 1000,
  }
  return {
    enabled: true,
    paused: false,
    phase: 'executing',
    activePlanId: 'plan-A',
    toolSnapshotDigest: 'snap',
    toolSnapshotTrusted: true,
    grant,
    ...overrides,
  }
}

test('关着 / 只读工具：直接放行，不消费额度', () => {
  assert.equal(evaluateDecision({ enabled: false }, 'pwsh', 'v1', NOW, { trusted: true }).why, 'off')
  assert.equal(evaluateDecision(stateOf(), 'read', 'v1', NOW, { trusted: true }).why, 'read-only')
  const s = stateOf()
  gateDecision(s, 'read', 'v1', NOW, { trusted: true })
  assert.equal(s.grant.used, 0)
})

test('暂停优先于阶段判定：paused 是独立布尔字段', () => {
  const d = evaluateDecision(stateOf({ paused: true, phase: 'executing' }), 'pwsh', 'v1', NOW, { trusted: true })
  assert.equal(d.allow, false)
  assert.equal(d.reason, 'paused')
  assert.match(d.message, /重新 advisor_plan/)
})

test('阶段不对（idle/planning/delivering）一律拒绝', () => {
  for (const phase of ['idle', 'planning', 'delivering']) {
    assert.equal(evaluateDecision(stateOf({ phase }), 'pwsh', 'v1', NOW, { trusted: true }).reason, 'phase-not-executing')
  }
})

test('没有授权 / 计划号不符：plan-mismatch', () => {
  assert.equal(evaluateDecision(stateOf({ grant: null }), 'pwsh', 'v1', NOW, { trusted: true }).reason, 'plan-mismatch')
  assert.equal(evaluateDecision(stateOf({ activePlanId: 'plan-B' }), 'pwsh', 'v1', NOW, { trusted: true }).reason, 'plan-mismatch')
  assert.equal(evaluateDecision(stateOf({ activePlanId: '' }), 'pwsh', 'v1', NOW, { trusted: true }).reason, 'plan-mismatch')
})

test('版本不可信 → version-mismatch；可信且一致 → granted；可信但漂移 → granted-drift', () => {
  assert.equal(evaluateDecision(stateOf(), 'pwsh', 'v1', NOW, { trusted: false }).reason, 'version-mismatch')
  const same = evaluateDecision(stateOf(), 'pwsh', 'v1', NOW, { trusted: true })
  assert.equal(same.why, 'granted')
  assert.equal(same.drift, false)
  const drifted = evaluateDecision(stateOf(), 'pwsh', 'v2', NOW, { trusted: true })
  assert.equal(drifted.allow, true)
  assert.equal(drifted.why, 'granted-drift')
  assert.equal(drifted.drift, true)
})

test('期限：过期、倒挂、字段不可信都按 grant-expired 处理（>= 边界）', () => {
  assert.equal(evaluateDecision(stateOf({ grant: { ...stateOf().grant, expiresAt: NOW } }), 'pwsh', 'v1', NOW, { trusted: true }).reason, 'grant-expired')
  assert.equal(evaluateDecision(stateOf({ grant: { ...stateOf().grant, totalDeadline: NOW } }), 'pwsh', 'v1', NOW, { trusted: true }).reason, 'grant-expired')
  const inverted = stateOf()
  inverted.grant.totalDeadline = inverted.grant.expiresAt - 1
  assert.equal(evaluateDecision(inverted, 'pwsh', 'v1', NOW, { trusted: true }).reason, 'grant-expired')
  for (const bad of [null, undefined, '1800000000000', NaN, Infinity, -Infinity, 0, -1]) {
    const s = stateOf()
    s.grant.expiresAt = bad
    assert.equal(evaluateDecision(s, 'pwsh', 'v1', NOW, { trusted: true }).reason, 'grant-expired', `expiresAt=${String(bad)}`)
  }
})

test('额度：单窗口 / 累计 / 续期次数任一耗尽都拒绝', () => {
  assert.equal(evaluateDecision(stateOf({ grant: { ...stateOf().grant, used: 10 } }), 'pwsh', 'v1', NOW, { trusted: true }).reason, 'quota-exhausted')
  assert.equal(evaluateDecision(stateOf({ grant: { ...stateOf().grant, totalUsed: 600 } }), 'pwsh', 'v1', NOW, { trusted: true }).reason, 'quota-exhausted')
  assert.equal(
    evaluateDecision(stateOf({ grant: { ...stateOf().grant, renewalCount: 99 } }), 'pwsh', 'v1', NOW, { trusted: true }).reason,
    'quota-exhausted',
  )
})

test('闲置超时且还能续期 → needs-renewal（不作废，仍拒绝写）', () => {
  const s = stateOf()
  s.grant.lastActivityAt = NOW - 31 * 60_000
  const d = evaluateDecision(s, 'pwsh', 'v1', NOW, { trusted: true })
  assert.equal(d.allow, false)
  assert.equal(d.why, 'needs-renewal')
  assert.match(d.message, /advisor_renew/)
})

test('工具快照不符 → tool-snapshot-mismatch', () => {
  assert.equal(evaluateDecision(stateOf({ toolSnapshotDigest: 'other' }), 'pwsh', 'v1', NOW, { trusted: true }).reason, 'tool-snapshot-mismatch')
  assert.equal(evaluateDecision(stateOf({ toolSnapshotDigest: '' }), 'pwsh', 'v1', NOW, { trusted: true }).reason, 'tool-snapshot-mismatch')
})

test('gateDecision 只在放行时消费额度，失效时作废授权并记原因', () => {
  const ok = stateOf()
  const d = gateDecision(ok, 'pwsh', 'v1', NOW, { trusted: true })
  assert.equal(d.allow, true)
  assert.equal(ok.grant.used, 1)
  assert.equal(ok.grant.totalUsed, 1)
  assert.equal(ok.grant.lastActivityAt, NOW)

  const expired = stateOf()
  expired.grant.expiresAt = NOW - 1
  const denied = gateDecision(expired, 'pwsh', 'v1', NOW, { trusted: true })
  assert.equal(denied.allow, false)
  assert.equal(expired.grant, null, '过期授权必须就地作废')
  assert.match(expired.grantExpired, /expired|grant-expired/)
})

test('writeSurface：当前状态没有执行授权 → 可写放行数为 0', async () => {
  mod.__test.setHostContext({
    get: () => ({ definitions: () => [{ name: 'read' }, { name: 'pwsh' }, { name: 'write' }] }),
  })
  const ws = await writeSurface('idle')
  assert.equal(ws.writableAllowCount, 0, '没有授权时不得放行任何宿主写工具')
  assert.deepEqual(ws.selfWriteTools, [])
  assert.equal(ws.toolTotal, 3)
})
