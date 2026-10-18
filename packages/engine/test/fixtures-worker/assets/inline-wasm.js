// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

var B64 = "__KS_ADD_WASM_B64__";
var bytes = Uint8Array.from(atob(B64), function (c) { return c.charCodeAt(0); });
(async function () {
  var out = {};
  try {
    var r = await WebAssembly.instantiate(bytes, {});
    out.instantiate = r.instance.exports.add(20, 22);
    out.hasModule = r.module instanceof WebAssembly.Module;
  } catch (e) {
    out.instantiate = "threw: " + e.message;
  }
  try {
    var m = await WebAssembly.compile(bytes);
    out.compile = new WebAssembly.Instance(m, {}).exports.add(2, 3);
  } catch (e) {
    out.compile = "threw: " + e.message;
  }
  document.title = "INLINEWASM:" + JSON.stringify(out);
})();
