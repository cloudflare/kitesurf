// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

export function legacy(n) {
  const padded = '  ' + n + '  ';
  return n.substr(1) + ':' + padded.trimLeft().trimRight() + ':' + unescape(escape('a b'));
}
