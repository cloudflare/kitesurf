// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { CDPSession } from "@cloudflare/puppeteer";
import { expect, test } from "./harness";
import { setContent } from "./set-content";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

async function families(cdp: CDPSession): Promise<string[]> {
  const dump = await cdp.send("Kitesurf.getFontFaces");
  const targets = "byTarget" in dump ? Object.values(dump.byTarget) : [];
  return targets.flatMap((entry) => {
    if (typeof entry?.json !== "string") return [];
    const faces: unknown = JSON.parse(entry.json);
    if (!Array.isArray(faces)) return [];
    return faces.flatMap((face) =>
      isRecord(face) && typeof face.family === "string" ? [face.family] : [],
    );
  });
}

test("script-inserted Arabic and Chinese text loads its faces", async ({ page, cdpSession }) => {
  await setContent(
    page,
    `<p id=en>Latin only in the markup.</p>
    <script>
      en.insertAdjacentHTML("afterend", "<p lang=ar>هذا النطاق</p><p id=zh>该域名仅用于文档示例</p>");
    </script>`,
  );

  await page.screenshot();
  const loaded = await families(cdpSession);
  expect(loaded).toContain("Noto Sans Arabic");
  expect(loaded.some((f) => f.startsWith("Noto Sans CJK"))).toBe(true);

  const zhWidth = await page.evaluate(() => {
    const zh = document.getElementById("zh");
    if (!zh) return 0;
    const range = document.createRange();
    range.selectNodeContents(zh);
    return range.getBoundingClientRect().width;
  });
  expect(zhWidth).toBeGreaterThanOrEqual(150);
});
