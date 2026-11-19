// ==UserScript==
// @name         DSH Bridge Diagnostic (Via)
// @namespace    https://local.dsh-bridge/
// @version      0.2.9
// @description  Diagnose Via GM requests, local Bridge health/status and the live ChatGPT DOM, then report the DOM back to the bridge so reply selectors can be fixed.
// @author       DSH Bridge Project
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function () {
  "use strict";

  const BRIDGE_BASE = "__BRIDGE_BASE__";
  const BRIDGE_TOKEN = "__BRIDGE_TOKEN__";
  const SCRIPT_VERSION = "0.2.9";

  const COMPOSER_SELECTORS = [
    "#prompt-textarea",
    "div[contenteditable='true'][role='textbox']",
    "div[contenteditable='true'][data-testid*='composer']",
    "textarea[data-testid='prompt-textarea']",
    "form div[contenteditable='true']",
    "div.ProseMirror[contenteditable='true']",
    "main div[contenteditable='true']",
    "form textarea"
  ];
  const MESSAGE_SELECTORS = [
    "[data-message-author-role='assistant']",
    "[data-message-author-role]",
    "article",
    "[data-testid^='conversation-turn']",
    "main [data-testid*='conversation-turn']"
  ];

  // This ChatGPT build no longer ships data-message-author-role; these are the
  // semantic Tailwind classes it does ship, kept as probe targets.
  const STRUCTURE_SELECTORS = [
    "[class*='bg-user-message']",
    "[class*='text-size-chat']",
    "[class*='markdown']",
    ".prose",
    "[class*='group']",
    "[class*='conversation']",
    "[role='article']",
    "[data-turn]",
    "[data-message-id]"
  ];

  function gm(method, path, body) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== "function") {
        reject(new Error("GM_xmlhttpRequest 不存在"));
        return;
      }
      const headers = { "X-DSH-Token": BRIDGE_TOKEN, Accept: "application/json" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      GM_xmlhttpRequest({
        method,
        url: BRIDGE_BASE + path,
        headers,
        data: body === undefined ? undefined : JSON.stringify(body),
        timeout: 8000,
        onload: (r) => {
          let parsed = {};
          try { parsed = r.responseText ? JSON.parse(r.responseText) : {}; } catch (_) { /* keep raw */ }
          if (r.status < 200 || r.status >= 300) reject(new Error("HTTP " + r.status + " " + (parsed.error || "")));
          else resolve(parsed);
        },
        onerror: () => reject(new Error("网络错误：Bridge 不可达（ADB reverse / Bridge 未启动）")),
        ontimeout: () => reject(new Error("请求超时"))
      });
    });
  }

  function findComposer() {
    for (const selector of COMPOSER_SELECTORS) {
      const el = document.querySelector(selector);
      if (el) return { el, selector };
    }
    return { el: null, selector: null };
  }

  function truncate(text, max) {
    const value = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
    return value.length > max ? value.slice(0, max) + "…" : value;
  }

  function describe(el, selector) {
    if (!el) return null;
    const attrs = {};
    for (const name of ["data-testid", "data-message-author-role", "aria-label", "role", "id", "class"]) {
      const value = el.getAttribute ? el.getAttribute(name) : null;
      if (value) attrs[name] = truncate(value, 120);
    }
    return {
      selector,
      tag: el.tagName ? el.tagName.toLowerCase() : "?",
      attrs,
      text_length: (el.innerText || el.textContent || "").length,
      text_head: truncate(el.innerText || el.textContent, 160),
      children: el.children ? el.children.length : 0,
      html_head: truncate(el.outerHTML, 700)
    };
  }

  function buildDomReport() {
    const counts = {};
    for (const selector of COMPOSER_SELECTORS.concat(MESSAGE_SELECTORS)) {
      try { counts[selector] = document.querySelectorAll(selector).length; } catch (_) { counts[selector] = -1; }
    }
    const composer = findComposer();
    const samples = [];
    for (const selector of MESSAGE_SELECTORS) {
      let nodes = [];
      try { nodes = [...document.querySelectorAll(selector)]; } catch (_) { nodes = []; }
      for (const el of nodes.slice(-3)) samples.push(describe(el, selector));
      if (samples.length >= 10) break;
    }
    const main = document.querySelector("main");
    // Structural dump: ChatGPT's class names are hashed, so the only stable
    // way to re-learn the reply container is to look at the tree itself.
    const mainChildren = main
      ? [...main.children].map((el) => ({
        tag: el.tagName.toLowerCase(),
        cls: truncate(el.getAttribute("class") || "", 120),
        testid: el.getAttribute("data-testid") || null,
        role: el.getAttribute("role") || null,
        text_length: (el.innerText || "").length
      }))
      : [];
    const textCandidates = [...document.querySelectorAll("main *")]
      .filter((el) => {
        const text = (el.innerText || "").trim();
        return text.length > 12 && el.children.length <= 2;
      })
      .slice(-12)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        cls: truncate(el.getAttribute("class") || "", 100),
        testid: el.getAttribute("data-testid") || null,
        role: el.getAttribute("role") || null,
        text_length: (el.innerText || "").length,
        text_head: truncate(el.innerText, 120)
      }));
    const structureCounts = {};
    for (const selector of STRUCTURE_SELECTORS) {
      try { structureCounts[selector] = document.querySelectorAll(selector).length; } catch (_) { structureCounts[selector] = -1; }
    }
    // Ancestor chain of the last markdown-looking node: the most direct way to
    // learn which wrapper represents one assistant turn.
    const chainSource = [...document.querySelectorAll("[class*='text-size-chat']")].pop();
    const ancestors = [];
    for (let el = chainSource, depth = 0; el && depth < 7; el = el.parentElement, depth += 1) {
      ancestors.push({
        depth,
        tag: el.tagName.toLowerCase(),
        cls: truncate(el.getAttribute("class") || "", 200),
        testid: el.getAttribute("data-testid") || null,
        role: el.getAttribute("role") || null,
        message_id: el.getAttribute("data-message-id") || null,
        turn: el.getAttribute("data-turn") || null,
        text_length: (el.innerText || "").length
      });
    }
    // Turn-list probe: walk up from the last user bubble, then look at its
    // siblings — that sibling set is the conversation turn list.
    const userBubble = [...document.querySelectorAll("[class*='bg-user-message']")].pop();
    const turnProbe = { bubble: null, chain: [], siblings: [] };
    if (userBubble) {
      turnProbe.bubble = describe(userBubble, "[class*='bg-user-message']");
      for (let el = userBubble, depth = 0; el && depth < 8; el = el.parentElement, depth += 1) {
        turnProbe.chain.push({
          depth,
          tag: el.tagName.toLowerCase(),
          cls: truncate(el.getAttribute("class") || "", 160),
          children: el.children.length,
          text_length: (el.innerText || "").length
        });
      }
      const turnList = userBubble.parentElement;
      if (turnList) {
        turnProbe.siblings = [...turnList.children].slice(-4).map((el) => ({
          tag: el.tagName.toLowerCase(),
          cls: truncate(el.getAttribute("class") || "", 200),
          text_length: (el.innerText || "").length,
          text_head: truncate(el.innerText, 200)
        }));
      }
    }
    // The sr-only wrapper that announces replies: its text starts with
    // "ChatGPT 说：", which makes it a reliable anchor for the assistant turn.
    const spokenNode = [...document.querySelectorAll("main div, main span")].find((el) => {
      const text = (el.innerText || "").trim();
      return text.length > 3 && text.length < 400 && /^(ChatGPT 说|你说|ChatGPT said|You said)[：:]/.test(text) && el.children.length === 0;
    });
    const spokenChain = [];
    for (let el = spokenNode, depth = 0; el && depth < 8; el = el.parentElement, depth += 1) {
      spokenChain.push({
        depth,
        tag: el.tagName.toLowerCase(),
        cls: truncate(el.getAttribute("class") || "", 200),
        children: el.children.length,
        text_length: (el.innerText || "").length
      });
    }
    return {
      version: SCRIPT_VERSION,
      href: location.href,
      href_length: location.href.length,
      ready_state: document.readyState,
      visibility: document.visibilityState,
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      user_agent: navigator.userAgent,
      counts,
      structure_counts: structureCounts,
      ancestors,
      turn_probe: turnProbe,
      spoken_chain: spokenChain,
      spoken_text: spokenNode ? truncate(spokenNode.innerText, 200) : null,
      last_markdown_html: chainSource ? truncate(chainSource.outerHTML, 1200) : null,
      composer: composer.el ? describe(composer.el, composer.selector) : null,
      message_samples: samples,
      main_text_head: main ? truncate(main.innerText, 800) : null,
      main_children: mainChildren,
      text_candidates: textCandidates,
      main_html_head: main ? truncate(main.innerHTML, 1500) : null,
      buttons: [...document.querySelectorAll("button")]
        .map((b) => truncate((b.getAttribute("data-testid") || "") + "|" + (b.getAttribute("aria-label") || "") + "|" + (b.type || ""), 80))
        .filter((v) => v !== "||")
        .slice(0, 40)
    };
  }

  // Collapsed by default: keep the page clean, expose only a pill that opens
  // the full self-check on demand. The DOM snapshots still upload in the
  // background (scheduleReports), so nothing is lost while collapsed.
  function build() {
    if (!document.body || document.getElementById("dsh-diagnostic")) return;
    const shell = document.createElement("div");
    shell.id = "dsh-diagnostic";
    shell.style.cssText = "position:fixed;right:8px;bottom:58px;z-index:2147483646;display:flex;flex-direction:column;align-items:flex-end;gap:6px;font:12px/1.4 Arial,sans-serif";

    const pill = document.createElement("button");
    pill.type = "button";
    pill.textContent = "DSH 诊断";
    pill.style.cssText = "padding:5px 10px;border:1px solid #555;border-radius:14px;background:#fff;color:#222;box-shadow:0 2px 8px #0003;font:12px/1.2 Arial,sans-serif;cursor:pointer";

    const box = document.createElement("section");
    box.style.cssText = "display:none;width:300px;max-height:70vh;overflow:auto;background:#fff;color:#222;border:2px solid #555;border-radius:9px;padding:10px;box-shadow:0 2px 14px #0004";
    const title = document.createElement("b");
    title.textContent = "DSH Via Diagnostic v" + SCRIPT_VERSION + "（点此收起）";
    title.style.cssText = "display:block;margin-bottom:7px;cursor:pointer";

    const status = document.createElement("div");
    status.style.cssText = "margin:7px 0;overflow-wrap:anywhere;white-space:pre-wrap";

    const btn = document.createElement("button");
    btn.textContent = "重新自检并上报 DOM";
    btn.style.cssText = "width:100%;padding:6px;border:1px solid #aaa;border-radius:6px;background:#f6f6f6";

    const collapse = () => { box.style.display = "none"; pill.style.display = "inline-block"; };
    title.onclick = collapse;
    pill.onclick = () => {
      pill.style.display = "none";
      box.style.display = "block";
      run(status, btn);
    };

    box.append(title, status, btn);
    shell.append(box, pill);
    document.body.appendChild(shell);
    btn.onclick = () => run(status, btn);
  }

  async function run(status, btn) {
    btn.disabled = true;
    const lines = [];
    const push = (k, v) => lines.push(k + ": " + v);
    const render = () => { status.textContent = lines.join("\n"); };

    const composer = findComposer();
    lines.push("GM_xmlhttpRequest: " + typeof GM_xmlhttpRequest);
    lines.push("Page: " + location.href.slice(0, 90));
    lines.push("Visibility: " + document.visibilityState);
    push("Composer", composer.el ? "found via " + composer.selector : "NOT FOUND");
    const editables = [...document.querySelectorAll("[contenteditable]")].map((el) => {
      const rect = el.getBoundingClientRect();
      return el.tagName.toLowerCase() + "[" + (el.getAttribute("role") || "-") + "," +
        Math.round(rect.width) + "x" + Math.round(rect.height) + "]";
    });
    push("contenteditable nodes", editables.length ? editables.join(" ") : "none");
    push("Send button", [...document.querySelectorAll("button")].some((b) => /send-button|aria-label="?Send|aria-label="?发送/.test((b.getAttribute("data-testid") || "") + (b.getAttribute("aria-label") || "")) || b.type === "submit") ? "found" : "NOT FOUND");
    for (const selector of MESSAGE_SELECTORS) {
      let n = "?";
      try { n = document.querySelectorAll(selector).length; } catch (_) { n = "err"; }
      push("count " + selector, n);
    }
    render();

    try {
      const health = await gm("GET", "/v1/health");
      push("Bridge health", "OK protocol=" + (health.protocol || "?") + " v" + (health.version || "?"));
      render();
    } catch (err) {
      push("Bridge health", "FAILED — " + err.message);
      render();
      btn.disabled = false;
      return;
    }

    try {
      const st = await gm("GET", "/v1/status");
      const counts = st.tasks || {};
      push("Queue", "queued=" + (counts.queued ?? "?") + " leased=" + (counts.leased ?? "?") + " ok=" + (counts.succeeded ?? "?"));
      const clients = st.clients || [];
      push("Clients", clients.length ? clients.map((c) => c.client_id + "@" + (c.last_seen_at || "-")).join(", ") : "none yet");
      render();
    } catch (err) {
      push("Bridge status", "FAILED — " + err.message);
      render();
    }

    try {
      const report = buildDomReport();
      const saved = await gm("POST", "/v1/diag/page", report);
      push("DOM report", "已上报 " + (saved.saved_to || "ok"));
      render();
    } catch (err) {
      push("DOM report", "FAILED — " + err.message);
      render();
    }

    btn.disabled = false;
  }

  async function report(trigger) {
    try {
      const payload = buildDomReport();
      payload.trigger = trigger;
      payload.captured_at = new Date().toISOString();
      await gm("POST", "/v1/diag/page", payload);
      return "ok";
    } catch (err) {
      return String((err && err.message) || err);
    }
  }

  // ChatGPT renders client-side: at document-idle the component tree is still
  // empty. Capture a series of snapshots instead of trusting the first one.
  function scheduleReports() {
    for (const delay of [2500, 6000, 12000, 20000, 30000]) {
      setTimeout(() => { report("auto+" + delay + "ms"); }, delay);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build, { once: true });
  else build();
  scheduleReports();
})();
