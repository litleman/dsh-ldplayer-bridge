#!/usr/bin/env node
// 重启后自检：不依赖浏览器，直接用 HTTP 打插件的 5 个端点，验证
//   /state 字段齐全 → /hello 注册与冲突 → /toggle 开关 → /override 必须先领票。
// 用法: node scripts/verify-restart.mjs [--base http://127.0.0.1:56051] [--session verify-restart]
// 产出: docs/anomaly-report.txt（成功也写，作为一次运行的证据）
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, '..');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const base = arg('base', 'http://127.0.0.1:56051').replace(/\/+$/, '');
const session = arg('session', `verify-restart-${Date.now().toString(36)}`);
const prefix = `${base}/api/advisor-toggle`;

const lines = [];
const failures = [];
const note = (ok, text, extra = '') => {
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${text}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures.push(text);
};

async function call(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${prefix}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

const run = async () => {
  lines.push(`# 顾问开关重启自检  ${new Date().toISOString()}`);
  lines.push(`base=${base}`);
  lines.push(`session=${session}`);
  lines.push('');

  // 1. /state 字段齐全
  const state = await call(`/state?session=${encodeURIComponent(session)}`)
  const expectedKeys = ['enabled', 'version', 'stateVersion', 'generation', 'alert', 'granted', 'degraded', 'deniedStreak']
  const missing = state.status === 200 ? expectedKeys.filter((k) => !(k in (state.json || {}))) : expectedKeys
  note(state.status === 200 && missing.length === 0, '/state 可读且字段齐全', `status=${state.status} missing=${missing.join(',') || '-'}`)

  // 2. /hello 注册 + 冲突
  const nonce = `n-${Date.now().toString(36)}`
  const hello = await call('/hello', { method: 'POST', body: { session, clientNonce: nonce } })
  note(hello.status === 200 && hello.json?.clientNonce === nonce, '/hello 首次注册成功', `status=${hello.status}`)
  const conflict = await call('/hello', { method: 'POST', body: { session, clientNonce: `${nonce}-other` } })
  note(conflict.status === 409, '/hello 换 nonce 被拒(409)', `status=${conflict.status}`)

  // 3. /toggle 打开 → 关闭（带 expectedVersion，验证乐观并发）
  const before = (await call(`/state?session=${encodeURIComponent(session)}`)).json || {}
  const open = await call('/toggle', {
    method: 'POST',
    body: { session, enabled: true, expectedVersion: before.stateVersion, clientNonce: nonce },
  })
  note(open.status === 200 && open.json?.enabled === true, '/toggle 打开成功', `status=${open.status}`)
  const openState = (await call(`/state?session=${encodeURIComponent(session)}`)).json || {}
  note(openState.stateVersion > before.stateVersion, '/toggle 递增 stateVersion', `${before.stateVersion} -> ${openState.stateVersion}`)

  const close = await call('/toggle', {
    method: 'POST',
    body: { session, enabled: false, expectedVersion: openState.stateVersion, clientNonce: nonce },
  })
  note(close.status === 200 && close.json?.enabled === false, '/toggle 关闭成功', `status=${close.status}`)

  // 4. /override 必须先领票
  const noTicket = await call('/override', { method: 'POST', body: { session, confirm: 'user', clientNonce: nonce } })
  note(noTicket.status === 403, '/override 无票被拒', `status=${noTicket.status} error=${noTicket.json?.error || '-'}`)

  const challenge = await call('/override/challenge', { method: 'POST', body: { session, clientNonce: nonce } })
  note(challenge.status === 200 && Boolean(challenge.json?.challengeId), '/override/challenge 发票成功', `status=${challenge.status}`)

  const wrongConfirm = await call('/override', {
    method: 'POST',
    body: { session, confirm: 'agent', clientNonce: nonce },
  })
  note(wrongConfirm.status === 403, '/override 冒充(confirm=agent)被拒', `status=${wrongConfirm.status}`)

  // 5. 收尾：把自检会话复位（关着），避免留下一个开着的假会话
  const final = (await call(`/state?session=${encodeURIComponent(session)}`)).json || {}
  if (final.enabled) {
    await call('/toggle', { method: 'POST', body: { session, enabled: false, expectedVersion: final.stateVersion, clientNonce: nonce } })
    lines.push('INFO  自检会话已复位为关闭')
  }

  lines.push('')
  lines.push(failures.length === 0 ? `RESULT: OK (${lines.filter((l) => l.startsWith('PASS')).length} 项全过)` : `RESULT: FAIL (${failures.length} 项失败)`)
  const target = join(pluginDir, 'docs', 'anomaly-report.txt')
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, `${lines.join('\n')}\n`, 'utf8')
  console.log(lines.join('\n'))
  console.log(`\n报告写入: ${target}`)
  process.exitCode = failures.length === 0 ? 0 : 1
};

run().catch(async (error) => {
  lines.push(`FAIL  自检中断: ${error?.stack || error}`)
  const target = join(pluginDir, 'docs', 'anomaly-report.txt')
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, `${lines.join('\n')}\n`, 'utf8')
  console.error(lines.join('\n'))
  process.exitCode = 1
})
