// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// `__proto__` on a bridged V8 object must answer boa's own intrinsic prototype, the mapping
// getPrototypeOf already applies, or page code writes straight into this realm's intrinsics.
import { expect, test } from "./harness";
import { setContent } from "./set-content";

const PROBE = `
var errors = [];
function attempt(fn) { try { fn(); } catch (e) { errors.push(String(e)); } }
attempt(function () { window.__v8Object.__proto__.ksObj = "obj"; });
attempt(function () { Object.defineProperty(window.__v8Object.__proto__, "ksDef", { value: "def", configurable: true }); });
attempt(function () { window.__v8Array.__proto__.ksArr = "arr"; });
attempt(function () { window.__v8Function.__proto__.ksFn = "fn"; });
window.__observe(errors.join(" | "), [({}).ksObj, ({}).ksDef, [].ksArr, (function () {}).ksFn].map(String).join(","));
`;

const MARKUP = `<!doctype html><title>t</title><script>
window.__v8Object = { a: 1 };
window.__v8Array = [1, 2];
window.__v8Function = function () {};
window.__observe = function (errors, boa) {
  setTimeout(function () {
    var marks = [({}).ksObj, ({}).ksDef, [].ksArr, (function () {}).ksFn];
    console.log("ks-proto " + JSON.stringify(marks.map(String).concat(boa, errors)));
  }, 0);
};
var s = document.createElement("script");
s.textContent = ${JSON.stringify(PROBE)};
document.head.appendChild(s);
</script>`;

test("page code cannot reach V8 intrinsic prototypes through a bridged __proto__", async ({
  page,
}) => {
  const seen = new Promise<string>((resolve) =>
    page.on("console", (m) => m.text().startsWith("ks-proto ") && resolve(m.text().slice(9))),
  );
  await setContent(page, MARKUP);
  const raw = await Promise.race([
    seen,
    new Promise<string>((resolve) => setTimeout(() => resolve("[]"), 20_000)),
  ]);
  expect(JSON.parse(raw)).toEqual([
    "undefined",
    "undefined",
    "undefined",
    "undefined",
    "obj,def,arr,fn",
    "",
  ]);
}, 60_000);

// The same invariant for the intrinsic constructors a V8 value exposes as plain properties:
// `document.createElement.constructor` is the realm's real Function, and its `prototype` is the
// (callable) real Function.prototype, so both must answer with boa's own intrinsics.
const CTOR_PROBE = `(() => {
  const errors = [];
  const attempt = (fn) => { try { fn(); } catch (e) { errors.push(String(e)); } };
  attempt(() => { document.createElement.constructor.prototype.ksFnProto = "fnp"; });
  attempt(() => { document.createElement.constructor.ksFnCtor = "ctor"; });
  const el = document.createElement("div");
  el.setAttribute("data-k", "v");
  return JSON.stringify([
    String((function () {}).ksFnProto),
    String(Function.ksFnCtor),
    el.tagName,
    el.getAttribute("data-k"),
    document.createElement("span").tagName,
    errors.join(" | "),
  ]);
})()`;

test("intrinsic constructors reached through a bridged value map to boa's own", async ({
  page,
}) => {
  await setContent(
    page,
    `<!doctype html><title>t</title><script>
    // V8's own intrinsics, read from the native realm the shim runs in.
    window.__v8IntrinsicTruth = function () {
      return JSON.stringify([
        String(Function.prototype.ksFnProto),
        String(Function.prototype.constructor.ksFnCtor),
      ]);
    };
    </script>`,
  );
  expect(JSON.parse((await page.evaluate(CTOR_PROBE)) as string)).toEqual([
    "fnp",
    "ctor",
    "DIV",
    "v",
    "SPAN",
    "",
  ]);
  expect(JSON.parse((await page.evaluate("window.__v8IntrinsicTruth()")) as string)).toEqual([
    "undefined",
    "undefined",
  ]);
}, 60_000);
