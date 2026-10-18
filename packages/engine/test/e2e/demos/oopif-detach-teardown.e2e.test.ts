// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("oopif-detach-teardown", async ({ page, cdpSession }) => {
  const created: Array<{ id: number; origin: string; isDefault: boolean }> = [];
  const destroyed: number[] = [];
  const detachedFrames: string[] = [];
  cdpSession.on("Runtime.executionContextCreated", (p) => {
    created.push({
      id: p.context.id,
      origin: p.context.origin,
      isDefault: (p.context.auxData as { isDefault?: boolean } | undefined)?.isDefault ?? false,
    });
  });
  cdpSession.on("Runtime.executionContextDestroyed", (p) => {
    destroyed.push(p.executionContextId);
  });
  cdpSession.on("Page.frameDetached", (p) => {
    detachedFrames.push(p.frameId);
  });
  await cdpSession.send("Runtime.enable");
  await cdpSession.send("Page.enable");
  await page.goto("http://localhost:8787/__fixtures/oopif-host.html", {
    waitUntil: "load",
    timeout: 60000,
  });

  const findChildCtx = () =>
    created.find((c) => !c.isDefault && c.origin === "http://127.0.0.1:8787");
  await expect.poll(() => !!findChildCtx(), { timeout: 15_000 }).toBe(true);
  const childCtx = findChildCtx();
  expect(childCtx, "child execution context must spawn").toBeTruthy();

  const before = (await cdpSession.send("Runtime.evaluate", {
    expression: "1 + 1",
    contextId: childCtx!.id,
    returnByValue: true,
  })) as { result: { value: unknown } };
  expect(before.result.value).toBe(2);

  await cdpSession.send("Runtime.evaluate", {
    expression: "document.querySelector('iframe').remove(); 'removed'",
    returnByValue: true,
  });

  await expect.poll(() => destroyed.includes(childCtx!.id), { timeout: 15_000 }).toBe(true);
  expect(destroyed, `context ${childCtx!.id} must be destroyed on iframe removal`).toContain(
    childCtx!.id,
  );
  expect(detachedFrames.length, "Page.frameDetached must fire").toBeGreaterThan(0);

  const after = (await cdpSession.send("Runtime.evaluate", {
    expression: "1 + 1",
    contextId: childCtx!.id,
    returnByValue: true,
  })) as {
    result: { value?: unknown; description?: string };
    exceptionDetails?: { exception?: { description?: string } };
  };
  expect(
    after.exceptionDetails?.exception?.description ?? "",
    "stale contextId must surface an error, not evaluate",
  ).toMatch(/unknown or destroyed/i);
});
