// 真实 review() 路径的外发脱敏测试（不是只测 redact() 纯函数）。
// 契约：①外发消息里的凭据被替换、消息头写明命中数；②脱敏实现抛错时**桥请求数必须为 0**（fail-closed）。
// 跑法: node --test test/review-redaction.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mod = await import('../index.js');
const { DEFAULTS, stateOf, setRedactor, resetRedactor } = mod.__test;

async function withBridge(handler) {
  const requests = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ method: req.method, url: req.url, body })
      const reply = handler({ method: req.method, url: req.url, body })
      res.writeHead(reply.status || 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply.json ?? {}))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { requests, base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) }
}

const fakeExec = (sessionId) => ({ agent: { session: { id: sessionId } } })

async function withSandbox(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'advisor-redact-'))
  const saved = { ...DEFAULTS }
  DEFAULTS.notesDir = join(dir, 'notes')
  DEFAULTS.workspace = dir
  // 生产路径由 apply() 里的 resolveConfig 填；测试直接注入 ready 态，桥地址留空以跟随 DEFAULTS.bridgeUrl。
  mod.__test.setResolved({
    workspace: { state: 'ready', path: dir, notesDir: join(dir, 'notes'), bridgeConfigPath: join(dir, 'bridge.json') },
    bridge: { state: 'ready', token: 'test-token', baseUrl: '' },
  })
  try {
    await fn(dir)
  } finally {
    mod.__test.setResolved(null)
    Object.assign(DEFAULTS, saved)
    resetRedactor()
    await rm(dir, { recursive: true, force: true })
  }
}

test('外发消息必须脱敏，且头部写明命中数', async () => {
  await withSandbox(async () => {
    const bridge = await withBridge(({ url, body }) => {
      if (url === '/v1/tasks') return { json: { task: { id: 'req-test-1' } } }
      if (url.startsWith('/v1/tasks/')) {
        return { json: { task: { status: 'succeeded', reply: 'VERDICT: GO\n\n理由：可以。' } } }
      }
      return { status: 404, json: { error: 'not found' } }
    })
    DEFAULTS.bridgeUrl = bridge.base
    try {
      const sessionId = 'redact-session'
      const state = stateOf(sessionId)
      state.enabled = true
      state.round = 0

      const secret = 'X-DSH-Token: 7odG4SuU1sz-Buh6DrrcYwgzuT'
      const home = 'C:\\Users\\litleman\\secret\\file.txt'
      const result = await mod.__test.review({}, fakeExec(sessionId), 'plan', `方案里不小心贴了凭据：\n${secret}\n路径 ${home}`)

      assert.equal(result.ok, true, '正常情况应拿到回复')
      const sent = bridge.requests.find((r) => r.url === '/v1/tasks')
      assert.ok(sent, '必须有桥请求')
      assert.equal(sent.body.includes('7odG4SuU1sz-Buh6DrrcYwgzuT'), false, '真实 token 不能外发');
      assert.equal(sent.body.includes('litleman'), false, '用户名要脱敏');
      assert.match(sent.body, /<redacted>/, '要出现替换标记');
      assert.match(sent.body, /脱敏：redact-v3-advisor，命中 [1-9]\d* 处/, '消息头要写命中数');
      assert.equal(bridge.requests.filter((r) => r.url === '/v1/tasks').length, 1);
    } finally {
      await bridge.close()
    }
  })
})

test('脱敏失败必须 fail-closed：桥请求数为 0，且结果不是成功', async () => {
  await withSandbox(async () => {
    const bridge = await withBridge(({ url }) => {
      if (url === '/v1/tasks') return { json: { task: { id: 'should-not-happen' } } }
      return { json: { task: { status: 'succeeded', reply: 'VERDICT: GO' } } }
    })
    DEFAULTS.bridgeUrl = bridge.base
    try {
      const sessionId = 'redact-boom-session'
      const state = stateOf(sessionId)
      state.enabled = true
      state.round = 0

      setRedactor(() => {
        throw new Error('redact boom')
      })

      let result
      let threw = null
      try {
        result = await mod.__test.review({}, fakeExec(sessionId), 'plan', '随便一段正文')
      } catch (error) {
        threw = error
      }

      assert.equal(bridge.requests.length, 0, `脱敏失败时不能有任何桥请求，实际 ${bridge.requests.length} 条`)
      const failed = Boolean(threw) || result?.ok === false
      assert.equal(failed, true, '脱敏失败不能返回成功结果')
      const text = String(threw?.message || result?.error || '')
      if (threw) assert.match(text, /redact boom/, '抛错要保留原始原因，不能被吞掉')
    } finally {
      resetRedactor()
      await bridge.close()
    }
  })
})
