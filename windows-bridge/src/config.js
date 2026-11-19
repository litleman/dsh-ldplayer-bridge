/**
 * Bridge configuration: one JSON file next to the code, plus env overrides.
 * The token lives here (never in logs, never echoed by the API).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateToken } from './util.js';

export const BRIDGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CONFIG_PATH = path.join(BRIDGE_ROOT, 'config.json');
export const STATE_DIR = path.join(BRIDGE_ROOT, '.state');

export const DEFAULT_LIMITS = {
  maxBodyBytes: 64 * 1024,
  maxTextChars: 20000,
  maxReplyChars: 60000,
  maxQueuedTasks: 200,
  maxRetainedTasks: 500,
  minPollIntervalMs: 200,
  defaultTimeoutSeconds: 180,
  maxTimeoutSeconds: 900,
  leaseSeconds: 300,
  maxLeaseAttempts: 2
};

export function defaultConfig() {
  return {
    host: '127.0.0.1',
    port: 18765,
    token: generateToken(48),
    adbPath: null,
    deviceSerial: null,
    clientId: 'ldplayer-via-main',
    userscriptPath: path.join(BRIDGE_ROOT, 'via', 'DSH-GPT-Bridge.user.js'),
    diagnosticPath: path.join(BRIDGE_ROOT, 'via', 'DSH-Bridge-Diagnostic.user.js'),
    outDir: path.join(BRIDGE_ROOT, 'out'),
    stateFile: path.join(STATE_DIR, 'state.json'),
    logFile: path.join(STATE_DIR, 'bridge.log'),
    logging: { taskText: false },
    limits: { ...DEFAULT_LIMITS }
  };
}

export function loadConfig({ configPath = DEFAULT_CONFIG_PATH, create = false } = {}) {
  const file = path.resolve(configPath || DEFAULT_CONFIG_PATH);
  let raw = null;
  if (fs.existsSync(file)) {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else if (create) {
    raw = defaultConfig();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  } else {
    throw new Error(`未找到配置文件 ${file}；先运行 dsh-bridge init 生成。`);
  }

  const config = {
    ...defaultConfig(),
    ...raw,
    limits: { ...DEFAULT_LIMITS, ...(raw.limits || {}) },
    logging: { taskText: false, ...(raw.logging || {}) }
  };

  // Relative paths in the file resolve against the config file's directory.
  const baseDir = path.dirname(file);
  for (const key of ['userscriptPath', 'diagnosticPath', 'outDir', 'stateFile', 'logFile']) {
    if (config[key] && !path.isAbsolute(config[key])) config[key] = path.resolve(baseDir, config[key]);
  }

  if (process.env.DSH_BRIDGE_TOKEN) config.token = process.env.DSH_BRIDGE_TOKEN;
  if (process.env.DSH_BRIDGE_PORT) config.port = Number.parseInt(process.env.DSH_BRIDGE_PORT, 10);
  if (process.env.DSH_BRIDGE_HOST) config.host = process.env.DSH_BRIDGE_HOST;
  if (process.env.DSH_BRIDGE_SERIAL) config.deviceSerial = process.env.DSH_BRIDGE_SERIAL;
  if (process.env.DSH_ADB_PATH) config.adbPath = process.env.DSH_ADB_PATH;

  validateConfig(config);
  config.configPath = file;
  return config;
}

export function validateConfig(config) {
  if (!config.token || config.token.length < 32) {
    throw new Error('token 太短：至少 32 个字符；运行 dsh-bridge token --rotate 生成新 token。');
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error(`端口无效：${config.port}`);
  }
  const host = String(config.host || '');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`拒绝绑定 ${host}：Bridge 只允许绑定回环地址。`);
  }
}

export function saveConfig(config, configPath = config.configPath || DEFAULT_CONFIG_PATH) {
  const file = path.resolve(configPath);
  const { configPath: _ignored, ...persisted } = config;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(persisted, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return file;
}

export function baseUrl(config) {
  const host = config.host === '::1' ? '[::1]' : config.host;
  return `http://${host}:${config.port}`;
}
