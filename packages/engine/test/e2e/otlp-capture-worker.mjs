// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

const payloads = [];

export default {
  /** @returns {Promise<Response>} */
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/traces" && request.method === "POST") {
      payloads.push(await request.json());
      return Response.json({ partialSuccess: {} });
    }
    if (url.pathname === "/spans") {
      const spans = payloads.flatMap((p) =>
        (p.resourceSpans ?? []).flatMap((rs) =>
          (rs.scopeSpans ?? []).flatMap((ss) => ss.spans ?? []),
        ),
      );
      return Response.json(spans);
    }
    if (url.pathname === "/reset") {
      payloads.length = 0;
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  },
};
