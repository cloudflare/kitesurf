// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { CDPSession, Page } from "@cloudflare/puppeteer";
import type { Protocol } from "devtools-protocol";
import { expect, test } from "./harness";
import { setContent } from "./set-content";

const PAGE = "https://ks.invalid/__fixtures/events.html";

function recordSameDocumentUrls(cdp: CDPSession): string[] {
  const urls: string[] = [];
  cdp.on("Page.navigatedWithinDocument", (e: Protocol.Page.NavigatedWithinDocumentEvent) => {
    urls.push(e.url);
  });
  return urls;
}

async function engineUrls(cdp: CDPSession, page: Page) {
  const history = await cdp.send("Page.getNavigationHistory");
  const { targetInfos } = await cdp.send("Target.getTargets");
  const pageTarget = targetInfos.find((t) => t.type === "page");
  return {
    history: history.entries.map((e) => e.url),
    current: history.entries[history.currentIndex]?.url,
    target: pageTarget?.url,
    frame: page.url(),
  };
}

test("a history update to another origin does not move the engine's page URL", async ({
  page,
  cdpSession,
}) => {
  await page.goto(PAGE, { waitUntil: "load", timeout: 15_000 });
  await cdpSession.send("Page.enable");
  const sameDocumentUrls = recordSameDocumentUrls(cdpSession);

  // A page that replaces URL gets past the in-page origin check, so the engine must check too.
  await page.evaluate(() => {
    const NativeURL = URL;
    globalThis.URL = class extends NativeURL {
      override get origin(): string {
        return "https://ks.invalid";
      }
    };
    try {
      history.pushState({}, "", "https://other.invalid/pushed");
    } catch {}
    try {
      history.replaceState({}, "", "https://other.invalid/replaced");
    } catch {}
    try {
      location.hash = "#moved";
    } catch {}
    history.pushState({}, "", "https://ks.invalid/__fixtures/after");
    globalThis.URL = NativeURL;
  });

  await expect.poll(() => sameDocumentUrls.at(-1)).toBe("https://ks.invalid/__fixtures/after");
  expect(sameDocumentUrls.filter((u) => u.includes("other.invalid"))).toEqual([]);
  const urls = await engineUrls(cdpSession, page);
  expect(urls.history.filter((u) => u.includes("other.invalid"))).toEqual([]);
  expect(urls.current).toBe("https://ks.invalid/__fixtures/after");
  expect(urls.target).toBe("https://ks.invalid/__fixtures/after");
  expect(urls.frame).toBe("https://ks.invalid/__fixtures/after");
});

test("an opaque-origin document changes only its fragment in the engine", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, "<!doctype html><title>opaque</title><p>opaque</p>");
  await cdpSession.send("Page.enable");
  const sameDocumentUrls = recordSameDocumentUrls(cdpSession);

  const start = await page.evaluate(() => {
    const href = location.href;
    try {
      history.pushState({}, "", "data:text/html,elsewhere");
    } catch {}
    history.replaceState({}, "", href + "#back");
    return href;
  });

  await expect.poll(() => sameDocumentUrls.at(-1)).toBe(`${start}#back`);
  expect(sameDocumentUrls.filter((u) => u.includes("elsewhere"))).toEqual([]);
  const urls = await engineUrls(cdpSession, page);
  expect(urls.history.filter((u) => u.includes("elsewhere"))).toEqual([]);
  expect(urls.current).toBe(`${start}#back`);
  expect(urls.target).toBe(`${start}#back`);
});
