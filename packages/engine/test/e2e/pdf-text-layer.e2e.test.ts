// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { inflateSync } from "node:zlib";

import { expect, test } from "./harness";
import { setContent } from "./set-content";

/** Every stream of the PDF, inflated where it is Flate-compressed, joined as Latin-1. */
function pdfStreams(pdf: Buffer): string {
  const out: string[] = [];
  let at = 0;
  for (;;) {
    const start = pdf.indexOf("stream\n", at, "latin1");
    if (start < 0) break;
    const end = pdf.indexOf("endstream", start, "latin1");
    if (end < 0) break;
    const raw = pdf.subarray(start + "stream\n".length, end);
    let body: Buffer;
    try {
      body = inflateSync(raw);
    } catch {
      body = raw;
    }
    out.push(body.toString("latin1"));
    at = end + "endstream".length;
  }
  return out.join("\n");
}

test("printToPDF maps shaped glyphs back to the text they show", async ({ page, cdpSession }) => {
  await setContent(
    page,
    `<meta charset=utf-8>
     <p>مرحبا بالعالم</p>
     <p>מחיר 123 ש״ח ABC</p>
     <p>一人大文日</p>
     <p>office fine</p>`,
  );
  const reply = (await cdpSession.send("Page.printToPDF", {})) as {
    data: string;
  };
  const streams = pdfStreams(Buffer.from(reply.data, "base64"));
  const unicode = (hex: string) => streams.includes(`<${hex}>`);

  // Joined Arabic forms map to the letters, not to presentation forms (U+FB00-FDFF and
  // U+FE70-FEFF, which also hold the Latin ligatures) or nothing.
  expect(unicode("0628"), "ب").toBe(true);
  expect(streams).not.toMatch(/<(?:F[B-D][0-9A-F]|FE[7-9A-F])[0-9A-F]>/);
  // CJK glyphs shared with Kangxi radicals map to the ideographs.
  for (const hex of ["4E00", "4EBA", "5927", "6587", "65E5"]) expect(unicode(hex), hex).toBe(true);
  expect(streams).not.toMatch(/<2F[0-9A-D][0-9A-F]>/);
  // A ligature glyph maps to all of its letters.
  expect(unicode("006600660069"), "ffi").toBe(true);
  expect(unicode("00660069"), "fi").toBe(true);
  // Right-to-left runs are drawn in visual order and marked so.
  expect(streams).toContain("/ReversedChars");
});
