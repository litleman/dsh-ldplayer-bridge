#!/usr/bin/env node
/**
 * dsh-bridge — Windows-side control surface for the LDPlayer x Via x ChatGPT bridge.
 *
 * This is the tool adapter DSH calls from its shell tool. Every command is
 * non-interactive and returns machine-readable output with --json, so an agent
 * can chain it (send -> wait -> read reply) without scraping prose.
 *
 * Exit codes: 0 ok | 1 usage/config error | 2 task failed or timed out | 3 bridge unreachable
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeClient } from '../src/client.js';
import { DEFAULT_CONFIG_PATH, baseUrl, defaultConfig, loadConfig, saveConfig, STATE_DIR } from '../src/config.js';
import { deviceInfo, findAdb, listDevices, pickDevice, reverseList, reverseRemove, reverseSetup, shell } from '../src/adb.js';
import { generateToken, maskToken, nowIso, PROTOCOL, SERVER_VERSION } from '../src/util.js';

const CLI_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(CLI_DIR);

const argv = process.argv.slice(2);
const command = argv[0] || 'help';
const { flags, positional } = parseArgs(argv.slice(1));

main().catch((err) => {
  const message = String((err && err.message) || err);
  console.error(`✖ ${message}`);
  process.exit(err && err.code === 'unreachable' ? 3 : 1);
});

async function main() {
  switch (command) {
    case 'init': return cmdInit();
    case 'token': return cmdToken();
    case 'serve': return cmdServe();
    case 'status': return cmdStatus();
    case 'diag': return cmdDiag();
    case 'send': return cmdSend();
    case 'new-chat': return cmdNewChat();
    case 'wait': return cmdWait();
    case 'get': return cmdGet();
    case 'cancel': return cmdCancel();
    case 'tasks': return cmdTasks();
    case 'clients': return cmdClients();
    case 'adb': return cmdAdb();
    case 'enroll': return cmdEnroll();
    case 'selftest': return cmdSelftest();
    case 'mock-via': return cmdMockVia();
    case 'help':
    case '--help':
    case '-h': return help();
    default:
      console.error(`未知命令：${command}`);
      help();
      process.exitCode = 1;
  }
}

// ---------------------------------------------------------------- config

function cmdInit() {
  const configPath = flags.get('config') || DEFAULT_CONFIG_PATH;
  if (fs.existsSync(configPath) && !flags.has('force')) {
    throw new Error(`配置已存在：${configPath}（加 --force 覆盖，旧 token 会失效）`);
  }
  const config = defaultConfig();
  if (flags.has('port')) config.port = Number.parseInt(flags.get('port'), 10);
  const detected = findAdb(flags.get('adb') || process.env.DSH_ADB_PATH || null);
  if (detected.adbPath) config.adbPath = detected.adbPath;
  const devices = listDevices(config.adbPath);
  const device = pickDevice(devices.devices, flags.get('serial') || null);
  if (device) config.deviceSerial = device.serial;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  saveConfig(config, configPath);
  console.log(`✔ 已生成配置：${configPath}`);
  console.log(`  监听：${config.host}:${config.port}`);
  console.log(`  token：${maskToken(config.token)}（完整值用 dsh-bridge token --show）`);
  console.log(`  adb：${config.adbPath || '未找到（请手工填写 config.adbPath）'}`);
  console.log(`  设备：${config.deviceSerial || '未检测到已启动的模拟器'}`);
  console.log('下一步：dsh-bridge serve  然后  dsh-bridge enroll --push');
}

function cmdToken() {
  const config = loadConfig({ configPath: flags.get('config') });
  if (flags.has('rotate')) {
    config.token = generateToken(48);
    const saved = saveConfig(config);
    console.log(`✔ 已轮换 token 并写入 ${saved}`);
    console.log('  新 token（需重启 serve，并重新 enroll 到 Via）：');
    console.log(`  ${config.token}`);
    return;
  }
  console.log(flags.has('show') ? config.token : maskToken(config.token));
}

// ---------------------------------------------------------------- server

async function cmdServe() {
  const config = loadConfig({ configPath: flags.get('config') });
  const { createBridgeServer } = await import('../src/server.js');
  const bridge = await createBridgeServer({
    config,
    logger: (level, event, fields) => {
      if (level === 'warn' || level === 'error' || flags.has('verbose')) {
        const detail = fields && Object.keys(fields).length ? JSON.stringify(fields) : '';
        console.log(`[${nowIso()}] ${level} ${event} ${detail}`.trim());
      }
    }
  });
  const address = await bridge.listen();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const pidFile = path.join(STATE_DIR, 'bridge.pid');
  fs.writeFileSync(pidFile, String(process.pid), 'utf8');
  console.log(`DSH Bridge ${SERVER_VERSION} (protocol ${PROTOCOL}) 监听 http://${config.host}:${address.port}`);
  console.log(`状态文件：${config.stateFile}`);
  console.log(`PID：${process.pid}（${pidFile}）`);
  const shutdown = async (signal) => {
    console.log(`\n收到 ${signal}，正在关闭…`);
    try { await bridge.close(); } catch { /* best effort */ }
    try { fs.unlinkSync(pidFile); } catch { /* already gone */ }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ---------------------------------------------------------------- status & diag

