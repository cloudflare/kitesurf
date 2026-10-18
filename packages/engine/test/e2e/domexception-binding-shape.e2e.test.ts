// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("DOMException has the WebIDL binding shape", async ({ page }) => {
  await setContent(
    page,
    `<script>
      const proto = DOMException.prototype;
      const e = new DOMException("msg", "InvalidCharacterError");
      const msgDesc = Object.getOwnPropertyDescriptor(proto, "message");
      const ctorDesc = Object.getOwnPropertyDescriptor(DOMException, "INDEX_SIZE_ERR");
      let brandThrows = false;
      try { msgDesc.get.apply({}); } catch (err) { brandThrows = err instanceof TypeError; }
      let protoToStringThrows = false;
      try { proto.toString(); } catch { protoToStringThrows = true; }
      document.title = JSON.stringify({
        messageIsOwn: Object.prototype.hasOwnProperty.call(e, "message"),
        getterOnProto: typeof msgDesc.get,
        brandThrows,
        protoToStringThrows,
        code: e.code,
        droppedNameCode: new DOMException("m", "ValidationError").code,
        constantConfigurable: ctorDesc.configurable,
        toStringTag: Object.prototype.toString.call(e),
        classSideProto: Object.getPrototypeOf(DOMException) === Function.prototype,
        isError: Error.isError(e),
        toString: e.toString(),
      });
    </` + `script>`,
  );
  const r = JSON.parse(String(await page.evaluate("document.title")));
  expect(r).toEqual({
    messageIsOwn: false,
    getterOnProto: "function",
    brandThrows: true,
    protoToStringThrows: true,
    code: 5,
    droppedNameCode: 0,
    constantConfigurable: false,
    toStringTag: "[object DOMException]",
    classSideProto: true,
    isError: true,
    toString: "InvalidCharacterError: msg",
  });
}, 120_000);

test("runtime-thrown native DOMExceptions still pass instanceof", async ({ page }) => {
  await setContent(
    page,
    `<script>
      // structuredClone of a Symbol throws workerd's own native
      // DataCloneError — not one constructed via the shim.
      try {
        structuredClone(Symbol("x"));
        document.title = JSON.stringify({ threw: false });
      } catch (err) {
        document.title = JSON.stringify({
          threw: true,
          isDOMException: err instanceof DOMException,
          name: err.name,
        });
      }
    </` + `script>`,
  );
  const r = JSON.parse(String(await page.evaluate("document.title")));
  expect(r).toEqual({
    threw: true,
    isDOMException: true,
    name: "DataCloneError",
  });
}, 120_000);
