// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";

const PAGE = "https://ks.invalid/__fixtures/lifecycle.html";
const ECHO = "https://ks.invalid/__fixtures/echo-headers.json";
const SECRET = "https://ks-other.invalid/__fixtures/no-acao-secret.json";

async function acceptFor(page: Page, claim: string | null): Promise<string> {
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  const hdrs =
    claim === null
      ? "{}"
      : JSON.stringify({
          "x-kitesurf-resource-type": claim,
        });
  const raw: unknown = await page.evaluate(`
    (async () => {
      const r = await fetch(${JSON.stringify(ECHO)}, { headers: ${hdrs} });
      const j = await r.json();
      return j.accept || "";
    })()
  `);
  return String(raw);
}

const FETCH_DEFAULT = "*/*";

test("a page fetch always reaches the origin as the Fetch default", async ({ page }) => {
  expect(await acceptFor(page, null)).toBe(FETCH_DEFAULT);
});

test("a forged resource type does not survive to the origin", async ({ page }) => {
  expect(await acceptFor(page, "Stylesheet")).toBe(FETCH_DEFAULT);
  expect(await acceptFor(page, "Image")).toBe(FETCH_DEFAULT);
  expect(await acceptFor(page, "Document")).toBe(FETCH_DEFAULT);
});

test("a Proxy init cannot discover and forge trusted metadata", async ({ page }) => {
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  const raw: unknown = await page.evaluate(`(async () => {
    const init = new Proxy({
      headers: { "x-kitesurf-allow-cross-origin": "1" },
    }, {
      get(target, key, receiver) {
        // A module-private Symbol is still disclosed to a Proxy trap.
        // Before the WeakMap channel, returning this forged value made
        // the gateway believe this page fetch was a Stylesheet.
        if (typeof key === "symbol") {
          return { resourceType: "Stylesheet", initiator: "parser" };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    try {
      const r = await fetch(${JSON.stringify(SECRET)}, init);
      const body = await r.text();
      return body.includes("kitesurf-cross-origin-secret")
        ? "READABLE"
        : "opaque";
    } catch (e) {
      return "blocked";
    }
  })()`);
  expect(String(raw)).toBe("blocked");
});

test("patched WeakMap methods cannot forge trusted metadata", async ({ page }) => {
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  const raw: unknown = await page.evaluate(`(async () => {
    const control = new WeakMap();
    const controlKey = {};
    control.set(controlKey, "original");
    WeakMap.prototype.get = function () {
      return { resourceType: "Stylesheet", initiator: "parser" };
    };
    const patchIsLive = control.get(controlKey).resourceType === "Stylesheet";
    try {
      const r = await fetch(${JSON.stringify(SECRET)}, {
        headers: { "x-kitesurf-allow-cross-origin": "1" },
      });
      const body = await r.text();
      return {
        patchIsLive,
        result: body.includes("kitesurf-cross-origin-secret")
          ? "READABLE"
          : "opaque",
      };
    } catch (e) {
      return { patchIsLive, result: "blocked" };
    }
  })()`);
  expect(raw).toEqual({ patchIsLive: true, result: "blocked" });
});

test("patched Function.call cannot forge trusted metadata", async ({ page }) => {
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  const raw: unknown = await page.evaluate(`(async () => {
    const realCall = Function.prototype.call;
    let patchIsLive = false;
    Function.prototype.call = function (receiver, ...args) {
      if (this === WeakMap.prototype.get) {
        patchIsLive = true;
        return { resourceType: "Stylesheet", initiator: "parser" };
      }
      return Reflect.apply(realCall, this, [receiver, ...args]);
    };
    // Prove the hook can intercept the old channel before asking
    // whether the engine still routes through it.
    WeakMap.prototype.get.call(new WeakMap(), {});
    try {
      const r = await fetch(${JSON.stringify(SECRET)}, {
        headers: { "x-kitesurf-allow-cross-origin": "1" },
      });
      const body = await r.text();
      return {
        patchIsLive,
        result: body.includes("kitesurf-cross-origin-secret")
          ? "READABLE"
          : "opaque",
      };
    } catch (e) {
      return { patchIsLive, result: "blocked" };
    }
  })()`);
  expect(raw).toEqual({ patchIsLive: true, result: "blocked" });
});

