// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Fetch.fulfillRequest's responsePhrase is the fulfilled response's status text. Without it the
// status text is empty: workerd follows the Fetch spec and no longer derives one from the status.

import { expect, test } from "./harness";

interface RequestPaused {
  requestId: string;
  request: { url: string };
}

test("Fetch.fulfillRequest uses responsePhrase as the status text", async ({
  page,
  cdpSession: cdp,
}) => {
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/phrase/*" }] });
  cdp.on("Fetch.requestPaused", (event) => {
    const { requestId, request } = event as RequestPaused;
    const withPhrase = !request.url.endsWith("/none");
    void cdp.send("Fetch.fulfillRequest", {
      requestId,
      responseCode: 422,
      ...(withPhrase ? { responsePhrase: "Unprocessable Entity" } : {}),
      responseHeaders: [{ name: "content-type", value: "text/html" }],
      body: btoa("<p>fulfilled</p>"),
    });
  });

  const response = await page.goto("https://ks.invalid/phrase/doc", {
    waitUntil: "domcontentloaded",
  });
  expect(response?.status()).toBe(422);
  expect(response?.statusText()).toBe("Unprocessable Entity");

  const statuses = await page.evaluate(async () => {
    const read = async (path: string) => {
      const r = await fetch(path);
      return `${r.status} ${JSON.stringify(r.statusText)}`;
    };
    return [await read("/phrase/sub"), await read("/phrase/none")];
  });
  expect(statuses).toEqual(['422 "Unprocessable Entity"', '422 ""']);
}, 120_000);

test("Fetch.fulfillRequest rejects a phrase that is not a reason-phrase", async ({
  page,
  cdpSession: cdp,
}) => {
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/bad-phrase" }] });
  const rejected = new Promise<string>((resolve) => {
    cdp.on("Fetch.requestPaused", (event) => {
      const { requestId } = event as RequestPaused;
      cdp
        .send("Fetch.fulfillRequest", { requestId, responseCode: 200, responsePhrase: "a\nb" })
        .then(
          () => resolve("accepted"),
          (error: Error) => {
            resolve(error.message);
            void cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 200, body: "" });
          },
        );
    });
  });
  await page.goto("https://ks.invalid/__fixtures/lifecycle.html", {
    waitUntil: "domcontentloaded",
  });
  const status = await page.evaluate(() => fetch("/bad-phrase").then((r) => r.status));
  expect(await rejected).toContain("Invalid http status code or phrase");
  expect(status).toBe(200);
}, 120_000);
