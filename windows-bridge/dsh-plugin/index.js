/**
 * dsh-ldplayer-bridge — DSH tools for the LDPlayer/Via ChatGPT bridge.
 *
 * The heavy lifting (HTTP server, task queue, ADB reverse, CLI) lives in the
 * sibling `windows-bridge` package; this plugin only imports its HTTP client
 * and registers normal DSH tools, so a conversation turn can talk to ChatGPT
 * running inside the emulator instead of shelling out to the CLI.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const name = "ldplayer-bridge";
const inject = ["tools"];

const here = path.dirname(fileURLToPath(import.meta.url));
/** windows-bridge root: the plugin lives in `<root>/dsh-plugin`. */
const DEFAULT_BRIDGE_DIR = path.resolve(here, "..");

const Config = z.object({
  bridgeDir: z.string().default(DEFAULT_BRIDGE_DIR),
  defaultTimeoutSeconds: z.natural().min(10).max(900).default(180),
  pollIntervalMs: z.natural().min(200).max(10000).default(500)
});

const OK_ICON = "✔";
const BAD_ICON = "✖";

function readBridgeConfig(bridgeDir) {
  const configPath = path.join(bridgeDir, "config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `找不到 ${configPath}；先在 ${bridgeDir} 里运行 \`node bin/dsh-bridge.js init\`。`
    );
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

const clientPromises = new Map();
async function loadClient(bridgeDir, { timeoutMs = 20000 } = {}) {
  const clientPath = path.join(bridgeDir, "src", "client.js");
  let promise = clientPromises.get(clientPath);
  if (!promise) {
    promise = import(pathToFileURL(clientPath).href);
    clientPromises.set(clientPath, promise);
  }
  const mod = await promise;
  return new mod.BridgeClient(readBridgeConfig(bridgeDir), { timeoutMs });
}

function bareHost(config) {
  return `http://${config.host}:${config.port}`;
}

function adbReverseList(config) {
  if (!config.adbPath || !fs.existsSync(config.adbPath)) {
    return { ok: false, reason: "adbPath 未配置或不存在", lines: [] };
  }
  return new Promise((resolve) => {
    execFile(
      config.adbPath,
      ["-s", config.deviceSerial || "emulator-5554", "reverse", "--list"],
      { timeout: 20000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, reason: (stderr || err.message || "").trim(), lines: [] });
          return;
        }
        const lines = String(stdout)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => line.replace(/^\S+\s+/, ""));
        resolve({ ok: true, lines });
      }
    );
  });
}

async function describeBridge(bridgeDir, timeoutMs) {
  const bridgeConfig = readBridgeConfig(bridgeDir);
  const client = await loadClient(bridgeDir, { timeoutMs });
  const snapshot = { bridgeConfig, health: null, status: null, clients: [], error: null };
  try {
    snapshot.health = await client.health();
    snapshot.status = await client.status();
    snapshot.clients = Array.isArray(snapshot.status?.clients) ? snapshot.status.clients : [];
  } catch (err) {
    snapshot.error = err;
  }
  snapshot.reverse = await adbReverseList(bridgeConfig);
  return snapshot;
}

function ageSeconds(iso) {
  const then = Date.parse(iso || "");
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.round((Date.now() - then) / 1000));
}

function shortPage(page) {
  if (!page) return "?";
  return page.length > 60 ? `${page.slice(0, 57)}…` : page;
}

