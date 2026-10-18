
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

export function jsonProbe(o) { return JSON.stringify(o); }
export function spreadProbe(o) { return JSON.stringify({ ...o }); }
export function entriesProbe(o) { return JSON.stringify(Object.entries(o)); }
export function keysProbe(o) { return Object.keys(o).join(","); }
export function getterProbe(o) { return o.computed; }
export function assignProbe(o) { const t = Object.assign({}, o); return JSON.stringify(t); }
