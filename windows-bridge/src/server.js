/**
 * Bridge HTTP server (protocol v1.1).
 *
 * Two faces, one process:
 *   Via userscript  -> GET /v1/tasks/next, POST /v1/tasks/{id}/result
 *   DSH tool layer  -> POST /v1/tasks, GET /v1/tasks/{id}, POST /v1/tasks/{id}/cancel,
 *                      GET /v1/status, GET /v1/clients
 *
 * Safety rails: loopback-only bind, loopback-only peers, constant-time token
 * compare, hard body cap, task text cap, queue cap, per-client poll throttle.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { TaskStore } from './store.js';
import { HttpError, PROTOCOL, SERVER_NAME, SERVER_VERSION, clampInt, isLoopback, nowIso, readJsonBody, sendJson, tokenMatches } from './util.js';

const TASK_ID_RE = /^req-\d{6,}$/;

export async function createBridgeServer({ config, stateFile, logFile, logger = null }) {
  const limits = config.limits;
  const store = new TaskStore({
    stateFile: stateFile || config.stateFile,
    logFile: logFile || config.logFile,
    limits,
    logging: config.logging,
    logger
  });
  await store.load();

  const lastPollByClient = new Map();
  const startedAt = nowIso();

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) {
        try { res.destroy(); } catch { /* already gone */ }
        return;
      }
      const status = err instanceof HttpError ? err.status : 500;
      const code = err instanceof HttpError ? err.code : 'internal_error';
      if (!(err instanceof HttpError)) {
        store.log('warn', 'request_failed', { error: String(err && err.message ? err.message : err) });
      }
      if (status === 413) res.setHeader('Connection', 'close');
      sendJson(res, status, { error: code, message: String(err && err.message ? err.message : err), ...(err && err.extra ? err.extra : {}) });
    });
  });

  server.headersTimeout = 15000;
  server.requestTimeout = 20000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 50;

  const sweeper = setInterval(() => {
    try { store.sweep(); } catch { /* sweep must never take the server down */ }
  }, 1000);
  if (typeof sweeper.unref === 'function') sweeper.unref();

  async function handle(req, res) {
    const peer = req.socket.remoteAddress;
    if (!isLoopback(peer)) {
      store.log('warn', 'peer_rejected', { peer: String(peer || 'unknown') });
      return sendJson(res, 403, { error: 'forbidden_peer', message: 'Bridge 只接受来自回环地址的请求。' });
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const segments = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && url.pathname === '/v1/health') {
      requireToken(req);
      return sendJson(res, 200, {
        status: 'ok',
        protocol: PROTOCOL,
        server: SERVER_NAME,
        version: SERVER_VERSION,
        server_time: nowIso(),
        uptime_seconds: Math.round((Date.now() - Date.parse(startedAt)) / 1000)
      });
    }

    if (req.method === 'GET' && url.pathname === '/v1/status') {
      requireToken(req);
      return sendJson(res, 200, statusPayload());
    }

    if (req.method === 'GET' && url.pathname === '/v1/clients') {
      requireToken(req);
      return sendJson(res, 200, { clients: store.listClients() });
    }

    // ---- one-tap userscript install ----
    // The token rides in the path (not the query) so the URL still ends in
    // `.user.js`; Via only offers its install prompt for that suffix.
    if (req.method === 'GET' && segments[0] === 'install' && segments.length === 3) {
      const supplied = segments[1] || url.searchParams.get('token') || '';
      if (!tokenMatches(supplied, config.token)) {
        throw new HttpError(401, 'unauthorized', '安装链接的 token 不匹配。');
      }
      const scriptName = segments[2];
      const scriptFile = {
        'bridge.user.js': config.userscriptPath,
        'diagnostic.user.js': config.diagnosticPath
      }[scriptName];
      if (!scriptFile) throw new HttpError(404, 'not_found', `未知脚本 ${scriptName}`);
      const source = fs
        .readFileSync(scriptFile, 'utf8')
        .replaceAll('__BRIDGE_BASE__', `http://${config.host}:${config.port}`)
        .replaceAll('__BRIDGE_TOKEN__', config.token)
        .replaceAll('__CLIENT_ID__', config.clientId);
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Disposition': `inline; filename="${scriptName}"`
      });
      return res.end(source);
    }

    // ---- page DOM snapshot reported by the in-page script ----
    // Reply detection depends on ChatGPT's DOM, which changes often. The
    // diagnostic script POSTs what it sees here so the host side can adjust
    // selectors without guesswork.
    if (req.method === 'POST' && url.pathname === '/v1/diag/page') {
      requireToken(req);
      const body = await readJsonBody(req, 262144);
      const reportPath = path.join(path.dirname(config.stateFile), 'page-report.json');
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, JSON.stringify({ received_at: nowIso(), ...body }, null, 2), 'utf8');
      return sendJson(res, 200, { ok: true, saved_to: reportPath });
    }

    // ---- Via side ----
    if (req.method === 'GET' && url.pathname === '/v1/tasks/next') {
      requireToken(req);
      const clientId = (url.searchParams.get('client_id') || '').trim();
      if (!clientId) throw new HttpError(400, 'missing_client_id', '缺少 client_id。');
      throttlePoll(clientId);
      // Missing query parameters must stay `undefined` (not null): a null
      // would be recorded as a heartbeat and reset ready/generating to false.
      const param = (name) => {
        const value = url.searchParams.get(name);
        return value === null ? undefined : value;
      };
      const heartbeat = {
        page: param('page') || null,
        ready: param('ready'),
        generating: param('generating'),
        script_version: param('v') || null,
        error: param('err') || null
      };
      const result = store.leaseNext(clientId, heartbeat);
      return sendJson(res, 200, result);
    }

    if (segments[1] === 'tasks' && segments[3] === 'result' && req.method === 'POST') {
      requireToken(req);
      const taskId = decodeURIComponent(segments[2]);
      assertTaskId(taskId);
      const body = await readJsonBody(req, limits.maxBodyBytes);
      const clientId = typeof body.client_id === 'string' ? body.client_id.trim() : '';
      if (!clientId) throw new HttpError(400, 'missing_client_id', 'result 必须带 client_id。');
      if (body.status !== 'success' && body.status !== 'error') {
        throw new HttpError(400, 'invalid_status', 'result.status 只能是 success 或 error。');
      }
      const outcome = store.submitResult({
        taskId,
        clientId,
        status: body.status,
        reply: typeof body.reply === 'string' ? body.reply : '',
        error: typeof body.error === 'string' ? body.error : '',
        completed: body.completed !== false
      });
      if (outcome.error) throw new HttpError(outcome.error.status, outcome.error.code, outcome.error.message, outcome.error.extra);
      return sendJson(res, 200, { ok: true, duplicate: Boolean(outcome.duplicate), task: outcome.task });
    }

    // ---- DSH side ----
    if (req.method === 'POST' && url.pathname === '/v1/tasks') {
      requireToken(req);
      const body = await readJsonBody(req, limits.maxBodyBytes);
      const created = store.createTask({
        text: body.text,
        action: body.action,
        session_id: body.session_id,
        timeout_seconds: body.timeout_seconds,
        client_id: body.client_id || null,
        meta: body.meta || null
      });
      if (created.error) throw new HttpError(created.error.status, created.error.code, created.error.message);
      return sendJson(res, 201, { ok: true, task: store.get(created.task.id) });
    }

    if (req.method === 'GET' && url.pathname === '/v1/tasks') {
      requireToken(req);
      const limit = clampInt(url.searchParams.get('limit'), 1, 200, 50);
      const status = url.searchParams.get('status');
      return sendJson(res, 200, { tasks: store.list({ limit, status }) });
    }

    if (segments[1] === 'tasks' && segments.length === 3 && req.method === 'GET') {
      requireToken(req);
      const taskId = decodeURIComponent(segments[2]);
      assertTaskId(taskId);
      const task = store.get(taskId);
      if (!task) throw new HttpError(404, 'task_not_found', `任务 ${taskId} 不存在。`);
      return sendJson(res, 200, { task });
    }

    if (segments[1] === 'tasks' && segments[3] === 'cancel' && req.method === 'POST') {
      requireToken(req);
      const taskId = decodeURIComponent(segments[2]);
      assertTaskId(taskId);
      const body = await readJsonBody(req, limits.maxBodyBytes);
      const outcome = store.cancel(taskId, typeof body.reason === 'string' ? body.reason : 'cancelled_by_dsh');
      if (outcome.error) throw new HttpError(outcome.error.status, outcome.error.code, outcome.error.message, outcome.error.extra);
      return sendJson(res, 200, { ok: true, task: outcome.task });
    }

    throw new HttpError(404, 'not_found', `未知端点 ${req.method} ${url.pathname}`);
  }

  function statusPayload() {
    store.sweep();
    const stats = store.stats();
    const clients = store.listClients();
    return {
      status: 'ok',
      protocol: PROTOCOL,
      server: SERVER_NAME,
      version: SERVER_VERSION,
      server_time: nowIso(),
      uptime_seconds: Math.round((Date.now() - Date.parse(startedAt)) / 1000),
      listen: `${config.host}:${config.port}`,
      tasks: stats,
      clients: clients.map((c) => ({
        client_id: c.client_id,
        last_seen_at: c.last_seen_at,
        page: c.page || null,
        ready: c.ready ?? null,
        generating: c.generating ?? null,
        script_version: c.script_version || null,
        lease_count: c.lease_count || 0,
        last_error: c.last_error || null
      }))
    };
  }

  function requireToken(req) {
    const supplied = req.headers['x-dsh-token'];
    if (!tokenMatches(typeof supplied === 'string' ? supplied : '', config.token)) {
      throw new HttpError(401, 'unauthorized', 'X-DSH-Token 缺失或不匹配。');
    }
  }

  function throttlePoll(clientId) {
    const now = Date.now();
    const prev = lastPollByClient.get(clientId) || 0;
    const gap = now - prev;
    if (gap < limits.minPollIntervalMs) {
      throw new HttpError(429, 'poll_too_fast', `轮询过快：最小间隔 ${limits.minPollIntervalMs}ms。`, {
        retry_after_ms: limits.minPollIntervalMs - gap
      });
    }
    lastPollByClient.set(clientId, now);
    if (lastPollByClient.size > 200) lastPollByClient.clear();
  }

  return {
    server,
    store,
    startedAt,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          const address = server.address();
          resolve(address);
        });
      });
    },
    async close() {
      clearInterval(sweeper);
      await new Promise((resolve) => server.close(() => resolve()));
      await store.flush();
    },
    status: statusPayload
  };
}

function assertTaskId(taskId) {
  if (!TASK_ID_RE.test(taskId)) throw new HttpError(400, 'invalid_task_id', `任务 ID 格式无效：${taskId}`);
}

export function statePathsFor(config, overrides = {}) {
  return {
    stateFile: overrides.stateFile || config.stateFile,
    logFile: overrides.logFile || config.logFile
  };
}

export function defaultStateDir(config) {
  return path.dirname(config.stateFile);
}
