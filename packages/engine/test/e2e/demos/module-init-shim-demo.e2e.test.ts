// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { setTimeout as sleep } from "node:timers/promises";

import { expect, test } from "../harness";

type ProbeState = Record<string, unknown>;
interface Fixture {
  name: string;
  html: string;
  waitMs: number;
  probes: string[];
  assertions: [
    label: string,
    predicate: (s: ProbeState) => boolean,
    detail: (s: ProbeState) => unknown,
  ][];
}

test("module-init-shim-demo", async ({ page }) => {
  const fixtures: Fixture[] = [
    {
      name: "A: classic <script> + setTimeout at top",
      html: `<!doctype html><html><body>
<script>
  try {
    setTimeout(() => { window.__a_fired = true; }, 0);
    window.__a_threw = false;
  } catch (e) {
    window.__a_threw = true;
    window.__a_err = e.name + ": " + e.message;
  }
  function helperA() { return 42; }
</script>
<script>
  try {
    window.__a_helper_visible = (typeof helperA === "function");
    window.__a_helper_result = (typeof helperA === "function") ? helperA() : null;
  } catch (e) {
    window.__a_helper_err = e.name + ": " + e.message;
  }
</script>
</body></html>`,
      waitMs: 50,
      probes: ["__a_threw", "__a_err", "__a_helper_visible", "__a_helper_result", "__a_fired"],
      assertions: [
        ["A.setTimeout did not throw", (s) => s.__a_threw === false, (s) => s.__a_err],
        [
          "A.cross-script helper visible",
          (s) => s.__a_helper_visible === true,
          () => "helper not seen",
        ],
        [
          "A.helper returned 42",
          (s) => s.__a_helper_result === 42,
          (s) => `got ${s.__a_helper_result}`,
        ],
        ["A.deferred timer fired", (s) => s.__a_fired === true, () => "callback never ran"],
      ],
    },
    {
      name: "B: <script type=module> + setTimeout at top",
      html: `<!doctype html><html><body>
<script type="module">
  try {
    setTimeout(() => { window.__b_fired = true; }, 0);
    window.__b_threw = false;
  } catch (e) {
    window.__b_threw = true;
    window.__b_err = e.name + ": " + e.message;
  }
</script>
</body></html>`,
      waitMs: 50,
      probes: ["__b_threw", "__b_err", "__b_fired"],
      assertions: [
        [
          "B.setTimeout did not throw at module-init",
          (s) => s.__b_threw === false,
          (s) => s.__b_err,
        ],
        [
          "B.deferred timer fired after drain",
          (s) => s.__b_fired === true,
          () => "callback never ran — shim drain didn't replay",
        ],
      ],
    },
    {
      name: "C: <script type=module> + fetch at top (no await)",
      html: `<!doctype html><html><body>
<script type="module">
  try {
    const p = fetch("/", { method: "GET" });
    window.__c_threw_sync = false;
    window.__c_promise_pending = (p && typeof p.then === "function");
    p.then(
      (r) => { window.__c_settled = "resolved:" + r.status; },
      (e) => { window.__c_settled = "rejected:" + e.name; },
    );
  } catch (e) {
    window.__c_threw_sync = true;
    window.__c_err = e.name + ": " + e.message;
  }
</script>
</body></html>`,
      waitMs: 200,
      probes: ["__c_threw_sync", "__c_err", "__c_promise_pending", "__c_settled"],
      assertions: [
        [
          "C.fetch did not throw synchronously",
          (s) => s.__c_threw_sync === false,
          (s) => s.__c_err,
        ],
        [
          "C.fetch returned a Promise",
          (s) => s.__c_promise_pending === true,
          () => "fetch did not return a thenable",
        ],
        [
          "C.fetch promise settled (resolve or reject) after drain",
          (s) => typeof s.__c_settled === "string",
          () => "promise neither resolved nor rejected — shim didn't replay",
        ],
      ],
    },
    {
      name: "D: <script type=module> + setTimeout + clearTimeout (cancel before drain)",
      html: `<!doctype html><html><body>
<script type="module">
  try {
    const id = setTimeout(() => { window.__d_fired = true; }, 0);
    window.__d_id_type = typeof id;
    clearTimeout(id);
    window.__d_threw = false;
  } catch (e) {
    window.__d_threw = true;
    window.__d_err = e.name + ": " + e.message;
  }
</script>
</body></html>`,
      waitMs: 100,
      probes: ["__d_threw", "__d_err", "__d_id_type", "__d_fired"],
      assertions: [
        ["D.setTimeout did not throw", (s) => s.__d_threw === false, (s) => s.__d_err],
        [
          "D.setTimeout returned a numeric id",
          (s) => s.__d_id_type === "number",
          (s) => `got ${s.__d_id_type}`,
        ],
        [
          "D.canceled callback did NOT fire",
          (s) => s.__d_fired === undefined || s.__d_fired === "<not set>",
          () => "shim drain ignored clearTimeout — callback fired anyway",
        ],
      ],
    },
  ];

  page.on("pageerror", (e) => console.error("[mi-shim] pageerror:", e.message));

  for (const f of fixtures) {
    const dataUrl = "data:text/html;base64," + Buffer.from(f.html).toString("base64");
    console.log(`\n[mi-shim] === ${f.name} ===`);
    await page
      .goto(dataUrl, { timeout: 5000 })
      .catch((e) => console.error(`[mi-shim]   goto threw: ${e.message}`));
    if (f.waitMs) await sleep(f.waitMs);

    const state = await page.evaluate((keys) => {
      const out: ProbeState = {};
      for (const k of keys) out[k] = k in window ? window[k] : "<not set>";
      return out;
    }, f.probes);

    for (const [label, predicate, detail] of f.assertions) {
      expect(predicate(state), `${label}: ${detail(state)}`).toBeTruthy();
    }
  }
});
