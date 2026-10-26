// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// page-script's view of the internals record from internal-state.js: the hooks it shares with
// dom-shim, plus the ones only the wasm core and the e2e tests reach. Kept out of state.ts because
// worker-script bundles state.ts and its loaded worker has no internal-state.js.

import type { DomHandle } from "./types.ts";
import type { DomShimInternals } from "./dom-shim.js";
import { getInternals } from "./internal-state.js";

export interface PageScriptInternals extends DomShimInternals {
  // The live DomHandle, for e2e tests that inspect wasm state directly.
  domDebug?: DomHandle | null;
}

export const ksInternals = getInternals() as PageScriptInternals;
