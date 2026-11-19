/**
 * Thin HTTP client used by the CLI (and therefore by DSH's shell tool calls).
 * Throws BridgeError with the server's error code so callers can branch on it.
 */
import { baseUrl } from './config.js';

export class BridgeError extends Error {
  constructor(message, { status = 0, code = 'client_error', extra = {} } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export class BridgeClient {
  constructor(config, { timeoutMs = 15000 } = {}) {
    this.config = config;
    this.base = baseUrl(config);
    this.token = config.token;
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, body, { timeoutMs = this.timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(this.base + path, {
        method,
        headers: {
          Accept: 'application/json',
          'X-DSH-Token': this.token,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const text = await response.text();
      let parsed = {};
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        throw new BridgeError(`Bridge 返回了非 JSON 响应（HTTP ${response.status}）。`, { status: response.status, code: 'bad_response' });
      }
      if (!response.ok) {
        throw new BridgeError(parsed.message || parsed.error || `HTTP ${response.status}`, {
          status: response.status,
          code: parsed.error || 'http_error',
          extra: parsed
        });
      }
      return parsed;
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      if (err.name === 'AbortError') {
        throw new BridgeError(`请求超时（${timeoutMs}ms）：${method} ${path}`, { code: 'client_timeout' });
      }
      const cause = err && err.cause ? ` (${err.cause.code || err.cause.message})` : '';
      throw new BridgeError(`无法连接 Bridge ${this.base}${cause}；先运行 dsh-bridge serve。`, { code: 'unreachable' });
    } finally {
      clearTimeout(timer);
    }
  }

  health() {
    return this.request('GET', '/v1/health');
  }

  status() {
    return this.request('GET', '/v1/status');
  }

  clients() {
    return this.request('GET', '/v1/clients');
  }

  async createTask({ text = '', action = 'send', sessionId = 'chatgpt-main', timeoutSeconds = 180, clientId = null, meta = null }) {
    const payload = { text, action, session_id: sessionId, timeout_seconds: timeoutSeconds };
    if (clientId) payload.client_id = clientId;
    if (meta) payload.meta = meta;
    const res = await this.request('POST', '/v1/tasks', payload);
    return res.task;
  }

  async getTask(taskId) {
    const res = await this.request('GET', `/v1/tasks/${encodeURIComponent(taskId)}`);
    return res.task;
  }

  async listTasks({ limit = 50, status = null } = {}) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (status) query.set('status', status);
    const res = await this.request('GET', `/v1/tasks?${query}`);
    return res.tasks;
  }

  /** Via side: long-poll for one task (or {task:null}). */
  leaseNext(clientId, heartbeat = {}) {
    const query = new URLSearchParams({ client_id: clientId });
    if (heartbeat.page) query.set('page', String(heartbeat.page).slice(0, 512));
    if (heartbeat.ready !== undefined) query.set('ready', heartbeat.ready ? '1' : '0');
    if (heartbeat.generating !== undefined) query.set('generating', heartbeat.generating ? '1' : '0');
    if (heartbeat.scriptVersion) query.set('v', heartbeat.scriptVersion);
    if (heartbeat.error) query.set('err', String(heartbeat.error).slice(0, 500));
    return this.request('GET', `/v1/tasks/next?${query}`);
  }

  /** Via side: report the outcome of a leased task. */
  submitResult(taskId, { clientId, status = 'success', reply = '', error = '', completed = true }) {
    return this.request('POST', `/v1/tasks/${encodeURIComponent(taskId)}/result`, {
      client_id: clientId,
      status,
      reply,
      error,
      completed
    });
  }

  async cancelTask(taskId, reason = 'cancelled_by_dsh') {
    const res = await this.request('POST', `/v1/tasks/${encodeURIComponent(taskId)}/cancel`, { reason });
    return res.task;
  }

  /**
   * Polls until the task reaches a terminal state.
   * Hard stop = task deadline + grace, so a dead Bridge can never hang DSH forever.
   */
  async waitTask(taskId, { pollMs = 400, graceMs = 5000, onUpdate = null } = {}) {
    const first = await this.getTask(taskId);
    const deadlineMs = Date.parse(first.deadline_at) + graceMs;
    let last = first;
    while (!isTerminal(last.status)) {
      if (Date.now() > deadlineMs) return { ...last, wait_timed_out: true };
      await sleep(pollMs);
      last = await this.getTask(taskId);
      if (onUpdate) onUpdate(last);
    }
    return last;
  }
}

export function isTerminal(status) {
  return ['succeeded', 'failed', 'timed_out', 'cancelled'].includes(status);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
