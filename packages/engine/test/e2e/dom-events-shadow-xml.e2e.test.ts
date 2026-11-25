// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Covers checkable click activation gating, XML createElement colon names,
// and non-ASCII valid custom element shadow hosts.
import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("checkable click activation gates on MouseEvent and restores state on dispatch error", async ({
  page,
}) => {
  await setContent(
    page,
    `<!doctype html><input id="cb" type="checkbox"><input id="cb2" type="checkbox">`,
    { waitUntil: "domcontentloaded" },
  );
  const got = await page.evaluate(() => {
    const cb = document.getElementById("cb") as HTMLInputElement;
    const cb2 = document.getElementById("cb2") as HTMLInputElement;
    const events: string[] = [];
    cb.addEventListener("input", () => events.push("input"));
    cb.addEventListener("change", () => events.push("change"));

    cb.indeterminate = true;
    cb.dispatchEvent(new Event("click"));
    const afterPlainEvent = {
      checked: cb.checked,
      indeterminate: cb.indeterminate,
      events: events.slice(),
    };

    let nonEventError = "";
    try {
      Reflect.apply(cb.dispatchEvent, cb, [{ type: "click" }]);
    } catch (e) {
      nonEventError = (e as Error).name;
    }
    const afterNonEvent = {
      checked: cb.checked,
      indeterminate: cb.indeterminate,
    };

    let reentrantError = "";
    cb2.indeterminate = true;
    cb.addEventListener(
      "click",
      (ev) => {
        try {
          cb2.dispatchEvent(ev);
        } catch (e) {
          reentrantError = (e as DOMException).name;
        }
      },
      { once: true },
    );
    cb.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const afterMouseEvent = {
      checked: cb.checked,
      indeterminate: cb.indeterminate,
      events: events.slice(),
      cb2Checked: cb2.checked,
      cb2Indeterminate: cb2.indeterminate,
    };

    return {
      afterPlainEvent,
      nonEventError,
      afterNonEvent,
      reentrantError,
      afterMouseEvent,
    };
  });

  expect(got).toEqual({
    afterPlainEvent: { checked: false, indeterminate: true, events: [] },
    nonEventError: "TypeError",
    afterNonEvent: { checked: false, indeterminate: true },
    reentrantError: "InvalidStateError",
    afterMouseEvent: {
      checked: true,
      indeterminate: false,
      events: ["input", "change"],
      cb2Checked: false,
      cb2Indeterminate: true,
    },
  });
});

test("XML createElement keeps colon names without prefix splitting", async ({ page }) => {
  await setContent(page, `<!doctype html><p>ok</p>`, { waitUntil: "domcontentloaded" });
  const got = await page.evaluate(() => {
    const xmlDoc = document.implementation.createDocument(null, "");
    const colon = xmlDoc.createElement("f:oo");
    const colonClone = colon.cloneNode(false) as Element;
    const book = xmlDoc.createElement("book");
    const bookClone = book.cloneNode(false) as Element;
    const xmlns = xmlDoc.createElement("xmlns");
    const xmlnsFoo = xmlDoc.createElement("xmlns:foo");
    const soap = new Document().createElement("soap:Envelope");
    let nsError = "";
    try {
      xmlDoc.createElementNS(null, "f:oo");
    } catch (e) {
      nsError = (e as DOMException).name;
    }
    return {
      colon: [colon.localName, colon.prefix, colon.namespaceURI, colon.tagName],
      colonClone: [
        colonClone.localName,
        colonClone.prefix,
        colonClone.namespaceURI,
        colonClone.tagName,
      ],
      bookClone: [bookClone.localName, bookClone.prefix, bookClone.namespaceURI, bookClone.tagName],
      xmlns: [xmlns.localName, xmlns.prefix, xmlns.namespaceURI],
      xmlnsFoo: [xmlnsFoo.localName, xmlnsFoo.prefix, xmlnsFoo.namespaceURI],
      soap: [soap.localName, soap.prefix, soap.namespaceURI, soap.tagName],
      nsError,
    };
  });

  expect(got).toEqual({
    colon: ["f:oo", null, null, "f:oo"],
    colonClone: ["f:oo", null, null, "f:oo"],
    bookClone: ["book", null, null, "book"],
    xmlns: ["xmlns", null, null],
    xmlnsFoo: ["xmlns:foo", null, null],
    soap: ["soap:Envelope", null, null, "soap:Envelope"],
    nsError: "NamespaceError",
  });
});

test("attachShadow allows spec-valid non-ASCII custom element names and rejects invalid hosts", async ({
  page,
}) => {
  await setContent(
    page,
    `<!doctype html><x-é id="dsd"><template shadowrootmode="open"><span>hi</span></template></x-é>`,
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
    const dsd = document.getElementById("dsd");
    const upper = document.createElementNS("http://www.w3.org/1999/xhtml", "x-Bad");
    return {
      dsdHtml: dsd?.shadowRoot?.innerHTML ?? null,
      accented: attempt(() => document.createElement("x-é").attachShadow({ mode: "open" })),
      greek: attempt(() => document.createElement("math-α").attachShadow({ mode: "open" })),
      emoji: attempt(() => document.createElement("emotion-😍").attachShadow({ mode: "open" })),
      input: attempt(() => document.createElement("input").attachShadow({ mode: "open" })),
      forbidden: attempt(() => document.createElement("font-face").attachShadow({ mode: "open" })),
      uppercase: attempt(() => (upper as HTMLElement).attachShadow({ mode: "open" })),
    };
  });

  expect(got).toEqual({
    dsdHtml: "<span>hi</span>",
    accented: "ok",
    greek: "ok",
    emoji: "ok",
    input: "NotSupportedError",
    forbidden: "NotSupportedError",
    uppercase: "NotSupportedError",
  });
});
