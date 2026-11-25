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

test("connecting a host upgrades and connects the elements in its shadow tree", async ({
  page,
}) => {
  await setContent(page, "<!doctype html><body></body>");
  const result = await page.evaluate(() => {
    const log: string[] = [];
    class Child extends HTMLElement {
      connectedCallback() {
        log.push("connected:" + this.id);
      }
      play() {}
    }
    // Issue #147, case A: the parent's constructor writes the child into its shadow root.
    customElements.define("x-child", Child);
    customElements.define(
      "x-parent",
      class extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: "open" }).innerHTML = '<x-child id="a"></x-child>';
        }
      },
    );
    document.body.append(document.createElement("x-parent"));
    const a = document.querySelector("x-parent")!.shadowRoot!.querySelector("x-child") as any;

    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "closed" });
    const b = root.appendChild(Object.assign(document.createElement("x-late-child"), { id: "b" }));
    customElements.define("x-late-child", class extends Child {});
    const beforeConnect = typeof (b as any).play;
    document.body.append(host);
    document.body.prepend(host);

    const deep = document.createElement("div");
    let cursor: Element = deep;
    for (let i = 0; i < 100; i++) cursor = cursor.appendChild(document.createElement("div"));
    cursor.appendChild(Object.assign(document.createElement("x-child"), { id: "c" }));
    document.body.append(deep);

    const other = document.implementation.createHTMLDocument("");
    other.body.append(Object.assign(document.createElement("x-child"), { id: "d" }));

    document.body.insertAdjacentHTML("beforeend", "<x-broken></x-broken>");
    window.addEventListener("error", (event) => event.preventDefault(), { once: true });
    customElements.define(
      "x-broken",
      class extends HTMLElement {
        constructor() {
          super();
          throw new Error("x-broken");
        }
        connectedCallback() {
          log.push("connected:broken");
        }
      },
    );
    const broken = document.querySelector("x-broken")!;
    broken.remove();
    document.body.append(broken);
    return { a: typeof a.play, beforeConnect, b: typeof (b as any).play, log };
  });

  expect(result).toEqual({
    a: "function",
    beforeConnect: "undefined",
    b: "function",
    log: ["connected:a", "connected:b", "connected:b", "connected:c", "connected:d"],
  });
});

test("markup setters upgrade the custom elements they parse, in place", async ({ page }) => {
  await setContent(page, "<!doctype html><body></body>");
  const result = await page.evaluate(() => {
    const log: string[] = [];
    customElements.define(
      "x-m",
      class extends HTMLElement {
        constructor() {
          super();
          const parent = this.parentNode as Element | null;
          log.push("ctor:" + (parent ? parent.id || parent.nodeName : "none"));
        }
        connectedCallback() {
          log.push("connected");
        }
        play() {}
      },
    );
    const div = (id: string, connected = false) => {
      const d = Object.assign(document.createElement("div"), { id });
      if (connected) document.body.append(d);
      return d;
    };
    const run = (make: () => Node | null) => {
      log.length = 0;
      const element = make() as (Node & { play?: unknown }) | null;
      return [typeof element?.play, ...log];
    };
    const shadow = (id: string, connected = false) =>
      div(id, connected).attachShadow({ mode: "open" });
    const range = document.createRange();
    range.selectNodeContents(document.body);
    return {
      innerHTMLDetached: run(() => {
        const d = div("d1");
        d.innerHTML = "<x-m></x-m>";
        return d.firstChild;
      }),
      innerHTMLConnected: run(() => {
        const d = div("d2", true);
        d.innerHTML = "<x-m></x-m>";
        return d.firstChild;
      }),
      shadowDetached: run(() => {
        const root = shadow("h1");
        root.innerHTML = "<x-m></x-m>";
        return root.firstChild;
      }),
      // Issue #147, case B.
      shadowConnected: run(() => {
        const root = shadow("h2", true);
        root.innerHTML = "<x-m></x-m>";
        return root.firstChild;
      }),
      insertAdjacentDetached: run(() => {
        const d = div("d3");
        d.insertAdjacentHTML("beforeend", "<x-m></x-m>");
        return d.firstChild;
      }),
      insertAdjacentConnected: run(() => {
        const d = div("d4", true);
        d.insertAdjacentHTML("afterbegin", "<x-m></x-m>");
        return d.firstChild;
      }),
      outerHTML: run(() => {
        const d = div("d5", true);
        d.innerHTML = "<span></span>";
        (d.firstChild as Element).outerHTML = "<x-m></x-m>";
        return d.firstChild;
      }),
      contextualFragment: run(() => range.createContextualFragment("<x-m></x-m>").firstChild),
      template: run(() => {
        const t = document.createElement("template");
        t.innerHTML = "<x-m></x-m>";
        return t.content.firstChild;
      }),
      domParser: run(() =>
        new DOMParser().parseFromString("<x-m></x-m>", "text/html").querySelector("x-m"),
      ),
    };
  });

  expect(result).toEqual({
    innerHTMLDetached: ["function", "ctor:d1"],
    innerHTMLConnected: ["function", "ctor:d2", "connected"],
    shadowDetached: ["function", "ctor:#document-fragment"],
    shadowConnected: ["function", "ctor:#document-fragment", "connected"],
    insertAdjacentDetached: ["function", "ctor:d3"],
    insertAdjacentConnected: ["function", "ctor:d4", "connected"],
    outerHTML: ["function", "ctor:d5", "connected"],
    contextualFragment: ["function", "ctor:#document-fragment"],
    template: ["undefined"],
    domParser: ["undefined"],
  });
});

