// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("large document print memory attribution", async ({ page, cdpSession }) => {
  const rows = Array.from(
    { length: 1800 },
    (_, i) =>
      `<p>Paragraph ${i}: ${"<span>Some sample inline text with words. </span>".repeat(8)}</p>`,
  ).join("");
  await setContent(
    page,
    `<style>body { font: 16px/20px serif } p { margin: 12px 0 }</style>${rows}`,
  );
  const targetId: unknown = Reflect.get(page.target(), "_targetId");
  if (typeof targetId !== "string") throw new Error("missing target id");
  const before = await cdpSession.send("Kitesurf.getMemoryStats", { targetId });
  const pdf = await cdpSession.send("Page.printToPDF", {});
  const after = await cdpSession.send("Kitesurf.getMemoryStats", { targetId });
  expect(pdf.error).toBeUndefined();
  expect(pdf.data.length).toBeGreaterThan(1000);
  const bytes = Uint8Array.from(atob(pdf.data), (c) => c.charCodeAt(0));
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  expect(hash).toBe("b4d4f27a37d16cbe5592c99b8f8fea6742ea052c828a5cca87056f9e3e80c1a5");
  const beforeBytes = before.bridge?.swapAlloc.wasmBytes;
  const afterBytes = after.bridge?.swapAlloc.wasmBytes;
  expect(beforeBytes).toBeTypeOf("number");
  expect(afterBytes).toBeTypeOf("number");
  if (beforeBytes === undefined || afterBytes === undefined) {
    throw new Error("missing Wasm memory stats");
  }
  // Twice the post-streaming 4.25 MiB growth, rounded up to the next MiB first.
  expect(afterBytes - beforeBytes).toBeLessThan(10 * 1024 * 1024);
}, 120_000);
