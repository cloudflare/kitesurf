// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// ShadowRoot.textContent reads its descendants' text, as a DocumentFragment does, while the
// host's textContent stays its light tree. Expected values are Chrome's for the same page.
import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("ShadowRoot.textContent reads and replaces the shadow tree's text", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html>
<div id="decl"><template shadowrootmode="open"><b>server</b> text<!--note--></template>light</div>
<div id="imp">host light</div>`,
    { waitUntil: "domcontentloaded" },
  );
  const got = await page.evaluate(() => {
    const decl = document.getElementById("decl")!;
    const imp = document.getElementById("imp")!;
    const root = imp.attachShadow({ mode: "open" });
    const p = document.createElement("p");
    const i = document.createElement("i");
    i.textContent = "deep";
    p.append("nested ", i);
    root.append(p, " tail");
    const read = {
      declared: decl.shadowRoot?.textContent ?? null,
      imperative: root.textContent,
      hostLight: imp.textContent,
      declHostLight: decl.textContent,
    };
    root.textContent = "replaced";
    return {
      ...read,
      afterSet: root.textContent,
      childCount: root.childNodes.length,
      firstIsText: root.firstChild?.nodeType === Node.TEXT_NODE,
    };
  });
  expect(got).toEqual({
    declared: "server text",
    imperative: "nested deep tail",
    hostLight: "host light",
    declHostLight: "light",
    afterSet: "replaced",
    childCount: 1,
    firstIsText: true,
  });
});
