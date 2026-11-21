// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// attachShadow() on a host with a declarative shadow root of the same mode takes that root
// over (DOM "attach a shadow root"), as server-rendered web components do when they hydrate.
import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("attachShadow takes over a declarative shadow root once", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html>
<div id="same"><template shadowrootmode="open"><b>server</b></template></div>
<div id="other"><template shadowrootmode="open"><b>server</b></template></div>
<div id="imperative"></div>
<div id="styled"><template shadowrootmode="open"><i>server</i></template></div>
<div id="closed"><template shadowrootmode="closed"><b>hidden</b></template></div>
<div id="outer"><template shadowrootmode="open"><div id="inner"><template shadowrootmode="open">one</template><template shadowrootmode="open">two</template></div></template></div>
<div id="twice"><template shadowrootmode="open">first</template><template shadowrootmode="open">second</template></div>`,
    { waitUntil: "domcontentloaded" },
  );
  const got = await page.evaluate(() => {
    const attempt = (fn: () => unknown) => {
      try {
        fn();
        return "ok";
      } catch (e) {
        return (e as DOMException).name;
      }
    };
    const same = document.getElementById("same")!;
    const declared = same.shadowRoot;
    const taken = same.attachShadow({ mode: "open" });
    const other = document.getElementById("other")!;
    const imperative = document.getElementById("imperative")!;
    const twice = document.getElementById("twice")!;
    // Adopted stylesheets belong to the root, not its children, so they survive the takeover.
    const styled = document.getElementById("styled")!;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync("b { color: rgb(255, 0, 0); }");
    styled.shadowRoot!.adoptedStyleSheets = [sheet];
    const styledRoot = styled.attachShadow({ mode: "open" });
    const styledBold = document.createElement("b");
    styledRoot.appendChild(styledBold);
    // A closed declarative root is reachable only through this takeover.
    const closed = document.getElementById("closed")!;
    const closedTaken = closed.attachShadow({ mode: "closed" });
    imperative.attachShadow({ mode: "open" });
    return {
      sameRoot: taken === declared,
      emptied: taken.childNodes.length,
      secondTakeover: attempt(() => same.attachShadow({ mode: "open" })),
      modeMismatch: attempt(() => other.attachShadow({ mode: "closed" })),
      otherKeptContent: other.shadowRoot?.innerHTML ?? null,
      imperativeReattach: attempt(() => imperative.attachShadow({ mode: "open" })),
      styledSheets: styledRoot.adoptedStyleSheets.length,
      styledColor: getComputedStyle(styledBold).color,
      closedHidden: closed.shadowRoot,
      closedEmptied: closedTaken.childNodes.length,
      twiceRoot: twice.shadowRoot?.innerHTML ?? null,
      twiceLight: twice.innerHTML,
      twiceTakeover: (() => {
        const first = twice.shadowRoot;
        const r = twice.attachShadow({ mode: "open" });
        return r === first && r.childNodes.length === 0;
      })(),
      nestedRoot: (() => {
        const inner = document.getElementById("outer")!.shadowRoot!.getElementById("inner")!;
        return [inner.shadowRoot?.innerHTML ?? null, inner.innerHTML];
      })(),
    };
  });
  expect(got).toEqual({
    sameRoot: true,
    emptied: 0,
    secondTakeover: "NotSupportedError",
    modeMismatch: "NotSupportedError",
    otherKeptContent: "<b>server</b>",
    imperativeReattach: "NotSupportedError",
    styledSheets: 1,
    styledColor: "rgb(255, 0, 0)",
    closedHidden: null,
    closedEmptied: 0,
    twiceRoot: "first",
    twiceLight: '<template shadowrootmode="open">second</template>',
    twiceTakeover: true,
    nestedRoot: ["one", '<template shadowrootmode="open">two</template>'],
  });
});
