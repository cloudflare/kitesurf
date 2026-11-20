// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

// Page script shares the realm that builds the isolate's replies, so it can put a function in one.
const MARKUP = `<!doctype html><title>start</title><style>p { color: red }</style><p id="p">x</p>
<script>
  Object.defineProperty(Object.prototype, "then", {
    configurable: true,
    get() {
      const rules = this && this.sheet && this.sheet.rules;
      if (Array.isArray(rules)) {
        for (const rule of rules) {
          rule.declarations = { map(callback) { document.title = "called:" + typeof callback; } };
        }
      }
      return undefined;
    },
  });
</script>`;

test("matched styles never call into a parsed stylesheet reply", async ({ page, cdpSession }) => {
  await setContent(page, MARKUP);
  await cdpSession.send("DOM.enable");
  await cdpSession.send("CSS.enable");
  const { root } = await cdpSession.send("DOM.getDocument");
  const { nodeId } = await cdpSession.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: "#p",
  });
  await cdpSession.send("CSS.getMatchedStylesForNode", { nodeId }).catch(() => {});
  expect(await page.evaluate(() => document.title)).toBe("start");
});

test("CSS.enable fetches opaque stylesheet text only for string urls", async ({
  page,
  cdpSession,
}) => {
  const key = "css-request-" + Math.random().toString(36).slice(2);
  const probe = `http://127.0.0.1:8787/__fixtures/inserted-probe/stable/${key}.js`;
  await setContent(
    page,
    `<!doctype html><title>start</title><script>
      Object.defineProperty(Object.prototype, "then", {
        configurable: true,
        get() {
          if (this && Array.isArray(this.sheets) && !this.sheets.added) {
            this.sheets.added = true;
            this.sheets.push({
              ownerNodeId: 99999,
              text: "",
              cors: "opaque",
              sourceURL: new Request(${JSON.stringify(probe)}, { method: "POST", body: "x" }),
            });
          }
          return undefined;
        },
      });
    </script>`,
  );
  await cdpSession.send("CSS.enable").catch(() => {});
  await page.goto("http://127.0.0.1:8787/__fixtures/lifecycle.html", { waitUntil: "load" });
  const hits = await page.evaluate(
    `fetch("/__fixtures/inserted-probe-hits/${key}").then((r) => r.json()).then((b) => b.hits)`,
  );
  expect(hits).toBe(0);
});
