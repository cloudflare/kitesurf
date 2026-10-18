// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, it, expect, beforeEach } from "vitest";
import { verify } from "web-bot-auth";
import { verifierFromJWK } from "web-bot-auth/crypto";
import { wbaHeadersFor, __resetWbaCachesForTest, type WbaEnv } from "../src/eval/web-bot-auth.ts";

const AGENT = "https://web-bot-auth.example.workers.dev";

async function makeKeys(): Promise<{ priv: JsonWebKey; pub: JsonWebKey }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    priv: (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey,
    pub: (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey,
  };
}

function must(v: string | undefined): string {
  expect(v).toBeTypeOf("string");
  return v as string;
}

function asRequest(url: string, h: Record<string, string>): Request {
  return new Request(url, { headers: Object.entries(h) });
}

async function thumbprintOf(pub: JsonWebKey): Promise<string> {
  const canonical = `{"crv":"${pub.crv}","kty":"${pub.kty}","x":"${pub.x}"}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function envFor(priv: JsonWebKey): Promise<WbaEnv> {
  return {
    WEB_BOT_AUTH_JWK: JSON.stringify(priv),
    WEB_BOT_AUTH_SIGNATURE_AGENT: AGENT,
  };
}

beforeEach(() => {
  __resetWbaCachesForTest();
});

describe("wbaHeadersFor: disabled states", () => {
  it("returns {} with no JWK configured", async () => {
    expect(await wbaHeadersFor({ WEB_BOT_AUTH_SIGNATURE_AGENT: AGENT }, "example.com")).toEqual({});
  });

  it("returns {} with no signature agent configured", async () => {
    const { priv } = await makeKeys();
    expect(await wbaHeadersFor({ WEB_BOT_AUTH_JWK: JSON.stringify(priv) }, "example.com")).toEqual(
      {},
    );
  });

  it("returns {} for a placeholder JWK rather than throwing", async () => {
    const env = { WEB_BOT_AUTH_JWK: "{}", WEB_BOT_AUTH_SIGNATURE_AGENT: AGENT };
    expect(await wbaHeadersFor(env, "example.com")).toEqual({});
  });

  it("returns {} for unparseable JSON rather than throwing", async () => {
    const env = {
      WEB_BOT_AUTH_JWK: "not json",
      WEB_BOT_AUTH_SIGNATURE_AGENT: AGENT,
    };
    expect(await wbaHeadersFor(env, "example.com")).toEqual({});
  });

  it("returns {} for a public-only key (cannot sign)", async () => {
    const { pub } = await makeKeys();
    const env = {
      WEB_BOT_AUTH_JWK: JSON.stringify(pub),
      WEB_BOT_AUTH_SIGNATURE_AGENT: AGENT,
    };
    expect(await wbaHeadersFor(env, "example.com")).toEqual({});
  });

  it("returns {} for an empty authority", async () => {
    const { priv } = await makeKeys();
    expect(await wbaHeadersFor(await envFor(priv), "")).toEqual({});
  });
});

describe("wbaHeadersFor: header shape", () => {
  it("emits lowercase signature / signature-input / signature-agent", async () => {
    const { priv } = await makeKeys();
    const h = await wbaHeadersFor(await envFor(priv), "example.com");
    expect(Object.keys(h).sort()).toEqual(["signature", "signature-agent", "signature-input"]);
  });

  it("quotes the signature agent as an RFC 8941 sf-string", async () => {
    const { priv } = await makeKeys();
    const h = await wbaHeadersFor(await envFor(priv), "example.com");
    expect(must(h["signature-agent"])).toBe(`"${AGENT}"`);
  });

  it("covers @authority + signature-agent and tags web-bot-auth", async () => {
    const { priv } = await makeKeys();
    const h = await wbaHeadersFor(await envFor(priv), "example.com");
    expect(must(h["signature-input"])).toMatch(/^sig1=\("@authority" "signature-agent"\);/);
    expect(must(h["signature-input"])).toContain(';tag="web-bot-auth"');
    expect(must(h["signature-input"])).toContain(';alg="ed25519"');
    expect(must(h["signature"])).toMatch(/^sig1=:[A-Za-z0-9+/=]+:$/);
  });

  it("derives keyid as the JWK thumbprint, not the JWK's kid", async () => {
    const { priv, pub } = await makeKeys();
    const env = await envFor({ ...priv, kid: "a-kid-we-must-ignore" } as JsonWebKey);
    const h = await wbaHeadersFor(env, "example.com");
    const thumbprint = await thumbprintOf(pub);
    expect(must(h["signature-input"])).toContain(`keyid="${thumbprint}"`);
    expect(must(h["signature-input"])).not.toContain("a-kid-we-must-ignore");
  });

  it("expires 5 minutes after created", async () => {
    const { priv } = await makeKeys();
    const h = await wbaHeadersFor(await envFor(priv), "example.com");
    const created = Number(/;created=(\d+)/.exec(must(h["signature-input"]))![1]);
    const expires = Number(/;expires=(\d+)/.exec(must(h["signature-input"]))![1]);
    expect(expires - created).toBe(300);
  });
});

describe("wbaHeadersFor: verification roundtrip", () => {
  it("verifies against the public key for the signed authority", async () => {
    const { priv, pub } = await makeKeys();
    const h = await wbaHeadersFor(await envFor(priv), "example.com");
    const received = asRequest("https://example.com/some/path", h);
    await verify(received, await verifierFromJWK(pub));
  });

  it("rejects a signature replayed onto a different authority", async () => {
    const { priv, pub } = await makeKeys();
    const h = await wbaHeadersFor(await envFor(priv), "example.com");
    const replayed = asRequest("https://evil.example/", h);
    await expect(verify(replayed, await verifierFromJWK(pub))).rejects.toThrow();
  });

  it("rejects a signature whose signature-agent was tampered with", async () => {
    const { priv, pub } = await makeKeys();
    const h = await wbaHeadersFor(await envFor(priv), "example.com");
    const tampered = asRequest("https://example.com/", {
      ...h,
      "signature-agent": '"https://attacker.example"',
    });
    await expect(verify(tampered, await verifierFromJWK(pub))).rejects.toThrow();
  });
});

describe("wbaHeadersFor: caching", () => {
  it("reuses one signature across requests to the same authority", async () => {
    const { priv } = await makeKeys();
    const env = await envFor(priv);
    const a = await wbaHeadersFor(env, "example.com");
    const b = await wbaHeadersFor(env, "example.com");
    expect(must(b["signature"])).toBe(must(a["signature"]));
  });

  it("signs each authority separately", async () => {
    const { priv } = await makeKeys();
    const env = await envFor(priv);
    const a = await wbaHeadersFor(env, "example.com");
    const b = await wbaHeadersFor(env, "cdn.example.net");
    expect(must(b["signature"])).not.toBe(must(a["signature"]));
  });

  it("treats a non-default port as a distinct authority", async () => {
    const { priv } = await makeKeys();
    const env = await envFor(priv);
    const a = await wbaHeadersFor(env, "example.com");
    const b = await wbaHeadersFor(env, "example.com:8443");
    expect(must(b["signature"])).not.toBe(must(a["signature"]));
  });

  it("collapses concurrent first-requests into a single signature", async () => {
    const { priv } = await makeKeys();
    const env = await envFor(priv);
    const [a, b, c] = await Promise.all([
      wbaHeadersFor(env, "example.com"),
      wbaHeadersFor(env, "example.com"),
      wbaHeadersFor(env, "example.com"),
    ]);
    expect(must(b["signature"])).toBe(must(a["signature"]));
    expect(must(c["signature"])).toBe(must(a["signature"]));
  });

  it("signs a port-qualified authority that verifies at that origin", async () => {
    const { priv, pub } = await makeKeys();
    const h = await wbaHeadersFor(await envFor(priv), "example.com:8443");
    const received = asRequest("https://example.com:8443/x", h);
    await verify(received, await verifierFromJWK(pub));
  });
});
