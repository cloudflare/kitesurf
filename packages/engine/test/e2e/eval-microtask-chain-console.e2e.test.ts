// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// An evaluate reply carries the console output of page promise chains it started, however long
// the chain. The settle drain runs a fixed number of microtask turns, so a longer chain only
// finishes in the macrotask the reply waits for.

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const PAGE = `<!doctype html>
<script>
  window.deepChain = async (steps, label) => {
    for (let i = 0; i < steps; i++) await null;
    console.log(label);
  };
</script>`;

test("Runtime.evaluate reply follows the console output of an 80-step page chain", async ({
  page,
}) => {
  await setContent(page, PAGE);
  const session = await page.target().createCDPSession();
  await session.send("Runtime.enable");

  const seen: string[] = [];
  session.on("Runtime.consoleAPICalled", (event: { args: Array<{ value?: unknown }> }) => {
    seen.push(String(event.args[0]?.value));
  });

  for (const steps of [80, 200]) {
    const label = `chain-${steps}`;
    const response = await session.send("Runtime.evaluate", {
      expression: `void deepChain(${steps}, ${JSON.stringify(label)})`,
      returnByValue: true,
    });
    expect(response.exceptionDetails).toBeUndefined();
    // Events are dispatched in wire order, so the entry is already here when the reply resolves.
    expect(seen, `${label} logged after the reply`).toContain(label);
  }
});
