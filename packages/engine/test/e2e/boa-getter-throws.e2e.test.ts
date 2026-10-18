// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const PROBE = `(() => {
  const grab = (f) => { try { return ["value", f()]; } catch (e) { return ["threw", e.name + ": " + e.message]; } };
  return {
    pageGetter: grab(() => window.__thrower.boom),
    pageSymbolGetter: grab(() => window.__thrower[Symbol.for("boom")]),
    hostGetter: grab(() => document.evaluate("1", document, null, XPathResult.NUMBER_TYPE, null).singleNodeValue),
    plainGetter: grab(() => window.__thrower.fine),
  };
})()`;

const DEFINE_THROWER = `<script>
  window.__thrower = Object.defineProperties({}, {
    boom: { get() { throw new RangeError("page getter threw"); } },
    [Symbol.for("boom")]: { get() { throw new SyntaxError("symbol getter threw"); } },
    fine: { get() { return 42; } },
  });
</script>`;

test("a throwing V8 getter throws into boa, with its own error", async ({ page }) => {
  await setContent(page, `<!doctype html><title>getters</title>${DEFINE_THROWER}`);
  expect(await page.evaluate(PROBE)).toStrictEqual({
    pageGetter: ["threw", "RangeError: page getter threw"],
    pageSymbolGetter: ["threw", "SyntaxError: symbol getter threw"],
    hostGetter: ["threw", "TypeError: The result type is not a single node."],
    plainGetter: ["value", 42],
  });
});

test("?ks_boa_lenient=1 keeps the legacy undefined for a throwing getter", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/dynimport.html?ks_boa_lenient=1", {
    waitUntil: "load",
    timeout: 30000,
  });
  const out = (await page.evaluate(`(() => {
    try { return ["value", String(document.evaluate("1", document, null, XPathResult.NUMBER_TYPE, null).singleNodeValue)]; }
    catch (e) { return ["threw", e.name]; }
  })()`)) as unknown;
  expect(out).toStrictEqual(["value", "undefined"]);
});

test("a V8 accessor's descriptor keeps its get/set, so the prototype-read fallback works", async ({
  page,
}) => {
  await setContent(
    page,
    `<!doctype html><title>descriptors</title><script src="data:text/javascript,0" onerror="void 0"></script>`,
  );
  const out = (await page.evaluate(`(() => {
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "onerror");
    const script = document.querySelector("script");
    const handler = () => {};
    let direct;
    try { direct = ["value", String(HTMLScriptElement.prototype.onerror)]; } catch (e) { direct = ["threw", e.name]; }
    desc.set.call(script, handler);
    return {
      shape: Object.keys(desc).sort().join(","),
      getIsFn: typeof desc.get, setIsFn: typeof desc.set,
      direct,
      viaGet: desc.get.call(script) === handler,
      viaProp: script.onerror === handler,
    };
  })()`)) as unknown;
  expect(out).toStrictEqual({
    shape: "configurable,enumerable,get,set",
    getIsFn: "function",
    setIsFn: "function",
    direct: ["threw", "TypeError"],
    viaGet: true,
    viaProp: true,
  });
});
