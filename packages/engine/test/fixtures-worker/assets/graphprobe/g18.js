// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

var d = Object.defineProperty;
var w = (t, e) => { for (var k in e) d(t, k, { get: e[k], enumerable: true }); };
var NS = {};
w(NS, { Provider: () => P });
class P { static instance() { return 'static-ns'; } }
export { NS };
