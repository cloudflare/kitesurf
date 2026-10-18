// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import addWasm from "../../assets/add.wasm";
import insertedBakeJs from "../../assets/inserted-bake.js";
import inlineWasmTemplate from "../../assets/inline-wasm.js";
import { dataModule, sleep } from "../util.ts";

export const scripts = new Hono();

const JS = "text/javascript; charset=utf-8";

scripts.all("/policy-script.js", (c) => {
  const tag = (c.req.query("tag") ?? "script").replace(/[^a-zA-Z0-9_-]/g, "");
  const extra = c.req.query("extra") === "1" ? "/* tampered */\n" : "";
  const headers: Record<string, string> = {
    "content-type": c.req.query("ct") ?? JS,
    "access-control-allow-origin": "*",
  };
  if (c.req.query("nosniff") === "1") headers["x-content-type-options"] = "nosniff";
  return c.body(
    `globalThis.__ksRan = (globalThis.__ksRan || []).concat([${JSON.stringify(tag)}]);\n${extra}`,
    200,
    headers,
  );
});

scripts.all("/policy-doc.html", (c) => {
  const headers: Record<string, string> = {};
  const csp = c.req.query("csp");
  if (csp) headers["content-security-policy"] = csp;
  const reportOnly = c.req.query("cspReportOnly");
  if (reportOnly) headers["content-security-policy-report-only"] = reportOnly;
  return c.html(
    `<!doctype html>
<html>
<head><meta charset="utf-8"><title>policy-doc</title></head>
<body>${c.req.query("body") ?? ""}</body>
</html>`,
    200,
    headers,
  );
});

scripts.all("/corp-script.js", (c) => {
  const policy = c.req.query("policy");
  const headers: Record<string, string> = { "content-type": JS };
  if (policy !== undefined) headers["cross-origin-resource-policy"] = policy;
  return c.body("globalThis.__ks_corp_ran = (globalThis.__ks_corp_ran || 0) + 1;", 200, headers);
});

scripts.all("/corp-script-page.html", (c) => {
  const policy = c.req.query("policy");
  const query = policy === undefined ? "" : `?policy=${encodeURIComponent(policy)}`;
  const crossorigin = c.req.query("crossorigin") === "1" ? " crossorigin" : "";
  return c.html(`<!doctype html>
<title>corp</title>
<script src="https://ks-other.invalid/__fixtures/corp-script.js${query}"${crossorigin}></script>
<body>corp</body>`);
});

const SLOW_PROBE_MS = 6000;
const insertedProbeHits = new Map<string, number>();
scripts.all("/inserted-probe/:mode{stable|volatile|gone|slow}/:file{[\\w-]+\\.js}", async (c) => {
  const mode = c.req.param("mode");
  const key = c.req.param("file").slice(0, -".js".length);
  const hit = (insertedProbeHits.get(key) ?? 0) + 1;
  insertedProbeHits.set(key, hit);
  if (hit > 1) {
    if (mode === "gone") return c.text("gone", 404);
    if (mode === "slow") await sleep(SLOW_PROBE_MS);
  }
  const headers: Record<string, string> = { "content-type": JS };
  if (mode === "stable" && hit > 1) headers["set-cookie"] = `probe_${key}=${hit}; Path=/`;
  const body = mode === "volatile" ? `${insertedBakeJs}\n// hit ${hit}\n` : insertedBakeJs;
  return c.body(body, 200, headers);
});
scripts.all("/inserted-probe-hits/:key{[\\w-]+}", (c) =>
  c.json({ hits: insertedProbeHits.get(c.req.param("key")) ?? 0 }, 200, {
    "cache-control": "no-store",
  }),
);

scripts.all("/:file{concimport-chunk-\\d+\\.js}", (c) => {
  const chunk = c.req.param("file").replace(/\D/g, "");
  return c.body(
    `export const value = ${chunk};\nexport function compute(a, b) { return a + b + ${chunk}; }\n`,
    200,
    { "content-type": JS },
  );
});

const inlineWasmJs = inlineWasmTemplate.replace(
  "__KS_ADD_WASM_B64__",
  btoa(String.fromCharCode(...new Uint8Array(dataModule(addWasm)))),
);
scripts.all("/inline-wasm.js", (c) => c.body(inlineWasmJs, 200, { "content-type": JS }));
