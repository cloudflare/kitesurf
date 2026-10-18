// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("generateKey error shapes match the WebCrypto spec", async ({ page }) => {
  await setContent(
    page,
    `<script>
      const errName = (p) => p.then(
        () => "no-throw",
        (e) => e.name,
      );
      Promise.all([
        errName(crypto.subtle.generateKey({}, true, ["sign"])),
        errName(crypto.subtle.generateKey("AES-CMAC", true, ["sign"])),
        errName(crypto.subtle.generateKey({ name: "HMAC", hash: "MD5" }, true, ["sign"])),
        errName(crypto.subtle.generateKey({ name: "RSA-PSS", hash: "SHA", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign"])),
        // Valid input must still produce a native CryptoKey.
        crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"])
          .then((k) => k.constructor.name + ":" + k.algorithm.name),
      ]).then((r) => { document.title = JSON.stringify(r); });
    </` + `script>`,
  );
  await page.waitForFunction("document.title.length > 0");
  const r = JSON.parse(String(await page.evaluate("document.title")));
  expect(r).toEqual([
    "TypeError",
    "NotSupportedError",
    "NotSupportedError",
    "NotSupportedError",
    "CryptoKey:AES-GCM",
  ]);
}, 120_000);
