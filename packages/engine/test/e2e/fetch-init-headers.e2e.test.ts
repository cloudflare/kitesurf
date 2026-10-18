// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("Request and Response accept frozen init dictionaries", async ({ page }) => {
  await setContent(page, "<p>Frozen fetch options</p>");

  const results = await page.evaluate(() => {
    const capture = (construct: () => string | null) => {
      try {
        return { value: construct(), error: null };
      } catch (error) {
        return { value: null, error: (error as Error).name };
      }
    };
    const request = capture(() => {
      const init = Object.freeze({
        headers: Object.freeze({ "x-test": "request" }),
      });
      return new Request("https://example.test/", init).headers.get("x-test");
    });
    const response = capture(() => {
      const init = Object.freeze({
        headers: Object.freeze({ "x-test": "response" }),
      });
      return new Response("body", init).headers.get("x-test");
    });
    return { request, response };
  });

  expect(results).toEqual({
    request: { value: "request", error: null },
    response: { value: "response", error: null },
  });
});

test("Request header sequences follow single-read Web IDL iteration", async ({ page }) => {
  await setContent(page, "<p>Header sequence conversion</p>");

  const actual = await page.evaluate(() => {
    const capture = (construct: () => string | null) => {
      try {
        return { value: construct(), error: null };
      } catch (error) {
        return { value: null, error: (error as Error).name };
      }
    };
    let nextGetterReads = 0;
    let step = 0;
    const iterator = Object.defineProperty({}, "next", {
      get() {
        nextGetterReads++;
        if (nextGetterReads > 1) throw new Error("next getter read twice");
        return () => (step++ === 0 ? { done: false, value: ["x-test", "yes"] } : { done: true });
      },
    });
    const headers = {
      [Symbol.iterator]() {
        return iterator;
      },
    };
    const iteratorRequest = capture(() =>
      new Request("https://example.test/", { headers: headers as never }).headers.get("x-test"),
    );
    const arrayLikePairRequest = capture(() =>
      new Request("https://example.test/", {
        headers: [{ 0: "x-test", 1: "yes", length: 2 }] as never,
      }).headers.get("x-test"),
    );
    const primitivePairRequest = capture(() =>
      new Request("https://example.test/", { headers: ["xy"] as never }).headers.get("x-test"),
    );
    const primitiveHeaderRequests = [1, true, ""].map((headers) =>
      capture(() =>
        new Request("https://example.test/", { headers: headers as never }).headers.get("x-test"),
      ),
    );
    return {
      iteratorRequest,
      nextGetterReads,
      arrayLikePairRequest,
      primitivePairRequest,
      primitiveHeaderRequests,
    };
  });

  expect(actual).toEqual({
    iteratorRequest: { value: "yes", error: null },
    nextGetterReads: 1,
    arrayLikePairRequest: { value: null, error: "TypeError" },
    primitivePairRequest: { value: null, error: "TypeError" },
    primitiveHeaderRequests: [
      { value: null, error: "TypeError" },
      { value: null, error: "TypeError" },
      { value: null, error: "TypeError" },
    ],
  });
});
