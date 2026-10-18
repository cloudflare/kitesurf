// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

var wasmBinaryFile = "add.wasm";
function report(k, v) {
  var el = document.getElementById(k);
  if (el) el.textContent = String(v);
}
try {
  var m = new WebAssembly.Module(
    Uint8Array.of(0x0, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00),
  );
  report(
    "probe",
    m instanceof WebAssembly.Module &&
      new WebAssembly.Instance(m) instanceof WebAssembly.Instance,
  );
} catch (e) {
  report("probe", "threw: " + e.message);
}
(async function () {
  try {
    var r1 = await WebAssembly.instantiateStreaming(fetch(wasmBinaryFile), {});
    report("streaming", r1.instance.exports.add(2, 3));
    report("streamingModule", r1.module instanceof WebAssembly.Module);
  } catch (e) {
    report("streaming", "threw: " + e.message);
  }
  try {
    var buf = await (await fetch(wasmBinaryFile)).arrayBuffer();
    var r2 = await WebAssembly.instantiate(buf, {});
    report("bytes", r2.instance.exports.add(20, 22));
    var m2 = await WebAssembly.compile(buf);
    report("compile", m2 instanceof WebAssembly.Module);
    var m3 = new WebAssembly.Module(new Uint8Array(buf));
    report("syncModule", new WebAssembly.Instance(m3, {}).exports.add(1, 1));
  } catch (e) {
    report("bytes", "threw: " + e.message);
  }
  report("done", true);
  document.title = "WASMBOOT:" + JSON.stringify({
    probe: document.getElementById("probe").textContent,
    streaming: document.getElementById("streaming").textContent,
    streamingModule: document.getElementById("streamingModule").textContent,
    bytes: document.getElementById("bytes").textContent,
    compile: document.getElementById("compile").textContent,
    syncModule: document.getElementById("syncModule").textContent,
  });
})();
