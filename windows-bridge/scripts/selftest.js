#!/usr/bin/env node
/**
 * selftest — protocol conformance for the Bridge server, no phone required.
 *
 * Boots a throwaway Bridge on an ephemeral port with its own state dir, then
 * drives every rule the protocol promises: token gate, leasing, ownership,
 * idempotent results, timeout, cancellation, lease expiry, body caps, poll
 * throttle, and restart recovery.
 *
 * Exit code 0 = all passed, 1 = at least one failure.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BridgeClient } from '../src/client.js';
import { defaultConfig } from '../src/config.js';
import { createBridgeServer } from '../src/server.js';

const verbose = process.argv.includes('--verbose');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-selftest-'));
const results = [];

function pass(name) {
  results.push({ name, ok: true });
  console.log(`✔ ${name}`);
}

function fail(name, detail) {
  results.push({ name, ok: false, detail });
  console.log(`✖ ${name}\n    ${detail}`);
}

async function check(name, fn) {
  try {
    await fn();
    pass(name);
  } catch (err) {
    fail(name, String((err && err.message) || err));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function assertStatus(err, expectedStatus, expectedCode) {
  assert(err && err.status === expectedStatus, `期望 HTTP ${expectedStatus} ${expectedCode}，实际 ${err && err.status} ${err && err.code}（${err && err.message}）`);
  if (expectedCode) assertEqual(err.code, expectedCode, '错误码');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeConfig(dir, overrides = {}) {
  const config = defaultConfig();
  config.host = '127.0.0.1';
  config.port = 0;
  config.stateFile = path.join(dir, 'state.json');
  config.logFile = path.join(dir, 'bridge.log');
  config.limits = { ...config.limits, minPollIntervalMs: 250, ...(overrides.limits || {}) };
  return Object.assign(config, overrides);
}

function fetchRaw(url, { method = 'GET', token = null, body = null } = {}) {
  const headers = { Accept: 'application/json' };
  if (token !== null) headers['X-DSH-Token'] = token;
  if (body !== null) headers['Content-Type'] = 'application/json';
  return fetch(url, { method, headers, body: body === null ? undefined : body });
}

async function main() {
  const config = makeConfig(path.join(tmpRoot, 'main'));
  fs.mkdirSync(path.dirname(config.stateFile), { recursive: true });
  const bridge = await createBridgeServer({ config });
  const address = await bridge.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const client = new BridgeClient({ ...config, port: address.port }, { timeoutMs: 5000 });
  const C1 = 'selftest-client-a';
  const C2 = 'selftest-client-b';

  console.log(`selftest: ${base}  state=${config.stateFile}\n`);

  // ---------- auth ----------
  await check('health 无 token → 401 unauthorized', async () => {
    const res = await fetchRaw(`${base}/v1/health`);
    assertEqual(res.status, 401, 'HTTP');
    const body = await res.json();
    assertEqual(body.error, 'unauthorized', 'error');
  });

  await check('health 错误 token → 401', async () => {
    const res = await fetchRaw(`${base}/v1/health`, { token: `${config.token}x` });
    assertEqual(res.status, 401, 'HTTP');
  });

  await check('health 正确 token → 200 status=ok', async () => {
    const health = await client.health();
    assertEqual(health.status, 'ok', 'status');
    assertEqual(health.protocol, 'v1.1', 'protocol');
  });

  await check('未知端点 → 404', async () => {
    const res = await fetchRaw(`${base}/v1/nope`, { token: config.token });
    assertEqual(res.status, 404, 'HTTP');
  });

  // ---------- leasing ----------
  let taskA = null;
  await check('POST /v1/tasks → 201 且状态 queued', async () => {
    const res = await fetchRaw(`${base}/v1/tasks`, {
      method: 'POST',
      token: config.token,
      body: JSON.stringify({ text: '自测任务 A', session_id: 'selftest', timeout_seconds: 60 })
    });
    assertEqual(res.status, 201, 'HTTP');
    const body = await res.json();
    taskA = body.task;
    assertEqual(taskA.status, 'queued', 'status');
    assert(/^req-\d{6,}$/.test(taskA.id) ? true : false, `任务 ID 格式异常：${taskA.id}`);
  });

  await check('首个 poll 领取任务 → leased 且只给一个客户端', async () => {
    const res = await client.leaseNext(C1, { ready: true, generating: false, page: 'https://chatgpt.com/' });
    assert(res.task && res.task.id === taskA.id, `期望领取 ${taskA.id}，实际 ${JSON.stringify(res)}`);
    const after = await client.getTask(taskA.id);
    assertEqual(after.status, 'leased', 'status');
    assertEqual(after.client_id, C1, 'owner');
    assertEqual(after.attempts, 1, 'attempts');
  });

  await check('轮询过快 → 429 poll_too_fast', async () => {
    try {
      await client.leaseNext(C1);
      throw new Error('第二次轮询本应被节流');
    } catch (err) {
      assertStatus(err, 429, 'poll_too_fast');
    }
  });

  await check('另一个客户端 poll → task=null（不会双领）', async () => {
    await sleep(config.limits.minPollIntervalMs + 40);
    const res = await client.leaseNext(C2);
    assertEqual(res.task, null, 'task');
    const after = await client.getTask(taskA.id);
    assertEqual(after.client_id, C1, 'owner 不应变化');
  });

  // ---------- results ----------
  await check('非 lease owner 提交 → 409 not_lease_owner', async () => {
    try {
      await client.submitResult(taskA.id, { clientId: C2, status: 'success', reply: 'x' });
      throw new Error('本应被拒绝');
    } catch (err) {
      assertStatus(err, 409, 'not_lease_owner');
    }
  });

  await check('未领取的任务提交 → 409 not_leased', async () => {
    const created = await client.createTask({ text: '未领取任务', timeoutSeconds: 60 });
    try {
      await client.submitResult(created.id, { clientId: C1, status: 'success', reply: 'x' });
      throw new Error('本应被拒绝');
    } catch (err) {
      assertStatus(err, 409, 'not_leased');
    }
    await client.cancelTask(created.id, 'selftest_cleanup');
  });

  await check('owner 提交 success → succeeded 且 reply 保留', async () => {
    const res = await client.submitResult(taskA.id, { clientId: C1, status: 'success', reply: '这是回显：自测任务 A' });
    assertEqual(res.task.status, 'succeeded', 'status');
    assertEqual(res.task.reply, '这是回显：自测任务 A', 'reply');
  });

  await check('重复提交同样载荷 → duplicate=true（幂等）', async () => {
    const res = await client.submitResult(taskA.id, { clientId: C1, status: 'success', reply: '这是回显：自测任务 A' });
    assertEqual(res.duplicate, true, 'duplicate');
  });

  await check('重复提交不同载荷 → 409 already_finished', async () => {
    try {
      await client.submitResult(taskA.id, { clientId: C1, status: 'success', reply: '换一个答案' });
      throw new Error('本应被拒绝');
    } catch (err) {
      assertStatus(err, 409, 'already_finished');
    }
  });

  await check('success 但 reply 为空 → failed（不静默成功）', async () => {
    const created = await client.createTask({ text: '空回复任务', timeoutSeconds: 60, clientId: C1 });
    await sleep(config.limits.minPollIntervalMs + 40);
    await client.leaseNext(C1);
    const res = await client.submitResult(created.id, { clientId: C1, status: 'success', reply: '   ' });
    assertEqual(res.task.status, 'failed', 'status');
  });

  // ---------- cancel & timeout ----------
  await check('cancel → cancelled，再 cancel → 409', async () => {
    const created = await client.createTask({ text: '取消任务', timeoutSeconds: 60 });
    const cancelled = await client.cancelTask(created.id, 'selftest');
    assertEqual(cancelled.status, 'cancelled', 'status');
    try {
      await client.cancelTask(created.id);
      throw new Error('第二次取消本应被拒绝');
    } catch (err) {
      assertStatus(err, 409, 'already_finished');
    }
  });

  await check('超时 → timed_out（把 deadline 拨到过去再 sweep）', async () => {
    const created = await client.createTask({ text: '超时任务', timeoutSeconds: 30 });
    const live = bridge.store.tasks.get(created.id);
    live.deadline_at = new Date(Date.now() - 1000).toISOString();
    bridge.store.sweep();
    const after = await client.getTask(created.id);
    assertEqual(after.status, 'timed_out', 'status');
  });

  // ---------- lease expiry ----------
  await check('lease 过期 → 重排队，再过期 → failed（重试用尽）', async () => {
    const created = await client.createTask({ text: '租约任务', timeoutSeconds: 120, clientId: C1 });
    await sleep(config.limits.minPollIntervalMs + 40);
    await client.leaseNext(C1);
    const live = bridge.store.tasks.get(created.id);
    assertEqual(live.attempts, 1, 'attempts after first lease');
    live.lease_expires_at = new Date(Date.now() - 1000).toISOString();
    bridge.store.sweep();
    let after = await client.getTask(created.id);
    assertEqual(after.status, 'queued', '重排队状态');
    assert(after.notes.includes('lease_expired_requeued'), 'notes 应记录 lease_expired_requeued');

    await sleep(config.limits.minPollIntervalMs + 40);
    const leased = await client.leaseNext(C1);
    assert(leased.task && leased.task.id === created.id, '应再次领取到同一个任务');
    const live2 = bridge.store.tasks.get(created.id);
    assertEqual(live2.attempts, 2, 'attempts after second lease');
    live2.lease_expires_at = new Date(Date.now() - 1000).toISOString();
    bridge.store.sweep();
    after = await client.getTask(created.id);
    assertEqual(after.status, 'failed', '重试用尽后状态');
  });

  // ---------- limits ----------
  await check('请求体超上限 → 413 body_too_large', async () => {
    const big = JSON.stringify({ text: 'x'.repeat(config.limits.maxBodyBytes + 1024) });
    const res = await fetchRaw(`${base}/v1/tasks`, { method: 'POST', token: config.token, body: big });
    assertEqual(res.status, 413, 'HTTP');
    const body = await res.json();
    assertEqual(body.error, 'body_too_large', 'error');
  });

  await check('text 超字符上限 → 400 text_too_long', async () => {
    const res = await fetchRaw(`${base}/v1/tasks`, {
      method: 'POST',
      token: config.token,
      body: JSON.stringify({ text: 'x'.repeat(config.limits.maxTextChars + 1) })
    });
    assertEqual(res.status, 400, 'HTTP');
    const body = await res.json();
    assertEqual(body.error, 'text_too_long', 'error');
  });

  await check('非法任务 ID → 400 invalid_task_id', async () => {
    const res = await fetchRaw(`${base}/v1/tasks/../etc/passwd`, { token: config.token });
    assert(res.status === 400 || res.status === 404, `期望 400/404，实际 ${res.status}`);
  });

  // ---------- status & clients ----------
  await check('status 汇总统计 & 客户端心跳可见', async () => {
    const status = await client.status();
    assert(status.tasks && status.tasks.total > 0, '缺少 tasks 统计');
    const seen = (status.clients || []).find((c) => c.client_id === C1);
    assert(seen, `未看到客户端 ${C1} 的心跳`);
    assertEqual(seen.ready, true, 'heartbeat.ready');
  });

  await check('list tasks 支持 status 过滤', async () => {
    const rows = await client.listTasks({ status: 'succeeded', limit: 10 });
    assert(rows.length >= 1 && rows.every((t) => t.status === 'succeeded'), '过滤结果不正确');
  });

  await bridge.close();

  // ---------- restart recovery ----------
  await check('重启后：queued 保留、leased 重新入队', async () => {
    const dir = path.join(tmpRoot, 'restart');
    const cfg = makeConfig(dir);
    fs.mkdirSync(path.dirname(cfg.stateFile), { recursive: true });
    let server = await createBridgeServer({ config: cfg });
    let addr = await server.listen();
    let c = new BridgeClient({ ...cfg, port: addr.port }, { timeoutMs: 5000 });
    try {
      // Target the two tasks at different clients so the lease below can only
      // pick the intended one (queued stays queued).
      const queued = await c.createTask({ text: '重启后仍在排队的任务', timeoutSeconds: 120, clientId: 'other-client' });
      const leased = await c.createTask({ text: '重启时处于 leased 的任务', timeoutSeconds: 120, clientId: C1 });
      const got = await c.leaseNext(C1);
      assert(got.task && got.task.id === leased.id, `应领取 ${leased.id}，实际 ${JSON.stringify(got.task && got.task.id)}`);
      await server.close();

      server = await createBridgeServer({ config: cfg });
      addr = await server.listen();
      c = new BridgeClient({ ...cfg, port: addr.port }, { timeoutMs: 5000 });
      const q = await c.getTask(queued.id);
      const l = await c.getTask(leased.id);
      assertEqual(q.status, 'queued', 'queued 任务状态');
      assertEqual(l.status, 'queued', 'leased 任务重启后应重新入队');
      assert(l.notes.includes('bridge_restarted'), 'notes 应记录 bridge_restarted');
    } finally {
      await server.close();
    }
  });

  // ---------- report ----------
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(` - ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log('全部通过。');
  }
  if (verbose) console.log(`临时状态目录：${tmpRoot}`);
  else fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`✖ selftest 崩溃：${(err && err.stack) || err}`);
  process.exit(1);
});
