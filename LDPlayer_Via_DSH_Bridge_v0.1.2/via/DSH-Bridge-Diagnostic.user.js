// ==UserScript==
// @name         DSH Bridge Diagnostic (Via 7.4.1)
// @namespace    https://local.dsh-bridge/
// @version      0.1.1
// @description  Diagnose Via GM request API, local Bridge connectivity and ChatGPT DOM selectors.
// @author       DSH Bridge Project
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function () {
  "use strict";
  const BRIDGE_BASE = "http://127.0.0.1:18765";
  const BRIDGE_TOKEN = "REPLACE_WITH_A_LONG_RANDOM_TOKEN";

  const visible = el => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const selectors = {
    composer: ["#prompt-textarea", "div[contenteditable='true'][role='textbox']", "textarea"],
    send: ["button[data-testid='send-button']", "button[aria-label*='Send']", "button[aria-label*='发送']", "form button[type='submit']"]
  };
  function hasVisible(list, enabledOnly) {
    return list.some(sel => [...document.querySelectorAll(sel)].some(el =>
      visible(el) && (!enabledOnly || !el.disabled)));
  }
  function requestHealth() {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== "function") {
        reject(new Error("GM_xmlhttpRequest is undefined"));
        return;
      }
      GM_xmlhttpRequest({
        method: "GET",
        url: BRIDGE_BASE + "/v1/health",
        headers: { "X-DSH-Token": BRIDGE_TOKEN, "Accept": "application/json" },
        timeout: 8000,
        onload: r => {
          if (r.status < 200 || r.status >= 300) reject(new Error("HTTP " + r.status));
          else resolve(r.responseText);
        },
        onerror: () => reject(new Error("Network error: Bridge unreachable")),
        ontimeout: () => reject(new Error("Request timed out"))
      });
    });
  }
  function addRow(box, label, value) {
    const p = document.createElement("div");
    p.style.cssText = "padding:3px 0;border-bottom:1px solid #eee;overflow-wrap:anywhere";
    const b = document.createElement("b");
    b.textContent = label + ": ";
    p.append(b, document.createTextNode(value));
    box.appendChild(p);
  }
  function build() {
    if (!document.body || document.getElementById("dsh-diagnostic")) return;
    const box = document.createElement("section");
    box.id = "dsh-diagnostic";
    box.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:2147483647;width:290px;max-height:65vh;overflow:auto;background:#fff;color:#222;border:2px solid #555;border-radius:9px;padding:10px;font:12px/1.4 Arial;box-shadow:0 2px 14px #0004";
    const title = document.createElement("b");
    title.textContent = "DSH Via Diagnostic v0.1.1";
    title.style.cssText = "display:block;margin-bottom:7px";
    box.appendChild(title);
    addRow(box, "GM_xmlhttpRequest", typeof GM_xmlhttpRequest);
    addRow(box, "Page", location.href);
    addRow(box, "Composer", hasVisible(selectors.composer, false) ? "found" : "not found");
    addRow(box, "Send button", hasVisible(selectors.send, true) ? "found" : "not found");
    addRow(box, "Assistant nodes", String(document.querySelectorAll("[data-message-author-role='assistant']").length));
    const status = document.createElement("div");
    status.style.cssText = "margin:7px 0;overflow-wrap:anywhere";
    status.textContent = "Bridge: checking…";
    box.appendChild(status);
    const btn = document.createElement("button");
    btn.textContent = "重新检查 Bridge";
    btn.onclick = async () => {
      status.textContent = "Bridge: checking…";
      try { status.textContent = "Bridge: ONLINE — " + (await requestHealth()).slice(0, 160); }
      catch (e) { status.textContent = "Bridge: FAILED — " + e.message; }
    };
    box.appendChild(btn);
    document.body.appendChild(box);
    btn.click();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build, { once: true });
  else build();
})();
