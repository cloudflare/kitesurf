// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const NEXT = "https://ks-other.invalid/__fixtures/slow-document.html?ms=2000";

test("an iframe the outgoing document adds during a navigate is not a frame of the next one", async ({
  page,
  cdpSession,
}) => {
  await setContent(
    page,
    `<!doctype html><title>outgoing</title><script>
      setTimeout(() => {
        location.href = ${JSON.stringify(NEXT)};
        setTimeout(() => {
          const f = document.createElement("iframe");
          f.src = "https://ks.invalid/__fixtures/lifecycle.html";
          document.body.appendChild(f);
        }, 300);
      }, 500);
    </script>`,
  );
  await cdpSession.send("Page.enable");
  const attached: string[] = [];
  cdpSession.on("Page.frameAttached", (e) => attached.push(e.frameId));

  await expect.poll(() => page.url(), { timeout: 15_000 }).toBe(NEXT);
  await expect
    .poll(() => page.evaluate(() => document.title), { timeout: 15_000 })
    .toBe("Slow document");

  const { frameTree } = await cdpSession.send("Page.getFrameTree");
  expect(frameTree.frame.url).toBe(NEXT);
  expect(frameTree.childFrames ?? []).toEqual([]);
  expect(attached).toEqual([]);
}, 30_000);
