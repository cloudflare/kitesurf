// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const RED_8X8_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";

test("inserted inline img beside a block keeps its attribute size under a running animation", async ({
  page,
}) => {
  await setContent(
    page,
    "<style>@keyframes nudge { to { transform: translateY(10px) } }" +
      " #anim { animation: nudge 7s infinite alternate }</style>" +
      "<div id=anim>animated</div>",
  );
  await page.evaluate(() => document.getElementById("anim")!.getBoundingClientRect().width);
  await page.evaluate(() => document.getElementById("anim")!.getBoundingClientRect().width);

  const size = await page.evaluate((src) => {
    document.body.innerHTML = `<img id=img width=64 height=64 src="${src}"><div>block</div>`;
    const rect = document.getElementById("img")!.getBoundingClientRect();
    return [rect.width, rect.height];
  }, RED_8X8_PNG);

  expect(size).toEqual([64, 64]);
});
