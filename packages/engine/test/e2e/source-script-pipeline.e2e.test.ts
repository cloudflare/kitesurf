// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// An OOPIF child has no parent bundle, so page-script's source pipeline (scripts.ts) runs it.
// The loaded worker refuses native code generation, so this pins that classic and module scripts
// run on boa with real module semantics, not through a regex rewrite into `AsyncFunction`. The
// setDocumentContent cases pin that synthetic-origin content goes through the parent's scan.
import { expect, test } from "./harness";
import { setContent } from "./set-content";

const LIVE_DEP =
  "data:text/javascript," + encodeURIComponent("export let n = 0; export function inc() { n++; }");

const SCRIPTS = `
<script>window.r = {}; var shared = 41;</script>
<script>window.r.shared = shared + 1; window.r.awaitInString = "please await";</script>
<script type="module">const s = \`
import x from "./missing-from-template.js";
\`; window.r.importInTemplate = 1;</script>
<script type="module">// import y from "./missing-from-comment.js";
window.r.importInComment = 1;</script>
<script type="module">export default function f() { return 3; }
window.r.exportDefault = f();</script>
<script type="module">await Promise.resolve(); window.r.topLevelAwait = 1;</script>
<script type="module">try { undeclared = 1; window.r.strict = false; } catch (e) { window.r.strict = e instanceof ReferenceError; }
window.r.thisUndefined = this === undefined; window.r.metaUrl = typeof import.meta.url;</script>`;

const EXPECTED = {
  shared: 42,
  awaitInString: "please await",
  importInTemplate: 1,
  importInComment: 1,
  exportDefault: 3,
  topLevelAwait: 1,
  strict: true,
  thisUndefined: true,
  metaUrl: "string",
};

test("an OOPIF child runs classic and module scripts on boa", async ({ page, cdpSession }) => {
  const child = `<!doctype html><body>${SCRIPTS}
<script type="module">import { n, inc } from "${LIVE_DEP}"; inc(); window.r.liveBinding = n;</script>
<script>addEventListener("load", () => parent.postMessage(JSON.stringify(window.r), "*"));</script></body>`;
  await setContent(
    page,
    `<!doctype html><body><script>window.got = null; addEventListener("message", (e) => { window.got = e.data; });</script>
<iframe src="data:text/html;charset=utf-8,${encodeURIComponent(child)}"></iframe></body>`,
  );
  let got: string | null = null;
  for (let i = 0; i < 40 && !got; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const r = await cdpSession.send("Runtime.evaluate", {
      expression: "window.got",
      returnByValue: true,
    });
    got = r.result.value ?? null;
  }
  expect(JSON.parse(got ?? "null")).toEqual({ ...EXPECTED, liveBinding: 1 });
});

// blitz-html keeps template contents under the <template> element, so the source fallback must
// test real ancestry: a cross-origin child has no bundle, and a template script is inert there.
const LOADED = `<script>addEventListener("load", () => parent.postMessage("loaded", "*"))</script>`;
const TEMPLATE_SCRIPT = `<template><script>parent.postMessage("template", "*")</script></template>`;
const templateCases: Array<[string, string | ((key: string) => string)]> = [
  ["an OOPIF child never runs a script inside a template", ""],
  [
    "a template does not stop a permitted external sibling script from running",
    (key) => `<script src="https://ks-other.invalid/__fixtures/oopif-csp-hop/${key}.js"></script>`,
  ],
];

for (const [name, sibling] of templateCases) {
  test(
    name,
    async ({ page }) => {
      const key = Math.random().toString(36).slice(2);
      const extra = typeof sibling === "function" ? sibling(key) : sibling;
      await page.goto("https://ks.invalid/__fixtures/lifecycle.html", { waitUntil: "load" });
      await page.evaluate(
        `window.__msgs = []; addEventListener("message", (e) => window.__msgs.push(String(e.data)));`,
      );
      await page.evaluate(
        (url) => {
          const frame = document.createElement("iframe");
          frame.src = url;
          document.body.appendChild(frame);
        },
        "https://ks-other.invalid/__fixtures/policy-doc.html?body=" +
          encodeURIComponent(TEMPLATE_SCRIPT + extra + LOADED),
      );
      const messages = async (): Promise<string[]> =>
        JSON.parse((await page.evaluate("JSON.stringify(window.__msgs)")) as string) as string[];
      await expect.poll(messages, { timeout: 20_000 }).toContain("loaded");
      expect(await messages()).toEqual(extra ? ["ran:" + key, "loaded"] : ["loaded"]);
    },
    60_000,
  );
}

