
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { reactive, isReactive, toRaw, effect, remember, recall, watchSize, effectRunCount, crossId, setSizeV8, readSize, tagOf } from "./seam-runtime.js";

const r = { loaded: true };
function safe(name, fn) {
  try { r[name] = fn(); } catch (e) { r[name] = "throw: " + ((e && e.message) || e); }
}
safe("weakmapRoundtrip", function () { const o = {}; remember(o); return recall(o) === true; });
safe("reactiveInterning", function () { const o = {}; return reactive(o) === reactive(o); });
safe("isReactiveOnProxy", function () { return isReactive(reactive({})) === true; });
safe("toRawUnwrap", function () { const o = {}; return toRaw(reactive(o)) === o; });
safe("sameCrossId", function () { const o = {}; return crossId(o) === crossId(o); });
safe("effectDelivery", function () {
  const raw = { size: 1520 };
  const el = document.getElementById("out");
  watchSize(raw, el);
  const p = reactive(raw);
  p.size = 30;
  return el.getAttribute("data-size") === "30";
});
document.title = "SEAM:" + JSON.stringify(r);