test("custom element constructor and callback errors fire the window error event", async ({
  page,
}) => {
  await setContent(
    page,
    `<!doctype html><body>
      <x-ctor-throws></x-ctor-throws><x-attr-throws a="1"></x-attr-throws>
      <script>
        window.__errors = [];
        window.addEventListener("error", (event) => {
          __errors.push(event.message);
          event.preventDefault();
        });
        customElements.define("x-ctor-throws", class extends HTMLElement {
          constructor() { super(); throw new Error("ctor"); }
        });
        customElements.define("x-attr-throws", class extends HTMLElement {
          static observedAttributes = ["a"];
          attributeChangedCallback() { throw new Error("attr"); }
        });
        customElements.define("x-connect-throws", class extends HTMLElement {
          connectedCallback() { throw new Error("connected"); }
        });
        document.body.append(document.createElement("x-connect-throws"));
      </script>
    </body>`,
  );
  expect(await page.evaluate("window.__errors")).toEqual([
    "Uncaught Error: ctor",
    "Uncaught Error: attr",
    "Uncaught Error: connected",
  ]);
});

test("instanceof a custom element class matches only its instances", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><body>
      <x-v8></x-v8>
      <script>
        window.V8El = class extends HTMLElement {};
        customElements.define("x-v8", V8El);
        const el = document.querySelector("x-v8");
        window.__v8 = [
          el instanceof V8El,
          document.body instanceof V8El,
          document.createElement("div") instanceof V8El,
          el instanceof HTMLElement,
          document.body instanceof HTMLElement,
        ];
      </script>
    </body>`,
  );
  // page.evaluate runs on Boa, so this class crosses the bridge.
  const boa = await page.evaluate(() => {
    class BoaEl extends HTMLElement {}
    customElements.define("x-boa", BoaEl);
    const el = document.createElement("x-boa");
    const V8El: typeof HTMLElement = Reflect.get(window, "V8El");
    return [
      el instanceof BoaEl,
      document.body instanceof BoaEl,
      document.querySelector("x-v8") instanceof BoaEl,
      el instanceof HTMLElement,
      document.createElement("x-undefined") instanceof HTMLElement,
      document.body instanceof V8El,
      document.querySelector("x-v8") instanceof V8El,
    ];
  });
  expect(await page.evaluate("window.__v8")).toEqual([true, false, false, true, true]);
  expect(boa).toEqual([true, false, false, true, true, false, true]);
});

test("an upgraded element takes its class's prototype in super()", async ({ page }) => {
  await setContent(page, "<!doctype html><body><x-proto></x-proto><x-early></x-early></body>");
  const result = await page.evaluate(() => {
    const element = document.querySelector("x-proto");
    const seen: boolean[] = [];
    class XProto extends HTMLElement {
      constructor() {
        seen.push(element instanceof XProto);
        super();
        seen.push(element instanceof XProto, this === element);
      }
    }
    customElements.define("x-proto", XProto);
    window.addEventListener("error", (event) => event.preventDefault(), { once: true });
    class XEarly extends HTMLElement {
      constructor() {
        if (document.body) throw new Error("x-early");
        super();
      }
    }
    customElements.define("x-early", XEarly);
    return { seen, early: document.querySelector("x-early") instanceof XEarly };
  });
  expect(result).toEqual({ seen: [false, true, true], early: false });
});
