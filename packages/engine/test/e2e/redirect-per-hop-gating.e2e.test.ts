// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";

const GATE = "https://ks.invalid/__fixtures/redirect-gate.html";
const ECHO = "/__fixtures/echo-headers.html";
const HOP = "https://ks.invalid/__fixtures/loud-redirect";

const BLOCKED_HOP_ORIGIN = "https://ks-other.invalid";

async function redirectedFetchStatus(page: Page): Promise<number | string> {
  const to = encodeURIComponent(`${BLOCKED_HOP_ORIGIN}/__fixtures/echo-headers.json`);
  return (await page.evaluate(`
    fetch("/__fixtures/loud-redirect?to=${to}")
      .then((r) => r.status)
      .catch((e) => "THREW:" + String(e))
  `)) as number | string;
}

test("an outbound filter is applied to a redirect hop, not only the entry URL", async ({
  page,
  cdpSession,
}) => {
  await page.goto(GATE, { waitUntil: "domcontentloaded" });
  expect(await redirectedFetchStatus(page), "the unfiltered redirect must succeed").toBe(200);

  // The entry URL is on ks.invalid, so only the redirect target matches.
  await cdpSession.send("Kitesurf.setOutboundFilters", {
    rejectRequestPattern: ["^https://ks-other\\.invalid/"],
  });
  expect(await redirectedFetchStatus(page)).not.toBe(200);
});

test("a same-origin child frame lands on the post-redirect URL", async ({ page }) => {
  const session = await page.target().createCDPSession();
  await session.send("Page.enable");
  await page.goto(GATE, { waitUntil: "domcontentloaded" });

  const tree = (await session.send("Page.getFrameTree")) as {
    frameTree: {
      childFrames?: { frame: { url: string; securityOrigin: string } }[];
    };
  };
  const child = tree.frameTree.childFrames?.[0]?.frame;
  expect(child, "the fixture's iframe produced no child frame").toBeDefined();
  expect(child?.url).toBe("https://ks.invalid/__fixtures/iframe-child.html");
  expect(child?.securityOrigin).toBe("https://ks.invalid");
});

async function docHeadersAfterHopTo(
  page: Page,
  landingOrigin: string,
): Promise<Record<string, string>> {
  await page.setExtraHTTPHeaders({ Authorization: "Bearer ks-hop-secret" });
  const to = `${landingOrigin}${ECHO}`;
  await page.goto(`${HOP}?to=${encodeURIComponent(to)}`, {
    waitUntil: "domcontentloaded",
  });
  const raw = (await page.evaluate("JSON.stringify(globalThis.__ks_doc_headers)")) as string;
  return JSON.parse(raw) as Record<string, string>;
}

// Fetch §http-redirect-fetch removes Authorization when a redirect changes origin.
test("Authorization is dropped when a navigate hop changes origin", async ({ page }) => {
  const echoed = await docHeadersAfterHopTo(page, "https://ks-other.invalid");
  expect(
    echoed.authorization,
    "Authorization survived a cross-origin redirect hop",
  ).toBeUndefined();
});

test("Authorization survives a same-origin navigate hop", async ({ page }) => {
  const echoed = await docHeadersAfterHopTo(page, "https://ks.invalid");
  expect(echoed.authorization).toBe("Bearer ks-hop-secret");
});

test("a client-set Cookie is dropped when a navigate hop changes origin", async ({ page }) => {
  await page.setExtraHTTPHeaders({ Cookie: "sid=ks-hop-secret" });
  const to = `https://ks-other.invalid${ECHO}`;
  await page.goto(`${HOP}?to=${encodeURIComponent(to)}`, {
    waitUntil: "domcontentloaded",
  });
  const raw = (await page.evaluate("JSON.stringify(globalThis.__ks_doc_headers)")) as string;
  const echoed = JSON.parse(raw) as Record<string, string>;
  expect(echoed.cookie, "a client-set Cookie survived a cross-origin redirect hop").toBeUndefined();
});

