// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Large page strings reach boa in chunks; every code unit must arrive, including a surrogate
// pair that straddles a chunk boundary and text that fits Latin-1.
import { expect, test } from "./harness";
import { setContent } from "./set-content";

const CHUNK_UNITS = 1 << 15;

function digest(text: string): [number, number] {
  let hash = 0;
  for (let index = 0; index < text.length; index++) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(index)) | 0;
  }
  return [text.length, hash];
}

function filler(units: number, alphabet: string): string {
  let text = "";
  for (let index = 0; text.length < units; index++) text += alphabet[index % alphabet.length];
  return text.slice(0, units);
}

test("large strings cross into boa unchanged", async ({ page }) => {
  const latin1Text = filler(70_000, "abcé ÿxyz");
  const wideText = filler(CHUNK_UNITS - 1, "aΩb") + "\u{1F600}" + filler(40_000, "ž😀q");
  await setContent(
    page,
    `<!doctype html><div id="latin1">${latin1Text}</div><div id="wide">${wideText}</div>`,
  );

  const pageDigests = await page.evaluate(`
    (() => {
      const digest = (text) => {
        let hash = 0;
        for (let index = 0; index < text.length; index++) {
          hash = (Math.imul(hash, 31) + text.charCodeAt(index)) | 0;
        }
        return [text.length, hash];
      };
      return [
        digest(document.getElementById("latin1").textContent),
        digest(document.getElementById("wide").textContent),
      ];
    })()
  `);
  expect(pageDigests).toEqual([digest(latin1Text), digest(wideText)]);
}, 60_000);