test("Object.prototype getters cannot exfiltrate a trusted init", async ({ page }) => {
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  const raw: unknown = await page.evaluate(`(async () => {
    let captured = null;
    let patchIsLive = false;
    Object.defineProperty(Object.prototype, "cache", {
      configurable: true,
      get() {
        patchIsLive = true;
        if (Object.prototype.hasOwnProperty.call(this, "headers")) {
          captured = this;
        }
        return undefined;
      },
    });
    void ({}).cache;

    const img = document.createElement("img");
    // Either terminal event means the loader built its init; the cap
    // only stops an image that reports neither from hanging the test.
    const imgDone = new Promise((r) => {
      img.addEventListener("load", () => r("load"));
      img.addEventListener("error", () => r("error"));
      setTimeout(() => r("timeout"), 5000);
    });
    img.src = "https://ks-other.invalid/__fixtures/solid-red.png";
    document.body.appendChild(img);
    await imgDone;

    if (captured === null) {
      return { patchIsLive, captured: false, result: "not-exposed" };
    }
    try {
      const r = await fetch(${JSON.stringify(SECRET)}, captured);
      const body = await r.text();
      return {
        patchIsLive,
        captured: true,
        result: body.includes("kitesurf-cross-origin-secret")
          ? "READABLE"
          : "opaque",
      };
    } catch (e) {
      return { patchIsLive, captured: true, result: "blocked" };
    }
  })()`);
  expect(raw).toEqual({
    patchIsLive: true,
    captured: false,
    result: "not-exposed",
  });
});

test("patched Function.apply cannot intercept a trusted init", async ({ page }) => {
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  const raw: unknown = await page.evaluate(`(async () => {
    const realApply = Function.prototype.apply;
    let captured = null;
    let patchIsLive = false;
    Function.prototype.apply = function (receiver, args) {
      patchIsLive = true;
      const init = args && args[1];
      if (init && init.headers &&
          init.headers["x-kitesurf-allow-cross-origin"] === "1") {
        captured = init;
      }
      return Reflect.apply(realApply, this, [receiver, args]);
    };
    (function () {}).apply(null, []);

    const img = document.createElement("img");
    // Either terminal event means the loader built its init; the cap
    // only stops an image that reports neither from hanging the test.
    const imgDone = new Promise((r) => {
      img.addEventListener("load", () => r("load"));
      img.addEventListener("error", () => r("error"));
      setTimeout(() => r("timeout"), 5000);
    });
    img.src = "https://ks-other.invalid/__fixtures/solid-red.png";
    document.body.appendChild(img);
    await imgDone;

    if (captured === null) {
      return { patchIsLive, captured: false, result: "not-exposed" };
    }
    try {
      const r = await fetch(${JSON.stringify(SECRET)}, captured);
      const body = await r.text();
      return {
        patchIsLive,
        captured: true,
        result: body.includes("kitesurf-cross-origin-secret")
          ? "READABLE"
          : "opaque",
      };
    } catch (e) {
      return { patchIsLive, captured: true, result: "blocked" };
    }
  })()`);
  expect(raw).toEqual({
    patchIsLive: true,
    captured: false,
    result: "not-exposed",
  });
});

// The privileged transport consults these page-mutable operations after it stamps trusted
// headers or before it releases an opaque response. Each row poisons one, proves the hook is
// live with a harmless control, then takes the privileged path.
const CUSTODY_SHEET = "https://ks-alt.invalid/__fixtures/cors-sheet-bare.css";
type CustodyProbe = { live: boolean; captured: boolean; result: string; style: string };

const FETCH_ACTION = `
        try {
          const r = await fetch(${JSON.stringify(SECRET)});
          out.result = (await r.text()).includes("kitesurf-cross-origin-secret")
            ? "READABLE"
            : "opaque";
        } catch (e) {
          out.result = "blocked";
        }`;

