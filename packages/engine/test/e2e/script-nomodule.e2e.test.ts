// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Kitesurf runs modules, so a classic script marked nomodule (a legacy fallback build) must
// neither run nor fire events, from the parser or from an insert. A module ignores nomodule.
import { expect, test } from "./harness";

const ORIGIN = "https://ks.invalid";
const scriptUrl = (tag: string): string => `${ORIGIN}/__fixtures/policy-script.js?tag=${tag}`;

const docUrl = (body: string): string => {
  const u = new URL(`${ORIGIN}/__fixtures/policy-doc.html`);
  u.searchParams.set("body", body);
  return u.toString();
};

test("nomodule classic scripts are skipped; modules ignore the attribute", async ({ page }) => {
  const body = `<script>window.__ev = [];
    window.__mark = function (tag) { window.__ksRan = (window.__ksRan || []).concat([tag]); };</script>
    <script nomodule>__mark("parser-inline-nomodule");</script>
    <script nomodule src="${scriptUrl("parser-external-nomodule")}" onload="__ev.push('load:parser')" onerror="__ev.push('error:parser')"></script>
    <script type="module" nomodule>__mark("parser-module-nomodule");</script>
    <script>
      var legacy = document.createElement("script");
      legacy.src = ${JSON.stringify(scriptUrl("inserted-nomodule"))};
      legacy.setAttribute("nomodule", "");
      legacy.onload = function () { __ev.push("load:inserted-nomodule"); };
      legacy.onerror = function () { __ev.push("error:inserted-nomodule"); };
      document.head.appendChild(legacy);
      var modern = document.createElement("script");
      modern.type = "module";
      modern.src = ${JSON.stringify(scriptUrl("inserted-module"))};
      modern.onload = function () { __ev.push("load:inserted-module"); };
      document.head.appendChild(modern);
    </script>`;
  await page.goto(docUrl(body), { waitUntil: "load" });
  await page.waitForFunction(
    () => ((globalThis as { __ev?: string[] }).__ev ?? []).includes("load:inserted-module"),
    { timeout: 20_000 },
  );
  await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));
  expect(
    await page.evaluate(() => ({
      ran: ((globalThis as { __ksRan?: string[] }).__ksRan ?? []).slice().sort(),
      events: (globalThis as { __ev?: string[] }).__ev,
    })),
  ).toEqual({
    ran: ["inserted-module", "parser-module-nomodule"],
    events: ["load:inserted-module"],
  });
}, 60_000);

test("an empty nomodule script can still run later", async ({ page }) => {
  await page.goto(
    docUrl(`<script>
    var s = document.createElement("script");
    s.setAttribute("nomodule", "");
    document.head.appendChild(s);
    s.remove();
    s.removeAttribute("nomodule");
    s.src = ${JSON.stringify(scriptUrl("empty-reuse"))};
    document.head.appendChild(s);
  </script>`),
    { waitUntil: "load" },
  );
  await page.waitForFunction(
    () => ((globalThis as { __ksRan?: string[] }).__ksRan ?? []).includes("empty-reuse"),
    { timeout: 20_000 },
  );
}, 60_000);
