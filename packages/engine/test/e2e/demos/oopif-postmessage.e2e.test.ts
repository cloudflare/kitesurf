// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("oopif-postmessage", async ({ page, cdpSession }) => {
  const contexts: Array<{ id: number; origin: string; isDefault: boolean }> = [];
  cdpSession.on("Runtime.executionContextCreated", (p) => {
    contexts.push({
      id: p.context.id,
      origin: p.context.origin,
      isDefault: (p.context.auxData as { isDefault?: boolean } | undefined)?.isDefault ?? false,
    });
  });
  await cdpSession.send("Runtime.enable");
  await page.goto("http://localhost:8787/__fixtures/oopif-host-postmessage.html", {
    waitUntil: "load",
    timeout: 60000,
  });
  await new Promise((r) => setTimeout(r, 500));

  const childCtx = contexts.find((c) => !c.isDefault && c.origin === "http://127.0.0.1:8787");
  expect(childCtx, `child context missing: ${JSON.stringify(contexts)}`).toBeTruthy();

  const evalIn = async (contextId: number | undefined, expression: string) => {
    const r = (await cdpSession.send("Runtime.evaluate", {
      expression,
      contextId,
      returnByValue: true,
    })) as { result: { value: unknown }; exceptionDetails?: unknown };
    expect(r.exceptionDetails, expression).toBeUndefined();
    return r.result.value;
  };

  const fromChild = (await evalIn(1, "window.__fromChild")) as Array<{
    data: { hello?: string; n?: number };
    origin: string;
    hasSource: boolean;
  }>;
  const hello = fromChild.find((m) => m.data?.hello === "from-child");
  expect(hello, `parent saw: ${JSON.stringify(fromChild)}`).toBeTruthy();
  expect(hello!.origin).toBe("http://127.0.0.1:8787");
  expect(hello!.hasSource).toBe(true);

  expect(
    fromChild.some((m) => m.data?.hello === "wrong-origin"),
    "targetOrigin gate must drop the https://evil.example message",
  ).toBe(false);

  const msgs = (await evalIn(childCtx!.id, "window.__msgs")) as Array<{
    data: { reply?: string; echo?: number };
    origin: string;
    sourceIsParent: boolean;
  }>;
  const pong = msgs.find((m) => m.data?.reply === "pong");
  expect(pong, `child saw: ${JSON.stringify(msgs)}`).toBeTruthy();
  expect(pong!.data.echo).toBe(2);
  expect(pong!.origin).toBe("http://localhost:8787");
  expect(pong!.sourceIsParent).toBe(true);

  expect(await evalIn(childCtx!.id, "window.__parentIsSelf")).toBe(false);

  const selfMsg = (await evalIn(1, "window.__selfMsg")) as {
    data: { self: boolean };
    origin: string;
  } | null;
  expect(selfMsg, "self-post never delivered").toBeTruthy();
  expect(selfMsg!.origin).toBe("http://localhost:8787");
});
