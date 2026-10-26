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

  // Read by the wasm core (packages/core/src/js/internals.rs). Close a small V8 function over a
  // boa trampoline shim and its pin handle(s), so a crossing costs no wasm-bindgen closure.
  wrapBoaFunction?: (call: Function, construct: Function, handle: number) => Function;
  wrapBoaMethod?: (call: Function, fnHandle: number, receiverHandle: number) => Function;
  // A baked module's V8 namespace, so boa reuses it instead of fetching.
  nativeImport?: (url: unknown) => Promise<unknown>;
  // A module body for boa's fetch-and-interpret path, through the script gate.
  fetchModuleSource?: (url: unknown) => Promise<string>;
  // Run due page timers while boa awaits; returns how many ran. Installed read-only.
  readonly pumpDueTimers?: (deadlineMs?: number) => number;
  // Ms until the next page timer is due, or Infinity.
  readonly nextTimerDelay?: () => number;

  // Installed by the memprof build's recorder banner.
  memprofImports?: object;
  memprofDump?: () => string;
  memprofReset?: () => void;
}

export const ksInternals = getInternals() as PageScriptInternals;