function renderStatus(snapshot) {
  const { bridgeConfig, health, status, clients, reverse, error } = snapshot;
  const lines = [];
  const up = Boolean(health) && !error;
  lines.push(
    up
      ? `${OK_ICON} Bridge 在线 ${bareHost(bridgeConfig)}（协议 ${health.protocol}，服务端 v${health.version || "?"}）`
      : `${BAD_ICON} Bridge 不可达 ${bareHost(bridgeConfig)}：${error ? error.message : "未知错误"}；先运行 \`node bin/dsh-bridge.js serve\``
  );
  const counts = status && status.tasks;
  if (counts) {
    lines.push(
      `队列：queued ${counts.queued ?? 0} / leased ${counts.leased ?? 0} / 成功 ${counts.succeeded ?? 0} / 失败 ${counts.failed ?? 0} / 超时 ${counts.timed_out ?? 0}`
    );
  }
  if (clients.length === 0) {
    lines.push(`${BAD_ICON} 没有 Via 客户端心跳：确认 Via 停在 https://chatgpt.com/，且页面右下角脚本已「启动」`);
  } else {
    for (const client of clients) {
      const age = ageSeconds(client.last_seen_at);
      const stale = age === null || age > 30;
      const state = client.ready ? "ready" : "busy";
      const extra = client.generating ? "（生成中）" : "";
      const when = age === null ? "?" : stale ? `心跳 ${age}s 前（可能已停）` : `${age}s 前`;
      lines.push(
        `${stale ? BAD_ICON : OK_ICON} 客户端 ${client.client_id}：${state}${extra}，脚本版本 ${client.script_version || "?"}，${when}，页面 ${shortPage(client.page)}`
      );
    }
  }
  if (reverse.ok) {
    const mapped = reverse.lines.find((line) => line.includes(`tcp:${bridgeConfig.port}`));
    lines.push(
      mapped
        ? `${OK_ICON} ADB reverse：${mapped}`
        : `${BAD_ICON} ADB reverse 未建立：设备内无法访问 tcp:${bridgeConfig.port}`
    );
  } else {
    lines.push(`${BAD_ICON} ADB reverse 查询失败：${reverse.reason}`);
  }
  return lines.join("\n");
}

/** The value schema DSL has no minimum/maximum, so bound the seconds here. */
function clampSeconds(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(900, Math.max(10, Math.round(n)));
}

function toResultLine(task, elapsedMs) {
  const seconds = (elapsedMs / 1000).toFixed(1);
  if (task.status === "succeeded") return `ChatGPT 回复（${seconds}s）：\n${task.reply || ""}`;
  if (task.status === "timed_out") return `任务 ${task.id} 超时（${seconds}s），ChatGPT 没有在时限内回传。`;
  if (task.status === "cancelled") return `任务 ${task.id} 已被取消。`;
  return `任务 ${task.id} 失败：${task.error || "未知错误"}`;
}

async function waitForTask(client, taskId, timeoutSeconds, pollIntervalMs) {
  const started = Date.now();
  try {
    const task = await client.waitTask(taskId, {
      pollMs: pollIntervalMs,
      graceMs: 5000
    });
    return { task, elapsedMs: Date.now() - started, error: null };
  } catch (err) {
    // 超时仍有可能是对端刚回传；再取一次快照，把最真实的状态给模型。
    let task = null;
    try {
      const fetched = await client.getTask(taskId);
      task = fetched.task || fetched;
    } catch {
      task = null;
    }
    return { task, elapsedMs: Date.now() - started, error: err };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run adb against the configured device and keep stdout/stderr instead of throwing. */
function adbRun(config, args, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    if (!config.adbPath || !fs.existsSync(config.adbPath)) {
      resolve({ ok: false, stdout: "", stderr: "adbPath 未配置或文件不存在" });
      return;
    }
    const serial = config.deviceSerial || "emulator-5554";
    execFile(
      config.adbPath,
      ["-s", serial, ...args],
      { timeout, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout || "").trim(),
          stderr: String(stderr || (err && err.message) || "").trim()
        });
      }
    );
  });
}

/** The script this bridge is currently serving, read straight from the install route. */
async function servedUserscript(bridgeConfig) {
  const url = `${bareHost(bridgeConfig)}/install/${bridgeConfig.token}/bridge.user.js`;
  const response = await fetch(url);
  const text = await response.text();
  const version = /@version\s+([0-9A-Za-z._-]+)/.exec(text)?.[1] ?? null;
  return { url, status: response.status, version, bytes: Buffer.byteLength(text) };
}

