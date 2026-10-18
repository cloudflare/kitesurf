
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { jsonProbe, spreadProbe, entriesProbe, keysProbe, getterProbe, assignProbe } from "./seam-plain-runtime.js";

const r = { loaded: true };
function safe(name, fn) {
  try { r[name] = fn(); } catch (e) { r[name] = "throw: " + ((e && e.message) || e); }
}
safe("jsonStringify", function () { return jsonProbe({ a: 1, b: 2 }) === '{"a":1,"b":2}'; });
safe("nestedJson", function () { return jsonProbe({ a: { b: [1, 2, 3] } }) === '{"a":{"b":[1,2,3]}}'; });
safe("objectSpread", function () { return spreadProbe({ a: 1, b: 2 }) === '{"a":1,"b":2}'; });
safe("objectEntries", function () { return entriesProbe({ a: 1 }) === '[["a",1]]'; });
safe("objectKeys", function () { return keysProbe({ x: 1, y: 2 }) === "x,y"; });
safe("objectAssign", function () { return assignProbe({ a: 1, b: 2 }) === '{"a":1,"b":2}'; });
safe("getterRead", function () { const o = { _v: 7, get computed() { return this._v * 2; } }; return getterProbe(o) === 14; });
document.title = "SEAM:" + JSON.stringify(r);
