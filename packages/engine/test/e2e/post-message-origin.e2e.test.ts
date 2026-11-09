// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { CDPSession } from "@cloudflare/puppeteer";
import { expect, test } from "./harness";
import { setContent } from "./set-content";

const CHILD = "http://127.0.0.1:8787/__fixtures/oopif-child-postmessage.html";

function childContexts(cdp: CDPSession): number[] {
  const ids: number[] = [];
  cdp.on("Runtime.executionContextCreated", (e) => {
    if (e.context.origin === "http://127.0.0.1:8787") ids.push(e.context.id);
  });
  return ids;
}

async function childMessages(cdp: CDPSession, contextId: number) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: "JSON.stringify(window.__msgs)",
    contextId,
    returnByValue: true,
  });
  return JSON.parse(String(r.result.value)) as Array<{ data: unknown; origin: string }>;
}

test("a message to a child carries the sending document's origin", async ({ page, cdpSession }) => {
  const contexts = childContexts(cdpSession);
  await cdpSession.send("Runtime.enable");
  // Classic script code can reach the isolate's upstream sender and claim any source origin.
  await setContent(
    page,
    `<!doctype html><iframe id="c" src="${CHILD}"></iframe><script>
      const frame = document.getElementById("c");
      setTimeout(() => {
        __ks_state_local.upstreamSender({
          event: "kitesurf.postMessage",
          params: {
            toFrameOwnerId: frame._id,
            dataJson: JSON.stringify({ claimed: true }),
            targetOrigin: "*",
            sourceOrigin: "https://claimed.invalid",
          },
        });
      }, 500);
    </script>`,
  );
  await expect.poll(() => contexts.length, { timeout: 15_000 }).toBeGreaterThan(0);
  await expect
    .poll(async () => (await childMessages(cdpSession, contexts[0]!)).length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  const messages = await childMessages(cdpSession, contexts[0]!);
  expect(messages.map((m) => m.origin)).toEqual(["null"]);
}, 60_000);

test("a child's message for its own iframe does not reach its embedder", async ({
  page,
  cdpSession,
}) => {
  const contexts = childContexts(cdpSession);
  await cdpSession.send("Runtime.enable");
  await setContent(
    page,
    `<!doctype html><iframe src="${CHILD}"></iframe><script>
      window.__got = [];
      addEventListener("message", (e) => window.__got.push(e.data));
    </script>`,
  );
  await expect.poll(() => contexts.length, { timeout: 15_000 }).toBeGreaterThan(0);
  await cdpSession.send("Runtime.evaluate", {
    contextId: contexts[0],
    expression: `(() => {
      const nested = document.createElement("iframe");
      document.body.appendChild(nested);
      nested.contentWindow.postMessage({ nested: true }, "*");
      window.parent.postMessage({ toParent: true }, "*");
    })()`,
  });
  const received = async () =>
    JSON.parse(String(await page.evaluate(() => JSON.stringify(Reflect.get(window, "__got")))));
  await expect.poll(received, { timeout: 15_000 }).toContainEqual({ toParent: true });
  expect(await received()).not.toContainEqual({ nested: true });
}, 60_000);
