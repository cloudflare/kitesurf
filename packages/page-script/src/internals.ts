// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// page-script's handle on the internals record from internal-state.js (KitesurfInternals). Kept
// out of state.ts because worker-script bundles state.ts and its loaded worker has no
// internal-state.js.

import { getInternals } from "./internal-state.js";

export const ksInternals = getInternals();
