// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

// Each expectation is what Chrome returns for the same script.
// https://html.spec.whatwg.org/multipage/custom-elements.html#upgrades

test("define() upgrades the document's elements before it returns", async ({ page }) => {
  await setContent(page, "<!doctype html><body></body>");
  const result = await page.evaluate(async () => {
    const out: Record<string, unknown> = {};
    const logged = (log: string[]) =>
      class extends HTMLElement {
        constructor() {
          super();
          log.push("ctor" + (this.id ? ":" + this.id : ""));
        }
        connectedCallback() {
          log.push("connected" + (this.id ? ":" + this.id : ""));
        }
        play() {}
      };

    document.body.insertAdjacentHTML("beforeend", "<x-late></x-late>");
    customElements.define("x-late", logged([]));
    const late = document.querySelector("x-late") as HTMLElement & { play?: unknown };
    out.sync = typeof late.play;
    await Promise.resolve();
    out.afterMicrotask = typeof late.play;

    const order: string[] = [];
    const wrap = document.body.appendChild(document.createElement("div"));
    const make = (id: string) => Object.assign(document.createElement("x-order"), { id });
    wrap.append(make("1"));
    const host = wrap.appendChild(document.createElement("div"));
    host.append(make("3"));
    host.attachShadow({ mode: "closed" }).append(make("2"));
    wrap.append(make("4"));
    customElements.define("x-order", logged(order));
    out.order = order;

    const attrs: string[] = [];
    document.body.insertAdjacentHTML("beforeend", '<x-attrs foo="1" bar="2"></x-attrs>');
    customElements.define(
      "x-attrs",
      class extends HTMLElement {
        static observedAttributes = ["foo"];
        constructor() {
          super();
          attrs.push("ctor");
        }
        attributeChangedCallback(name: string, oldValue: string | null, value: string) {
          attrs.push(`attr:${name}:${oldValue}:${value}`);
        }
        connectedCallback() {
          attrs.push("connected");
        }
      },
    );
    out.attrs = attrs;

    document.body.insertAdjacentHTML("beforeend", "<x-when></x-when>");
    const defined = customElements.whenDefined("x-when");
    customElements.define("x-when", logged([]));
    await defined;
    out.whenDefined = typeof (document.querySelector("x-when") as any).play;

    // The spec's reentrancy example: b is re-inserted while a's constructor runs.
    let reentrant = 0;
    document.body.insertAdjacentHTML("beforeend", '<x-re id="a"></x-re><x-re id="b"></x-re>');
    customElements.define(
      "x-re",
      class extends HTMLElement {
        constructor() {
          super();
          reentrant++;
          const b = document.querySelector("x-re#b");
          if (b && b !== this) document.body.appendChild(b);
        }
      },
    );
    out.reentrant = reentrant;

    const nested: string[] = [];
    document.body.insertAdjacentHTML("beforeend", "<x-outer><x-inner></x-inner></x-outer>");
    customElements.define(
      "x-outer",
      class extends HTMLElement {
        constructor() {
          super();
          nested.push("outer");
          customElements.define(
            "x-inner",
            class extends HTMLElement {
              constructor() {
                super();
                nested.push("inner");
              }
            },
          );
          nested.push("outer after define");
        }
      },
    );
    out.nested = nested;

    document.body.insertAdjacentHTML("beforeend", "<template><x-skip></x-skip></template>");
    const detached = document.createElement("x-skip");
    customElements.define("x-skip", logged([]));
    const template = document.querySelector("template") as HTMLTemplateElement;
    out.skipped = [typeof (template.content.firstChild as any).play, typeof (detached as any).play];

    let failures = 0;
    document.body.insertAdjacentHTML("beforeend", "<x-fail></x-fail>");
    window.addEventListener("error", (event) => event.preventDefault(), { once: true });
    customElements.define(
      "x-fail",
      class extends HTMLElement {
        constructor() {
          super();
          failures++;
          throw new Error("x-fail");
        }
      },
    );
    const failed = document.querySelector("x-fail") as HTMLElement;
    failed.remove();
    document.body.append(failed);
    customElements.upgrade(failed);
    out.failures = failures;
    return out;
  });

  expect(result).toEqual({
    sync: "function",
    afterMicrotask: "function",
    order: [
      "ctor:1",
      "connected:1",
      "ctor:2",
      "connected:2",
      "ctor:3",
      "connected:3",
      "ctor:4",
      "connected:4",
    ],
    attrs: ["ctor", "attr:foo:null:1", "connected"],
    whenDefined: "function",
    reentrant: 2,
    nested: ["outer", "inner", "outer after define"],
    skipped: ["undefined", "undefined"],
    failures: 1,
  });
});

