/**
 * ADB discovery and reverse-port management for LDPlayer instances.
 * Every command is scoped with `-s <serial>` so multi-instance setups cannot
 * accidentally forward the wrong emulator.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CANDIDATE_ROOTS = [
  'D:\\leidian\\LDPlayer14',
  'D:\\leidian\\LDPlayer12',
  'D:\\leidian\\LDPlayer9',
  'C:\\LDPlayer\\LDPlayer14',
  'C:\\LDPlayer\\LDPlayer12',
  'C:\\LDPlayer\\LDPlayer9',
  'C:\\Program Files\\LDPlayer\\LDPlayer14',
  'C:\\Program Files (x86)\\LDPlayer\\LDPlayer14',
  'D:\\Program Files\\LDPlayer\\LDPlayer14',
  'D:\\Program Files (x86)\\LDPlayer\\LDPlayer14'
];

export function findAdb(explicitPath) {
  const tried = [];
  const consider = (candidate) => {
    if (!candidate) return null;
    tried.push(candidate);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* unreadable path: keep looking */
    }
    return null;
  };

  const direct = consider(explicitPath);
  if (direct) return { adbPath: direct, tried };

  const fromPath = spawnSync('where.exe', ['adb'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
  if (fromPath.status === 0 && fromPath.stdout) {
    for (const line of fromPath.stdout.split(/\r?\n/)) {
      const hit = consider(line.trim());
      if (hit) return { adbPath: hit, tried };
    }
  }

  for (const root of CANDIDATE_ROOTS) {
    const hit = consider(path.join(root, 'adb.exe'));
    if (hit) return { adbPath: hit, tried };
  }
  return { adbPath: null, tried };
}

export function runAdb(adbPath, args, { timeoutMs = 25000 } = {}) {
  if (!adbPath) {
    return { ok: false, code: null, stdout: '', stderr: '未找到 adb.exe；请设置 config.adbPath 或 DSH_ADB_PATH。' };
  }
  const result = spawnSync(adbPath, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024
  });
  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();
  if (result.error) {
    return { ok: false, code: null, stdout, stderr: `${result.error.message}` };
  }
  return { ok: result.status === 0, code: result.status, stdout, stderr };
}

/** Parses `adb devices -l` into structured rows. */
export function listDevices(adbPath) {
  const res = runAdb(adbPath, ['devices', '-l']);
  const devices = [];
  if (res.ok) {
    for (const line of res.stdout.split(/\r?\n/)) {
      const text = line.trim();
      if (!text || text.startsWith('List of devices')) continue;
      const [serial, state, ...rest] = text.split(/\s+/);
      if (!serial) continue;
      const detail = {};
      for (const part of rest) {
        const idx = part.indexOf(':');
        if (idx > 0) detail[part.slice(0, idx)] = part.slice(idx + 1);
      }
      devices.push({ serial, state, product: detail.product || null, model: detail.model || null, device: detail.device || null, transport_id: detail.transport_id || null });
    }
  }
  return { ok: res.ok, devices, raw: res.stdout, stderr: res.stderr, code: res.code };
}

export function pickDevice(devices, preferredSerial) {
  const usable = devices.filter((d) => d.state === 'device');
  if (preferredSerial) {
    const hit = usable.find((d) => d.serial === preferredSerial);
    if (hit) return hit;
  }
  if (usable.length === 1) return usable[0];
  if (usable.length > 1) {
    // Prefer a booted LDPlayer emulator, then the first ready device.
    const emulator = usable.find((d) => /^emulator-\d+$/.test(d.serial));
    return emulator || usable[0];
  }
  return null;
}

export function reverseSetup(adbPath, serial, port) {
  const add = runAdb(adbPath, ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`]);
  const list = reverseList(adbPath, serial);
  return {
    ok: add.ok && list.mappings.includes(`tcp:${port} tcp:${port}`),
    add,
    list
  };
}

export function reverseList(adbPath, serial) {
  const res = runAdb(adbPath, ['-s', serial, 'reverse', '--list']);
  // Newer adb prints `host-13 tcp:18765 tcp:18765`; older prints just the pair.
  const mappings = res.ok
    ? res.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const match = line.match(/(tcp:\d+)\s+(tcp:\d+)/);
          return match ? `${match[1]} ${match[2]}` : line.replace(/^\S+\s+/, '');
        })
    : [];
  return { ok: res.ok, mappings, raw: res.stdout, stderr: res.stderr };
}

export function reverseRemove(adbPath, serial, port) {
  const res = runAdb(adbPath, ['-s', serial, 'reverse', '--remove', `tcp:${port}`]);
  return { ok: res.ok, ...res };
}

export function shell(adbPath, serial, command, timeoutMs = 15000) {
  return runAdb(adbPath, ['-s', serial, 'shell', command], { timeoutMs });
}

/** Reads a compact device fingerprint for compatibility records. */
export function deviceInfo(adbPath, serial) {
  const props = shell(
    adbPath,
    serial,
    'getprop ro.build.version.release; getprop ro.build.version.sdk; getprop ro.product.cpu.abi; getprop ro.product.model'
  );
  const lines = props.ok ? props.stdout.split(/\r?\n/).map((l) => l.trim()) : [];
  return {
    ok: props.ok,
    android: lines[0] || null,
    sdk: lines[1] || null,
    abi: lines[2] || null,
    model: lines[3] || null
  };
}
