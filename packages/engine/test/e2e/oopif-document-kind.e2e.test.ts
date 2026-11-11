// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const CHILD_ORIGIN = "http://127.0.0.1:8787";

// The child marks its own document only when the engine parses the response as HTML and runs it.
test("a cross-origin child document is classified like a top-level document", async ({
  page,
  cdpSession,
}) => {
  const contexts: Array<{ id: number; origin: string }> = [];
  cdpSession.on("Runtime.executionContextCreated", (p) => {
    contexts.push({ id: p.context.id, origin: p.context.origin });
  });
  await cdpSession.send("Runtime.enable");

  const run = String(Date.now());
  const childRan = async (kind: string): Promise<boolean | null> => {
    contexts.length = 0;
    await page.goto(
      `http://localhost:8787/__fixtures/oopif-kind-host.html?kind=${kind}&run=${run}`,
      {
        waitUntil: "load",
        timeout: 60000,
      },
    );
    let ctx: { id: number; origin: string } | undefined;
    for (let i = 0; i < 20 && !ctx; i++) {
      await new Promise((r) => setTimeout(r, 250));
      ctx = contexts.find((c) => c.origin === CHILD_ORIGIN);
    }
    if (!ctx) return null;
    const r = (await cdpSession.send("Runtime.evaluate", {
      expression: 'document.documentElement.getAttribute("data-executed")',
      contextId: ctx.id,
      returnByValue: true,
    })) as { result: { value: unknown } };
    return r.result.value === "1";
  };

  const observed: Array<[string, boolean | null]> = [];
  for (const kind of ["html", "text", "json", "attachment", "204", "205"]) {
    observed.push([kind, await childRan(kind)]);
  }
  // A refused response leaves no child document at all, so there is nothing to run.
  expect(observed).toEqual([
    ["html", true],
    ["text", false],
    ["json", false],
    ["attachment", null],
    ["204", null],
    ["205", null],
  ]);
  // A refused document is requested once, not again when the frame's isolate is spawned.
  const hits = await page.evaluate(
    `fetch("/__fixtures/oopif-kind-hits?kind=attachment&run=${run}").then((r) => r.json())`,
  );
  expect(hits).toEqual({ hits: 1 });
});