const SHEET_ACTION = `
        const el = document.createElement("p");
        el.id = "target";
        document.body.appendChild(el);
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = ${JSON.stringify(CUSTODY_SHEET)};
        const settled = new Promise((r) => {
          link.onload = () => r("load");
          link.onerror = () => r("error");
          setTimeout(() => r("timeout"), 5000);
        });
        document.head.appendChild(link);
        const landed = await settled;
        const color = getComputedStyle(el).color;
        let mutate = "";
        for (const s of document.styleSheets) {
          if (String(s && s.href).indexOf("cors-sheet-bare") === -1) continue;
          try { s.insertRule("#zz{color:rgb(1,2,3)}", 0); }
          catch (e) { mutate = String((e && e.name) || e); }
        }
        out.style = [landed, color, mutate].join("|");`;

const POISON_REQUEST = `
      const real = Request;
      Request = function (input, init) {
        live = true;
        const h = init && init.headers;
        if (h && h.get("x-kitesurf-page-origin") !== null) forge(h);
        return Reflect.construct(real, [input, init]);
      };
      control = () => new Request("https://ks.invalid/");
      restore = () => { Request = real; };`;

const POISON_REQUEST_HEADERS = `
      const proto = Request.prototype, desc = Object.getOwnPropertyDescriptor(proto, "headers");
      Object.defineProperty(proto, "headers", { configurable: true, enumerable: desc.enumerable, get() {
        const h = desc.get.call(this);
        live = true;
        if (h.get("x-kitesurf-page-origin") !== null) forge(h);
        return h;
      } });
      control = () => new Request("https://ks.invalid/").headers;
      restore = () => Object.defineProperty(proto, "headers", desc);`;

const POISON_ARRAY_BUFFER = `
      const real = Response.prototype.arrayBuffer;
      Response.prototype.arrayBuffer = function () {
        live = true;
        if (String(this && this.url).indexOf("cors-sheet-bare") !== -1) captured = true;
        return real.call(this);
      };
      control = () => new Response("x").arrayBuffer();
      restore = () => { Response.prototype.arrayBuffer = real; };`;

// Page scripts run in the Boa realm with their own Array/Object intrinsics, so replacing those
// never reaches the worker-realm transport (measured). The host-realm globals and prototypes
// below are reachable, so they are the rows this runtime can falsify.
// Row: name, stylesheet row, poison installed in page scope.
const CUSTODY_ROWS: Array<[string, boolean, string]> = [
  ["globalThis.Request", false, POISON_REQUEST],
  ["Request.prototype.headers", false, POISON_REQUEST_HEADERS],
  ["Response.prototype.arrayBuffer", true, POISON_ARRAY_BUFFER],
];

test("page intrinsics cannot take custody of the transport request or response", async ({
  page,
}) => {
  const got: Array<[string, boolean, CustodyProbe]> = [];
  for (const [name, sheet, poison] of CUSTODY_ROWS) {
    await page.goto(PAGE, { waitUntil: "domcontentloaded" });
    const probe = (await page.evaluate(`(async () => {
      let live = false, captured = false, control = () => {}, restore = () => {};
      const forge = (h) => {
        captured = true;
        h.set("x-kitesurf-resource-type", "Stylesheet");
        h.set("x-kitesurf-allow-cross-origin", "1");
      };
      const out = { live: false, captured: false, result: "", style: "" };
      ${poison}
      try {
        await control();
        ${sheet ? SHEET_ACTION : FETCH_ACTION}
      } finally {
        restore();
        out.live = live;
        out.captured = captured;
      }
      return out;
    })()`)) as CustodyProbe;
    got.push([name, sheet, probe]);
  }
  for (const [name, sheet, probe] of got) {
    expect(probe.live, name).toBe(true);
    expect(probe.captured, name).toBe(false);
    if (sheet) expect(probe.style, name).toBe("load|rgb(0, 0, 255)|SecurityError");
    else expect(probe.result, name).toBe("blocked");
  }
}, 300_000);

test("the parser's own loads keep their type", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/external-sheet.html", {
    waitUntil: "load",
  });
  const color: unknown = await page.evaluate(
    `getComputedStyle(document.getElementById("x")).color`,
  );
  expect(String(color)).toBe("rgb(0, 128, 0)");
});