test("a cross-site navigate hop withholds Strict cookies but keeps Lax", async ({ page }) => {
  const session = await page.target().createCDPSession();
  await session.send("Network.enable");
  const landing = "https://ks-other.invalid/";
  for (const [name, sameSite] of [
    ["strict", "Strict"],
    ["lax", "Lax"],
  ] as const) {
    await session.send("Network.setCookie", {
      name,
      value: "1",
      url: landing,
      sameSite,
    });
  }

  const to = `https://ks-other.invalid${ECHO}`;
  await page.goto(`${HOP}?to=${encodeURIComponent(to)}`, {
    waitUntil: "domcontentloaded",
  });
  const raw = (await page.evaluate("JSON.stringify(globalThis.__ks_doc_headers)")) as string;
  const echoed = JSON.parse(raw) as Record<string, string>;
  expect(echoed.cookie ?? "").toContain("lax=1");
  expect(
    echoed.cookie ?? "",
    "SameSite=Strict attached to a navigation arriving from another site",
  ).not.toContain("strict=1");
});

test("a same-site navigate hop keeps Strict cookies", async ({ page }) => {
  const session = await page.target().createCDPSession();
  await session.send("Network.enable");
  await session.send("Network.setCookie", {
    name: "strict",
    value: "1",
    url: "https://ks.invalid/",
    sameSite: "Strict",
  });

  const to = `https://ks.invalid${ECHO}`;
  await page.goto(`${HOP}?to=${encodeURIComponent(to)}`, {
    waitUntil: "domcontentloaded",
  });
  const raw = (await page.evaluate("JSON.stringify(globalThis.__ks_doc_headers)")) as string;
  const echoed = JSON.parse(raw) as Record<string, string>;
  expect(echoed.cookie ?? "").toContain("strict=1");
});

test("a same-origin iframe that redirects off-origin adopts the new origin", async ({ page }) => {
  const session = await page.target().createCDPSession();
  await session.send("Page.enable");
  await page.goto("https://ks.invalid/__fixtures/redirect-gate-xo.html", {
    waitUntil: "domcontentloaded",
  });

  const tree = (await session.send("Page.getFrameTree")) as {
    frameTree: {
      childFrames?: { frame: { url: string; securityOrigin: string } }[];
    };
  };
  const child = tree.frameTree.childFrames?.[0]?.frame;
  expect(child, "the fixture's iframe produced no child frame").toBeDefined();
  expect(child?.url).toBe("https://ks-other.invalid/__fixtures/lifecycle.html");
  expect(child?.securityOrigin).toBe("https://ks-other.invalid");
});

test("a depth-2 frame that redirects off-origin still gets a realm", async ({ page }) => {
  const session = await page.target().createCDPSession();
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  const origins: string[] = [];
  const realmFrameIds = new Set<string>();
  const stoppedFrameIds = new Set<string>();
  session.on("Runtime.executionContextCreated", (p: unknown) => {
    const e = p as {
      context?: {
        origin?: unknown;
        auxData?: { frameId?: unknown };
      };
    };
    if (typeof e.context?.origin === "string") {
      origins.push(e.context.origin);
      if (
        e.context.origin === "https://ks-other.invalid" &&
        typeof e.context.auxData?.frameId === "string"
      ) {
        realmFrameIds.add(e.context.auxData.frameId);
      }
    }
  });
  session.on("Page.frameStoppedLoading", (p: unknown) => {
    const e = p as { frameId?: unknown };
    if (typeof e.frameId === "string") stoppedFrameIds.add(e.frameId);
  });

  await page.goto("https://ks.invalid/__fixtures/redirect-gate-deep.html", {
    waitUntil: "domcontentloaded",
  });
  let realmObserved = false;
  try {
    await expect
      .poll(() => origins.includes("https://ks-other.invalid"), {
        timeout: 15_000,
      })
      .toBe(true);
    realmObserved = true;
  } catch {}
  if (realmObserved) {
    await expect
      .poll(() => [...realmFrameIds].some((id) => stoppedFrameIds.has(id)), { timeout: 15_000 })
      .toBe(true);
  }

  const tree = (await session.send("Page.getFrameTree")) as {
    frameTree: {
      childFrames?: {
        frame: { url: string; securityOrigin: string };
        childFrames?: { frame: { url: string; securityOrigin: string } }[];
      }[];
    };
  };
  const grandchild = tree.frameTree.childFrames?.[0]?.childFrames?.[0]?.frame;
  expect(grandchild, "no depth-2 frame in the tree").toBeDefined();
  expect(grandchild?.securityOrigin).toBe("https://ks-other.invalid");

  expect(origins, `no ks-other realm; saw ${JSON.stringify(origins)}`).toContain(
    "https://ks-other.invalid",
  );
});
