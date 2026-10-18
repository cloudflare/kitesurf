// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("oopif-late-spawn", async ({ page, cdpSession }) => {
  const contexts: Array<{ id: number; origin: string; isDefault: boolean }> = [];
  cdpSession.on("Runtime.executionContextCreated", (p) => {
    contexts.push({
      id: p.context.id,
      origin: p.context.origin,
      isDefault: (p.context.auxData as { isDefault?: boolean } | undefined)?.isDefault ?? false,
    });
  });
  await cdpSession.send("Runtime.enable");
  await page.goto("http://localhost:8787/__fixtures/oopif-dynamic-host.html", {
    waitUntil: "load",
    timeout: 60000,
  });

  let childTarget: { targetId: string; url: string } | undefined;
  for (let i = 0; i < 40 && !childTarget; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const { targetInfos } = (await cdpSession.send("Target.getTargets")) as {
      targetInfos: Array<{ targetId: string; type: string; url: string }>;
    };
    childTarget = targetInfos.find(
      (t) => t.type === "iframe" && t.url.startsWith("http://127.0.0.1:8787"),
    );
  }
  expect(childTarget, "late frame must surface as an iframe target with its real URL").toBeTruthy();

  let childCtx: { id: number; origin: string } | undefined;
  for (let i = 0; i < 40 && !childCtx; i++) {
    await new Promise((r) => setTimeout(r, 250));
    childCtx = contexts.find((c) => !c.isDefault && c.origin === "http://127.0.0.1:8787");
  }
  expect(childCtx, `child execution context missing: ${JSON.stringify(contexts)}`).toBeTruthy();

  const r = (await cdpSession.send("Runtime.evaluate", {
    expression: "document.title",
    contextId: childCtx!.id,
    returnByValue: true,
  })) as { result: { value: unknown } };
  expect(r.result.value).toBe("oopif-child-quads");
});
