// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

export function arity() {
  const a = Array.prototype.slice.call(arguments);
  return a.length + ':' + String(a[3] && a[3].client);
}
export const holder = { method: function () {
  const a = Array.prototype.slice.call(arguments);
  return a.length + ':' + String(a[3] && a[3].client);
} };
