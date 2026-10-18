// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("picture-srcset-demo", async ({ page }) => {
  const PNG_8 =
    "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC";
  const PNG_16 =
    "iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAIAAAAC64paAAAAGUlEQVR4nGNg+M9APhrVPKp5VPOo5oHVDACjP46AujfqtQAAAABJRU5ErkJggg==";
  const PNG_30 =
    "iVBORw0KGgoAAAANSUhEUgAAAB4AAAAeCAIAAAC0Ujn1AAAAJUlEQVR4nO3MsQkAAAjAsP7/tP4guAUyp5o3arVarVar1Wr12QK3QYCq0nt/LwAAAABJRU5ErkJggg==";
  const PNG_32 = PNG_30;

  function dataUrl(b64) {
    return `data:image/png;base64,${b64}`;
  }

  await page.goto("https://example.com/__fixtures/inline-script.html", { timeout: 25000 });
  await new Promise((r) => setTimeout(r, 400));

  await page.evaluate(
    ({ p8, p16, p32 }) => {
      document.body.innerHTML = `
      <div id="root" style="padding:20px;background:white">
        <p style="float:left"><img id="t1" src="${p8}"></p>
        <p style="clear:both"></p>
        <p style="float:left"><img id="t2" srcset="${p8} 100w, ${p32} 400w, ${p16} 200w"></p>
        <p style="clear:both"></p>
        <p style="float:left"><picture>
          <source type="image/png" srcset="${p32}">
          <img id="t3" src="${p8}">
        </picture></p>
        <p style="clear:both"></p>
        <p style="float:left"><picture>
          <source type="image/avif" srcset="${p16}">
          <source type="image/png" srcset="${p32}">
          <img id="t4" src="${p8}">
        </picture></p>
        <p style="clear:both"></p>
        <p style="float:left"><picture>
          <source type="image/png" srcset="${p32} 960w">
          <img id="t5" src="${p8}" srcset="${p16} 480w">
        </picture></p>
        <p style="clear:both"></p>
      </div>
    `;
    },
    { p8: dataUrl(PNG_8), p16: dataUrl(PNG_16), p32: dataUrl(PNG_32) },
  );

  await page
    .waitForFunction(
      () =>
        ["t1", "t2", "t3", "t4", "t5"].every((id) => {
          const el = document.getElementById(id);
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }),
      { timeout: 15000 },
    )
    .catch(() => {});

  const probe = await page.evaluate(() => {
    function size(id) {
      const el = document.getElementById(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    }
    return {
      t1: size("t1"),
      t2: size("t2"),
      t3: size("t3"),
      t4: size("t4"),
      t5: size("t5"),
    };
  });
  console.log("[srcset] rendered intrinsic sizes:", probe);

  expect(probe.t1, "t1 plain src loads PNG_8 (10x10)").toStrictEqual({ w: 10, h: 10 });
  expect(probe.t2, "t2 srcset largest-width loads PNG_32 (30x30)").toStrictEqual({ w: 30, h: 30 });
  expect(probe.t3, "t3 picture source beats img src").toStrictEqual({ w: 30, h: 30 });
  expect(probe.t4, "t4 avif skipped, png source picked").toStrictEqual({ w: 30, h: 30 });
  expect(probe.t5, "t5 picture source beats img srcset").toStrictEqual({ w: 30, h: 30 });

  await page.evaluate((p16) => {
    const pic = document.getElementById("t3").parentElement;
    const src = pic.querySelector("source");
    src.setAttribute("srcset", p16);
  }, dataUrl(PNG_16));
  await page
    .waitForFunction(
      () => {
        const r = document.getElementById("t3").getBoundingClientRect();
        return Math.round(r.width) !== 30 || Math.round(r.height) !== 30;
      },
      { timeout: 15000 },
    )
    .catch(() => {});

  const post = await page.evaluate(() => {
    const el = document.getElementById("t3");
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  console.log("[srcset] t3 after <source> srcset swap:", post);
  expect(
    post,
    "t3 reloads when sibling <source> srcset mutates (now PNG_16 = 20x20)",
  ).toStrictEqual({ w: 20, h: 20 });
});
