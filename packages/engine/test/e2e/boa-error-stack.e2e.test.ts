// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Error reporters often log only `stack`, so on boa it must lead with "Name: message".
import { expect, test } from "./harness";
import { setContent } from "./set-content";

const BOA = `
var first = function (e) { return String(e.stack).split("\\n")[0]; };
var named = new Error("renamed");
named.name = "ConfigError";
var out = [first(new TypeError("bad thing")), first(named), first(new Error())];
try { null.x; } catch (e) { out.push(String(e.stack).indexOf(e.message) >= 0); }
window.__stacks = out;
`;

test("an error's stack on boa leads with its name and message", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><title>t</title><script>
    var s = document.createElement("script");
    s.textContent = ${JSON.stringify(BOA)};
    document.head.appendChild(s);
    </script>`,
  );
  await page.waitForFunction(() => !!(globalThis as { __stacks?: unknown }).__stacks, {
    timeout: 20_000,
  });
  expect(await page.evaluate(() => (globalThis as { __stacks?: unknown }).__stacks)).toEqual([
    "TypeError: bad thing",
    "ConfigError: renamed",
    "Error",
    true,
  ]);
}, 60_000);
