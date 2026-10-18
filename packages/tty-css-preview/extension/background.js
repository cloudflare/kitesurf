// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { loadCssWithFallback, updateCss } from "./update.js";

const CSS_URL = "http://127.0.0.1:8765/tty.css";

async function loadLiveCss(level) {
  const response = await fetch(`${CSS_URL}?level=${level}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`CSS server returned ${response.status}`);
  return response.text();
}

async function loadBundledCss(level) {
  const files = ["fallback-level1.css"];
  if (level === 2) files.push("fallback-level2.css");
  const responses = await Promise.all(files.map((file) => fetch(chrome.runtime.getURL(file))));
  for (const response of responses) {
    if (!response.ok) throw new Error(`Bundled CSS returned ${response.status}`);
  }
  const parts = await Promise.all(responses.map((response) => response.text()));
  return parts.map((css) => css.trimEnd()).join("\n\n") + "\n";
}

async function updateTab(tabId, documentId, frameId, message) {
  const { level = 1, showGrid = false } = await chrome.storage.local.get(["level", "showGrid"]);
  const target = { tabId, documentIds: [documentId] };

  const result = await updateCss({
    level,
    appliedCss: typeof message.appliedCss === "string" ? message.appliedCss : null,
    appliedLevel: Number(message.appliedLevel) || 0,
    loadCss: (requestedLevel) => loadCssWithFallback(requestedLevel, loadLiveCss, loadBundledCss),
    removeCss: (css) => chrome.scripting.removeCSS({ target, css, origin: "USER" }),
    insertCss: (css) => chrome.scripting.insertCSS({ target, css, origin: "USER" }),
  });
  return {
    ...result,
    showGrid: level > 0 && showGrid && frameId === 0,
  };
}

async function serverStatus() {
  try {
    const response = await fetch("http://127.0.0.1:8765/health", { cache: "no-store" });
    return { online: response.ok };
  } catch (error) {
    return { online: false, message: String(error) };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "poll" && sender.tab?.id !== undefined && sender.documentId !== undefined) {
    updateTab(sender.tab.id, sender.documentId, sender.frameId, message)
      .then(sendResponse)
      .catch((error) => {
        console.error("[tty-css-preview] Failed to update the tab", error);
        sendResponse({ status: "error", message: String(error) });
      });
    return true;
  }

  if (message?.type === "serverStatus") {
    serverStatus()
      .then(sendResponse)
      .catch((error) => {
        console.error("[tty-css-preview] Failed to read the server status", error);
        sendResponse({ online: false, message: String(error) });
      });
    return true;
  }

  return false;
});