async function cmdStatus() {
  const config = loadConfig({ configPath: flags.get('config') });
  const client = new BridgeClient(config, { timeoutMs: 5000 });
  const result = { bridge: null, adb: adbSummary(config), error: null };
  try {
    const [health, status] = await Promise.all([client.health(), client.status()]);
    result.bridge = { ...health, ...status };
  } catch (err) {
    result.error = { code: err.code, message: err.message };
  }
  if (flags.has('json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.error) {
      console.log(`Bridge：离线（${result.error.message}）`);
    } else {
      const tasks = result.bridge.tasks || {};
      console.log(`Bridge：在线 ${baseUrl(config)}  protocol=${result.bridge.protocol} v${result.bridge.version}`);
      console.log(`任务：queued=${tasks.queued ?? 0} leased=${tasks.leased ?? 0} succeeded=${tasks.succeeded ?? 0} failed=${tasks.failed ?? 0} timed_out=${tasks.timed_out ?? 0} cancelled=${tasks.cancelled ?? 0}`);
      const clients = result.bridge.clients || [];
      if (!clients.length) console.log('客户端：暂无 Via 心跳');
      for (const c of clients) {
        console.log(`客户端：${c.client_id}  最后心跳=${c.last_seen_at}  ready=${c.ready ?? '?'}  generating=${c.generating ?? '?'}  页面=${c.page || '-'}`);
      }
    }
    console.log(`ADB：${result.adb.adbPath || '未找到'}  设备=${result.adb.serial || '无'}  状态=${result.adb.state || '-'}  reverse=${result.adb.reverse || '无'}`);
    if (result.adb.error) console.log(`ADB 错误：${result.adb.error}`);
  }
  if (result.error) process.exitCode = 3;
}

async function cmdDiag() {
  const config = loadConfig({ configPath: flags.get('config') });
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add('配置文件', fs.existsSync(config.configPath), config.configPath);
  add('token 长度 ≥ 32', config.token.length >= 32, `len=${config.token.length}`);

  const client = new BridgeClient(config, { timeoutMs: 5000 });
  let health = null;
  try {
    health = await client.health();
    add('Bridge /v1/health', true, `protocol=${health.protocol} v${health.version}`);
  } catch (err) {
    add('Bridge /v1/health', false, err.message);
  }

  const adb = adbSummary(config);
  add('adb.exe', Boolean(adb.adbPath), adb.adbPath || '未找到');
  add('设备在线', adb.state === 'device', `${adb.serial || '无'} ${adb.state || ''}`.trim());
  add('ADB reverse 映射', adb.reverse === `tcp:${config.port} tcp:${config.port}`, adb.reverse || adb.error || '无映射');

  if (adb.adbPath && adb.serial && health) {
    // The decisive test: have the *device* reach the host through adb reverse.
    const probe = shell(
      adb.adbPath,
      adb.serial,
      `curl -s -m 6 -H "X-DSH-Token: ${config.token}" http://127.0.0.1:${config.port}/v1/health`,
      12000
    );
    const ok = probe.ok && /"status"\s*:\s*"ok"/.test(probe.stdout);
    add('设备侧访问 Bridge（adb reverse + curl）', ok, ok ? '200 ok' : (probe.stderr || probe.stdout || '无输出').slice(0, 200));
  }

  let status = null;
  try { status = await client.status(); } catch { /* reported above */ }
  if (status) {
    const clients = status.clients || [];
    const known = clients.find((c) => c.client_id === config.clientId) || clients[0];
    add('Via 客户端心跳', Boolean(known), known ? `${known.client_id} @ ${known.last_seen_at}` : '尚未收到心跳（Via 脚本未运行或未打开 ChatGPT 页面）');
    if (known) {
      add('ChatGPT 页面可输入', known.ready === true, `ready=${known.ready} page=${known.page || '-'}`);
      add('页面未在生成中', known.generating !== true, `generating=${known.generating}`);
    }
  }

  const failed = checks.filter((c) => !c.ok);
  if (flags.has('json')) {
    console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
  } else {
    for (const c of checks) console.log(`${c.ok ? '✔' : '✖'} ${c.name} — ${c.detail}`);
    console.log(failed.length === 0 ? '\n全部通过。' : `\n${failed.length} 项未通过。`);
  }
  if (failed.length) process.exitCode = 2;
}

