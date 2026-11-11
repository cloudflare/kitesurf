// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

var B64 = "__KS_ADD_WASM_B64__";
// Two 118-byte modules that share size, head16 and tail16 but differ in the
// first byte of their 64-byte data payload (the last 64 bytes of the module).
var COLLIDE_A = "__KS_COLLIDE_A_B64__";
var COLLIDE_B = "__KS_COLLIDE_B_B64__";
function decode(b64) {
  return Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
}
function syncValue(bytes) {
  return new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports.value();
}
function probe(fn) {
  try {
    return fn();
  } catch (e) {
    return "threw: " + e.message;
  }
}
var bytes = decode(B64);
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
  out.syncA = probe(function () { return syncValue(decode(COLLIDE_A)); });
  out.syncB = probe(function () { return syncValue(decode(COLLIDE_B)); });
  var unrelated = decode(COLLIDE_B);
  unrelated[unrelated.length - 64] = 3;
  out.syncC = probe(function () { return syncValue(unrelated); });
  out.tiny = probe(function () {
    return new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports.add(20, 22);
  });
  var padded = new Uint8Array(bytes.length + 3);
  padded.set(bytes, 3);
  out.view = probe(function () {
    var view = new Uint8Array(padded.buffer, 3, bytes.length);
    return new WebAssembly.Instance(new WebAssembly.Module(view), {}).exports.add(20, 22);
  });
  document.title = "INLINEWASM:" + JSON.stringify(out);
})();
