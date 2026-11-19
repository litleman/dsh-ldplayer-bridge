/**
 * In-memory task queue with JSON snapshot persistence.
 *
 * State machine (protocol v1):
 *   queued -> leased -> succeeded | failed
 *          -> timed_out | cancelled
 *   leased -> queued   (lease expired, retry budget left)
 *
 * Invariants:
 *  - a task is leased to at most one client at a time (single-threaded mutation,
 *    check-and-set in one tick);
 *  - terminal results are idempotent (same payload again = 200 duplicate);
 *  - a task never disappears silently: restart re-queues unfinished work.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensureDir, nowIso, writeFileAtomic } from './util.js';

const TERMINAL = new Set(['succeeded', 'failed', 'timed_out', 'cancelled']);

export class TaskStore {
  constructor({ stateFile, logFile = null, limits, logging = {}, logger = null }) {
    this.stateFile = stateFile;
    this.logFile = logFile;
    this.limits = limits;
    this.logging = logging;
    this.logger = logger; // (level, message, fields) => void
    this.seq = 0;
    this.tasks = new Map(); // id -> task
    this.clients = new Map(); // client_id -> client record
    this.saveTimer = null;
    this.saveChain = Promise.resolve();
    this.startedAt = nowIso();
  }

  // ---------- lifecycle ----------

  async load() {
    try {
      const raw = await fs.readFile(this.stateFile, 'utf8');
      const snapshot = JSON.parse(raw);
      this.seq = Number.isInteger(snapshot.seq) ? snapshot.seq : 0;
      for (const task of snapshot.tasks || []) {
        if (!task || !task.id) continue;
        this.tasks.set(task.id, task);
      }
      for (const client of snapshot.clients || []) {
        if (client && client.client_id) this.clients.set(client.client_id, client);
      }
      const recovered = this._requeueUnfinished('bridge_restarted');
      this.log('info', 'state_loaded', { tasks: this.tasks.size, clients: this.clients.size, requeued: recovered });
      return { loaded: true, tasks: this.tasks.size, recovered };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.log('warn', 'state_load_failed', { error: String(err.message || err) });
      }
      return { loaded: false, tasks: 0, recovered: 0 };
    }
  }

  _requeueUnfinished(reason) {
    let recovered = 0;
    for (const task of this.tasks.values()) {
      if (TERMINAL.has(task.status)) continue;
      if (task.status === 'queued') continue;
      task.status = 'queued';
      task.client_id = null;
      task.leased_at = null;
      task.lease_expires_at = null;
      task.requeued_at = nowIso();
      task.notes = [...(task.notes || []), reason];
      recovered += 1;
    }
    if (recovered) this.scheduleSave();
    return recovered;
  }

  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this._writeSnapshot();
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this._writeSnapshot().catch(() => {});
    }, 120);
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref();
  }

  _writeSnapshot() {
    const snapshot = {
      version: 1,
      saved_at: nowIso(),
      seq: this.seq,
      tasks: [...this.tasks.values()],
      clients: [...this.clients.values()]
    };
    const data = `${JSON.stringify(snapshot, null, 2)}\n`;
    this.saveChain = this.saveChain
      .then(async () => {
        await ensureDir(path.dirname(this.stateFile));
        await writeFileAtomic(this.stateFile, data);
      })
      .catch((err) => this.log('warn', 'state_save_failed', { error: String(err.message || err) }));
    return this.saveChain;
  }

  // ---------- logging ----------

  log(level, event, fields = {}) {
    const entry = { at: nowIso(), level, event, ...fields };
    // Task text and replies are only logged when explicitly enabled.
    if (this.logger) this.logger(level, event, fields);
    if (!this.logFile) return;
    this._appendLog(`${JSON.stringify(entry)}\n`);
  }

  _appendLog(line) {
    ensureDir(path.dirname(this.logFile))
      .then(() => fs.appendFile(this.logFile, line, 'utf8'))
      .catch(() => {});
  }

  // ---------- task creation ----------

  nextId() {
    this.seq += 1;
    return `req-${String(this.seq).padStart(6, '0')}`;
  }

  createTask({ text, action = 'send', session_id = 'chatgpt-main', timeout_seconds, client_id = null, meta = null }) {
    // `new-chat` opens a fresh conversation in the page and sends nothing, so it
    // needs no prompt text; `probe` reports page statistics; `send` (the default)
    // still requires a prompt.
    const kind = action === 'new-chat' || action === 'probe' ? action : 'send';
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (kind === 'send' && !trimmed) {
      return { error: { status: 400, code: 'empty_text', message: 'text 不能为空。' } };
    }
    if (trimmed.length > this.limits.maxTextChars) {
      return {
        error: {
          status: 400,
          code: 'text_too_long',
          message: `text 超过 ${this.limits.maxTextChars} 字符上限（当前 ${trimmed.length}）。`
        }
      };
    }
    const queued = [...this.tasks.values()].filter((t) => t.status === 'queued' || t.status === 'leased' || t.status === 'running').length;
    if (queued >= this.limits.maxQueuedTasks) {
      return { error: { status: 503, code: 'queue_full', message: `未完成任务已达上限 ${this.limits.maxQueuedTasks}。` } };
    }
    const timeout = Number.isFinite(Number(timeout_seconds))
      ? Math.min(this.limits.maxTimeoutSeconds, Math.max(5, Math.round(Number(timeout_seconds))))
      : this.limits.defaultTimeoutSeconds;

    const created = nowIso();
    const task = {
      id: this.nextId(),
      action: kind,
      text: trimmed,
      session_id: String(session_id || 'chatgpt-main').slice(0, 64),
      created_at: created,
      timeout_seconds: timeout,
      deadline_at: new Date(Date.parse(created) + timeout * 1000).toISOString(),
      target_client: client_id ? String(client_id).slice(0, 64) : null,
      status: 'queued',
      client_id: null,
      attempts: 0,
      leased_at: null,
      lease_expires_at: null,
      completed_at: null,
      reply: null,
      error: null,
      meta,
      notes: []
    };
    this.tasks.set(task.id, task);
    this._pruneFinished();
    this.scheduleSave();
    this.log('info', 'task_created', {
      task_id: task.id,
      action: kind,
      timeout_seconds: timeout,
      text_chars: trimmed.length,
      ...(this.logging.taskText ? { text: trimmed } : {})
    });
    return { task };
  }

  _pruneFinished() {
    const finished = [...this.tasks.values()]
      .filter((t) => TERMINAL.has(t.status))
      .sort((a, b) => Date.parse(a.completed_at || a.created_at) - Date.parse(b.completed_at || b.created_at));
    const excess = finished.length - this.limits.maxRetainedTasks;
    if (excess <= 0) return;
    for (const task of finished.slice(0, excess)) this.tasks.delete(task.id);
  }

  // ---------- leasing ----------

  leaseNext(clientId, heartbeat = {}) {
    this.touchClient(clientId, heartbeat);
    this.sweep();
    const now = Date.now();
    const candidate = [...this.tasks.values()]
      .filter((t) => t.status === 'queued')
      .filter((t) => !t.target_client || t.target_client === clientId)
      .filter((t) => Date.parse(t.deadline_at) > now)
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];

    if (!candidate) return { task: null };

    candidate.status = 'leased';
    candidate.client_id = clientId;
    candidate.attempts += 1;
    candidate.leased_at = nowIso();
    candidate.lease_expires_at = new Date(now + this.limits.leaseSeconds * 1000).toISOString();

    const client = this.clients.get(clientId);
    if (client) client.lease_count = (client.lease_count || 0) + 1;
    this.scheduleSave();
    this.log('info', 'task_leased', {
      task_id: candidate.id,
      client_id: clientId,
      attempt: candidate.attempts,
      ...(this.logging.taskText ? { text: candidate.text } : {})
    });
    return {
      task: {
        id: candidate.id,
        action: candidate.action || 'send',
        text: candidate.text,
        session_id: candidate.session_id,
        created_at: candidate.created_at,
        timeout_seconds: candidate.timeout_seconds
      }
    };
  }

  // ---------- results ----------

  submitResult({ taskId, clientId, status, reply, error, completed = true }) {
    const task = this.tasks.get(taskId);
    if (!task) return { error: { status: 404, code: 'task_not_found', message: `任务 ${taskId} 不存在。` } };

    const normalized = status === 'success' ? 'success' : 'error';
    if (TERMINAL.has(task.status)) {
      const sameOutcome =
        (normalized === 'success' && task.status === 'succeeded' && task.reply === (reply || '').slice(0, this.limits.maxReplyChars)) ||
        (normalized === 'error' && task.status === 'failed' && task.error === (error || '').slice(0, 2000));
      if (sameOutcome) {
        return { task: this.publicTask(task), duplicate: true };
      }
      return {
        error: {
          status: 409,
          code: 'already_finished',
          message: `任务 ${taskId} 已处于终态 ${task.status}，拒绝覆盖。`,
          extra: { current_status: task.status }
        }
      };
    }

    if (task.status !== 'leased' && task.status !== 'running') {
      return {
        error: {
          status: 409,
          code: 'not_leased',
          message: `任务 ${taskId} 当前状态为 ${task.status}，没有交给任何客户端。`,
          extra: { current_status: task.status }
        }
      };
    }
    if (task.client_id && clientId && task.client_id !== clientId) {
      return {
        error: {
          status: 409,
          code: 'not_lease_owner',
          message: `任务 ${taskId} 由 ${task.client_id} 领取，${clientId} 不能提交结果。`
        }
      };
    }

    task.completed_at = nowIso();
    task.lease_expires_at = null;
    if (normalized === 'success') {
      const text = typeof reply === 'string' ? reply : '';
      if (!text.trim()) {
        task.status = 'failed';
        task.error = '客户端报告成功，但 reply 为空。';
      } else {
        task.status = 'succeeded';
        task.reply = text.slice(0, this.limits.maxReplyChars);
      }
    } else {
      task.status = 'failed';
      task.error = String(error || '客户端报告未知错误。').slice(0, 2000);
    }
    this.scheduleSave();
    this.log('info', 'task_result', {
      task_id: task.id,
      client_id: clientId || task.client_id,
      status: task.status,
      reply_chars: task.reply ? task.reply.length : 0,
      ...(this.logging.taskText ? { reply: task.reply, error: task.error } : {}),
      completed: Boolean(completed)
    });
    return { task: this.publicTask(task) };
  }

  // ---------- reads & control ----------

  get(taskId) {
    const task = this.tasks.get(taskId);
    return task ? this.publicTask(task) : null;
  }

  /** Full record for the DSH side: includes the prompt text. */
  publicTask(task) {
    return {
      id: task.id,
      action: task.action || 'send',
      status: task.status,
      session_id: task.session_id,
      created_at: task.created_at,
      timeout_seconds: task.timeout_seconds,
      deadline_at: task.deadline_at,
      client_id: task.client_id,
      attempts: task.attempts,
      leased_at: task.leased_at,
      lease_expires_at: task.lease_expires_at,
      completed_at: task.completed_at,
      reply: task.reply,
      error: task.error,
      text: task.text,
      notes: task.notes || []
    };
  }

  list({ limit = 50, status = null } = {}) {
    let rows = [...this.tasks.values()];
    if (status) rows = rows.filter((t) => t.status === status);
    rows.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    return rows.slice(0, limit).map((t) => this.publicTask(t));
  }

  cancel(taskId, reason = 'cancelled_by_dsh') {
    const task = this.tasks.get(taskId);
    if (!task) return { error: { status: 404, code: 'task_not_found', message: `任务 ${taskId} 不存在。` } };
    if (TERMINAL.has(task.status)) {
      return { error: { status: 409, code: 'already_finished', message: `任务 ${taskId} 已是终态 ${task.status}。` } };
    }
    task.status = 'cancelled';
    task.completed_at = nowIso();
    task.lease_expires_at = null;
    task.error = `已取消（${reason}）。`;
    task.notes = [...(task.notes || []), reason];
    this.scheduleSave();
    this.log('info', 'task_cancelled', { task_id: task.id, reason });
    return { task: this.publicTask(task) };
  }

  // ---------- expiry sweep ----------

  sweep() {
    const now = Date.now();
    let changed = 0;
    for (const task of this.tasks.values()) {
      if (TERMINAL.has(task.status)) continue;
      const deadline = Date.parse(task.deadline_at);
      if (Number.isFinite(deadline) && now >= deadline) {
        task.status = 'timed_out';
        task.completed_at = nowIso();
        task.lease_expires_at = null;
        task.error = `任务超时（${task.timeout_seconds}s）未完成。`;
        changed += 1;
        this.log('info', 'task_timed_out', { task_id: task.id, client_id: task.client_id });
        continue;
      }
      if (task.status === 'leased' && task.lease_expires_at && now >= Date.parse(task.lease_expires_at)) {
        if (task.attempts < this.limits.maxLeaseAttempts) {
          task.status = 'queued';
          task.client_id = null;
          task.leased_at = null;
          task.lease_expires_at = null;
          task.requeued_at = nowIso();
          task.notes = [...(task.notes || []), 'lease_expired_requeued'];
          changed += 1;
          this.log('warn', 'task_requeued', { task_id: task.id, attempts: task.attempts });
        } else {
          task.status = 'failed';
          task.completed_at = nowIso();
          task.lease_expires_at = null;
          task.error = 'Via 领取任务后未回传结果（lease 过期，重试次数用尽）。';
          changed += 1;
          this.log('warn', 'task_lease_dead', { task_id: task.id, attempts: task.attempts });
        }
      }
    }
    if (changed) this.scheduleSave();
    return changed;
  }

  // ---------- clients ----------

  touchClient(clientId, heartbeat = {}) {
    if (!clientId) return null;
    const now = nowIso();
    const client = this.clients.get(clientId) || {
      client_id: clientId,
      first_seen_at: now,
      last_seen_at: null,
      last_poll_at: null,
      lease_count: 0,
      last_error: null,
      page: null,
      script_version: null
    };
    client.last_seen_at = now;
    client.last_poll_at = now;
    if (heartbeat.page) client.page = String(heartbeat.page).slice(0, 512);
    if (heartbeat.ready !== undefined) client.ready = heartbeat.ready === true || heartbeat.ready === '1' || heartbeat.ready === 'true';
    if (heartbeat.generating !== undefined) {
      client.generating = heartbeat.generating === true || heartbeat.generating === '1' || heartbeat.generating === 'true';
    }
    if (heartbeat.script_version) client.script_version = String(heartbeat.script_version).slice(0, 32);
    if (heartbeat.error) client.last_error = String(heartbeat.error).slice(0, 500);
    this.clients.set(clientId, client);
    this.scheduleSave();
    return client;
  }

  listClients() {
    return [...this.clients.values()].sort((a, b) => String(b.last_seen_at).localeCompare(String(a.last_seen_at)));
  }

  stats() {
    const counts = { queued: 0, leased: 0, running: 0, succeeded: 0, failed: 0, timed_out: 0, cancelled: 0 };
    for (const task of this.tasks.values()) {
      if (counts[task.status] !== undefined) counts[task.status] += 1;
    }
    return { total: this.tasks.size, ...counts, started_at: this.startedAt };
  }
}
