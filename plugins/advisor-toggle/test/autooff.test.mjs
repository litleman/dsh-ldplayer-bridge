// 自动关闭（评审保护退出）的状态机：分类计数、会话隔离、清零、回执话术。
// 跑法: node --test test/autooff.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const mod = await import('../index.js')
const { stateOf, DEFAULTS, gateDecision } = mod.__test

const FAKE_CTX = {
  get: (name) =>
    name === 'tools'
      ? { list: async () => [{ name: 'read' }, { name: 'pwsh' }], register: () => () => {} }
      : undefined,
}

const fakeExec = (sessionId) => ({ agent: { session: { id: sessionId } } })

// reply: 每次 GET 任务返回的内容；null 表示任务失败（桥接故障）
async function withBridge(reply, fn) {
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const body =
        req.url === '/v1/tasks'
          ? { task: { id: 'req-auto-1' } }
          : reply === null
            ? { task: { status: 'failed', error: 'CHAT_LIMIT：模拟器里找不到输入框' } }
            : { task: { status: 'succeeded', reply } }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`

  const dir = await mkdtemp(join(tmpdir(), 'advisor-autooff-'))
  const saved = { ...DEFAULTS }
  DEFAULTS.bridgeUrl = base
  mod.__test.setResolved({
    workspace: { state: 'ready', path: dir, notesDir: join(dir, 'notes'), bridgeConfigPath: join(dir, 'bridge.json') },
    bridge: { state: 'ready', token: 'test-token', baseUrl: '' },
  })
  mod.__test.setHostContext(FAKE_CTX)
  try {
    await fn()
  } finally {
    mod.__test.setHostContext(null)
    mod.__test.setResolved(null)
    Object.assign(DEFAULTS, saved)
    await new Promise((r) => server.close(r))
    await rm(dir, { recursive: true, force: true })
  }
}

test('HOLD/NO-GO 是正常结论：不计故障、不触发自动关闭', async () => {
  await withBridge('VERDICT: HOLD\n\n资料不够，补证据。', async () => {
    const sessionId = 'auto-hold'
    const state = stateOf(sessionId)
    state.enabled = true
    for (let i = 0; i < 3; i += 1) {
      const r = await mod.__test.review(FAKE_CTX, fakeExec(sessionId), 'plan', '方案')
      assert.equal(r.verdict, 'HOLD')
    }
    assert.equal(state.enabled, true, 'HOLD 不应自动关闭开关')
    assert.equal(state.faultStreak, 0)
    assert.equal(state.protocolFaults, 0)
    assert.equal(state.bridgeFaults, 0)
  })
})

test('拿到有效结论即清零之前累计的故障', async () => {
  await withBridge(null, async () => {
    const sessionId = 'auto-reset'
    const state = stateOf(sessionId)
    state.enabled = true
    await mod.__test.review(FAKE_CTX, fakeExec(sessionId), 'plan', '一')
    await mod.__test.review(FAKE_CTX, fakeExec(sessionId), 'plan', '二')
    assert.equal(state.faultStreak, 2)
  })
  await withBridge('VERDICT: GO\n\n可以。', async () => {
    const sessionId = 'auto-reset'
    const state = stateOf(sessionId)
    state.enabled = true
    const r = await mod.__test.review(FAKE_CTX, fakeExec(sessionId), 'plan', '三')
    assert.equal(r.verdict, 'GO')
    assert.equal(state.faultStreak, 0, '有效结论应把故障计数清零')
    assert.equal(state.autoOffReason, '')
  })
})

test('协议故障（能跑完但解析不出 VERDICT）也会累计并在阈值处退出保护', async () => {
  await withBridge('我觉得这个方案还行，你继续吧。', async () => {
    const sessionId = 'auto-protocol'
    const state = stateOf(sessionId)
    state.enabled = true
    const first = await mod.__test.review(FAKE_CTX, fakeExec(sessionId), 'plan', '方案')
    assert.equal(first.ok, false)
    assert.equal(state.protocolFaults, 1)
    assert.equal(state.enabled, true, '第一次协议故障不该关开关')

    await mod.__test.review(FAKE_CTX, fakeExec(sessionId), 'plan', '方案')
    const third = await mod.__test.review(FAKE_CTX, fakeExec(sessionId), 'plan', '方案')
    assert.equal(third.autoOff, true)
    assert.equal(state.enabled, false)
    assert.match(state.autoOffReason, /协议 3/)
  })
})

test('会话隔离：一个会话的故障不影响另一个会话的开关', async () => {
  await withBridge(null, async () => {
    const a = stateOf('auto-a')
    const b = stateOf('auto-b')
    a.enabled = true
    b.enabled = true
    for (let i = 0; i < 3; i += 1) await mod.__test.review(FAKE_CTX, fakeExec('auto-a'), 'plan', '方案')
    assert.equal(a.enabled, false, 'A 会话连续故障应退出保护')
    assert.equal(b.enabled, true, 'B 会话不该被牵连')
    assert.equal(b.faultStreak, 0)
  })
})

test('自动关闭后门禁确实退出（写工具不再被拦），且状态可被外部读到', async () => {
  const sessionId = 'auto-gate'
  const state = stateOf(sessionId)
  state.enabled = true
  state.grant = null
  const blocked = gateDecision(state, 'write', 'v1', Date.now(), { trusted: true })
  assert.equal(blocked.allow, false, '开着且无授权时必须拒绝')

  state.enabled = false
  state.autoOffReason = '连续 3 次顾问故障（桥接 3 / 协议 0）'
  const open = gateDecision(state, 'write', 'v1', Date.now(), { trusted: true })
  assert.equal(open.allow, true, '关闭后应放行')
  assert.ok(['off', 'disabled'].includes(open.why), `关闭原因应标明开关已关，实际=${open.why}`)
})

test('重载（新会话状态）默认是关，不会静默恢复成开启', () => {
  const state = stateOf('auto-fresh-session')
  assert.equal(state.enabled, false)
  assert.equal(state.faultStreak, 0)
  assert.equal(state.autoOffReason, '')
})

test('回执话术：区分桥接故障与"保护已退出"', () => {
  const bridgeFault = mod.__test.formatAdvisorResult({
    ok: false,
    verdict: '',
    reply: '',
    error: 'CHAT_LIMIT：模拟器里找不到输入框',
    autoOff: false,
  })
  assert.match(bridgeFault, /失败原因/)
  assert.doesNotMatch(bridgeFault, /评审保护已退出/)

  const exited = mod.__test.formatAdvisorResult({
    ok: false,
    verdict: '',
    reply: '',
    error: '等待回复超时',
    autoOff: true,
  })
  assert.match(exited, /评审保护已退出/)
})
