// 工具快照必须走真实契约 tools.definitions(scope)，并且只比「写类工具」子集。
// 2026-11-23 的现场 bug：实现按 tools.list() 取表，而真实服务没有 list →
// 每次真实 GO 都报 no-tools-service、签不出授权，人只能手动关开关。这里锁住契约形状。
// 顾问 v4 建议：只读工具的增减不该让正在进行的执行批次失效。
// 跑法: node --test test/tools-contract.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'

const mod = await import('../index.js')
const { toolSnapshotOf, makeGrant, DEFAULTS } = mod.__test

function withTools(service) {
  mod.__test.setHostContext({ get: (name) => (name === 'tools' ? service : undefined) })
}

test('真实契约：只有 definitions(scope) 也能取到可信快照，并透传会话作用域', async () => {
  const seen = []
  withTools({
    definitions: (scope) => {
      seen.push(scope)
      // 故意乱序，验证快照对顺序不敏感；read 是只读工具，必须被排除在写类集合之外
      return [{ name: 'pwsh' }, { name: 'read' }]
    },
    register: () => () => {},
  })
  const agent = { session: { id: 'session-contract' } }
  const snap = await toolSnapshotOf(agent)
  assert.equal(snap.trusted, true)
  assert.equal(snap.source, 'definitions')
  assert.equal(snap.count, 1, '只读工具 read 不计入写类快照')
  assert.deepEqual(seen, [agent], '必须把 exec.agent 透传给 definitions')

  // 真实契约下必须签得出授权（修复前这里必然抛 no-tools-service）
  const state = { toolSnapshotDigest: snap.digest, toolSnapshotTrusted: true, planDigest: '' }
  const grant = makeGrant({ state, version: 'a'.repeat(64), planId: 'plan-contract', round: 1 })
  assert.equal(grant.planId, 'plan-contract')
  assert.equal(grant.toolSnapshotDigest, snap.digest)
  assert.equal(grant.maxOps, Number(DEFAULTS.maxOpsPerGrant))
  // 累计层字段（顾问 v4 M2）：新签的授权必须自带累计额度、续期上限与总期限
  assert.equal(grant.totalUsed, 0)
  assert.equal(grant.totalOpsLimit, Number(DEFAULTS.totalOpsPerPlan))
  assert.equal(grant.renewalCount, 0)
  assert.equal(grant.maxRenewals, Number(DEFAULTS.maxRenewals))
  assert.ok(grant.totalDeadline > grant.at, '总期限必须晚于签发时间')
})

test('兼容旧形状：没有 definitions 时退回 list()', async () => {
  withTools({ list: async () => [{ name: 'read' }, { name: 'write' }, { name: 'edit' }], register: () => () => {} })
  const snap = await toolSnapshotOf()
  assert.equal(snap.trusted, true)
  assert.equal(snap.source, 'list')
  assert.equal(snap.count, 2, 'read 是只读工具，不计入')
})

test('async definitions 也支持（不假设同步返回）', async () => {
  withTools({ definitions: async () => [{ name: 'read' }] })
  const snap = await toolSnapshotOf()
  assert.equal(snap.trusted, true)
  assert.equal(snap.source, 'definitions')
  assert.equal(snap.count, 0)
  assert.equal(snap.reason, 'no-write-tools')
})

test('两种方法都没有：判为不可信，授权签不出来', async () => {
  withTools({ register: () => () => {} })
  const snap = await toolSnapshotOf()
  assert.equal(snap.trusted, false)
  assert.match(snap.reason, /no-tools-service/)
  // 快照不可信时，即使顾问回了 GO 也不许盖章
  assert.throws(
    () => makeGrant({ state: { toolSnapshotDigest: snap.digest, toolSnapshotTrusted: snap.trusted }, version: 'v'.repeat(64), planId: 'p', round: 1 }),
    /工具快照不可信/,
  )
  // 摘要是空串时同样直接拒绝
  assert.throws(
    () => makeGrant({ state: { toolSnapshotDigest: '', toolSnapshotTrusted: true }, version: 'v'.repeat(64), planId: 'p', round: 1 }),
    /toolSnapshotDigest 不能为空/,
  )
})

test('工具表为空：写类集合为空，但仍是"读到了工具表"（不该冒充读不到）', async () => {
  withTools({ definitions: () => [] })
  const snap = await toolSnapshotOf()
  assert.equal(snap.trusted, true)
  assert.equal(snap.count, 0)
  assert.equal(snap.reason, 'no-write-tools')
})

test('definitions 抛错：不可信，不吞异常也不放行', async () => {
  withTools({
    definitions: () => {
      throw new Error('boom')
    },
  })
  const snap = await toolSnapshotOf()
  assert.equal(snap.trusted, false)
  assert.match(snap.reason, /tool-list-failed:boom/)
})
