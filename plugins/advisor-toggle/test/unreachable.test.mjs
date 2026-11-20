// 顾问不可达时的行为：失败原因必须可见，连续失败要自动关掉开关（不把人锁在门外）。
// 跑法: node --test test/unreachable.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const mod = await import('../index.js')
const { stateOf, DEFAULTS } = mod.__test

const FAKE_CTX = {
  get: (name) =>
    name === 'tools'
      ? { list: async () => [{ name: 'read' }, { name: 'pwsh' }], register: () => () => {} }
      : undefined,
}

const fakeExec = (sessionId) => ({ agent: { session: { id: sessionId } } })

async function withFailingBridge(fn) {
  const requests = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      requests.push(req.url)
      const body = req.url === '/v1/tasks'
        ? { task: { id: 'req-fail-1' } }
        : { task: { status: 'failed', error: 'CHAT_LIMIT：模拟器里找不到输入框' } }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`

  const dir = await mkdtemp(join(tmpdir(), 'advisor-fail-'))
  const saved = { ...DEFAULTS }
  DEFAULTS.bridgeUrl = base
  mod.__test.setResolved({
    workspace: { state: 'ready', path: dir, notesDir: join(dir, 'notes'), bridgeConfigPath: join(dir, 'bridge.json') },
    bridge: { state: 'ready', token: 'test-token', baseUrl: '' },
  })
  mod.__test.setHostContext(FAKE_CTX)
  try {
    await fn({ requests })
  } finally {
    mod.__test.setHostContext(null)
    mod.__test.setResolved(null)
    Object.assign(DEFAULTS, saved)
    await new Promise((r) => server.close(r))
    await rm(dir, { recursive: true, force: true })
  }
}

test('顾问不可达：工具回执里必须能看到真实失败原因与排查步骤', async () => {
  const text = mod.__test.formatAdvisorResult({
    ok: false,
    verdict: '',
    reply: '',
    error: 'CHAT_LIMIT：模拟器里找不到输入框',
  })
  assert.match(text, /失败原因：CHAT_LIMIT/)
  assert.match(text, /桥接=/)
  assert.match(text, /gpt_new_chat/)
  assert.match(text, /长按 3 秒/)
})

test('顾问不可达：连续 3 次失败自动关掉开关，并标明 autoOff', async () => {
  await withFailingBridge(async () => {
    const sessionId = 'unreachable-session'
    const state = stateOf(sessionId)
    state.enabled = true

    const first = await mod.__test.review(FAKE_CTX, fakeExec(sessionId), 'plan', '随便一段方案')
    assert.equal(first.ok, false)
    assert.match(first.error, /CHAT_LIMIT/)
    assert.equal(state.enabled, true, '第一次失败不该立刻关开关')

    await mod.__test.review(FAKE_CTX, fakeExec(sessionId), 'plan', '再来一次')
    const third = await mod.__test.review(FAKE_CTX, fakeExec(sessionId), 'plan', '第三次')

    assert.equal(third.ok, false)
    assert.equal(state.enabled, false, '连续失败达到阈值后开关应自动关闭')
    assert.equal(third.autoOff, true, '回执要告诉调用方"开关已自动关闭"')
    assert.match(state.autoOffReason, /连续 3 次顾问故障/)
  })
})
