// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Reached only through a computed import, so boa evaluates this module and reads the baked
// library's exports through its live bindings.
import { count, incrementCount } from "https://ks-alt.invalid/__fixtures/module-registry-lib.js";

export function read() {
  return count;
}

export function bump() {
  incrementCount();
  return count;
}