/**
 * Via's script manager, reached through the browser UI. Coordinates come from the
 * 1920x1080 emulator profile; override them through the tool when the layout differs.
 */
const VIA_UPDATE_TAPS = [
  { x: 1851, y: 80, label: "打开菜单" },
  { x: 1856, y: 366, label: "进入设置" },
  { x: 600, y: 729, label: "进入脚本" },
  { x: 1871, y: 90, label: "点更新" },
  // 「确定」在更新弹窗的右下角，y≈665（不是 699：699 落在按钮下方的空白里，
  // 点了等于什么都没发生，脚本永远停在旧版本——2026-11-19 实测踩到）。
  { x: 1165, y: 665, label: "确认更新" }
];

async function installedScriptVersion(bridgeDir) {
  try {
    const client = await loadClient(bridgeDir, { timeoutMs: 8000 });
    const status = await client.status();
    const clients = Array.isArray(status?.clients) ? status.clients : [];
    return clients.map((client) => ({
      id: client.client_id,
      version: client.script_version || null,
      ready: Boolean(client.ready),
      ageSeconds: ageSeconds(client.last_seen_at)
    }));
  } catch (err) {
    return [{ id: "?", version: null, ready: false, ageSeconds: null, error: err.message }];
  }
}

/**
 * 保住「桥」这条链路：雷电（或整台机器）重启后，`adb reverse` 会没了、Via 也被杀，
 * 页面脚本自然不心跳。这里做三件事，每轮都幂等：
 *   1) 设备不在线就等（不自己拉起模拟器，避免抢用户的操作）；
 *   2) reverse 缺 tcp:<port> 就补上；
 *   3) 设备在线但确实没人心跳（>max(3×stale,300)s）→ 强制重启 Via 并打开 ChatGPT（5 分钟冷却）。
 * 返回结构化结果，既给日志用，也可以被工具渲染。
 */
let lastViaRelaunch = 0;
let lastServerSpawn = 0;

/**
 * 保证 Bridge 服务端（`node bin/dsh-bridge.js serve`）活着。
 * 它是独立进程：机器重启、进程被误杀、或 adb/雷电一起重启后，它都可能不在，
 * 这时页面脚本怎么心跳也没用（HTTP 直接 ECONNREFUSED）。
 * 只在健康检查失败时拉起，成功拉起后等最多 10 秒再复检一次。
 */
