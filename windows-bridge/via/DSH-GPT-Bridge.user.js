// ==UserScript==
// @name         DSH GPT Bridge (Via)
// @namespace    https://local.dsh-bridge/
// @version      0.2.8
// @description  Connect the ChatGPT page inside Via Browser to the local DeepSeekHarness bridge (polling task queue).
// @author       DSH Bridge Project
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @updateURL    __BRIDGE_BASE__/install/__BRIDGE_TOKEN__/bridge.user.js
// @downloadURL  __BRIDGE_BASE__/install/__BRIDGE_TOKEN__/bridge.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  "use strict";

  // ===== Injected by `dsh-bridge enroll` — do not edit by hand =====
  const BRIDGE_BASE = "__BRIDGE_BASE__";
  const BRIDGE_TOKEN = "__BRIDGE_TOKEN__";
  const CLIENT_ID = "__CLIENT_ID__";
  const SCRIPT_VERSION = "0.2.8";

  const POLL_INTERVAL_MS = 1800;
  const REQUEST_TIMEOUT_MS = 12000;
  const REPLY_TIMEOUT_MS = 180000;
  const REPLY_GRACE_MS = 8000;
  const QUIET_STABLE_MS = 2600;
  const MAX_REPLY_CHARS = 60000;
  const MAX_TEXT_CHARS = 20000;

  const STATE_KEY = "dsh_bridge_enabled_v1";
  // Remember the project page so "new chat" can come back to a fresh
  // conversation *inside the same project* instead of the bare chat homepage.
  const PROJECT_URL_KEY = "dsh_bridge_project_path_v1";
  // A hard navigation reloads the page and would drop a leased control task, so
  // the task is parked here first and reported as soon as the fresh page loads.
  const PENDING_KEY = "dsh_bridge_pending_v1";
  // ChatGPT blocks the composer once the conversation is full; these are the
  // banners it shows. Detecting them turns a 5-minute hang into a fast retry.
  const LIMIT_RE = /上下文窗口已达上限|已达到消息上限|消息上限|达到对话上限|对话已达上限|You've reached the limit|out of messages|context window is full/i;
  // Via only exposes the GM_* hooks listed in @grant; referencing an ungranted
  // one throws ReferenceError and would kill the whole script. Probe with typeof.
  const store = {
    get(key, fallback) {
      try {
        return typeof GM_getValue === "function" ? GM_getValue(key, fallback) : fallback;
      } catch (_) { return fallback; }
    },
    set(key, value) {
      try {
        if (typeof GM_setValue === "function") GM_setValue(key, value);
      } catch (_) { /* persistence is optional */ }
    }
  };
  let enabled = store.get(STATE_KEY, true) !== false;
  let pollTimer = null;
  let busy = false;
  let panel = null;
  let statusNode = null;
  let pill = null;
  let body = null;
  let closeButton = null;
  let expanded = false;
  let lastError = false;

  function setStatus(message, isError) {
    lastError = Boolean(isError);
    if (statusNode) {
      statusNode.textContent = (isError ? "错误：" : "状态：") + message;
      statusNode.style.color = isError ? "#b42318" : "#16794a";
    }
    if (pill) pill.dataset.bad = isError ? "1" : "0";
    refreshPill();
  }

  function request(method, path, body) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== "function") {
        reject(new Error("Via 未提供 GM_xmlhttpRequest；检查脚本授权。"));
        return;
      }
      const headers = { Accept: "application/json", "X-DSH-Token": BRIDGE_TOKEN };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      GM_xmlhttpRequest({
        method,
        url: BRIDGE_BASE + path,
        headers,
        data: body === undefined ? undefined : JSON.stringify(body),
        timeout: REQUEST_TIMEOUT_MS,
        onload: (response) => {
          let parsed = {};
          try { parsed = response.responseText ? JSON.parse(response.responseText) : {}; } catch (_) {
            reject(new Error("Bridge 返回非 JSON（HTTP " + response.status + "）。"));
            return;
          }
          if (response.status < 200 || response.status >= 300) {
            const label = parsed.error === "unauthorized" ? "token 不匹配" : (parsed.error || "HTTP " + response.status);
            const err = new Error("Bridge 拒绝：" + label + (parsed.retry_after_ms ? "（稍后重试）" : ""));
            err.code = parsed.error || "http_" + response.status;
            reject(err);
            return;
          }
          resolve(parsed);
        },
        onerror: () => reject(new Error("无法连接 Bridge；检查 Bridge 是否运行、ADB reverse 是否生效。")),
        ontimeout: () => reject(new Error("Bridge 请求超时。"))
      });
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function visible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findComposer() {
    const selectors = [
      "#prompt-textarea",
      "div[contenteditable='true'][data-testid*='composer']",
      "div[contenteditable='true'][role='textbox']",
      "textarea[data-testid='prompt-textarea']",
      "form textarea"
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && visible(el)) return el;
    }
    const form = document.querySelector("form");
    if (form) {
      const el = form.querySelector("[contenteditable='true'], textarea");
      if (el && visible(el)) return el;
    }
    return null;
  }

  function setNativeValue(el, value) {
    el.focus();
    if (el.isContentEditable) {
      el.replaceChildren();
      const paragraph = document.createElement("p");
      paragraph.textContent = value;
      el.appendChild(paragraph);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function findSendButton() {
    const selectors = [
      "button[data-testid='send-button']",
      "button[aria-label*='Send']",
      "button[aria-label*='发送']",
      "form button[type='submit']"
    ];
    for (const selector of selectors) {
      const hit = [...document.querySelectorAll(selector)].find((b) => visible(b) && !b.disabled);
      if (hit) return hit;
    }
    return null;
  }

  function isGenerating() {
    const buttons = [...document.querySelectorAll("button")];
    return buttons.some((button) => {
      if (!visible(button)) return false;
      const label = ((button.getAttribute("aria-label") || "") + " " +
        (button.getAttribute("data-testid") || "") + " " + (button.innerText || "")).toLowerCase();
      return /stop generating|stop streaming|stop response|停止生成|停止响应|停止回答|停止/.test(label);
    });
  }

  // ChatGPT's reply container has changed shape more than once. Older builds
  // mark turns with data-message-author-role; the current build (Via's WebView
  // / Android) instead puts a screen-reader heading "ChatGPT 说：" (h1-h6.sr-only)
  // at the top of each assistant turn, so that heading is the stable anchor.
  const SR_HEADING = /^(ChatGPT\s*(说|表示|said)|ChatGPT\s*说|You\s*said|你说)[：:]/i;

  function legacyAssistantNodes() {
    return [...document.querySelectorAll("[data-message-author-role='assistant']")];
  }

  function modernAssistantNodes() {
    const headings = [...document.querySelectorAll("main h1, main h2, main h3, main h4, main h5, main h6")];
    const turns = [];
    for (const heading of headings) {
      const text = (heading.innerText || heading.textContent || "").trim();
      if (!SR_HEADING.test(text)) continue;
      // The heading sits inside the turn wrapper; that wrapper also holds the
      // message body.
      const turn = heading.parentElement;
      if (turn && !turns.includes(turn)) turns.push(turn);
    }
    return turns;
  }

  function assistantNodes() {
    const legacy = legacyAssistantNodes();
    return legacy.length ? legacy : modernAssistantNodes();
  }

  function nodeText(node) {
    if (!node) return "";
    const clone = node.cloneNode(true);
    clone.querySelectorAll("button, nav, style, script, [class*='sr-only'], [aria-hidden='true']").forEach((el) => el.remove());
    const text = ((clone.innerText || clone.textContent || "") + "").trim();
    return text.replace(SR_HEADING, "").trim();
  }

  function lastNode() {
    const nodes = assistantNodes();
    return nodes.length ? nodes[nodes.length - 1] : null;
  }

  function lastText() {
    return nodeText(lastNode());
  }

  // ---------- conversation lifecycle ----------

  /** The project path (/g/g-p-…/) survives new chats; a /c/<id> suffix does not. */
  function rememberProjectPath() {
    const hit = /^(\/g\/g-p-[^/]+)/.exec(location.pathname);
    if (hit) store.set(PROJECT_URL_KEY, hit[1]);
  }

  function freshChatUrl() {
    const saved = store.get(PROJECT_URL_KEY, "");
    return typeof saved === "string" && /^\/g\/g-p-[^/]+/.test(saved) ? saved : "/";  }

  function pageSaysLimit() {
    const main = document.querySelector("main") || document.body;
    if (!main) return false;
    const text = (main.innerText || main.textContent || "").slice(-20000);
    return LIMIT_RE.test(text);
  }

  function findNewChatControl() {
    const nodes = [...document.querySelectorAll("a, button, [role='button'], [role='link']")];
    return nodes.find((el) => {
      if (!visible(el)) return false;
      const label = ((el.getAttribute("aria-label") || "") + " " + (el.innerText || "")).trim().toLowerCase();
      return /新聊天|新对话|新建对话|new chat/.test(label);
    }) || null;
  }

  async function waitForFreshChat(budgetMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < budgetMs) {
      await sleep(600);
      if (findComposer() && assistantNodes().length === 0 && !isGenerating()) return true;
    }
    return false;
  }

  /**
   * `new-chat` may need a real navigation; the page reload kills the closure that
   * owns the leased task, so park it and report after the fresh page settles.
   */
  function parkPending(task) {
    if (!task || !task.id) return;
    try {
      store.set(PENDING_KEY, JSON.stringify({
        id: task.id,
        action: task.action === "new-chat" ? "new-chat" : "send",
        text: task.text || "",
        ts: Date.now()
      }));
    } catch (_) { /* ignore */ }
  }

  function clearPending() {
    try { store.set(PENDING_KEY, ""); } catch (_) { /* ignore */ }
  }

  async function recoverPending() {
    let pending = null;
    try { pending = JSON.parse(store.get(PENDING_KEY, "") || "null"); } catch (_) { pending = null; }
    if (!pending || !pending.id) return;
    if (Date.now() - Number(pending.ts || 0) > 180000) {
      clearPending();
      return;
    }
    const ready = await waitForFreshChat(25000);
    if (!ready) return;
    const resultUrl = "/v1/tasks/" + encodeURIComponent(pending.id) + "/result";
    if (pending.action === "send" && pending.text) {
      // The reload interrupted a prompt that was already queued; resend it here so
      // the caller still gets an answer instead of a timeout.
      setStatus("已切到新对话，正在补发任务 " + pending.id + "…");
      try {
        const reply = await submitPrompt(pending.text, REPLY_TIMEOUT_MS - REPLY_GRACE_MS);
        clearPending();
        await request("POST", resultUrl, { client_id: CLIENT_ID, status: "success", reply, completed: true });
        setStatus("任务 " + pending.id + " 已补发并回传。");
      } catch (err) {
        clearPending();
        const message = String((err && err.message) || err);
        try {
          await request("POST", resultUrl, { client_id: CLIENT_ID, status: "error", error: message, completed: true });
        } catch (_) { /* the Bridge times the task out on its own */ }
        setStatus(message, true);
      }
      return;
    }
    clearPending();
    try {
      await request("POST", resultUrl, {
        client_id: CLIENT_ID, status: "success", reply: "新对话已就绪：" + location.pathname, completed: true
      });
      setStatus("已恢复任务 " + pending.id + "：新对话已就绪。");
    } catch (_) { /* the Bridge times the task out on its own */ }
  }

  /**
   * Open a new conversation *inside the current project* so the advisor keeps its
   * knowledge base. This is a real navigation, so the leased task is parked in GM
   * storage first and reported by `recoverPending()` on the fresh page.
   */
  async function startNewChat(quiet, task) {
    const target = freshChatUrl();
    const atTarget = location.pathname === target || location.pathname === target + "/";
    if (atTarget && findComposer() && assistantNodes().length === 0) {
      return location.pathname;
    }
    parkPending(task);
    if (!quiet) setStatus("正在新开对话…");
    location.href = target;
    await sleep(2500);
    // A real navigation unloads this page; only the SPA variant gets here.
    const ok = await waitForFreshChat(20000);
    if (!ok) throw new Error("新建对话失败：跳转后没有等到空白输入框。");
    clearPending();
    return location.pathname;
  }

  async function submitPrompt(text, budgetMs) {
    const composer = findComposer();
    if (!composer) throw new Error("找不到输入框：页面可能未登录、未加载完，或聊天界面已改版。");
    if (pageSaysLimit()) {
      const limitError = new Error("CHAT_LIMIT：当前对话已达上下文或消息上限，需要新建对话。");
      limitError.code = "chat_limit";
      throw limitError;
    }

    const baselineNode = lastNode();
    const baselineId = baselineNode ? (baselineNode.getAttribute("data-message-id") || "") : "";
    const baselineCount = assistantNodes().length;
    const baselineText = nodeText(baselineNode);

    setNativeValue(composer, text);
    await sleep(400);

    // 发送按钮在水合完成前是 disabled 的，点它等于没点；点空之后 12 秒等不到新节点，
    // 又会被 pageSaysLimit() 误判成"对话已满"，顾问侧就看到一串 CHAT_LIMIT。
    // 现在：点 → 确认草稿离开输入框或出现新消息 → 不行再试，最多 3 次。
    const sentAfter = async (ms) => {
      const before = assistantNodes().length;
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const box = findComposer();
        const stillDraft = box ? (box.textContent || "").trim() : "";
        if (assistantNodes().length > before || !stillDraft) return true;
        await sleep(300);
      }
      return false;
    };

    let sent = false;
    for (let attempt = 0; attempt < 3 && !sent; attempt++) {
      const sendButton = findSendButton();
      if (sendButton) {
        sendButton.click();
      } else {
        const box = findComposer() || composer;
        for (const type of ["keydown", "keyup"]) {
          box.dispatchEvent(new KeyboardEvent(type, {
            key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true
          }));
        }
      }
      sent = await sentAfter(attempt === 0 ? 2500 : 4000);
      if (!sent && pageSaysLimit()) break;
    }
    if (!sent) {
      const limitNow = pageSaysLimit();
      const rejected = new Error(limitNow
        ? "CHAT_LIMIT：发送被拒绝，当前对话已达上下文或消息上限。"
        : "SEND_FAILED：点了发送但草稿没有离开输入框（按钮可能还没就绪）。");
      rejected.code = limitNow ? "chat_limit" : "send_failed";
      throw rejected;
    }

    const startedAt = Date.now();
    let sawNew = false;
    let previous = "";
    let stableSince = 0;

    while (Date.now() - startedAt < budgetMs) {
      await sleep(700);
      const node = lastNode();
      const current = nodeText(node);
      const currentId = node ? (node.getAttribute("data-message-id") || "") : "";
      if (assistantNodes().length > baselineCount || (currentId && currentId !== baselineId) ||
          (current && current !== baselineText)) {
        sawNew = true;
      }
      // The send is silently refused when the conversation is full; fail fast
      // so the caller can open a new chat instead of burning the whole timeout.
      if (!sawNew && Date.now() - startedAt > 12000 && pageSaysLimit()) {
        const limitError = new Error("CHAT_LIMIT：发送被拒绝，当前对话已达上下文或消息上限。");
        limitError.code = "chat_limit";
        throw limitError;
      }
      if (isGenerating()) stableSince = 0;
      if (sawNew && current) {
        if (current !== previous) {
          previous = current;
          stableSince = Date.now();
        } else if (!isGenerating() && stableSince && Date.now() - stableSince >= QUIET_STABLE_MS) {
          return current.slice(0, MAX_REPLY_CHARS);
        }
      }
    }
    throw new Error("等待回复超时；可能仍在生成、请求失败，或回复节点选择器已变化。");
  }

  function pageState() {
    return "ready=" + (findComposer() ? 1 : 0) +
      "&generating=" + (isGenerating() ? 1 : 0) +
      "&limit=" + (pageSaysLimit() ? 1 : 0) +
      "&v=" + encodeURIComponent(SCRIPT_VERSION) +
      "&page=" + encodeURIComponent(location.origin + location.pathname);
  }

  async function processTask(task) {
    if (!task || !task.id || typeof task.text !== "string") throw new Error("Bridge 下发的任务格式无效。");
    if (task.text.length > MAX_TEXT_CHARS) throw new Error("任务文本超过上限。");

    // `new-chat` is a control task: no prompt, just leave a blank conversation
    // behind so the next `send` starts with a clean context window.
    if (task.action === "probe") {
      // Report how much text the open conversation actually holds, so the caller
      // can calibrate "the context window is full" against a real number.
      const main = document.querySelector("main") || document.body;
      const text = (main && (main.innerText || main.textContent)) || "";
      const reply = JSON.stringify({
        url: location.pathname,
        chars: text.length,
        users: document.querySelectorAll("[data-message-author-role='user']").length,
        assistants: assistantNodes().length,
        limit: pageSaysLimit(),
        version: SCRIPT_VERSION
      });
      await request("POST", "/v1/tasks/" + encodeURIComponent(task.id) + "/result", {
        client_id: CLIENT_ID, status: "success", reply, completed: true
      });
      return;
    }

    if (task.action === "new-chat") {
      setStatus("领取任务 " + task.id + "，正在新建对话…");
      try {
        const path = await startNewChat(false, task);
        await request("POST", "/v1/tasks/" + encodeURIComponent(task.id) + "/result", {
          client_id: CLIENT_ID, status: "success", reply: "新对话已就绪：" + path, completed: true
        });
        setStatus("任务 " + task.id + "：新对话已就绪。");
      } catch (err) {
        const message = String((err && err.message) || err);
        try {
          await request("POST", "/v1/tasks/" + encodeURIComponent(task.id) + "/result", {
            client_id: CLIENT_ID, status: "error", error: message, completed: true
          });
        } catch (_) { /* the Bridge will time the task out on its own */ }
        setStatus(message, true);
      }
      return;
    }

    const budget = Math.max(15000, Math.min(
      REPLY_TIMEOUT_MS,
      (task.timeout_seconds ? task.timeout_seconds * 1000 : REPLY_TIMEOUT_MS) - REPLY_GRACE_MS
    ));
    setStatus("领取任务 " + task.id + "，正在提交…");
    try {
      let reply;
      try {
        reply = await submitPrompt(task.text, budget);
      } catch (err) {
        if (!err || (err.code !== "chat_limit" && err.code !== "send_failed")) throw err;
        if (err.code === "chat_limit") {
          // Recovery: open a new conversation and resend once. The prompt is
          // self-contained, so nothing is lost by leaving the old chat behind.
          setStatus("对话已满，正在新开对话并重发…");
          await startNewChat(false, task);
        } else {
          setStatus("发送没生效，重试一次…");
          await sleep(1500);
        }
        reply = await submitPrompt(task.text, budget);
      }
      await request("POST", "/v1/tasks/" + encodeURIComponent(task.id) + "/result", {
        client_id: CLIENT_ID, status: "success", reply, completed: true
      });
      setStatus("任务 " + task.id + " 已回传（" + reply.length + " 字）。");
    } catch (err) {
      const message = String((err && err.message) || err);
      try {
        await request("POST", "/v1/tasks/" + encodeURIComponent(task.id) + "/result", {
          client_id: CLIENT_ID, status: "error", error: message, completed: true
        });
      } catch (_) { /* the Bridge will time the task out on its own */ }
      setStatus(message, true);
    }
  }

  async function pollOnce() {
    if (!enabled || busy || document.visibilityState === "prerender") return;
    busy = true;
    try {
      const data = await request("GET", "/v1/tasks/next?client_id=" + encodeURIComponent(CLIENT_ID) + "&" + pageState());
      if (data.task) {
        await processTask(data.task);
      } else {
        setStatus("Bridge 在线，等待任务。");
      }
    } catch (err) {
      setStatus(String((err && err.message) || err), true);
    } finally {
      busy = false;
    }
  }

  async function checkConnection() {
    try {
      const health = await request("GET", "/v1/health");
      setStatus("Bridge 在线（" + (health.status || "ok") + " / " + (health.protocol || "v1") + "）。");
      return true;
    } catch (err) {
      setStatus(String((err && err.message) || err), true);
      return false;
    }
  }

  // Collapsed by default: the page belongs to ChatGPT, not to this tool, so we
  // only show a small pill that mirrors status. Clicking it opens the details.
  function buildPanel() {
    if (panel || !document.body) return;
    panel = document.createElement("div");
    panel.id = "dsh-gpt-bridge-panel";
    panel.style.cssText = [
      "position:fixed", "right:10px", "bottom:10px", "z-index:2147483647",
      "display:flex", "flex-direction:column", "align-items:flex-end", "gap:6px",
      "font:12px/1.45 Arial,sans-serif"
    ].join(";");

    pill = document.createElement("button");
    pill.type = "button";
    pill.textContent = "DSH ↔ GPT";
    pill.style.cssText = [
      "padding:5px 10px", "border:1px solid #888", "border-radius:14px",
      "background:#fff", "color:#222", "box-shadow:0 2px 8px #0003",
      "font:12px/1.2 Arial,sans-serif", "cursor:pointer", "max-width:220px",
      "overflow:hidden", "text-overflow:ellipsis", "white-space:nowrap"
    ].join(";");
    pill.onclick = () => setExpanded(true);

    body = document.createElement("div");
    body.style.cssText = [
      "width:240px", "padding:10px", "border:1px solid #888", "border-radius:10px",
      "background:#fff", "color:#222", "box-shadow:0 2px 12px #0003",
      "display:none"
    ].join(";");

    const title = document.createElement("div");
    title.textContent = "DSH ↔ GPT Bridge v" + SCRIPT_VERSION;
    title.style.cssText = "font-weight:bold;margin-bottom:6px;cursor:pointer";
    title.title = "点击收起";
    title.onclick = () => setExpanded(false);
    statusNode = document.createElement("div");
    statusNode.textContent = "状态：初始化…";
    statusNode.style.cssText = "overflow-wrap:anywhere;margin-bottom:8px";
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:6px";
    const check = document.createElement("button");
    check.textContent = "检查连接";
    check.onclick = checkConnection;
    const toggle = document.createElement("button");
    toggle.textContent = enabled ? "暂停" : "启动";
    toggle.onclick = () => {
      enabled = !enabled;
      store.set(STATE_KEY, enabled);
      toggle.textContent = enabled ? "暂停" : "启动";
      setStatus(enabled ? "已启动轮询。" : "已暂停轮询。");
    };
    closeButton = document.createElement("button");
    closeButton.textContent = "收起";
    closeButton.onclick = () => setExpanded(false);
    [check, toggle, closeButton].forEach((button) => {
      button.style.cssText = "flex:1;padding:5px;border:1px solid #aaa;border-radius:6px;background:#f6f6f6;color:#222";
      row.appendChild(button);
    });
    body.append(title, statusNode, row);
    panel.append(body, pill);
    document.body.appendChild(panel);
    setExpanded(false);
  }

  function setExpanded(next) {
    expanded = Boolean(next);
    if (!panel) return;
    if (body) body.style.display = expanded ? "block" : "none";
    if (pill) pill.style.display = expanded ? "none" : "inline-block";
    if (expanded) refreshPill();
  }

  // The pill carries the same information in one line: state + short status.
  function refreshPill() {
    if (!pill) return;
    const text = (statusNode && statusNode.textContent) || "";
    const short = text.replace(/^状态：/, "").slice(0, 22);
    const bad = pill.dataset.bad === "1";
    pill.textContent = "DSH ↔ GPT · " + (enabled ? short : "已暂停");
    pill.style.borderColor = bad ? "#d33" : "#888";
    pill.style.color = bad ? "#b00" : "#222";
  }

  function start() {
    buildPanel();
    rememberProjectPath();
    recoverPending().catch(() => {});
    checkConnection();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
    if (typeof GM_registerMenuCommand === "function") {
      try {
        GM_registerMenuCommand("DSH Bridge：检查连接", checkConnection);
        GM_registerMenuCommand("DSH Bridge：立即轮询", pollOnce);
        GM_registerMenuCommand("DSH Bridge：新建对话", () => {
          startNewChat(false).catch((err) => setStatus(String((err && err.message) || err), true));
        });
        GM_registerMenuCommand("DSH Bridge：暂停/启动", () => {
          enabled = !enabled;
          store.set(STATE_KEY, enabled);
          setStatus(enabled ? "已启动。" : "已暂停。");
        });
      } catch (_) { /* menu integration is optional */ }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
