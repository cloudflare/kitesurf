// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { CdpClientState } from "../src/cdp/types.ts";

/** The state of one CDP client, for a partial DispatchCtx fixture. */
export function testClient(connectionMode: "page" | "browser" = "browser"): CdpClientState {
  return {
    id: "test-client",
    connectionMode,
    autoAttach: false,
    flatten: false,
    sessions: new Set(),
    preNavScriptIds: new Set(),
    memoryTargets: { renderer: null, engine: null, storage: null },
  };
}
