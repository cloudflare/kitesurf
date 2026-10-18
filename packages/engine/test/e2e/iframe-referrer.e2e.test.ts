// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Wire Referer and document.referrer stay aligned across synthetic documents.
import { expect } from "vitest";

import { test } from "./harness";

const HOST = "https://ks.invalid/__fixtures/iframe-referrer-host.html";

const STATIC_FRAME_REFERRERS = `(() => {
  const d = document.getElementById("echo").contentDocument;
  return { sent: JSON.parse(d.getElementById("h").textContent).referer, referrer: d.referrer };
})()`;

test("a static same-origin frame reports the Referer its request sent", async ({ page }) => {
  await page.goto(HOST, { waitUntil: "load", timeout: 30000 });
  expect(await page.evaluate(STATIC_FRAME_REFERRERS)).toEqual({
    sent: HOST,
    referrer: HOST,
  });
});

test("the frame's Referer and document.referrer agree under strict-origin", async ({ page }) => {
  // strict-origin trims a same-origin referrer to the origin, a row the
  // gateway used to skip: the wire carried the full URL and JS the origin.
  await page.goto(`${HOST}?policy=strict-origin`, { waitUntil: "load", timeout: 30000 });
  expect(await page.evaluate(STATIC_FRAME_REFERRERS)).toEqual({
    sent: "https://ks.invalid/",
    referrer: "https://ks.invalid/",
  });
});

test("a nested frame fetches under its embedder frame's policy", async ({ page, cdpSession }) => {
  // The middle frame sends `Referrer-Policy: origin`; the top document
  // sends none. The grandchild's Referer must follow the middle frame.
  await page.goto("https://ks.invalid/__fixtures/iframe-referrer-nested-host.html", {
    waitUntil: "load",
    timeout: 30000,
  });
  const { frameTree } = await cdpSession.send("Page.getFrameTree");
  const grandchild = frameTree.childFrames?.[0]?.childFrames?.[0]?.frame;
  if (!grandchild) throw new Error("no depth-2 frame in the tree");
  expect(new URL(grandchild.url).searchParams.get("referer")).toBe("https://ks.invalid/");
});

test("the initial about:blank document takes its creator's URL and is quirks", async ({ page }) => {
  await page.goto(HOST, { waitUntil: "load", timeout: 30000 });
  const got = await page.evaluate(`(() => {
    const d = document.getElementById("initial").contentDocument;
    return { referrer: d.referrer, compatMode: d.compatMode, doctype: d.doctype };
  })()`);
  expect(got).toEqual({ referrer: HOST, compatMode: "BackCompat", doctype: null });
});

test("dynamic frames: same-origin gets the full URL, about:blank the origin", async ({ page }) => {
  await page.goto(HOST, { waitUntil: "load", timeout: 30000 });
  const got = await page.evaluate(`(async () => {
    const f = document.createElement("iframe");
    const loaded = () => new Promise((r) => { f.onload = r; });
    // Created before navigating: the initial document's referrer.
    document.body.appendChild(f);
    const initial = f.contentDocument.referrer;
    let p = loaded();
    f.src = "/__fixtures/iframe-child.html";
    await p;
    const child = f.contentDocument.referrer;
    p = loaded();
    // A navigation to an opaque about:blank: origin only by default.
    f.src = "about:blank";
    await p;
    return { initial, child, blank: f.contentDocument.referrer };
  })()`);
  expect(got).toEqual({
    initial: HOST,
    child: HOST,
    blank: "https://ks.invalid/",
  });
});

test("a DOMParser document has an empty referrer and its doctype", async ({ page }) => {
  const got = await page.evaluate(`(() => {
    const p = new DOMParser();
    const std = p.parseFromString("<!DOCTYPE html><p>x", "text/html");
    const legacy = p.parseFromString(
      '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd"><p>x',
      "text/html",
    );
    const none = p.parseFromString("<p>x", "text/html");
    return {
      referrer: std.referrer,
      std: [std.doctype.name, std.doctype === std.doctype],
      legacy: [legacy.doctype.name, legacy.doctype.publicId, legacy.doctype.systemId],
      none: none.doctype,
    };
  })()`);
  expect(got).toEqual({
    referrer: "",
    std: ["html", true],
    legacy: ["html", "-//W3C//DTD HTML 4.01//EN", "http://www.w3.org/TR/html4/strict.dtd"],
    none: null,
  });
});

test("Request keeps its referrer and fetch() sends it", async ({ page }) => {
  await page.goto(HOST, { waitUntil: "load", timeout: 30000 });
  const got = await page.evaluate(`(async () => {
    const req = new Request("/__fixtures/echo-headers.json", { referrer: "/some/path" });
    const echoed = await fetch(req).then((r) => r.json());
    let threw = "";
    try { new Request("/x", { referrerPolicy: "bogus" }); } catch (e) { threw = e.name; }
    return {
      referrer: req.referrer,
      cloned: req.clone().referrer,
      defaults: [new Request("/x").referrer, new Request("/x").referrerPolicy],
      none: new Request("/x", { referrer: "" }).referrer,
      crossOrigin: new Request("/x", { referrer: "https://other.invalid/" }).referrer,
      sent: echoed.referer,
      threw,
    };
  })()`);
  expect(got).toEqual({
    referrer: "https://ks.invalid/some/path",
    cloned: "https://ks.invalid/some/path",
    defaults: ["about:client", ""],
    none: "",
    crossOrigin: "about:client",
    sent: "https://ks.invalid/some/path",
    threw: "TypeError",
  });
});
