// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Protocol } from "devtools-protocol";
import { expect, test } from "../harness";

test("hit-test-demo", async ({ page }) => {
  const FIXTURE_URL =
    process.env.KITESURF_FIXTURE ?? "http://127.0.0.1:8787/__fixtures/events.html";

  await page.goto(FIXTURE_URL, { timeout: 15000 });

  await page.evaluate(() => {
    globalThis.__ks_path = [];
  });

  const session = await page.target().createCDPSession();
  const { root } = await session.send("DOM.getDocument", {});
  const { nodeId } = await session.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: "#btn",
  });
  console.log("[ht] #btn nodeId =", nodeId);
  expect(nodeId, "#btn not found").toBeTruthy();

  const { model } = await session.send("DOM.getBoxModel", { nodeId });
  console.log("[ht] #btn box.content =", JSON.stringify(model.content));
  const cx = (model.content[0] + model.content[2]) / 2;
  const cy = (model.content[1] + model.content[5]) / 2;
  console.log("[ht] dispatching click at (", cx, ",", cy, ")");

  await session.send("Input.dispatchMouseEvent", {
    // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- input.ts maps click.
    type: "click" as unknown as Protocol.Input.DispatchMouseEventRequest["type"],
    x: cx,
    y: cy,
    button: "left",
    clickCount: 1,
  });

  await new Promise((r) => setTimeout(r, 50));

  const after = await page.evaluate(() => ({
    path: globalThis.__ks_path,
    counter: document.querySelector("#counter").textContent,
  }));
  const path = after.path;
  console.log("[ht] page.click('#btn') path =", JSON.stringify(path));

  const expected = [
    "window:capture",
    "btn:target",
    "btn:once",
    "btn:preventDefault",
    "body:bubble",
    "window:bubble",
    "target=btn",
  ];
  expect(path, "click propagation path").toStrictEqual(expected);

  const counter = after.counter;
  console.log("[ht] counter =", counter);
  expect(counter, "counter after click").toBe("1");
});
