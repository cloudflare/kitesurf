// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements CDP Log commands: the per-session ledger for engine-emitted entries.

import { defineDomain, stub } from "./domain.ts";

export const logDomain = defineDomain("Log", {
  methods: {
    "Log.enable": (ctx, req) => {
      ctx.browser.networkEvents.setLogEnabled(req.sessionId, true);
      return {};
    },
    "Log.disable": (ctx, req) => {
      ctx.browser.networkEvents.setLogEnabled(req.sessionId, false);
      return {};
    },
    // Entries go out as they happen, so there is no buffer to clear; nothing reports violations.
    "Log.clear": stub,
    "Log.startViolationsReport": stub,
    "Log.stopViolationsReport": stub,
  },
});
