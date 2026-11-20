// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("adoption never hands a parser handle to a page-visible wrapper", async ({ page }) => {
  await setContent(page, '<div id="host"></div>');

  const seen = await page.evaluate(() => {
    const host = document.getElementById("host")!;
    const forgedDom = { nodeInfo: () => ({ nodeType: 1, nodeName: "SPAN", attributes: [] }) };
    const forged = { _dom: forgedDom, _id: -1, nodeType: 1 };
    let forgedError = "";
    try {
      Reflect.apply(host.appendChild, host, [forged]);
    } catch (error) {
      forgedError = (error as Error).name;
    }
    const parsed = new DOMParser().parseFromString('<b data-x="1">hi</b>', "text/html");
    const real = parsed.querySelector("b")!;
    const text = parsed.createTextNode("hi");
    const appended = host.appendChild(real);
    host.appendChild(text);
    return {
      forgedKeptOwnDom: (forged as { _dom: unknown })._dom === forgedDom,
      forgedError,
      realDomType: typeof Reflect.get(real, "_dom"),
      sameNode: appended === real,
      attr: real.getAttribute("data-x"),
      text: text.textContent,
      hostText: host.textContent,
    };
  });

  expect(seen).toEqual({
    forgedKeptOwnDom: true,
    forgedError: "TypeError",
    realDomType: "undefined",
    sameNode: true,
    attr: "1",
    text: "hi",
    hostText: "hi",
  });
});