// ---------------------------------------------------------------- tasks

async function cmdSend() {
  const config = loadConfig({ configPath: flags.get('config') });
  const client = new BridgeClient(config, { timeoutMs: 15000 });
  let text = flags.get('text');
  if (!text && flags.has('file')) text = fs.readFileSync(flags.get('file'), 'utf8');
  if (!text && positional.length) text = positional.join(' ');
  if (!text) throw new Error('缺少 --text（或 --file / 位置参数）。');
  const timeoutSeconds = Number.parseInt(flags.get('timeout') || '180', 10);
  const sessionId = flags.get('session') || 'chatgpt-main';
  const targetClient = flags.get('client') || null;

  const created = await client.createTask({ text, sessionId, timeoutSeconds, clientId: targetClient });
  if (flags.has('no-wait')) {
    if (flags.has('json')) console.log(JSON.stringify({ ok: true, task: created }, null, 2));
    else console.log(created.id);
    return;
  }
  console.error(`→ 任务 ${created.id} 已入队（超时 ${timeoutSeconds}s），等待 Via 回传…`);
  const finished = await client.waitTask(created.id, {
    onUpdate: flags.has('verbose') ? (t) => console.error(`  … ${t.status}`) : null
  });
  const ok = finished.status === 'succeeded';
  if (flags.has('json')) {
    console.log(JSON.stringify({ ok, task: finished }, null, 2));
  } else if (ok) {
    console.log(finished.reply);
  } else {
    console.error(`✖ 任务 ${finished.id} 结束状态 ${finished.status}：${finished.error || '无错误信息'}${finished.wait_timed_out ? '（本地等待超时）' : ''}`);
  }
  if (!ok) process.exitCode = 2;
}

async function cmdNewChat() {
  const config = loadConfig({ configPath: flags.get('config') });
  const client = new BridgeClient(config, { timeoutMs: 15000 });
  const timeoutSeconds = Number.parseInt(flags.get('timeout') || '60', 10);
  const created = await client.createTask({
    action: 'new-chat',
    text: '',
    sessionId: flags.get('session') || 'chatgpt-main',
    timeoutSeconds
  });
  if (flags.has('no-wait')) {
    console.log(created.id);
    return;
  }
  const finished = await client.waitTask(created.id, { pollMs: 500 });
  const ok = finished.status === 'succeeded';
  if (flags.has('json')) console.log(JSON.stringify({ ok, task: finished }, null, 2));
  else if (ok) console.log(finished.reply);
  else console.error(`new-chat 结束状态 ${finished.status}：${finished.error || '无错误信息'}`);
  if (!ok) process.exitCode = 2;
}

async function cmdWait() {
  const config = loadConfig({ configPath: flags.get('config') });
  const taskId = flags.get('id') || positional[0];
  if (!taskId) throw new Error('缺少 --id。');
  const finished = await new BridgeClient(config, { timeoutMs: 15000 }).waitTask(taskId);
  const ok = finished.status === 'succeeded';
  if (flags.has('json')) console.log(JSON.stringify({ ok, task: finished }, null, 2));
  else if (ok) console.log(finished.reply);
  else console.error(`✖ ${finished.status}：${finished.error || '无错误信息'}`);
  if (!ok) process.exitCode = 2;
}

async function cmdGet() {
  const config = loadConfig({ configPath: flags.get('config') });
  const taskId = flags.get('id') || positional[0];
  if (!taskId) throw new Error('缺少 --id。');
  const task = await new BridgeClient(config).getTask(taskId);
  if (flags.has('json')) console.log(JSON.stringify(task, null, 2));
  else {
    console.log(`${task.id}  [${task.status}]  ${task.created_at} → ${task.completed_at || '-'}`);
    if (task.reply) console.log(task.reply);
    if (task.error) console.log(`错误：${task.error}`);
  }
}

async function cmdCancel() {
  const config = loadConfig({ configPath: flags.get('config') });
  const taskId = flags.get('id') || positional[0];
  if (!taskId) throw new Error('缺少 --id。');
  const task = await new BridgeClient(config).cancelTask(taskId, flags.get('reason') || 'cancelled_by_dsh');
  console.log(`✔ ${task.id} → ${task.status}`);
}

