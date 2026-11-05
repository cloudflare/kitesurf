// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Large page strings reach boa in chunks; every code unit must arrive, including a surrogate
// pair that straddles a chunk boundary and text that fits Latin-1.
import { expect, test } from "./harness";
import { setContent } from "./set-content";

const CHUNK_UNITS = 1 << 15;

function digest(s: string): [number, number] {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return [s.length, h];
}

function filler(units: number, alphabet: string): string {
  let out = "";
  for (let i = 0; out.length < units; i++) out += alphabet[i % alphabet.length];
  return out.slice(0, units);
}

test("large strings cross into boa unchanged", async ({ page }) => {
  const latin1 = filler(70_000, "abcé ÿxyz");
  const wide = filler(CHUNK_UNITS - 1, "aΩb") + "\u{1F600}" + filler(40_000, "ž😀q");
  await setContent(
    page,
    `<!doctype html><div id="latin1">${latin1}</div><div id="wide">${wide}</div>`,
  );
  const result = await page.evaluate(
    `(() => { const d = (s) => { let h = 0; for (let i = 0; i < s.length; i++) ` +
      `h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0; return [s.length, h]; }; ` +
      `return [d(document.getElementById("latin1").textContent), ` +
      `d(document.getElementById("wide").textContent)]; })()`,
  );
  expect(result).toEqual([digest(latin1), digest(wide)]);
}, 60_000);
