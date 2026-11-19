// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Child-frame isolates announce a default main-world context so frame.evaluate() resolves.

import { expect, test } from "./harness";

const HOST_URL =
  "https://ks.invalid/__fixtures/sandbox-host.html?src=/__fixtures/sandbox-child.html";
const CHILD_SUFFIX = "/__fixtures/sandbox-child.html";

test("frame.evaluate() resolves in a same-origin iframe with an isolate", async ({
  page,
  cdpSession,
}) => {
  await page.goto(HOST_URL, { waitUntil: "load", timeout: 30_000 });

  const child = page
    .frames()
    .find((frame) => frame !== page.mainFrame() && frame.url().endsWith(CHILD_SUFFIX));
  if (!child) throw new Error("child frame missing from page.frames()");

  const childText = await child.evaluate(() => ({
    markup: document.querySelector("#markup")?.textContent ?? null,
    url: location.href,
  }));
  expect(childText).toEqual({
    markup: "sandbox child markup",
    url: "https://ks.invalid/__fixtures/sandbox-child.html",
  });

  const { frameTree } = await cdpSession.send("Page.getFrameTree");
  const childTree = frameTree.childFrames?.find((entry) => entry.frame.url.endsWith(CHILD_SUFFIX));
  if (!childTree) throw new Error("child frame missing from Page.getFrameTree");
  const childFrameId = childTree.frame.id;

  const replayed: Array<{ id: number; frameId?: string; isDefault?: boolean }> = [];
  cdpSession.on("Runtime.executionContextCreated", (event) => {
    const aux = event.context.auxData as { frameId?: string; isDefault?: boolean } | undefined;
    replayed.push({ id: event.context.id, frameId: aux?.frameId, isDefault: aux?.isDefault });
  });
  await cdpSession.send("Runtime.enable");
  expect(replayed.find((entry) => entry.frameId === childFrameId && entry.isDefault)).toBeTruthy();
}, 120_000);
