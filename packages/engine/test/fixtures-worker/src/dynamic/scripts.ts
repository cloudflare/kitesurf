// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import addWasm from "../../assets/add.wasm";
import insertedBakeJs from "../../assets/inserted-bake.js";
import inlineWasmTemplate from "../../assets/inline-wasm.js";
import { dataModule, intQuery, sleep } from "../util.ts";

export const scripts = new Hono();

const JS = "text/javascript; charset=utf-8";

scripts.all("/policy-script.js", (c) => {
  const tag = (c.req.query("tag") ?? "script").replace(/[^a-zA-Z0-9_-]/g, "");
  const extra = c.req.query("extra") === "1" ? "/* tampered */\n" : "";
  // A large bundle: `pad` bytes of comment after the statement.
  const pad = Math.min(Number(c.req.query("pad") ?? 0) || 0, 32 * 1024 * 1024);
  const headers: Record<string, string> = {
    "content-type": c.req.query("ct") ?? JS,
    "access-control-allow-origin": "*",
  };
  if (c.req.query("nosniff") === "1") headers["x-content-type-options"] = "nosniff";
  return c.body(
    `globalThis.__ksRan = (globalThis.__ksRan || []).concat([${JSON.stringify(tag)}]);\n${extra}` +
      (pad > 0 ? `//${"x".repeat(pad)}\n` : ""),
    200,
    headers,
  );
});

// Modules a page inserts at runtime: one registers a WebMCP tool through an import, one
// throws while evaluating, and one imports a module that is not there.
const INSERTED_MODULES: Record<string, string> = {
  "tool.js": `import { label } from "./dep.js";
document.modelContext.registerTool({
  name: "inserted_tool",
  description: "Registered by an inserted module",
  execute: () => label,
});
globalThis.__insertedModule = (globalThis.__insertedModule || []).concat(["tool"]);
`,
  "dep.js": `export const label = "from-dep";\n`,
  "throws.js": `globalThis.__insertedModule = (globalThis.__insertedModule || []).concat(["throws"]);
throw new Error("inserted module threw");
`,
  // A lazy chunk 404s while this module evaluates; its own graph loaded, so it still gets load.
  "throws-after-lazy-404.js": `globalThis.__insertedModule = (globalThis.__insertedModule || []).concat(["lazy"]);
await import("./lazy-missing.js").catch(() => {});
throw new Error("inserted module threw after a lazy 404");
`,
  // A parse error: HTML fires load on the element and reports the error to the window.
  "syntax.js": `globalThis.__insertedModule = ["unreachable"];\nexport const = ;\n`,
  "broken.js": `import "./missing.js";
globalThis.__insertedModule = (globalThis.__insertedModule || []).concat(["broken"]);
`,
};
// Past the 8 MiB budget for inserted script source, which bounds what boa buffers and parses.
const OVER_BUDGET_BYTES = 9 * 1024 * 1024;
scripts.all("/inserted-module/big.js", (c) =>
  c.body(`// ${"x".repeat(OVER_BUDGET_BYTES)}\nglobalThis.__insertedModule = ["big"];\n`, 200, {
    "content-type": JS,
    "access-control-allow-origin": "*",
  }),
);
scripts.all("/inserted-module/:file{[\\w-]+\\.js}", (c) => {
  const body = INSERTED_MODULES[c.req.param("file")];
  if (body === undefined) return c.text("not found", 404);
  return c.body(body, 200, { "content-type": JS, "access-control-allow-origin": "*" });
});

// The connection drops before the body completes, so the fetch has no usable response.
scripts.all("/dropped-script.js", () => {
  const dropped = new ReadableStream<Uint8Array>({
    pull(ctl) {
      ctl.error(new Error("dropped-script: connection dropped"));
    },
  });
  return new Response(dropped, { headers: { "content-type": JS } });
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
// Learned on the first hit as a benign body, then served hostile on later hits so the
// speculative bake and the runtime fetch see the same bytes.
const HOSTILE_PROBE = `window.__insertedNative = typeof Error.captureStackTrace === "function";
window.__insertedRuns = 1;
window.__hostileResult = "pending";
import("file:///bundle/internal-state.js").then(function (ns) {
  window.__hostileResult = typeof ns.getInternalState;
}, function () { window.__hostileResult = "refused"; });
`;
const insertedProbeHits = new Map<string, number>();
scripts.all(
  "/inserted-probe/:mode{stable|volatile|gone|slow|hostile}/:file{[\\w-]+\\.js}",
  async (c) => {
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
    const body =
      mode === "volatile"
        ? `${insertedBakeJs}\n// hit ${hit}\n`
        : mode === "hostile" && hit > 1
          ? HOSTILE_PROBE
          : insertedBakeJs;
    return c.body(body, 200, headers);
  },
);
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

// A script for document.write order tests: it waits `ms` and records `tag`.
// With `next` it writes the script for that tag. With `inline` it writes an
// inline script that records that tag, then records `<tag>-after`.
scripts.all("/written-script.js", async (c) => {
  const word = (name: string) => (c.req.query(name) ?? "").replace(/[^a-z0-9-]/gi, "");
  await sleep(intQuery(c, "ms", { fallback: 0, min: 0, max: 3000 }));
  const push = (value: string) =>
    `globalThis.__written = (globalThis.__written || []).concat([${JSON.stringify(value)}]);`;
  const tag = word("tag");
  const next = word("next");
  const inline = word("inline");
  let body = push(tag) + "\n";
  if (next) {
    body += `document.write('<script src="/__fixtures/written-script.js?tag=${next}"><\\/script>');\n`;
  }
  if (inline) {
    body += `document.write('<script>${push(inline)}<\\/script>');\n`;
    body += push(`${tag}-after`) + "\n";
  }
  return c.body(body, 200, { "content-type": JS });
});
