// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A child response is committed only when its terminal frame-ancestors/X-Frame-Options policy
// admits every trusted ancestor. Blocked documents keep the frame but never expose protected
// markup or run their scripts.

import type { CDPSession, Page } from "@cloudflare/puppeteer";
import { expect, test } from "./harness";

const HOST = "https://ks.invalid/__fixtures/frame-policy-host.html";
const SAME_CHILD = "/__fixtures/frame-policy-child.html";
const CROSS_CHILD = "https://ks-other.invalid/__fixtures/frame-policy-child.html";

function urlWith(base: string, params: Record<string, string | undefined>): string {
  const url = new URL(base, HOST);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.href;
}

async function messages(page: Page): Promise<Array<{ data: unknown; origin: string }>> {
  return page.evaluate(() => JSON.parse(JSON.stringify(Reflect.get(window, "__msgs"))));
}

async function waitForFrameLoad(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "__frameLoaded") === true), {
      timeout: 20_000,
    })
    .toBe(true);
}

async function sameOriginSecret(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const frame = document.getElementById("f") as HTMLIFrameElement | null;
    try {
      return frame?.contentDocument?.getElementById("secret")?.textContent ?? null;
    } catch {
      return null;
    }
  });
}

async function frameUrls(cdp: CDPSession): Promise<string[]> {
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const urls: string[] = [];
  const walk = (node: typeof frameTree): void => {
    urls.push(node.frame.url);
    for (const child of node.childFrames ?? []) walk(child);
  };
  walk(frameTree);
  return urls;
}

async function fixtureHits(page: Page, marker: string): Promise<number> {
  return page.evaluate(async (value) => {
    const response = await fetch(
      `/__fixtures/frame-policy-hits?marker=${encodeURIComponent(value)}`,
    );
    return ((await response.json()) as { hits: number }).hits;
  }, marker);
}

test("a cross-origin child commits only when its frame-ancestors admits the top origin", async ({
  page,
  cdpSession,
}) => {
  const rows: Array<{ marker: string; csp: string; allowed: boolean }> = [
    { marker: "oopif-allow", csp: "frame-ancestors https://ks.invalid", allowed: true },
    { marker: "oopif-none", csp: "frame-ancestors 'none'", allowed: false },
    { marker: "oopif-star", csp: "frame-ancestors *", allowed: true },
  ];
  for (const row of rows) {
    await page.goto(
      urlWith(HOST, {
        child: urlWith(CROSS_CHILD, { marker: row.marker, csp: row.csp }),
      }),
      { waitUntil: "load", timeout: 30_000 },
    );
    await waitForFrameLoad(page);
    const received = (await messages(page)).map((message) => message.data);
    if (row.allowed) {
      await expect
        .poll(async () => (await messages(page)).map((m) => m.data))
        .toContain(`ran:${row.marker}`);
    } else {
      await expect.poll(() => fixtureHits(page, row.marker), { timeout: 20_000 }).toBe(1);
      expect(received).not.toContain(`ran:${row.marker}`);
      // The frame stays in the tree; a policy refusal is not a detach.
      expect((await frameUrls(cdpSession)).some((url) => url.includes(row.marker))).toBe(true);
    }
  }
}, 120_000);

test("same-origin X-Frame-Options and CSP rows", async ({ page }) => {
  const rows: Array<{
    marker: string;
    xfo?: string;
    csp?: string;
    cspReportOnly?: string;
    allowed: boolean;
  }> = [
    { marker: "xfo-deny", xfo: "DENY", allowed: false },
    { marker: "xfo-same", xfo: "SAMEORIGIN", allowed: true },
    { marker: "xfo-comma", xfo: "SAMEORIGIN,", allowed: false },
    { marker: "xfo-duplicate", xfo: "DENY, DENY", allowed: false },
    { marker: "xfo-conflict", xfo: "SAMEORIGIN, DENY", allowed: false },
    { marker: "xfo-allow-from", xfo: "ALLOW-FROM https://example.com", allowed: true },
    { marker: "xfo-empty", xfo: ",", allowed: true },
    {
      marker: "csp-precedence",
      xfo: "DENY",
      csp: "frame-ancestors https://ks.invalid",
      allowed: true,
    },
    { marker: "report-only", cspReportOnly: "frame-ancestors 'none'", allowed: true },
  ];
  for (const row of rows) {
    await page.goto(
      urlWith(HOST, {
        child: urlWith(SAME_CHILD, {
          marker: row.marker,
          xfo: row.xfo,
          csp: row.csp,
          cspReportOnly: row.cspReportOnly,
          script: "0",
        }),
      }),
      { waitUntil: "load", timeout: 30_000 },
    );
    await waitForFrameLoad(page);
    const secret = await sameOriginSecret(page);
    if (row.allowed) {
      expect(secret).toContain(row.marker);
    } else {
      expect(secret).toBeNull();
    }
  }
}, 180_000);

test("the terminal response after a redirect decides embedding", async ({ page }) => {
  const rows: Array<{ marker: string; redirect?: string; xfo?: string; allowed: boolean }> = [
    { marker: "redirect-deny", redirect: "1", xfo: "DENY", allowed: false },
    { marker: "redirect-allow", redirect: "1", allowed: true },
  ];
  for (const row of rows) {
    await page.goto(
      urlWith(HOST, {
        child: urlWith(SAME_CHILD, {
          marker: row.marker,
          redirect: row.redirect,
          xfo: row.xfo,
          script: "0",
        }),
      }),
      { waitUntil: "load", timeout: 30_000 },
    );
    await waitForFrameLoad(page);
    const secret = await sameOriginSecret(page);
    if (row.allowed) {
      expect(secret).toContain(row.marker);
    } else {
      expect(secret).toBeNull();
    }
  }
}, 90_000);

test("a dynamically inserted same-origin frame is replaced by a blank document", async ({
  page,
}) => {
  const rows: Array<{ marker: string; xfo?: string; allowed: boolean }> = [
    { marker: "dynamic-deny", xfo: "DENY", allowed: false },
    { marker: "dynamic-allow", allowed: true },
  ];
  for (const row of rows) {
    await page.goto(
      urlWith(HOST, {
        dynamic: "1",
        child: urlWith(SAME_CHILD, { marker: row.marker, xfo: row.xfo }),
      }),
      { waitUntil: "load", timeout: 30_000 },
    );
    await waitForFrameLoad(page);
    const secret = await sameOriginSecret(page);
    if (row.allowed) {
      expect(secret).toContain(row.marker);
    } else {
      expect(secret).toBeNull();
    }
  }
}, 90_000);
