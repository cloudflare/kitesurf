// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { CDPSession } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";

const BIG_BYTES = 900_000;
const SMALL_BYTES = 4_096;
const url = (bytes: number, seed: number): string =>
  `https://ks.invalid/__fixtures/chatty-json?bytes=${bytes}&seed=${seed}`;

interface Fetched {
  status: number;
  length: number;
  head: string;
  tail: string;
  parsedSeed: number;
}

test("an oversize text body streams through whole; a small one is still captured", async ({
  page,
  cdpSession,
}) => {
  const seen = new Map<string, string>();
  (cdpSession as CDPSession).on("Network.responseReceived", (p: unknown) => {
    const ev = p as { requestId?: string; response?: { url?: string } };
    if (ev.requestId && ev.response?.url) seen.set(ev.response.url, ev.requestId);
  });
  await cdpSession.send("Network.enable");

  await page.goto("https://ks.invalid/__fixtures/lifecycle.html", {
    waitUntil: "load",
    timeout: 60000,
  });

  const fetchBody = async (target: string): Promise<Fetched> =>
    (await page.evaluate(async (u: string) => {
      const r = await fetch(u);
      const text = await r.text();
      return {
        status: r.status,
        length: text.length,
        head: text.slice(0, 12),
        tail: text.slice(-2),
        parsedSeed: JSON.parse(text).seed as number,
      };
    }, target)) as Fetched;

  const big = await fetchBody(url(BIG_BYTES, 7));
  expect(big.status).toBe(200);
  expect(big.length, "the page must get every byte, not the 256 KB we were willing to retain").toBe(
    BIG_BYTES,
  );
  expect(big.head).toBe('{"seed":7,"f');
  expect(big.tail).toBe('"}');
  expect(big.parsedSeed).toBe(7);

  const small = await fetchBody(url(SMALL_BYTES, 8));
  expect(small.length).toBe(SMALL_BYTES);
  expect(small.parsedSeed).toBe(8);

  const bodyOf = async (target: string): Promise<string> => {
    const requestId = seen.get(target);
    expect(requestId, `Network.responseReceived seen for ${target}`).toBeTruthy();
    const reply = (await cdpSession.send("Network.getResponseBody", {
      requestId: requestId!,
    })) as { body?: string };
    return reply.body ?? "";
  };

  expect(
    await bodyOf(url(SMALL_BYTES, 8)),
    "a body under the cap stays readable from the Network panel",
  ).toHaveLength(SMALL_BYTES);
  expect(await bodyOf(url(BIG_BYTES, 7)), "a body past the cap must not be retained").toBe("");
});