async function cmdTasks() {
  const config = loadConfig({ configPath: flags.get('config') });
  const rows = await new BridgeClient(config).listTasks({
    limit: Number.parseInt(flags.get('limit') || '20', 10),
    status: flags.get('status') || null
  });
  if (flags.has('json')) console.log(JSON.stringify(rows, null, 2));
  else if (!rows.length) console.log('（无任务）');
  else for (const t of rows) console.log(`${t.id}  ${t.status.padEnd(9)} ${t.created_at}  ${t.completed_at || '-'}`);
}

async function cmdClients() {
  const config = loadConfig({ configPath: flags.get('config') });
  const res = await new BridgeClient(config).clients();
  if (flags.has('json')) console.log(JSON.stringify(res, null, 2));
  else if (!res.clients.length) console.log('（尚无客户端心跳）');
  else for (const c of res.clients) console.log(`${c.client_id}  last_seen=${c.last_seen_at}  ready=${c.ready ?? '?'}  page=${c.page || '-'}`);
}

// ---------------------------------------------------------------- adb & enrollment

async function cmdAdb() {
  const config = loadConfig({ configPath: flags.get('config') });
  const action = positional[0] || 'status';
  const detected = findAdb(config.adbPath);
  if (!detected.adbPath) throw new Error('未找到 adb.exe；用 --adb 或 config.adbPath 指定。');
  const adbPath = detected.adbPath;
  const devices = listDevices(adbPath);
  const device = pickDevice(devices.devices, config.deviceSerial);

  if (action === 'devices') {
    if (flags.has('json')) console.log(JSON.stringify(devices, null, 2));
    else console.log(devices.devices.map((d) => `${d.serial}\t${d.state}\t${d.model || ''}`).join('\n') || '（无设备）');
    return;
  }
  if (!device) throw new Error('没有可用的设备；先启动雷电模拟器。');
  if (action === 'status') {
    const info = deviceInfo(adbPath, device.serial);
    const rev = reverseList(adbPath, device.serial);
    const payload = { serial: device.serial, model: device.model, info, reverse: rev.mappings };
    if (flags.has('json')) console.log(JSON.stringify(payload, null, 2));
    else {
      console.log(`serial=${device.serial} model=${device.model}`);
      console.log(`系统：Android ${info.android}（sdk ${info.sdk}, ${info.abi}）`);
      console.log(`reverse：${rev.mappings.length ? rev.mappings.join(', ') : '（无）'}`);
    }
    return;
  }
  if (action === 'setup') {
    const result = reverseSetup(adbPath, device.serial, config.port);
    if (!result.ok) throw new Error(`reverse 未生效：${result.add.stderr || result.add.stdout}`);
    if (device.serial !== config.deviceSerial) {
      config.deviceSerial = device.serial;
      saveConfig(config);
    }
    console.log(`✔ ${device.serial}: tcp:${config.port} → 主机 tcp:${config.port}`);
    console.log(`  当前映射：${result.list.mappings.join(', ')}`);
    return;
  }
  if (action === 'remove') {
    const result = reverseRemove(adbPath, device.serial, config.port);
    if (!result.ok) throw new Error(`移除失败：${result.stderr}`);
    console.log(`✔ 已移除 tcp:${config.port}`);
    return;
  }
  throw new Error(`未知 adb 子命令：${action}（可用：status/devices/setup/remove）`);
}

