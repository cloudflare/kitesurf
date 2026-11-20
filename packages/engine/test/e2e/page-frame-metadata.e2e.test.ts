// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Protocol } from "devtools-protocol";
import { expect, test } from "./harness";

const URL_BASE = process.env.KITESURF_FIXTURE_BASE ?? "http://127.0.0.1:8787";

function withoutIds(frame: Protocol.Page.Frame): Omit<Protocol.Page.Frame, "id" | "loaderId"> {
  const { id: _id, loaderId: _loaderId, ...rest } = frame;
  return rest;
}

// Expected frames follow Chrome 152's Page.getFrameTree for the same documents on a loopback host,
// with frame and loader ids removed.
test("Page.getFrameTree reports Chrome's frame metadata", async ({ page }) => {
  const session = await page.target().createCDPSession();

  const initial = await session.send("Page.getFrameTree");
  expect(withoutIds(initial.frameTree.frame)).toEqual({
    url: "about:blank",
    domainAndRegistry: "",
    securityOrigin: "://",
    securityOriginDetails: { isLocalhost: false },
    mimeType: "text/html",
    adFrameStatus: { adFrameType: "none" },
    secureContextType: "InsecureScheme",
    crossOriginIsolatedContextType: "NotIsolated",
    gatedAPIFeatures: [],
  });

  await page.goto(`${URL_BASE}/__fixtures/iframe-host.html#top`, { timeout: 15_000 });
  await page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.id = "by-id";
    document.body.append(frame);
  });
  await expect
    .poll(async () => (await session.send("Page.getFrameTree")).frameTree.childFrames?.length)
    .toBe(3);

  const { frameTree } = await session.send("Page.getFrameTree");
  const origin = new URL(URL_BASE).origin;
  const childBase = {
    parentId: frameTree.frame.id,
    mimeType: "text/html",
    adFrameStatus: { adFrameType: "none", explanations: [] },
    secureContextType: "SecureLocalhost",
    crossOriginIsolatedContextType: "NotIsolated",
    gatedAPIFeatures: [],
  };
  const blankChild = {
    ...childBase,
    url: "about:blank",
    domainAndRegistry: "",
    securityOrigin: "://",
    securityOriginDetails: { isLocalhost: false },
  };
  expect(withoutIds(frameTree.frame)).toEqual({
    url: `${origin}/__fixtures/iframe-host.html`,
    urlFragment: "#top",
    domainAndRegistry: "",
    securityOrigin: origin,
    securityOriginDetails: { isLocalhost: true },
    mimeType: "text/html",
    adFrameStatus: { adFrameType: "none" },
    secureContextType: "SecureLocalhost",
    crossOriginIsolatedContextType: "NotIsolated",
    gatedAPIFeatures: [],
  });
  expect(frameTree.childFrames?.map((child) => withoutIds(child.frame))).toEqual([
    {
      ...childBase,
      name: "child-a",
      url: `${origin}/__fixtures/iframe-child.html`,
      domainAndRegistry: "",
      securityOrigin: origin,
      securityOriginDetails: { isLocalhost: true },
    },
    { ...blankChild, name: "child-b" },
    { ...blankChild, name: "by-id" },
  ]);
});

// Puppeteer asks every attached frame session for its tree, so a child frame must read the same
// there as in its parent's tree, and as Chrome reports a cross-site frame on its own session.
test("a child frame's own session reports the same Page.Frame", async ({ page, cdpSession }) => {
  // The fixture's iframe is on 127.0.0.1, so loading the host from localhost makes that iframe a
  // cross-site frame, as in the Chrome reference.
  await page.goto("http://localhost:8787/__fixtures/oopif-host-quads.html", { timeout: 60_000 });
  const childOrigin = "http://127.0.0.1:8787";
  type TargetInfo = { targetId: string; type: string; url: string };
  let iframeTarget: TargetInfo | undefined;
  await expect
    .poll(
      async () => {
        const { targetInfos } = (await cdpSession.send("Target.getTargets")) as {
          targetInfos: TargetInfo[];
        };
        iframeTarget = targetInfos.find(
          (info) => info.type === "iframe" && info.url.startsWith(childOrigin),
        );
        return iframeTarget !== undefined;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  if (!iframeTarget) throw new Error("iframe target missing");
  const { sessionId } = await cdpSession.send("Target.attachToTarget", {
    targetId: iframeTarget.targetId,
    flatten: true,
  });
  const childSession = cdpSession.connection()?.session(sessionId);
  if (!childSession) throw new Error(`no session ${sessionId} on the connection`);

  const own = (await childSession.send("Page.getFrameTree")).frameTree;
  const { frameTree } = await cdpSession.send("Page.getFrameTree");
  const inParent = frameTree.childFrames?.find((child) => child.frame.id === own.frame.id);
  expect(own).toEqual(inParent);
  expect("childFrames" in own).toBe(false);
  expect(withoutIds(own.frame)).toEqual({
    parentId: frameTree.frame.id,
    name: "",
    url: `${childOrigin}/__fixtures/oopif-child-quads.html`,
    domainAndRegistry: "",
    securityOrigin: childOrigin,
    securityOriginDetails: { isLocalhost: true },
    mimeType: "text/html",
    adFrameStatus: { adFrameType: "none", explanations: [] },
    secureContextType: "SecureLocalhost",
    crossOriginIsolatedContextType: "NotIsolatedFeatureDisabled",
    gatedAPIFeatures: [],
  });
});