test("upgrade() upgrades a disconnected tree without connecting it", async ({ page }) => {
  await setContent(page, "<!doctype html><body></body>");
  const result = await page.evaluate(() => {
    const log: string[] = [];
    class Up extends HTMLElement {
      constructor() {
        super();
        log.push("ctor");
      }
      connectedCallback() {
        log.push("connected");
      }
      play() {}
    }
    const host = document.createElement("div");
    host.innerHTML = "<x-up></x-up>";
    const shadowHost = document.createElement("div");
    shadowHost.attachShadow({ mode: "open" }).innerHTML = "<x-up></x-up>";
    const other = document.implementation.createHTMLDocument("");
    other.body.innerHTML = "<x-up></x-up>";
    customElements.define("x-up", Up);
    const before = typeof (host.firstChild as any).play;
    customElements.upgrade(host.firstChild as Node);
    customElements.upgrade(shadowHost);
    customElements.upgrade(other.body);
    customElements.upgrade(other.body.firstChild as Node);
    let missingRoot = "no throw";
    try {
      (customElements.upgrade as (root?: unknown) => void)();
    } catch (error) {
      missingRoot = (error as Error).name;
    }
    return {
      before,
      light: typeof (host.firstChild as any).play,
      shadow: typeof (shadowHost.shadowRoot!.firstChild as any).play,
      otherDocument: typeof (other.body.firstChild as any).play,
      log,
      missingRoot,
    };
  });

  expect(result).toEqual({
    before: "undefined",
    light: "function",
    shadow: "function",
    otherDocument: "undefined",
    log: ["ctor", "ctor"],
    missingRoot: "TypeError",
  });
});

test("a classic script sees elements that an earlier script defined", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><body>
      <x-before></x-before>
      <script>
        window.__log = [];
        class Logged extends HTMLElement { mark() {} }
        customElements.define("x-before", class extends Logged {});
        __log.push("before:" + typeof document.querySelector("x-before").mark);
        customElements.define("x-after", class extends Logged {});
      </script>
      <x-after></x-after>
      <script>__log.push("after:" + typeof document.querySelector("x-after").mark);</script>
    </body>`,
  );
  expect(await page.evaluate("window.__log")).toEqual(["before:function", "after:function"]);
});

test("define() in a module script lets connected callbacks start I/O", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><body>
      <x-io></x-io>
      <script type="module">
        globalThis.__io = [];
        customElements.define("x-io", class extends HTMLElement {
          connectedCallback() {
            __io.push("connected");
            setTimeout(() => __io.push("timer"), 0);
            fetch("data:text/plain,ok").then((r) => r.text()).then((t) => __io.push("fetch:" + t));
            crypto.subtle.digest("SHA-256", new Uint8Array([1])).then(() => __io.push("digest"));
          }
        });
        __io.push("defined");
      </script>
    </body>`,
  );
  await page.waitForFunction("globalThis.__io && globalThis.__io.length >= 5", { timeout: 10_000 });
  const io = (await page.evaluate("globalThis.__io")) as string[];
  expect(io.slice(0, 2)).toEqual(["connected", "defined"]);
  expect(io.slice(2).sort()).toEqual(["digest", "fetch:ok", "timer"]);
});
