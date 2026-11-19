#!/usr/bin/env node
/**
 * mock-via — plays the role of the Via userscript so the Windows side can be
 * proven end to end before the phone is involved.
 *
 * It polls like Via does, pretends to type, then reports a reply that echoes
 * the prompt. Useful for `dsh-bridge send` rehearsals and for CI.
 *
 *   node scripts/mock-via.js                 # poll forever
 *   node scripts/mock-via.js --once          # handle at most one task
 *   node scripts/mock-via.js --reply "…"     # custom reply template ({text} placeholder)
 *   node scripts/mock-via.js --fail          # report every task as failed
 */
import { BridgeClient } from '../src/client.js';
import { baseUrl, loadConfig } from '../src/config.js';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const next = argv[index + 1];
  return next && !next.startsWith('--') ? next : true;
};

const config = loadConfig({ configPath: flag('config') });
const clientId = flag('client', 'mock-via');
const intervalMs = Number.parseInt(flag('interval', '500'), 10);
const once = Boolean(flag('once', false));
const shouldFail = Boolean(flag('fail', false));
const typingMs = Number.parseInt(flag('typing', '700'), 10);
const template = flag('reply', '【mock-via 回显】{text}');
const client = new BridgeClient(config, { timeoutMs: 10000 });

let stopping = false;
process.on('SIGINT', () => {
  stopping = true;
  console.log('\nmock-via 停止。');
  process.exit(0);
});

console.log(`mock-via: ${baseUrl(config)}  client=${clientId}  interval=${intervalMs}ms  ${once ? '--once' : 'loop'}`);

let handled = 0;
while (!stopping) {
  try {
    const res = await client.leaseNext(clientId, {
      ready: true,
      generating: false,
      page: 'mock://via',
      scriptVersion: 'mock-0.2.0'
    });
    if (!res.task) {
      await sleep(intervalMs);
      continue;
    }
    const task = res.task;
    console.log(`→ 领取 ${task.id}（${task.text.length} 字符，超时 ${task.timeout_seconds}s）`);
    await sleep(Math.min(typingMs, task.timeout_seconds * 1000));
    if (shouldFail) {
      await client.submitResult(task.id, { clientId, status: 'error', error: 'mock-via 故意失败', completed: false });
      console.log(`✖ ${task.id} → failed`);
    } else {
      const reply = String(template).replaceAll('{text}', task.text);
      await client.submitResult(task.id, { clientId, status: 'success', reply });
      console.log(`✔ ${task.id} → succeeded（${reply.length} 字符）`);
    }
    handled += 1;
    if (once) break;
  } catch (err) {
    if (err && err.code === 'unreachable') {
      console.error(`✖ ${err.message}`);
      process.exit(3);
    }
    console.error(`! ${err && err.message ? err.message : err}`);
    await sleep(Math.max(intervalMs, 1000));
  }
}

console.log(`mock-via 结束，共处理 ${handled} 个任务。`);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
