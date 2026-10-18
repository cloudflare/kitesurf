// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("oopif-heap-usage", async ({ page, cdpSession }) => {
  await page.goto("http://localhost:8787/__fixtures/oopif-host-quads.html", {
    waitUntil: "load",
    timeout: 60000,
  });
  type TargetInfo = { targetId: string; type: string; url: string };
  let targetInfos: TargetInfo[] = [];
  let iframeTarget: TargetInfo | undefined;
  const targetDeadline = Date.now() + 15000;
  for (;;) {
    ({ targetInfos } = (await cdpSession.send("Target.getTargets")) as {
      targetInfos: TargetInfo[];
    });
    iframeTarget = targetInfos.find(
      (t) => t.type === "iframe" && t.url.startsWith("http://127.0.0.1:8787"),
    );
    if (iframeTarget || Date.now() >= targetDeadline) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(iframeTarget, `iframe target missing; got ${JSON.stringify(targetInfos)}`).toBeTruthy();

  const { sessionId } = await cdpSession.send("Target.attachToTarget", {
    targetId: iframeTarget!.targetId,
    flatten: true,
  });
  expect(sessionId).toBeTruthy();
  const childSession = cdpSession.connection()?.session(sessionId);
  if (!childSession) throw new Error(`no session ${sessionId} on the connection`);

  let childContextId = 0;
  const childRequests: string[] = [];
  childSession.on("Runtime.executionContextCreated", (params) => {
    childContextId = params.context.id;
  });
  childSession.on("Network.requestWillBeSent", (params) => {
    childRequests.push(params.request.url);
  });
  await childSession.send("Runtime.enable");
  await childSession.send("Network.enable");
  expect(childContextId).toBeGreaterThan(0);

  const tree = await childSession.send("Page.getFrameTree");
  expect(tree.frameTree.frame.id).toBe(iframeTarget!.targetId);
  expect(tree.frameTree.frame.url).toContain("127.0.0.1:8787");

  const childUsage = await childSession.send("Runtime.getHeapUsage");
  expect(childUsage.usedSize).toBeGreaterThan(1_000_000);
  expect(childUsage.totalSize).toBeGreaterThanOrEqual(childUsage.usedSize);

  const mainUsage = await cdpSession.send("Runtime.getHeapUsage");
  expect(mainUsage.usedSize).toBeGreaterThan(1_000_000);

  let childReady = false;
  for (let attempt = 0; attempt < 20 && !childReady; attempt++) {
    const ready = (await cdpSession.send("Runtime.evaluate", {
      contextId: childContextId,
      expression: "typeof document === 'object' ? document.title : ''",
      returnByValue: true,
    })) as { result: { value?: unknown } };
    childReady = ready.result.value === "oopif-child-quads";
    if (!childReady) await new Promise((r) => setTimeout(r, 50));
  }
  expect(childReady).toBe(true);

  const probe = (await cdpSession.send("Runtime.evaluate", {
    contextId: childContextId,
    expression: "fetch(location.href + '?network-session-probe=1').then(r => r.status)",
    awaitPromise: true,
    returnByValue: true,
  })) as { result: { value?: unknown } };
  expect(probe.result.value).toBe(200);
  await childSession.send("Runtime.getHeapUsage");
  const sawProbe = () => childRequests.some((url) => url.includes("network-session-probe=1"));
  const probeDeadline = Date.now() + 5000;
  while (!sawProbe() && Date.now() < probeDeadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(sawProbe()).toBe(true);
});
