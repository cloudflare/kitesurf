// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Selects the host egress hook or Worker global fetch for forwarded requests.

export interface ExternalOutbound {
  /** Performs the host's external fetch; request failures propagate to the caller. */
  fetch(request: Request): Promise<Response>;
}

/** Uses the host fetch when configured, otherwise the Worker global `fetch`. */
export function directExternalFetch(
  externalOutbound: ExternalOutbound | undefined,
  request: Request,
): Promise<Response> {
  return externalOutbound ? externalOutbound.fetch(request) : fetch(request);
}
