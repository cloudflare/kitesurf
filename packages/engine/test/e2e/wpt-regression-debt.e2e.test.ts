// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("DOM regression fixes preserve observable browser behavior", async ({ page }) => {
  await setContent(page, "<div id=parent><i></i><b></b><u></u></div>");

  const result = await page.evaluate(`(async () => {
    const mathAnchor = document.createElementNS(
      "http://www.w3.org/1998/Math/MathML",
      "a",
    );

    const parent = document.getElementById("parent");
    const kept = parent.children[1];
    const recordsPromise = new Promise((resolve) => {
      new MutationObserver((records) => resolve(records.map((record) => ({
        added: [...record.addedNodes].map((node) => node.localName),
        removed: [...record.removedNodes].map((node) => node.localName),
      })))).observe(parent, { childList: true });
    });
    parent.replaceChildren(kept);
    const records = await recordsPromise;

    const fragmentParent = document.createElement("div");
    const fragment = document.createDocumentFragment();
    fragment.append(document.createElement("em"), document.createElement("strong"));
    const fragmentRecords = [];
    new MutationObserver((entries) => fragmentRecords.push(...entries)).observe(
      fragmentParent,
      { childList: true },
    );
    fragmentParent.replaceChildren(fragment);
    await Promise.resolve();

    const emptyParent = document.createElement("div");
    let emptyRecords = 0;
    new MutationObserver((entries) => { emptyRecords += entries.length; }).observe(
      emptyParent,
      { childList: true },
    );
    emptyParent.replaceChildren();
    await Promise.resolve();

    const firstDoc = document.implementation.createHTMLDocument("first");
    const secondDoc = document.implementation.createHTMLDocument("second");
    const forward = firstDoc.compareDocumentPosition(secondDoc);
    const reverse = secondDoc.compareDocumentPosition(firstDoc);

    const progressResult = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      let duringProgress = "unset";
      reader.onprogress = () => { duringProgress = reader.result; };
      reader.onerror = () => reject(reader.error);
      reader.onloadend = () => resolve({
        duringProgress,
        finalResult: reader.result,
      });
      reader.readAsText(new Blob(["done"]));
    });

    const progressAbort = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onprogress = () => reader.abort();
      reader.onabort = () => resolve({
        event: "abort",
        result: reader.result,
        readyState: reader.readyState,
      });
      reader.onload = () => resolve({ event: "load" });
      reader.readAsText(new Blob(["stop"]));
    });

    return {
      mathRelList: mathAnchor.relList?.constructor.name,
      records,
      fragmentAdded: fragmentRecords[0].addedNodes.map((node) => node.localName),
      emptyRecords,
      disconnected: {
        forward,
        reverse,
        forwardAgain: firstDoc.compareDocumentPosition(secondDoc),
      },
      progressResult,
      progressAbort,
    };
  })()`);

  expect(result).toEqual({
    mathRelList: "DOMTokenList",
    records: [{ added: ["b"], removed: ["i", "b", "u"] }],
    fragmentAdded: ["em", "strong"],
    emptyRecords: 0,
    disconnected: {
      forward: 37,
      reverse: 35,
      forwardAgain: 37,
    },
    progressResult: {
      duringProgress: null,
      finalResult: "done",
    },
    progressAbort: {
      event: "abort",
      result: null,
      readyState: 2,
    },
  });
});

test("deriveBits rejects non-finite lengths before workerd coercion", async ({ page }) => {
  await setContent(page, "<title>crypto</title>");

  const result = await page.evaluate(`(async () => {
    const errorName = (length) => crypto.subtle
      .deriveBits({}, {}, length)
      .then(() => "resolved", (error) => error.name);
    return Promise.all([
      errorName(NaN),
      errorName(Infinity),
      errorName(-Infinity),
      errorName("Infinity"),
      errorName({ valueOf: () => Infinity }),
      errorName(8n),
    ]);
  })()`);

  expect(result).toEqual([
    "TypeError",
    "TypeError",
    "TypeError",
    "TypeError",
    "TypeError",
    "TypeError",
  ]);
});
