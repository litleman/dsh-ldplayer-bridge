// v11：授权审计（/isolation）必须对**生产工具表**逐工具跑纯判定，指标全部动态统计。
// 覆盖六种探针状态的写面画像、scope 隔离、未知 scope 显式报错、审计零副作用。
// 跑法: node --test test/isolation.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'

const mod = await import('../index.js')
const { auditIsolation } = mod.__test

function withTools(service) {
  mod.__test.setHostContext({ get: (name) => (name === 'tools' ? service : undefined) })
}

const HOST_TOOLS = [
  { name: 'read' },
  { name: 'grep' },
  { name: 'pwsh' },
  { name: 'write' },
  { name: 'edit' },
  { name: 'plugin_manager' },
  { name: 'advisor_plan' },
  { name: 'advisor_review' },
]

test('executing：只读工具全放行，宿主写工具被放行、插件自己没有写工具', async () => {
  withTools({ definitions: () => HOST_TOOLS })
  const audit = await auditIsolation('executing', 'root')
  assert.equal(audit.complete, true)
  assert.equal(audit.total, HOST_TOOLS.length)
  assert.equal(audit.state, 'executing')
  assert.equal(audit.probeSource, 'live')
  assert.deepEqual(audit.selfWriteTools, [], 'v11 插件不再有任何写工具')
  assert.ok(audit.hostWritableAllowed.includes('pwsh'))
  assert.equal(audit.writableAllowCount, audit.hostWritableAllowed.length)
  assert.equal(audit.ok, true)
  assert.ok(audit.allowed.includes('read'), '只读工具必须出现在放行集合里')
})

test('无授权状态（idle / planning / delivering / paused / executing-invalid）零写权限', async () => {
  withTools({ definitions: () => HOST_TOOLS })
  for (const stateName of ['idle', 'planning', 'delivering', 'paused', 'executing-invalid']) {
    const audit = await auditIsolation(stateName, 'root')
    assert.equal(audit.state, stateName)
    assert.equal(audit.probeSource, 'simulated')
    assert.equal(audit.writableAllowCount, 0, `${stateName} 不该放行任何写工具`)
    assert.deepEqual(audit.selfWriteTools, [])
    assert.equal(audit.ok, true, `${stateName} 的画像必须自洽`)
  }
})

test('未知 scope 显式报错，绝不回退到另一个 scope', async () => {
  withTools({ definitions: () => HOST_TOOLS })
  await assert.rejects(() => auditIsolation('executing', 'global'), /unknown-scope:global/)
})

test('root 与 session 分别取表，不互相冒充', async () => {
  const seen = []
  withTools({
    definitions: (scope) => {
      seen.push(scope)
      return scope ? [{ name: 'session_only_write' }] : [{ name: 'pwsh' }]
    },
  })
  const root = await auditIsolation('executing', 'root')
  const session = await auditIsolation('executing', 'session')
  assert.equal(seen.length, 2)
  assert.equal(seen[0], undefined, 'root 取表时不传 scope')
  assert.ok(seen[1], 'session 取表时必须传会话作用域')
  assert.deepEqual(root.hostWritableAllowed, ['pwsh'])
  assert.deepEqual(session.hostWritableAllowed, ['session_only_write'])
})

test('注册表里新增的写工具自动进入放行集合（无需改测试清单）', async () => {
  withTools({ definitions: () => [...HOST_TOOLS, { name: 'write_extra_thing_zzz' }] })
  const audit = await auditIsolation('executing', 'root')
  assert.ok(audit.hostWritableAllowed.includes('write_extra_thing_zzz'))
  assert.equal(audit.writableAllowCount, 5)
})

test('注册表为空：complete=false 并说明原因，不能冒充"审计通过"', async () => {
  withTools({ definitions: () => [] })
  const audit = await auditIsolation('executing', 'root')
  assert.equal(audit.complete, false)
  assert.equal(audit.note, 'empty-registry')
  assert.equal(audit.total, 0)
  assert.equal(audit.ok, false)
})

test('没有 tools 服务：complete=false，note=no-tools-service', async () => {
  mod.__test.setHostContext({ get: () => undefined })
  const audit = await auditIsolation('executing', 'root')
  assert.equal(audit.complete, false)
  assert.equal(audit.note, 'no-tools-service')
})
