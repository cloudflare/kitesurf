// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { test } from "../harness";
import { targetIdForSession } from "../connect";

test("script-execution-probe", async ({ page }) => {
  const FIXTURE_URL =
    process.env.KITESURF_FIXTURE ?? "http://127.0.0.1:8787/__fixtures/lifecycle.html";

  const consoleEntries = [];
  page.on("console", (msg) => {
    consoleEntries.push({ level: msg.type(), text: msg.text() });
  });

  console.log("[probe] navigating to", FIXTURE_URL);
  await page.goto(FIXTURE_URL).catch((err) => {
    console.log("[probe] page.goto threw:", err && err.message);
  });

  console.log("[probe] navigate returned. console entries:");
  for (const e of consoleEntries) {
    console.log("  [" + e.level + "]", e.text);
  }

  const session = await page.target().createCDPSession();
  const targetId = await targetIdForSession(session);
  const title = await session
    .send("Target.getTargets")
    .then((r) => r.targetInfos.find((t) => t.targetId === targetId)?.title)
    .catch(() => "?");
  console.log("[probe] target title:", JSON.stringify(title));

  await session.send("DOM.enable", {}).catch(() => {});
  const docNode = await session
    .send("DOM.getDocument", { depth: -1 })
    .catch((err): { error: string; root?: undefined } => ({ error: err && err.message }));
  if (docNode && docNode.root) {
    const summary = [];
    const walk = (n) => {
      if (!n) return;
      if (n.nodeType === 1) {
        const attrs = [];
        const a = n.attributes || [];
        for (let i = 0; i + 1 < a.length; i += 2) {
          attrs.push(a[i] + "=" + JSON.stringify(a[i + 1]));
        }
        summary.push(
          n.nodeName +
            (attrs.length ? "[" + attrs.join(",") + "]" : "") +
            " kids=" +
            (n.children ? n.children.length : 0),
        );
      }
      if (n.children) for (const k of n.children) walk(k);
    };
    walk(docNode.root);
    console.log("[probe] DOM summary:");
    for (const line of summary.slice(0, 20)) console.log("  ", line);
  } else {
    console.log("[probe] DOM.getDocument failed:", JSON.stringify(docNode));
  }
});
