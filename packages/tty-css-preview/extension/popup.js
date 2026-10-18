// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

const levelSelect = document.querySelector("#level");
const showGridToggle = document.querySelector("#show-grid");
const status = document.querySelector("#status");

async function refresh() {
  const { level = 1, showGrid = false } = await chrome.storage.local.get(["level", "showGrid"]);
  levelSelect.value = String(level);
  showGridToggle.checked = showGrid;

  const server = await chrome.runtime.sendMessage({ type: "serverStatus" });
  status.textContent = server.online
    ? "Server online. The content script polls for CSS changes 500 ms after each response."
    : "Server offline. Using bundled CSS without hot reload.";
  status.classList.toggle("online", server.online);
}

levelSelect.addEventListener("change", async () => {
  await chrome.storage.local.set({ level: Number(levelSelect.value) });
});

showGridToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ showGrid: showGridToggle.checked });
});

void refresh();
