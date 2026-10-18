// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

export function bfn(n) { return 'bfn-' + n; }
export const bobj = { m: (n) => 'bm-' + n };
export class BCls { constructor(n) { this.n = n; } tag() { return 'bc-' + this.n; } }
export const btoken = 'baked-ok';
