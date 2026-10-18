// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A wasm trap poisons the page's module. The engine must end that generation like a crashed
// renderer: settle in-flight calls, emit Inspector.targetCrashed, and let a navigate recover.
import type { CDPSession, Page } from "@cloudflare/puppeteer";
import { expect, test } from "./harness";
import { setContent } from "./set-content";

// Overflows boa's recursive-descent parser on the 1 MiB wasm stack, where ~230 levels fit. If
// the parser ever stops recursing per level, this needs another way to trap the module.
function overflowingChain(depth = 3000): string {
  let chain = "1";
  for (let i = 0; i < depth; i++) chain = `o.p${i}=(${chain})`;
  return `var o = {}; ${chain};`;
}

function watchCrash(page: Page, cdp: CDPSession) {
  const crashed = new Promise<void>((resolve) =>
    cdp.on("Inspector.targetCrashed", () => resolve()),
  );
  page.on("error", () => {}); // puppeteer turns Inspector.targetCrashed into "Page crashed!"
  const notice = new Promise<string>((resolve) => {
    cdp.on("Runtime.consoleAPICalled", (ev) => {
      const text = String(ev.args?.[0]?.value ?? "");
      if (ev.type === "error" && text.includes("engine crashed")) resolve(text);
    });
  });
  return { crashed, notice };
}

async function evaluateText(cdp: CDPSession, expression: string): Promise<string> {
  const reply = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
  if (reply.exceptionDetails)
    return `threw: ${reply.exceptionDetails.exception?.description ?? ""}`;
  return String(reply.result.value);
}

test("a trap inside Runtime.evaluate settles it and crashes the target", async ({ page }) => {
  await setContent(page, "<!doctype html><title>t</title>");
  const cdp = await page.createCDPSession();
  await cdp.send("Runtime.enable");
  const { crashed, notice } = watchCrash(page, cdp);

  // The trap lands in the async wasm task behind this evaluate, which then never settled and
  // left the CDP call hanging.
  expect(await evaluateText(cdp, overflowingChain())).toMatch(
    /page engine crashed \(memory access out of bounds\)/,
  );
  await crashed;
  expect(await notice).toContain("the page's engine crashed (memory access out of bounds)");
  expect(await evaluateText(cdp, "1 + [1].length")).toMatch(
    /session is dead \(page engine crashed/,
  );

  await setContent(page, "<!doctype html><title>again</title>");
  expect(await evaluateText(cdp, "document.title + [1, 2].map((n) => n * 2)")).toBe("again2,4");
}, 60_000);

test("a trap in page script during load crashes the target", async ({ page }) => {
  const cdp = await page.createCDPSession();
  await cdp.send("Runtime.enable");
  const { crashed } = watchCrash(page, cdp);

  // A page's own eval runs on boa, so this traps mid-navigation like the reCAPTCHA
  // script did.
  const source = JSON.stringify(overflowingChain());
  await setContent(
    page,
    `<title>t</title><script>try { eval(${source}); } catch {}</script>`,
  ).catch(() => {});
  await crashed;
  expect(await evaluateText(cdp, "1 + [1].length")).toMatch(
    /session is dead \(page engine crashed/,
  );
}, 60_000);
