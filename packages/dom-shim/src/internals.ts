// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// dom-shim's handle on the internals record from internal-state.js: the hooks it shares with
// page-script, kept off globalThis so page JS never sees them as globals. The type,
// KitesurfInternals, lives beside the record in page-script/src/internal-state.ts.

import { getInternals } from "./internal-state.js";

export const ksInternals = getInternals();
