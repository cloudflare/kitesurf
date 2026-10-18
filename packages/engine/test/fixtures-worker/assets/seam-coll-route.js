
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { mapProbe, setProbe, dateProbe, reProbe, makeMap, makeDate, tagProbe } from "./seam-coll-runtime.js";

const r = { loaded: true };
function safe(name, fn) {
  try { r[name] = fn(); } catch (e) { r[name] = "throw: " + ((e && e.message) || e); }
}
safe("boaMapMethods", function () { const p = mapProbe(new Map()); return p.get === 42 && p.size === 1; });
safe("boaMapInstanceof", function () { return mapProbe(new Map()).isMap === true; });
safe("boaMapIterate", function () { return mapProbe(new Map()).spread === 1; });
safe("boaSetMethods", function () { const p = setProbe(new Set()); return p.has === true && p.size === 1; });
safe("boaSetInstanceof", function () { return setProbe(new Set()).isSet === true; });
safe("boaDateMethods", function () { return dateProbe(new Date(1000)).time === 1000; });
safe("boaDateInstanceof", function () { return dateProbe(new Date(0)).isDate === true; });
safe("boaReTest", function () { return reProbe(/ab+c/, "abbbc").test === true; });
safe("boaReInstanceof", function () { return reProbe(/x/, "x").isRe === true; });
safe("v8MapToBoa", function () { const m = makeMap(); return m.get("a") === 1; });
safe("v8DateToBoa", function () { const d = makeDate(); return d.getTime() === 1000; });
safe("boaMapTag", function () { return tagProbe(new Map()) === "[object Map]"; });
document.title = "SEAM:" + JSON.stringify(r);
