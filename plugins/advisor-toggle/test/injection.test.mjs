// 注入消息的回归测试：agent/pre-step 追加的 user 消息必须带 source。
//
// 背景：experimental-liveshare 的 agent/pre-step 包装会读 message.source.kind，
// 注入的消息没有 source 时它抛 TypeError: Cannot read properties of undefined
// (reading 'kind')，整轮直接 agent.failed。这里锁死两条：
//   1. userMessage() 产出的消息一定有 source.kind；
//   2. 源码里不再出现手写 `{ role: 'user', content: ... }` 这种裸消息。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const mod = await import('../index.js');
const { userMessage } = mod.__test;

test('注入的 user 消息带 source.kind（缺了会让 liveshare 的 pre-step 崩溃）', () => {
  const message = userMessage({ text: '提醒一下', source: { kind: 'advisor-delivery-reminder' } });
  assert.equal(message.role, 'user');
  assert.equal(message.source?.kind, 'advisor-delivery-reminder');
  assert.deepEqual(message.content, [{ type: 'text', text: '提醒一下' }]);
});

test('源码里不再存在没有 source 的裸 user 消息', async () => {
  const source = await readFile(join(root, 'index.js'), 'utf8');
  const bare = /role:\s*['"]user['"]\s*,\s*content:/.exec(source);
  assert.equal(bare, null, `发现手写裸消息：${bare?.[0] ?? ''}；请改用 userMessage()`);
});
