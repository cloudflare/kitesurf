// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// An inserted script runs on boa, where DOM objects are bridged from V8. Sanitizers find
// getters by walking Element.prototype's chain, so Object.getPrototypeOf must follow V8's.
import { expect, test } from "./harness";
import { setContent } from "./set-content";

const BOA_PROBE = `
var lookupGetter = function (object, prop) {
  while (object !== null) {
    var desc = Object.getOwnPropertyDescriptor(object, prop);
    if (desc) return desc.get || desc.value;
    object = Object.getPrototypeOf(object);
  }
  return null;
};
var div = document.createElement("div");
var parentNode = lookupGetter(Element.prototype, "parentNode");
document.body.appendChild(div);
window.__result = {
  elementProto: Object.getPrototypeOf(Element.prototype) === Node.prototype,
  divProto: Object.getPrototypeOf(div) === HTMLDivElement.prototype,
  isPrototypeOf: Node.prototype.isPrototypeOf(div),
  parentNodeGetter: typeof parentNode === "function" && parentNode.call(div) === document.body,
  v8Object: Object.getPrototypeOf(window.__v8Object) === Object.prototype,
  v8Array: Object.getPrototypeOf(window.__v8Array) === Array.prototype,
  v8Null: Object.getPrototypeOf(window.__v8Null) === null
};
`;

test("boa sees the V8 prototype chain of bridged objects", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><title>t</title><body><script>
    window.__v8Object = { a: 1 };
    window.__v8Array = [1, 2];
    window.__v8Null = Object.create(null);
    var s = document.createElement("script");
    s.textContent = ${JSON.stringify(BOA_PROBE)};
    document.head.appendChild(s);
    </script></body>`,
  );
  await page.waitForFunction(() => !!(globalThis as { __result?: unknown }).__result, {
    timeout: 20_000,
  });
  expect(await page.evaluate(() => (globalThis as { __result?: unknown }).__result)).toEqual({
    elementProto: true,
    divProto: true,
    isPrototypeOf: true,
    parentNodeGetter: true,
    v8Object: true,
    v8Array: true,
    v8Null: true,
  });
}, 60_000);
