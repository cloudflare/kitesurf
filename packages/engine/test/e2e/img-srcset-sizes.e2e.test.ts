// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Image candidate selection must honour the `sizes` attribute and `<picture><source media>`.
// https://html.spec.whatwg.org/multipage/images.html#selecting-an-image-source-from-the-source-set
import { expect, test } from "./harness";
import { setContent } from "./set-content";

const PNG_10 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC";
const PNG_20 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAIAAAAC64paAAAAGUlEQVR4nGNg+M9APhrVPKp5VPOo5oHVDACjP46AujfqtQAAAABJRU5ErkJggg==";
const PNG_30 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAB4AAAAeCAIAAAC0Ujn1AAAAJUlEQVR4nO3MsQkAAAjAsP7/tP4guAUyp5o3arVarVar1Wr12QK3QYCq0nt/LwAAAABJRU5ErkJggg==";

test("srcset selects the smallest candidate covering sizes and skips non-matching picture media", async ({
  page,
}) => {
  const html = `<!doctype html><html><body>
    <img id="fixed-sizes" srcset="${PNG_10} 200w, ${PNG_20} 500w, ${PNG_30} 1200w" sizes="400px">
    <img id="vw-sizes" srcset="${PNG_10} 400w, ${PNG_20} 800w, ${PNG_30} 1600w" sizes="50vw">
    <img id="media-sizes" srcset="${PNG_10} 200w, ${PNG_20} 500w, ${PNG_30} 1200w" sizes="(max-width: 600px) 150px, 1000px">
    <img id="default-100vw" srcset="${PNG_10} 600w, ${PNG_20} 1400w, ${PNG_30} 2000w">
    <picture>
      <source media="(max-width: 500px)" srcset="${PNG_10}">
      <source media="(min-width: 700px)" srcset="${PNG_20}">
      <img id="pic-media" src="${PNG_30}">
    </picture>
  </body></html>`;
  await setContent(page, html, { waitUntil: "load" });
  const widths = await page.evaluate(() => ({
    fixedSizes: (document.getElementById("fixed-sizes") as HTMLImageElement).naturalWidth,
    vwSizes: (document.getElementById("vw-sizes") as HTMLImageElement).naturalWidth,
    mediaSizes: (document.getElementById("media-sizes") as HTMLImageElement).naturalWidth,
    default100vw: (document.getElementById("default-100vw") as HTMLImageElement).naturalWidth,
    picMedia: (document.getElementById("pic-media") as HTMLImageElement).naturalWidth,
  }));

  expect(widths).toEqual({
    // 400px slot -> smallest >= 400w is 500w (PNG_20 = 20px)
    fixedSizes: 20,
    // 50vw of 1280px = 640px -> smallest >= 640w is 800w (PNG_20 = 20px)
    vwSizes: 20,
    // viewport 1280 > 600 -> fallback 1000px -> smallest >= 1000w is 1200w (PNG_30 = 30px)
    mediaSizes: 30,
    // omitted sizes = 100vw = 1280px -> smallest >= 1280w is 1400w (PNG_20 = 20px), not 2000w
    default100vw: 20,
    // (max-width: 500px) does not match 1280px; (min-width: 700px) matches -> PNG_20 = 20px
    picMedia: 20,
  });
});
