// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements CDP Fetch interception commands for pausing and resuming requests.

import type { CdpRequest } from "./types.ts";
import type { DispatchCtx } from "./dispatch.ts";
import {
  ensureInterception,
  getInterception,
  MAX_GLOB_PATTERN_CHARS,
  MAX_GLOB_PATTERNS,
  releaseAllParked,
  resolveParked,
  type InterceptAction,
} from "./fetch-interception.ts";

export async function handleFetch(ctx: DispatchCtx, req: CdpRequest): Promise<unknown> {
  switch (req.method) {
    case "Fetch.enable": {
      const st = ensureInterception(ctx.connectionId);
      const raw = req.params?.patterns ?? [{ urlPattern: "*" }];
      const active = raw.filter((p) => (p.requestStage ?? "Request") === "Request");
      if (active.length > MAX_GLOB_PATTERNS) {
        throw new Error(
          `Invalid patterns: ${active.length} exceeds the ${MAX_GLOB_PATTERNS} pattern limit`,
        );
      }
      for (const p of active) {
        const pattern = p.urlPattern ?? "*";
        if (pattern.length > MAX_GLOB_PATTERN_CHARS) {
          throw new Error(
            `Invalid urlPattern: ${pattern.length} characters exceeds the ` +
              `${MAX_GLOB_PATTERN_CHARS} character limit`,
          );
        }
      }
      st.patterns = active.map((p) => ({
        pattern: p.urlPattern ?? "*",
        resourceType: p.resourceType,
      }));
      const sessionId = req.sessionId;
      st.emit = (params) => ctx.emit({ method: "Fetch.requestPaused", params, sessionId });
      return {};
    }

    case "Fetch.disable": {
      const st = getInterception(ctx.connectionId);
      if (st) {
        releaseAllParked(st);
        st.patterns = [];
        st.pendingEmits = [];
      }
      return {};
    }

    case "Fetch.continueRequest": {
      const p = req.params!;
      const action: InterceptAction = {
        kind: "continue",
        url: p.url,
        method: p.method,
        headers: p.headers,
        postData: p.postData,
      };
      resolveOrThrow(ctx, p.requestId, action);
      return {};
    }

    case "Fetch.fulfillRequest": {
      const p = req.params!;
      resolveOrThrow(ctx, p.requestId, {
        kind: "fulfill",
        responseCode: p.responseCode,
        responseHeaders: p.responseHeaders,
        body: p.body,
      });
      return {};
    }

    case "Fetch.failRequest": {
      const p = req.params!;
      resolveOrThrow(ctx, p.requestId, {
        kind: "fail",
        errorReason: p.errorReason,
      });
      return {};
    }

    case "Fetch.continueWithAuth":
      return {};

    default:
      return {};
  }
}

function resolveOrThrow(ctx: DispatchCtx, interceptionId: string, action: InterceptAction): void {
  const st = ensureInterception(ctx.connectionId);
  if (!resolveParked(st, interceptionId, action)) {
    throw new Error("Invalid InterceptionId.");
  }
}
