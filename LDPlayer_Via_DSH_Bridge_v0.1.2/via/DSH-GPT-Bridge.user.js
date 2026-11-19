// ==UserScript==
// @name         DSH GPT Bridge (Via)
// @namespace    https://local.dsh-bridge/
// @version      0.1.0
// @description  Connect ChatGPT page in Via Browser to a local DeepSeekHarness bridge.
// @author       DSH Bridge Project
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  "use strict";

  // ===== User configuration =====
  // Must match the token configured in the Windows Bridge. Replace before use.
  const BRIDGE_BASE = "http://127.0.0.1:18765";
  const BRIDGE_TOKEN = "REPLACE_WITH_A_LONG_RANDOM_TOKEN";
  const CLIENT_ID = "ldplayer-via-main";
  const POLL_INTERVAL_MS = 1800;
  const REQUEST_TIMEOUT_MS = 10000;
  const REPLY_TIMEOUT_MS = 180000;
  const QUIET_STABLE_MS = 2600;
  const MAX_REPLY_CHARS = 50000;

  const STATE_KEY = "dsh_bridge_enabled_v1";
  let enabled = GM_getValue ? GM_getValue(STATE_KEY, true) : true;
  let pollTimer = null;
  let busy = false;
  let lastError = "";
  let lastActivity = "尚未连接";
  let panel;
  let statusNode;

  function logStatus(message, isError) {
    lastActivity = message;
    if (isError) lastError = message;
    if (statusNode) {
      statusNode.textContent = (isError ? "错误：" : "状态：") + message;
      statusNode.style.color = isError ? "#b42318" : "#16794a";
    }
  }

  function gmRequest(method, path, body) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== "function") {
        reject(new Error("Via 未提供 GM_xmlhttpRequest；请检查脚本授权和 Via 版本。"));
        return;
      }
      const headers = {
        "Accept": "application/json",
        "X-DSH-Token": BRIDGE_TOKEN
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      GM_xmlhttpRequest({
        method,
        url: BRIDGE_BASE + path,
        headers,
        data: body === undefined ? undefined : JSON.stringify(body),
        timeout: REQUEST_TIMEOUT_MS,
        onload: (response) => {
          let parsed;
          try { parsed = response.responseText ? JSON.parse(response.responseText) : {}; }
          catch (_) { reject(new Error("Bridge 返回了非 JSON 响应，HTTP " + response.status)); return; }
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(parsed.error || ("Bridge HTTP " + response.status)));
            return;
          }
          resolve(parsed);
        },
        onerror: () => reject(new Error("无法连接 Bridge；检查 Bridge 是否启动、ADB reverse 和 token。")),
        ontimeout: () => reject(new Error("Bridge 请求超时。"))
      });
    });
  }

  function findComposer() {
    const selectors = [
      "#prompt-textarea",
      "div[contenteditable='true'][data-testid*='composer']",
      "div[contenteditable='true'][role='textbox']",
      "textarea"
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && isVisible(el)) return el;
    }
    // Fallback: visible contenteditable textbox inside the message form.
    const form = document.querySelector("form");
    if (form) {
      const el = form.querySelector("[contenteditable='true'], textarea");
      if (el && isVisible(el)) return el;
    }
    return null;
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function setNativeValue(el, value) {
    el.focus();
    if (el.isContentEditable) {
      el.replaceChildren();
      const line = document.createElement("p");
      line.textContent = value;
      el.appendChild(line);
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true, inputType: "insertText", data: value
      }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    const proto = el.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new InputEvent("input", {
      bubbles: true, inputType: "insertText", data: value
    }));
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
      const buttons = [...document.querySelectorAll(selector)];
      const button = buttons.find(b => isVisible(b) && !b.disabled);
      if (button) return button;
    }
    return null;
  }

  function isGenerating() {
    const buttons = [...document.querySelectorAll("button")];
    return buttons.some(b => {
      const label = ((b.getAttribute("aria-label") || "") + " " +
        (b.getAttribute("data-testid") || "") + " " + (b.innerText || "")).toLowerCase();
      return /stop generating|停止生成|stop streaming|停止响应/.test(label) && isVisible(b);
    });
  }

  function assistantNodes() {
    return [...document.querySelectorAll("[data-message-author-role='assistant']")];
  }

  function lastAssistantText() {
    const nodes = assistantNodes();
    if (!nodes.length) return "";
    const node = nodes[nodes.length - 1];
    // Prefer rendered text; avoid copying buttons/tool controls.
    const clone = node.cloneNode(true);
    clone.querySelectorAll("button, nav, [aria-hidden='true']").forEach(e => e.remove());
    return (clone.innerText || clone.textContent || "").trim();
  }

  async function submitPrompt(text) {
    const composer = findComposer();
    if (!composer) throw new Error("找不到 ChatGPT 输入框；请确认页面已登录且聊天界面已加载。");

    const beforeNodes = assistantNodes().length;
    const beforeText = lastAssistantText();
    setNativeValue(composer, text);
    await sleep(350);

    const sendButton = findSendButton();
    if (sendButton) {
      sendButton.click();
    } else {
      composer.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", code: "Enter", keyCode: 13, which: 13,
        bubbles: true, cancelable: true
      }));
      composer.dispatchEvent(new KeyboardEvent("keyup", {
        key: "Enter", code: "Enter", keyCode: 13, which: 13,
        bubbles: true, cancelable: true
      }));
    }

    const startedAt = Date.now();
    let sawNewOutput = false;
    let previousText = "";
    let stableSince = 0;

    while (Date.now() - startedAt < REPLY_TIMEOUT_MS) {
      await sleep(700);
      const nodes = assistantNodes();
      const currentText = lastAssistantText();
      if (nodes.length > beforeNodes || (currentText && currentText !== beforeText)) {
        sawNewOutput = true;
      }
      if (sawNewOutput && currentText) {
        if (currentText !== previousText) {
          previousText = currentText;
          stableSince = Date.now();
        } else if (!isGenerating() && stableSince &&
                   Date.now() - stableSince >= QUIET_STABLE_MS) {
          return currentText.slice(0, MAX_REPLY_CHARS);
        }
      }
    }
    throw new Error("等待 ChatGPT 回复超时；页面可能仍在生成、请求失败或回复区域选择器已变化。");
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function processTask(task) {
    if (!task || !task.id || typeof task.text !== "string") {
      throw new Error("Bridge 下发的任务格式无效。");
    }
    logStatus("收到任务 " + task.id + "，正在提交 ChatGPT…");
    try {
      const reply = await submitPrompt(task.text);
      await gmRequest("POST", "/v1/tasks/" + encodeURIComponent(task.id) + "/result", {
        client_id: CLIENT_ID,
        status: "success",
        reply,
        completed: true
      });
      logStatus("任务 " + task.id + " 已完成并回传。");
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      try {
        await gmRequest("POST", "/v1/tasks/" + encodeURIComponent(task.id) + "/result", {
          client_id: CLIENT_ID,
          status: "error",
          error: message,
          completed: true
        });
      } catch (_) {}
      logStatus(message, true);
    }
  }

  async function pollOnce() {
    if (!enabled || busy || document.visibilityState === "prerender") return;
    busy = true;
    try {
      const data = await gmRequest(
        "GET",
        "/v1/tasks/next?client_id=" + encodeURIComponent(CLIENT_ID)
      );
      if (data.task) {
        await processTask(data.task);
      } else {
        logStatus("Bridge 在线，等待任务。");
      }
    } catch (err) {
      logStatus(String(err.message || err), true);
    } finally {
      busy = false;
    }
  }

  async function checkConnection() {
    try {
      const health = await gmRequest("GET", "/v1/health");
      logStatus("Bridge 在线（" + (health.status || "ok") + "）。");
      return true;
    } catch (err) {
      logStatus(String(err.message || err), true);
      return false;
    }
  }

  function buildPanel() {
    if (panel || !document.body) return;
    panel = document.createElement("div");
    panel.id = "dsh-gpt-bridge-panel";
    panel.style.cssText = [
      "position:fixed", "right:10px", "bottom:10px", "z-index:2147483647",
      "width:230px", "padding:10px", "border:1px solid #888",
      "border-radius:10px", "background:#fff", "color:#222",
      "font:12px/1.45 Arial,sans-serif", "box-shadow:0 2px 12px #0003"
    ].join(";");
    const title = document.createElement("div");
    title.textContent = "DSH ↔ GPT Bridge";
    title.style.cssText = "font-weight:bold;margin-bottom:6px";
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
      if (GM_setValue) GM_setValue(STATE_KEY, enabled);
      toggle.textContent = enabled ? "暂停" : "启动";
      logStatus(enabled ? "已启动轮询。" : "已暂停轮询。");
    };
    [check, toggle].forEach(b => {
      b.style.cssText = "flex:1;padding:5px;border:1px solid #aaa;border-radius:6px;background:#f6f6f6;color:#222";
      row.appendChild(b);
    });
    panel.append(title, statusNode, row);
    document.body.appendChild(panel);
  }

  function start() {
    buildPanel();
    checkConnection();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
    if (GM_registerMenuCommand) {
      GM_registerMenuCommand("DSH Bridge：检查连接", checkConnection);
      GM_registerMenuCommand("DSH Bridge：立即轮询", pollOnce);
      GM_registerMenuCommand("DSH Bridge：暂停/启动", () => {
        enabled = !enabled;
        if (GM_setValue) GM_setValue(STATE_KEY, enabled);
        logStatus(enabled ? "已启动。" : "已暂停。");
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
