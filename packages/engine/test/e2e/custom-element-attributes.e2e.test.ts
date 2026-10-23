// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("custom element registration stores the callback read after observed attributes", async ({
  page,
}) => {
  await setContent(page, "<p>x</p>");
  const calls = await page.evaluate(() => {
    const log: string[] = [];
    let callbackReads = 0;
    const first = () => log.push("first callback");
    const second = () => log.push("second callback");
    class AccessorElement extends HTMLElement {
      static get observedAttributes() {
        log.push("observed attributes");
        return ["state"];
      }
      get attributeChangedCallback() {
        log.push("callback " + ++callbackReads);
        return callbackReads === 1 ? first : second;
      }
    }
    customElements.define("accessor-element", AccessorElement);
    document.createElement("accessor-element").setAttribute("state", "changed");
    return log;
  });
  expect(calls).toEqual(["callback 1", "observed attributes", "callback 2", "second callback"]);
});

test("custom elements react to observed attribute changes", async ({ page }) => {
  await setContent(
    page,
    `<turbo-frame state="initial"></turbo-frame>
     <script type="module">
       globalThis.__attributeChanges = [];
       class TurboFrame extends HTMLElement {
         static get observedAttributes() { return ["src", "state"]; }
         constructor() {
           super();
           globalThis.__attributeChanges.push(["constructor"]);
           this.setAttribute("src", "/constructor");
         }
         attributeChangedCallback(name, oldValue, newValue, namespace) {
           globalThis.__attributeChanges.push([name, oldValue, newValue, namespace]);
         }
         connectedCallback() {
           globalThis.__attributeChanges.push(["connected"]);
         }
       }
       customElements.define("turbo-frame", TurboFrame);
     </script>`,
    { waitUntil: "domcontentloaded" },
  );

  const changes = await page.evaluate(`(() => {
    const frame = document.querySelector("turbo-frame");
    frame.setAttribute("src", "/first");
    frame.setAttribute("src", "/second");
    frame.setAttribute("unobserved", "ignored");
    frame.removeAttribute("src");
    return globalThis.__attributeChanges;
  })()`);

  expect(changes).toEqual([
    ["constructor"],
    ["state", null, "initial", null],
    ["src", null, "/constructor", null],
    ["connected"],
    ["src", "/constructor", "/first", null],
    ["src", "/first", "/second", null],
    ["src", "/second", null, null],
  ]);
}, 120_000);
