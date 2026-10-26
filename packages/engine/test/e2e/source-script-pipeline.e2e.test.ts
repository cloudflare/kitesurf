// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// An OOPIF child has no parent bundle, so page-script's source pipeline (scripts.ts) runs it.
// The loaded worker refuses native code generation, so this pins that classic and module scripts
// run on boa with real module semantics, not through a regex rewrite into `AsyncFunction`.
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