function cmdEnroll() {
  const config = loadConfig({ configPath: flags.get('config') });
  fs.mkdirSync(config.outDir, { recursive: true });
  const render = (templatePath, outName) => {
    if (!fs.existsSync(templatePath)) throw new Error(`模板不存在：${templatePath}`);
    const source = fs.readFileSync(templatePath, 'utf8');
    const rendered = source
      .replaceAll('__BRIDGE_BASE__', baseUrl(config))
      .replaceAll('__BRIDGE_TOKEN__', config.token)
      .replaceAll('__CLIENT_ID__', config.clientId);
    const outPath = path.join(config.outDir, outName);
    fs.writeFileSync(outPath, rendered, 'utf8');
    return outPath;
  };
  const bridgeOut = render(config.userscriptPath, 'DSH-GPT-Bridge.user.js');
  const diagOut = render(config.diagnosticPath, 'DSH-Bridge-Diagnostic.user.js');
  console.log('✔ 已生成带 token 的 Via 脚本：');
  console.log(`  ${bridgeOut}`);
  console.log(`  ${diagOut}`);
  console.log(`  token=${maskToken(config.token)}  client=${config.clientId}  base=${baseUrl(config)}`);

  console.log('在 Via 地址栏打开下面的安装链接（Bridge 仍在运行时才有效）：');
  console.log(`  ${baseUrl(config)}/install/${config.token}/diagnostic.user.js`);
  console.log(`  ${baseUrl(config)}/install/${config.token}/bridge.user.js`);

  if (!flags.has('push')) return;
  const detected = findAdb(config.adbPath);
  if (!detected.adbPath) throw new Error('未找到 adb.exe，无法推送。');
  const devices = listDevices(detected.adbPath);
  const device = pickDevice(devices.devices, config.deviceSerial);
  if (!device) throw new Error('没有可用设备，无法推送。');
  for (const [local, remote] of [
    [bridgeOut, '/sdcard/Download/DSH-GPT-Bridge.user.js'],
    [diagOut, '/sdcard/Download/DSH-Bridge-Diagnostic.user.js']
  ]) {
    const res = spawnSync(detected.adbPath, ['-s', device.serial, 'push', local, remote], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000
    });
    if (res.status !== 0) throw new Error(`推送失败：${remote} ${(res.stderr || '').trim()}`);
    console.log(`  → ${device.serial}:${remote}`);
  }
  console.log('请在 Via 中打开 /sdcard/Download/ 下的 .user.js 并安装（先装 Diagnostic 自检，再装 Bridge）。');
}

// ---------------------------------------------------------------- tests

async function cmdSelftest() {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'selftest.js'), ...(flags.has('verbose') ? ['--verbose'] : [])], {
    stdio: 'inherit',
    windowsHide: true
  });
  process.exitCode = res.status ?? 1;
}

async function cmdMockVia() {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'mock-via.js'), ...positional], {
    stdio: 'inherit',
    windowsHide: true
  });
  process.exitCode = res.status ?? 1;
}

// ---------------------------------------------------------------- helpers

function adbSummary(config) {
  const detected = findAdb(config.adbPath);
  if (!detected.adbPath) return { adbPath: null, serial: null, state: null, reverse: null, error: '未找到 adb.exe' };
  const devices = listDevices(detected.adbPath);
  const device = pickDevice(devices.devices, config.deviceSerial);
  if (!device) return { adbPath: detected.adbPath, serial: null, state: null, reverse: null, error: '没有在线设备' };
  const rev = reverseList(detected.adbPath, device.serial);
  const wanted = `tcp:${config.port} tcp:${config.port}`;
  return {
    adbPath: detected.adbPath,
    serial: device.serial,
    state: device.state,
    reverse: rev.mappings.find((m) => m === wanted) || null
  };
}

function parseArgs(list) {
  const flags = new Map();
  const positional = [];
  for (let i = 0; i < list.length; i += 1) {
    const token = list[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = list[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

function help() {
  console.log(`dsh-bridge ${SERVER_VERSION} — Windows 端 Bridge 控制台

用法：
  dsh-bridge init [--port 18765] [--adb <adb.exe>] [--serial <serial>] [--force]
  dsh-bridge serve [--verbose]                       前台运行 Bridge（127.0.0.1:18765）
  dsh-bridge status [--json]                         Bridge/队列/客户端/ADB 一览
  dsh-bridge diag [--json]                           端到端诊断（含设备侧 curl 回环测试）
  dsh-bridge send --text "…" [--timeout 180] [--session chatgpt-main] [--no-wait] [--json]
  dsh-bridge new-chat [--timeout 60] [--no-wait] [--json]
  dsh-bridge wait --id req-000001 [--json]
  dsh-bridge get --id req-000001 [--json]
  dsh-bridge cancel --id req-000001 [--reason …]
  dsh-bridge tasks [--status succeeded] [--limit 20] [--json]
  dsh-bridge clients [--json]
  dsh-bridge adb status|devices|setup|remove
  dsh-bridge enroll [--push]                         生成带 token 的 Via 脚本（--push 推到 /sdcard/Download）
  dsh-bridge token [--show|--rotate]
  dsh-bridge selftest [--verbose]                    自测队列/超时/幂等（不碰真机）
  dsh-bridge mock-via [--once]                       模拟 Via 客户端并回显，用于联调

环境变量：DSH_BRIDGE_TOKEN / DSH_BRIDGE_PORT / DSH_BRIDGE_HOST / DSH_BRIDGE_SERIAL / DSH_ADB_PATH
`);
}
