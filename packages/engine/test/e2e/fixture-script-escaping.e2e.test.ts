// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A caller-controlled `</script>` must stay data: JSON.stringify leaves `<` unescaped, so an
// unescaped fixture value would end the script element.

import { env } from "cloudflare:test";
import { expect, test } from "./harness";

const PAYLOAD = `</script><img src=x onerror="globalThis.__pwned=1">`;

test("a header value cannot break out of the echo-headers script", async () => {
  const resp = await env.ENGINE.fetch("https://ks.invalid/__fixtures/echo-headers.html", {
    headers: { "x-ks-probe": PAYLOAD },
  });
  expect(resp.status).toBe(200);
  const body = await resp.text();

  expect(body).toContain("x-ks-probe");

  const opens = body.match(/<script/gi) ?? [];
  const closes = body.match(/<\/script/gi) ?? [];
  expect(closes.length).toBe(opens.length);

  expect(body).not.toContain("<img");

  const script = body.slice(body.indexOf("__ks_doc_headers"));
  expect(script).toContain("\\u003c/script>");
});
