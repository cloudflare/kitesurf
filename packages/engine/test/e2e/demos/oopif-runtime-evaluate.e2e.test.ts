// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("oopif-runtime-evaluate", async ({ page, cdpSession }) => {
  const contexts: Array<{
    id: number;
    frameId?: string;
    isDefault: boolean;
    origin: string;
  }> = [];
  cdpSession.on("Runtime.executionContextCreated", (p) => {
    contexts.push({
      id: p.context.id,
      frameId: (p.context.auxData as { frameId?: string } | undefined)?.frameId,
      isDefault: (p.context.auxData as { isDefault?: boolean } | undefined)?.isDefault ?? false,
      origin: p.context.origin,
    });
  });
  await cdpSession.send("Runtime.enable");
  await page.goto("http://localhost:8787/__fixtures/oopif-host-quads.html", {
    waitUntil: "load",
    timeout: 60000,
  });

  await expect
    .poll(() => contexts.some((c) => !c.isDefault && c.origin === "http://127.0.0.1:8787"), {
      timeout: 15_000,
    })
    .toBe(true);

  const main = contexts.find((c) => c.isDefault && c.id === 1);
  const oopif = contexts.find((c) => !c.isDefault && c.origin === "http://127.0.0.1:8787");
  expect(main, `main context missing; got ${JSON.stringify(contexts)}`).toBeTruthy();
  expect(oopif, `OOPIF context missing; got ${JSON.stringify(contexts)}`).toBeTruthy();
  expect(oopif!.id).toBeGreaterThan(1);
  expect(oopif!.frameId).toBeTruthy();

  const initialViewport = await cdpSession.send("Runtime.evaluate", {
    expression: "globalThis.__fixtureInitialViewport",
    contextId: oopif!.id,
    returnByValue: true,
  });
  expect(initialViewport.result.value).toEqual([400, 300]);

  const inChild = (await cdpSession.send("Runtime.evaluate", {
    expression: "globalThis.__ks_oopif_marker = 'child-realm'; globalThis.__ks_oopif_marker",
    contextId: oopif!.id,
    returnByValue: true,
  })) as { result: { value: unknown } };
  expect(inChild.result.value).toBe("child-realm");

  const inMain = (await cdpSession.send("Runtime.evaluate", {
    expression:
      "typeof globalThis.__ks_oopif_marker === 'undefined' ? 'unset' : globalThis.__ks_oopif_marker",
    contextId: 1,
    returnByValue: true,
  })) as { result: { value: unknown } };
  expect(inMain.result.value, "main realm must not see the child's global").toBe("unset");

  await cdpSession.send("Runtime.evaluate", {
    expression: "globalThis.__ks_oopif_marker = 'main-realm'",
    contextId: 1,
    returnByValue: true,
  });
  const inChildAgain = (await cdpSession.send("Runtime.evaluate", {
    expression: "globalThis.__ks_oopif_marker",
    contextId: oopif!.id,
    returnByValue: true,
  })) as { result: { value: unknown } };
  expect(inChildAgain.result.value, "child realm still sees its own marker, not main's").toBe(
    "child-realm",
  );

  const bogus = (await cdpSession.send("Runtime.evaluate", {
    expression: "1",
    contextId: 9999,
    returnByValue: true,
  })) as {
    result: { description?: string };
    exceptionDetails?: { exception?: { description?: string } };
  };
  const err = bogus.exceptionDetails?.exception?.description ?? "";
  expect(
    /unknown or destroyed/.test(err),
    `bogus contextId should raise; got ${JSON.stringify(bogus)}`,
  ).toBe(true);
});