async function ensureBridgeServer(bridgeDir, { waitMs = 10000 } = {}) {
  const bridgeConfig = readBridgeConfig(bridgeDir);
  const healthUrl = `${bareHost(bridgeConfig)}/v1/health`;
  const probe = async () => {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  };
  if (await probe()) return { action: "server-ok", spawned: false };
  if (Date.now() - lastServerSpawn < 15000) return { action: "server-spawn-cooling", spawned: false };

  const entry = path.join(bridgeDir, "bin", "dsh-bridge.js");
  if (!fs.existsSync(entry)) {
    return { action: "server-missing", spawned: false, error: `找不到 ${entry}` };
  }
  const child = spawn(process.execPath, [entry, "serve"], {
    cwd: bridgeDir,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  lastServerSpawn = Date.now();

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(700);
    if (await probe()) return { action: "server-restarted", spawned: true };
  }
  return { action: "server-unhealthy", spawned: true };
}

async function ensureBridgeLink(bridgeDir, options = {}) {
  const { relaunchVia = true, staleSeconds = 90, force = false } = options;
  const bridgeConfig = readBridgeConfig(bridgeDir);
  const out = {
    server: null,
    device: null,
    reverseAdded: false,
    reversePresent: false,
    relaunchedVia: false,
    heartbeatAge: null,
    action: "none",
    error: null
  };
  // 服务端先活过来，后面 adb / 心跳检查才有意义。
  out.server = (await ensureBridgeServer(bridgeDir)).action;
  if (!bridgeConfig.adbPath || !fs.existsSync(bridgeConfig.adbPath)) {
    out.error = "adbPath 未配置或文件不存在";
    out.action = "no-adb";
    return out;
  }
  const state = await adbRun(bridgeConfig, ["get-state"]);
  out.device = state.ok ? state.stdout || "device" : "offline";
  if (!state.ok || !String(state.stdout || "device").includes("device")) {
    // 设备没起来就什么都不做：自动拉起模拟器会打断用户，改成让调用方决定。
    out.action = "device-offline";
    return out;
  }

  const list = await adbReverseList(bridgeConfig);
  const mapped = list.ok && list.lines.some((line) => line.includes(`tcp:${bridgeConfig.port}`));
  out.reversePresent = Boolean(mapped);
  if (!mapped) {
    const added = await adbRun(bridgeConfig, [
      "reverse",
      `tcp:${bridgeConfig.port}`,
      `tcp:${bridgeConfig.port}`
    ]);
    out.reverseAdded = added.ok;
    if (!added.ok) out.error = added.stderr || "adb reverse 失败";
    out.action = added.ok ? "reverse-restored" : "reverse-failed";
  }

  let fresh = false;
  try {
    const client = await loadClient(bridgeDir, { timeoutMs: 6000 });
    const status = await client.status();
    const clients = Array.isArray(status?.clients) ? status.clients : [];
    const ages = clients
      .map((c) => ageSeconds(c.last_seen_at))
      .filter((n) => Number.isFinite(n));
    out.heartbeatAge = ages.length ? Math.min(...ages) : null;
    fresh = ages.some((age) => age <= staleSeconds);
  } catch (err) {
    out.error = out.error || err.message;
  }

  if (!fresh && relaunchVia) {
    // 只在「确实没人心跳」时才重启 Via：心跳新鲜说明页面活着（可能正在生成回复），
    // 重启会把在飞的任务打断。再加 5 分钟冷却，避免重启风暴。
    const lonely = out.heartbeatAge === null || out.heartbeatAge > Math.max(staleSeconds * 3, 300);
    const cooled = Date.now() - lastViaRelaunch > 5 * 60 * 1000;
    if (lonely && cooled) {
      // 多半是重启后 Via 根本没跑起来，或者停在别的页面。
      // force-stop 一下再开，能保证脚本重新注入（SPA 导航不会重跑脚本）。
      const pkg = bridgeConfig.viaPackage || "mark.via";
      await adbRun(bridgeConfig, ["shell", "am", "force-stop", pkg]);
      await sleep(800);
      await adbRun(bridgeConfig, [
        "shell",
        "am",
        "start",
        "-a",
        "android.intent.action.VIEW",
        "-d",
        "https://chatgpt.com/",
        "-p",
        pkg
      ]);
      lastViaRelaunch = Date.now();
      out.relaunchedVia = true;
      out.action = out.action === "none" ? "via-restarted" : `${out.action}+via-restarted`;
    }
  } else if (fresh && out.action === "none") {
    out.action = "ok";
  }

  if (force && out.action === "none") out.action = "ok";
  return out;
}

function apply(ctx, config) {
  const bridgeDir = path.resolve(config.bridgeDir || DEFAULT_BRIDGE_DIR);
  const defaultTimeoutSeconds = config.defaultTimeoutSeconds ?? 180;
  const pollIntervalMs = config.pollIntervalMs ?? 500;

  // 守护 adb reverse 与 Via 心跳：雷电（或整机）重启后 reverse 会丢、Via 会被杀，
  // 不补这一步就得每次手工 adb reverse + 重开页面（2026-11-20 用户反馈）。
  // watchdogSeconds=0 可关掉；relaunchVia=false 时只补 reverse、不动 Via。
  const watchdogSeconds = config.watchdogSeconds ?? 30;
  const runEnsure = () =>
    ensureBridgeLink(bridgeDir, { relaunchVia: config.relaunchVia !== false })
      .then((r) => {
        if (r.action !== "ok" && r.action !== "none") {
          console.log(
            `[dsh-ldplayer-bridge] ensure: ${r.action} reverse=${r.reversePresent} heartbeat=${r.heartbeatAge ?? "?"}s ${r.error || ""}`
          );
        }
        return r;
      })
      .catch((err) => {
        console.log(`[dsh-ldplayer-bridge] ensure failed: ${err.message}`);
        return { action: "error", error: err.message };
      });
  if (watchdogSeconds > 0) {
    const timer = setInterval(runEnsure, watchdogSeconds * 1000);
    if (typeof timer.unref === "function") timer.unref();
    if (typeof ctx.effect === "function") ctx.effect(() => () => clearInterval(timer));
    setTimeout(runEnsure, 3000);
  }

  ctx.tools.register(
    defineTool({
      name: "gpt_bridge_status",
      description:
        "检查雷电模拟器 + Via + ChatGPT 桥接是否可用：Bridge 进程是否在线、任务队列计数、Via 页面脚本的心跳与 ready 状态、adb reverse 映射。在发送任务前先用它确认链路，或在 gpt_send_message 失败后用它定位问题。",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            bridge: { type: "string", required: true },
            summary: { type: "string", required: true },
            clients: { type: "array", required: true, items: { type: "string" } }
          }
        },
        render: (_args, value) => [{ type: "text", text: value.summary }]
      },
      async execute() {
        const snapshot = await describeBridge(bridgeDir, 8000);
        const ok = Boolean(snapshot.health) && snapshot.clients.length > 0;
        return {
          ok,
          bridge: bareHost(snapshot.bridgeConfig),
          summary: renderStatus(snapshot),
          clients: snapshot.clients.map((client) => client.client_id)
        };
      },
      presentCall: () => ({
        card: "generic",
        title: "Check GPT bridge",
        kind: "other",
        rawInput: {}
      })
    })
  );

  ctx.tools.register(
    defineTool({
      name: "gpt_new_chat",
      description:
        "让模拟器里的 ChatGPT 新建一个对话（回到项目内的空白会话）。当上下文窗口已满、发送被拒绝，或一个议题聊太久需要重新开始时先用它，然后紧接着 gpt_send_message；prompt 是自包含的，所以换新对话不会丢信息。返回 ok 表示已经停在空白输入框上。",
      parameters: {
        timeout_seconds: {
          type: "integer",
          description: "等待新对话就绪的秒数上限，10–900，默认 60。"
        }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            task_id: { type: "string", required: true },
            state: { type: "string", required: true },
            page: { type: "string", required: true },
            error: { type: "string", required: true },
            elapsed_ms: { type: "integer", required: true }
          }
        },
        render: (_args, value) => [
          { type: "text", text: value.error || `新对话已就绪（${value.page || "?"}，${value.task_id}）。` }
        ]
      },
      timeoutMs: 960000,
      async execute(args) {
        const client = await loadClient(bridgeDir, { timeoutMs: 20000 });
        const task = await client.createTask({
          action: "new-chat",
          text: "",
          sessionId: "chatgpt-main",
          timeoutSeconds: clampSeconds(args.timeout_seconds, 60)
        });
        const { task: finished, elapsedMs, error } = await waitForTask(
          client,
          task.id,
          900,
          pollIntervalMs
        );
        if (!finished) {
          return {
            ok: false,
            task_id: task.id,
            state: "unknown",
            page: "",
            error: `新对话任务 ${task.id} 状态查询失败：${error ? error.message : "未知错误"}`,
            elapsed_ms: elapsedMs
          };
        }
        const ok = finished.status === "succeeded";
        return {
          ok,
          task_id: task.id,
          state: finished.status,
          page: ok ? String(finished.reply || "").replace(/^新对话已就绪：/, "") : "",
          error: ok ? "" : toResultLine(finished, elapsedMs),
          elapsed_ms: elapsedMs
        };
      },
      presentCall: () => ({
        card: "generic",
        title: "New ChatGPT conversation",
        kind: "other",
        rawInput: {}
      })
    })
  );

  ctx.tools.register(
    defineTool({
      name: "gpt_send_message",
      description:
        "把一段提示词交给雷电模拟器里 Via 浏览器打开的 ChatGPT，并把它的回复带回来。任务会进入 Bridge 队列，由 Via 页面脚本自动填入输入框、发送、等待生成结束并回传正文。默认等到回复再返回；长回答请把 timeout_seconds 调大。失败时返回 ok=false 和原因，可先用 gpt_bridge_status 排查。",
      parameters: {
        text: {
          type: "string",
          required: true,
          description: "要发给 ChatGPT 的完整提示词（纯文本）。"
        },
        timeout_seconds: {
          type: "integer",
          description: "等待回复的秒数上限，10–900，默认取插件配置（180）。",
        },
        session: {
          type: "string",
          description: "会话标识，仅用于日志区分，默认 chatgpt-main。"
        },
        new_chat: {
          type: "boolean",
          description: "发送前先新建一个对话。上下文窗口已满、或想换一个干净上下文重新开始时用；默认 false。"
        },
        wait: {
          type: "boolean",
          description: "是否等待回复；false 时立即返回 task_id，之后用 gpt_wait_reply 取回复。默认 true。"
        }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            task_id: { type: "string", required: true },
            state: { type: "string", required: true },
            reply: { type: "string", required: true },
            error: { type: "string", required: true },
            elapsed_ms: { type: "integer", required: true }
          }
        },
        render: (_args, value) => [
          {
            type: "text",
            text: value.error || value.reply || `任务 ${value.task_id} 已排队（${value.state}），稍后用 gpt_wait_reply 取回复。`
          }
        ]
      },
      timeoutMs: 960000,
      async execute(args) {
        const bridgeConfig = readBridgeConfig(bridgeDir);
        const client = await loadClient(bridgeDir, { timeoutMs: 20000 });
        const timeoutSeconds = clampSeconds(args.timeout_seconds, defaultTimeoutSeconds);

        if (args.new_chat === true) {
          const chatTask = await client.createTask({
            action: "new-chat",
            text: "",
            sessionId: args.session || "chatgpt-main",
            timeoutSeconds: Math.min(timeoutSeconds, 120)
          });
          const fresh = await waitForTask(client, chatTask.id, chatTask.timeout_seconds || 120, pollIntervalMs);
          const state = fresh.task ? fresh.task.status : "unknown";
          if (!fresh.task || state !== "succeeded") {
            return {
              ok: false,
              task_id: chatTask.id,
              state,
              reply: "",
              error: `新建对话失败，消息未发送：${fresh.task ? toResultLine(fresh.task, fresh.elapsedMs) : "状态查询失败"}`,
              elapsed_ms: fresh.elapsedMs
            };
          }
        }

        const task = await client.createTask({
          text: args.text,
          sessionId: args.session || "chatgpt-main",
          timeoutSeconds,
          clientId: bridgeConfig.clientId
        });
        const taskId = task.id;

        if (args.wait === false) {
          return {
            ok: true,
            task_id: taskId,
            state: task.status || "queued",
            reply: "",
            error: "",
            elapsed_ms: 0
          };
        }

        const { task: finished, elapsedMs, error } = await waitForTask(
          client,
          taskId,
          timeoutSeconds,
          pollIntervalMs
        );
        if (!finished) {
          return {
            ok: false,
            task_id: taskId,
            state: "unknown",
            reply: "",
            error: `任务 ${taskId} 状态查询失败：${error ? error.message : "未知错误"}`,
            elapsed_ms: elapsedMs
          };
        }
        const ok = finished.status === "succeeded";
        return {
          ok,
          task_id: taskId,
          state: finished.status,
          reply: finished.reply || "",
          error: ok ? "" : toResultLine(finished, elapsedMs),
          elapsed_ms: elapsedMs
        };
      },
      presentCall: (args) => ({
        card: "generic",
        title: `Ask ChatGPT in LDPlayer: ${String(args.text).slice(0, 40)}`,
        kind: "other",
        rawInput: args
      })
    })
  );

  ctx.tools.register(
    defineTool({
      name: "gpt_wait_reply",
      description:
        "等待一个已经排队（例如用 gpt_send_message 且 wait=false 创建）的任务返回结果，并取回 ChatGPT 的回复正文。",
      parameters: {
        task_id: {
          type: "string",
          required: true,
          description: "任务 id，形如 req-000012。"
        },
        timeout_seconds: {
          type: "integer",
          description: "额外等待的秒数上限，10–900，默认取插件配置（180）。",
        }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            task_id: { type: "string", required: true },
            state: { type: "string", required: true },
            reply: { type: "string", required: true },
            error: { type: "string", required: true },
            elapsed_ms: { type: "integer", required: true }
          }
        },
        render: (_args, value) => [
          {
            type: "text",
            text: value.error || value.reply || `任务 ${value.task_id} 已排队（${value.state}），稍后用 gpt_wait_reply 取回复。`
          }
        ]
      },
      timeoutMs: 960000,
      async execute(args) {
        const client = await loadClient(bridgeDir, { timeoutMs: 20000 });
        const { task, elapsedMs, error } = await waitForTask(
          client,
          args.task_id,
          clampSeconds(args.timeout_seconds, defaultTimeoutSeconds),
          pollIntervalMs
        );
        if (!task) {
          return {
            ok: false,
            task_id: args.task_id,
            state: "unknown",
            reply: "",
            error: `任务 ${args.task_id} 不存在或查询失败：${error ? error.message : "未知错误"}`,
            elapsed_ms: elapsedMs
          };
        }
        const ok = task.status === "succeeded";
        return {
          ok,
          task_id: args.task_id,
          state: task.status,
          reply: task.reply || "",
          error: ok ? "" : toResultLine(task, elapsedMs),
          elapsed_ms: elapsedMs
        };
      },
      presentCall: (args) => ({
        card: "generic",
        title: `Wait for task ${args.task_id}`,
        kind: "other",
        rawInput: args
      })
    })
  );

  ctx.tools.register(
    defineTool({
      name: "gpt_install_userscript",
      description:
        "把 Bridge 正在提供的 Via 用户脚本装进雷电模拟器里的 Via：先用 adb 补 reverse、在 Via 打开安装地址，再按 1920x1080 的界面坐标走一遍「菜单 → 设置 → 脚本 → 更新 → 确认」，最后用客户端心跳里的 script_version 校验是否真升到了服务端版本。open_only=true 时只打开安装页不点界面；脚本布局不同就传 taps 覆盖坐标。",
      parameters: {
        open_only: {
          type: "boolean",
          description: "只建立 reverse 并在 Via 打开安装页，不执行界面上的一串点击。默认 false。"
        },
        timeout_seconds: {
          type: "integer",
          description: "等待客户端心跳报告新版本的秒数上限，10–300，默认 90。"
        },
        device_serial: { type: "string", description: "覆盖 adb 设备序列号，默认用 config.json 里的 deviceSerial。" },
        via_package: { type: "string", description: "Via 的包名，默认 mark.via。" },
        chat_url: { type: "string", description: "安装完要重开的页面，默认 https://chatgpt.com/。" },
        settle_ms: { type: "integer", description: "两次点击之间的等待毫秒数，默认 1200。" }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            url: { type: "string", required: true },
            served_version: { type: "string", required: true },
            installed_versions: { type: "array", required: true, items: { type: "string" } },
            summary: { type: "string", required: true }
          }
        },
        render: (_args, value) => [{ type: "text", text: value.summary }]
      },
      timeoutMs: 400000,
      async execute(args) {
        const bridgeConfig = readBridgeConfig(bridgeDir);
        const device = {
          ...bridgeConfig,
          deviceSerial: args.device_serial || bridgeConfig.deviceSerial
        };
        const log = [];
        const served = await servedUserscript(bridgeConfig);
        log.push(`服务端脚本：v${served.version || "?"}（${served.bytes} 字节，HTTP ${served.status}）`);

        const reverse = await adbRun(device, ["reverse", `tcp:${bridgeConfig.port}`, `tcp:${bridgeConfig.port}`]);
        log.push(reverse.ok ? `adb reverse tcp:${bridgeConfig.port} 已建立` : `adb reverse 失败：${reverse.stderr}`);

        const pkg = args.via_package || "mark.via";
        const opener = await adbRun(device, [
          "shell",
          "am",
          "start",
          "-a",
          "android.intent.action.VIEW",
          "-d",
          served.url,
          "-p",
          pkg
        ]);
        log.push(opener.ok ? `已在 ${pkg} 打开安装地址` : `打开安装地址失败：${opener.stderr}`);

        if (!args.open_only) {
          const settle = Math.min(8000, Math.max(300, Number(args.settle_ms) || 1200));
          for (const tap of VIA_UPDATE_TAPS) {
            await sleep(settle);
            const tapped = await adbRun(device, ["shell", "input", "tap", String(tap.x), String(tap.y)]);
            log.push(`${tapped.ok ? "点击" : "点击失败"} ${tap.label}（${tap.x},${tap.y}）`);
          }
          // 脚本库更新后 Via 不会重跑已加载的脚本：SPA 导航不够，必须真正重载页面，
          // 否则心跳里的 script_version 会一直停在旧版本（实测 0.2.7 → 0.2.8 就是卡在这一步）。
          const chatUrl = args.chat_url || "https://chatgpt.com/";
          await sleep(1500);
          await adbRun(device, ["shell", "am", "force-stop", pkg]);
          await sleep(1500);
          const reopened = await adbRun(device, [
            "shell",
            "am",
            "start",
            "-a",
            "android.intent.action.VIEW",
            "-d",
            chatUrl,
            "-p",
            pkg
          ]);
          log.push(reopened.ok ? `已重开 ${chatUrl}，让新脚本重新执行` : `重开页面失败：${reopened.stderr}`);
        }

        const budget = clampSeconds(args.timeout_seconds, 90);
        const deadline = Date.now() + budget * 1000;
        let observed = await installedScriptVersion(bridgeDir);
        while (Date.now() < deadline) {
          const hit = observed.find((client) => client.version && client.version === served.version);
          if (hit) break;
          await sleep(2000);
          observed = await installedScriptVersion(bridgeDir);
        }
        const installed = observed.map((client) => `${client.id}=${client.version || "?"}`);
        const matched = observed.some((client) => client.version && client.version === served.version);
        log.push(
          matched
            ? `心跳已报告 v${served.version}，安装完成`
            : `等待 ${budget}s 后仍未看到 v${served.version}；当前心跳：${installed.join("，") || "无客户端"}`
        );
        return {
          ok: matched,
          url: served.url,
          served_version: served.version || "",
          installed_versions: installed,
          summary: log.join("\n")
        };
      },
      presentCall: (args) => ({
        card: "generic",
        title: args.open_only ? "Open the Via userscript install page" : "Install the Via userscript",
        kind: "other",
        rawInput: args
      })
    })
  );
}

export { Config, apply, inject, name };
