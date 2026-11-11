// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements CDP Log commands: the per-session ledger for engine-emitted entries.

import type { CdpRequest } from "./types.ts";
import type { DispatchCtx } from "./dispatch.ts";

export async function handleLog(ctx: DispatchCtx, req: CdpRequest): Promise<unknown> {
  switch (req.method) {
    case "Log.enable":
      ctx.browser.networkEvents.setLogEnabled(req.sessionId, true);
      return {};

    case "Log.disable":
      ctx.browser.networkEvents.setLogEnabled(req.sessionId, false);
      return {};

    default:
      return {};
  }
}
