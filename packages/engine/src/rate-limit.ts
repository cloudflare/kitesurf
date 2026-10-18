// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Builds rate-limit responses and logs limiter failures for engine entry points.

/** Returns a plain-text 429 response with `Retry-After` set in seconds. */
export function rateLimited(message: string, retryAfterSeconds = 10): Response {
  return new Response(message, {
    status: 429,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "retry-after": String(retryAfterSeconds),
    },
  });
}

export function warnLimiterFailure(tier: "account" | "per-ip" | "aggregate", err: unknown): void {
  console.warn(
    `[kitesurf] ${tier} rate limiter failed (failing open):`,
    err instanceof Error ? err.message : String(err),
  );
}

export function isRateLimitedEntrypoint(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}
