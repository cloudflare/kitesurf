// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("Blob and File types use File API normalization", async ({ page }) => {
  await setContent(page, "<p>Blob type normalization</p>");

  const actual = await page.evaluate(() => {
    const inputs = [
      "TEXT/HTML;CHARSET=GBK",
      "text/html;charset=gbk;charset=windows-1255",
      "text/html;charset=gbk(",
      "text/html;charset=\u000bgbk",
      "a",
      " image/gif ",
      "text/\u00e5",
    ];
    const errorName = (construct: () => unknown) => {
      try {
        construct();
        return null;
      } catch (error) {
        return (error as Error).name;
      }
    };
    const captureType = (construct: () => string) => {
      try {
        return { value: construct(), error: null };
      } catch (error) {
        return { value: null, error: (error as Error).name };
      }
    };
    return {
      types: inputs.map((type) => [
        new Blob([], { type }).type,
        new File([], "mime-test", { type }).type,
      ]),
      frozenTypes: [
        captureType(() => new Blob([], Object.freeze({ type: " TEXT/HTML " })).type),
        captureType(() => new File([], "mime-test", Object.freeze({ type: " TEXT/HTML " })).type),
      ],
      primitiveOptions: [
        errorName(() => Reflect.construct(Blob, [[], 1])),
        errorName(() => Reflect.construct(File, [[], "mime-test", 1])),
      ],
    };
  });

  expect(actual).toEqual({
    types: [
      ["text/html;charset=gbk", "text/html;charset=gbk"],
      ["text/html;charset=gbk;charset=windows-1255", "text/html;charset=gbk;charset=windows-1255"],
      ["text/html;charset=gbk(", "text/html;charset=gbk("],
      ["", ""],
      ["a", "a"],
      [" image/gif ", " image/gif "],
      ["", ""],
    ],
    frozenTypes: [
      { value: " text/html ", error: null },
      { value: " text/html ", error: null },
    ],
    primitiveOptions: ["TypeError", "TypeError"],
  });
});

test("Request and Response blobs retain MIME serialization", async ({ page }) => {
  await setContent(page, "<p>Response body MIME type</p>");

  const types = await page.evaluate(async () => {
    const headers = { "content-type": "TEXT/HTML;CHARSET=GBK" };
    const request = new Request("https://example.test/", {
      method: "POST",
      headers,
      body: "request body",
    });
    const response = new Response("response body", { headers });
    const shadowedResponse = new Response("shadowed body", { headers });
    Object.defineProperty(shadowedResponse, "headers", {
      get() {
        throw new Error("instance headers getter was called");
      },
    });
    const [requestBlob, responseBlob, shadowedBlob] = await Promise.all([
      request.blob(),
      response.blob(),
      shadowedResponse.blob(),
    ]);
    return [requestBlob.type, responseBlob.type, shadowedBlob.type];
  });

  expect(types).toEqual([
    "text/html;charset=GBK",
    "text/html;charset=GBK",
    "text/html;charset=GBK",
  ]);
});