// A parser module is a parser script, not a runtime insert: the child's own CSP decides it
// before Boa registers, fetches or evaluates it, and 'strict-dynamic' does not admit it.
const DONE = `<script type="module" nonce="ok">parent.postMessage("done", "*")</script>`;
const inlineModule = (attrs: string, msg: string): string =>
  `<script type="module"${attrs}>parent.postMessage("${msg}", "*")</script>`;
const externalModule = (key: string, attrs = ""): string =>
  `<script type="module"${attrs} src="https://ks.invalid/__fixtures/oopif-csp-hop/${key}.js"></script>`;
const moduleCases: Array<[string, string, string, string[]]> = [
  [
    "an inline module without the nonce never runs",
    "script-src 'nonce-ok'",
    inlineModule("", "blocked-inline") + inlineModule(' nonce="ok"', "inline-ok"),
    ["inline-ok", "done"],
  ],
  [
    "a parser module entry is not admitted by 'strict-dynamic'",
    "script-src 'nonce-ok' 'strict-dynamic'",
    externalModule("blocked") + externalModule("allowed", ' nonce="ok"'),
    ["ran:allowed", "done"],
  ],
];

for (const [name, csp, body, expected] of moduleCases) {
  test(
    name,
    async ({ page }) => {
      await page.goto("https://ks.invalid/__fixtures/lifecycle.html", { waitUntil: "load" });
      await page.evaluate(
        `window.__msgs = []; addEventListener("message", (e) => window.__msgs.push(String(e.data)));`,
      );
      const child = new URL("https://ks-other.invalid/__fixtures/policy-doc.html");
      child.searchParams.set("csp", csp);
      child.searchParams.set("body", body + DONE);
      await page.evaluate((url) => {
        const frame = document.createElement("iframe");
        frame.src = url;
        document.body.appendChild(frame);
      }, child.toString());
      const messages = async (): Promise<string[]> =>
        JSON.parse((await page.evaluate("JSON.stringify(window.__msgs)")) as string) as string[];
      await expect.poll(messages, { timeout: 20_000 }).toContain("done");
      expect(await messages()).toEqual(expected);
    },
    60_000,
  );
}

test("setDocumentContent on a synthetic origin runs the page's scripts", async ({ cdpSession }) => {
  // Puppeteer registers a script to evaluate on new documents. The bundle
  // then held only that script, and the page's own scripts never ran.
  await cdpSession.send("Page.setDocumentContent", {
    frameId: "main",
    html: `<!doctype html><body>${SCRIPTS}</body>`,
  });
  const r = await cdpSession.send("Runtime.evaluate", {
    expression: "JSON.stringify([location.href, window.r])",
    returnByValue: true,
  });
  expect(JSON.parse(r.result.value)).toEqual(["https://kitesurf.local/", EXPECTED]);
});

test("setDocumentContent enforces the markup's meta CSP", async ({ cdpSession }) => {
  // The nonce'd pair proves scripts run at all, so the blocked pair can't pass vacuously.
  await cdpSession.send("Page.setDocumentContent", {
    frameId: "main",
    html: `<!doctype html><head><meta http-equiv="Content-Security-Policy" content="script-src 'nonce-ok'"></head>
<body><script nonce="ok">window.ran = ["classic"];</script><script type="module" nonce="ok">window.ran.push("module");</script>
<script>window.ran.push("blocked classic");</script><script type="module">window.ran.push("blocked module");</script></body>`,
  });
  const r = await cdpSession.send("Runtime.evaluate", {
    expression: "JSON.stringify(window.ran ?? null)",
    returnByValue: true,
  });
  expect(JSON.parse(r.result.value)).toEqual(["classic", "module"]);
});
