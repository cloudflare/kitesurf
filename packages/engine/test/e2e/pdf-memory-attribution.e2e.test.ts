// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { createHash } from "node:crypto";

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const PARAGRAPH_COUNT = 1800;
const INLINE_TEXT = "<span>Some sample inline text with words. </span>".repeat(8);
// Twice the post-streaming 4.25 MiB growth, rounded up to the next MiB first.
const MAX_WASM_GROWTH_BYTES = 10 * 1024 * 1024;
const EXPECTED_PDF_SHA256 = "b4d4f27a37d16cbe5592c99b8f8fea6742ea052c828a5cca87056f9e3e80c1a5";

/** A document long enough that printing it dominates the Wasm heap. */
function largeDocument(): string {
  const rows = Array.from(
    { length: PARAGRAPH_COUNT },
    (_, i) => `<p>Paragraph ${i}: ${INLINE_TEXT}</p>`,
  ).join("");
  return `<style>body { font: 16px/20px serif } p { margin: 12px 0 }</style>${rows}`;
}

const pdfBytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

test("large document print memory attribution", async ({ page, cdpSession }) => {
  await setContent(page, largeDocument());
  const targetId: unknown = Reflect.get(page.target(), "_targetId");
  if (typeof targetId !== "string") throw new Error("missing target id");

  const before = await cdpSession.send("Kitesurf.getMemoryStats", { targetId });
  const pdf = await cdpSession.send("Page.printToPDF", {});
  const after = await cdpSession.send("Kitesurf.getMemoryStats", { targetId });

  expect(pdf.error).toBeUndefined();
  expect(pdf.data.length).toBeGreaterThan(1000);
  expect(createHash("sha256").update(pdfBytes(pdf.data)).digest("hex")).toBe(EXPECTED_PDF_SHA256);

  const beforeBytes = before.bridge?.swapAlloc.wasmBytes;
  const afterBytes = after.bridge?.swapAlloc.wasmBytes;
  expect(beforeBytes).toBeTypeOf("number");
  expect(afterBytes).toBeTypeOf("number");
  if (beforeBytes === undefined || afterBytes === undefined) {
    throw new Error("missing Wasm memory stats");
  }
  expect(afterBytes - beforeBytes).toBeLessThan(MAX_WASM_GROWTH_BYTES);
}, 120_000);
