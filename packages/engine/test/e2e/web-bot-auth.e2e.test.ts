// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { verify } from "web-bot-auth";
import { verifierFromJWK } from "web-bot-auth/crypto";

import { expect, test } from "./harness";
import { WBA_TEST_KEYID, WBA_TEST_PUBLIC_JWK, WBA_TEST_SIGNATURE_AGENT } from "./wba-test-key.ts";

const ORIGIN = "http://127.0.0.1:8787";
const FIXTURE_URL = `${ORIGIN}/__fixtures/echo-headers.html`;

type EchoedHeaders = Record<string, string>;

async function expectValidSignature(
  headers: EchoedHeaders,
  label: string,
  url: string = FIXTURE_URL,
): Promise<void> {
  const agent = headers["signature-agent"];
  const input = headers["signature-input"];
  const sig = headers["signature"];

  expect(agent, `${label}: signature-agent present`).toBe(`"${WBA_TEST_SIGNATURE_AGENT}"`);
  expect(sig, `${label}: signature present`).toMatch(/^sig1=:[A-Za-z0-9+/=]+:$/);
  expect(input, `${label}: covered components`).toContain('("@authority" "signature-agent")');
  expect(input, `${label}: tag`).toContain(';tag="web-bot-auth"');
  expect(input, `${label}: alg`).toContain(';alg="ed25519"');
  expect(input, `${label}: keyid is our key's thumbprint`).toContain(`keyid="${WBA_TEST_KEYID}"`);

  const received = new Request(url, {
    headers: {
      Signature: sig!,
      "Signature-Input": input!,
      "Signature-Agent": agent!,
    },
  });
  try {
    await verify(received, await verifierFromJWK(WBA_TEST_PUBLIC_JWK as JsonWebKey));
  } catch (err) {
    throw new Error(
      `${label}: signature did not verify against the published public key: ${String(err)}`,
    );
  }
}

test("web-bot-auth signs the document and subresource fetches", async ({ page }) => {
  await page.goto(FIXTURE_URL, { waitUntil: "domcontentloaded" });

  const docHeaders = (await page.evaluate("globalThis.__ks_doc_headers")) as EchoedHeaders;
  await expectValidSignature(docHeaders, "document fetch");

  await page.evaluate("globalThis.__ks_fetch_ready");
  const fetchHeaders = (await page.evaluate("globalThis.__ks_fetch_headers")) as EchoedHeaders;
  expect(fetchHeaders?.error, "in-page fetch succeeded").toBeUndefined();
  await expectValidSignature(fetchHeaders, "page fetch()");

  expect(
    fetchHeaders["signature"],
    "document and subresource share the cached per-authority signature",
  ).toBe(docHeaders["signature"]);
});

test("page code cannot forge or strip the signature", async ({ page }) => {
  await page.goto(FIXTURE_URL, { waitUntil: "domcontentloaded" });

  const forged = (await page.evaluate(`
    fetch("/__fixtures/echo-headers.json", {
      headers: {
        "signature": "sig1=:Zm9yZ2Vk:",
        "signature-input": 'sig1=("@authority");tag="web-bot-auth"',
        "signature-agent": '"https://attacker.invalid"',
      },
    }).then((r) => r.json())
  `)) as EchoedHeaders;

  expect(forged["signature"], "forged signature was replaced").not.toBe("sig1=:Zm9yZ2Vk:");
  await expectValidSignature(forged, "forged-header fetch");
});

interface PptrRequest {
  url(): string;
  continue(overrides?: { url?: string; headers?: Record<string, string> }): Promise<void>;
}

test("Fetch.continueRequest cannot strip the signature", async ({ page }) => {
  await page.setRequestInterception(true);
  page.on("request", (req: PptrRequest) => {
    if (req.url().endsWith("/echo-headers.json")) {
      void req.continue({ headers: { "x-client": "1" } });
    } else {
      void req.continue();
    }
  });
  await page.goto(FIXTURE_URL, { waitUntil: "domcontentloaded" });

  const echoed = (await page.evaluate(`
    fetch("/__fixtures/echo-headers.json").then((r) => r.json())
  `)) as EchoedHeaders;

  expect(echoed["x-client"], "the client's own header survived").toBe("1");
  await expectValidSignature(echoed, "after continue({headers})");
});

test("a cross-host URL override is re-signed for the new authority", async ({ page }) => {
  const OTHER = "https://ks-other.invalid/__fixtures/echo-headers.json";
  await page.setRequestInterception(true);
  page.on("request", (req: PptrRequest) => {
    if (req.url().endsWith("/reroute-me.json")) {
      void req.continue({ url: OTHER });
    } else {
      void req.continue();
    }
  });
  await page.goto("https://ks.invalid/__fixtures/lifecycle.html", {
    waitUntil: "domcontentloaded",
  });

  const echoed = (await page.evaluate(`
    fetch("/reroute-me.json").then((r) => r.json())
  `)) as EchoedHeaders;

  await expectValidSignature(echoed, "cross-host override", OTHER);

  const asOriginalHost = new Request("https://ks.invalid/__fixtures/reroute-me.json", {
    headers: {
      Signature: echoed["signature"]!,
      "Signature-Input": echoed["signature-input"]!,
      "Signature-Agent": echoed["signature-agent"]!,
    },
  });
  await expect(
    verify(asOriginalHost, await verifierFromJWK(WBA_TEST_PUBLIC_JWK as JsonWebKey)),
    "the carried-over original-host signature would not verify",
  ).rejects.toThrow();
});
