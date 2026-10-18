// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Creates cached Web Bot Auth signature headers for outbound request authorities.

import { signatureHeaders, type Signer } from "web-bot-auth";
import { signerFromJWK } from "web-bot-auth/crypto";

export interface WbaEnv {
  WEB_BOT_AUTH_JWK?: string;
  WEB_BOT_AUTH_SIGNATURE_AGENT?: string;
}

const SIGNATURE_TTL_MS = 5 * 60_000;

const REFRESH_SKEW_MS = 30_000;

const signatureCache = new Map<
  string,
  { headers: Promise<Record<string, string>>; expiresAt: number }
>();

const MAX_CACHED_AUTHORITIES = 256;

const signerCache = new Map<string, Promise<Signer>>();

export const WBA_HEADER_NAMES = ["signature", "signature-input", "signature-agent"] as const;

function isEd25519PrivateJwk(v: unknown): v is JsonWebKey {
  if (typeof v !== "object" || v === null) return false;
  const jwk = v as Record<string, unknown>;
  return (
    jwk.kty === "OKP" &&
    jwk.crv === "Ed25519" &&
    typeof jwk.x === "string" &&
    typeof jwk.d === "string"
  );
}

const loggedFailures = new Set<string>();
function logOnce(reason: string, detail: unknown): void {
  if (loggedFailures.has(reason)) return;
  loggedFailures.add(reason);
  console.error(`[kitesurf] web-bot-auth ${reason}:`, detail);
}

function getSigner(jwkJson: string): Promise<Signer> | null {
  const cached = signerCache.get(jwkJson);
  if (cached) return cached;
  let jwk: unknown;
  try {
    jwk = JSON.parse(jwkJson);
  } catch (err) {
    logOnce("jwk-parse-failed", err);
    return null;
  }
  if (!isEd25519PrivateJwk(jwk)) {
    logOnce("jwk-not-ed25519-private", "expected {kty:'OKP',crv:'Ed25519',x,d}");
    return null;
  }
  const signer = signerFromJWK(jwk).catch((err: unknown) => {
    signerCache.delete(jwkJson);
    logOnce("signer-import-failed", err);
    throw err;
  });
  signerCache.set(jwkJson, signer);
  return signer;
}

function signatureAgentHeaderValue(agent: string): string {
  return JSON.stringify(agent);
}

/** Returns signed headers for an authority, or `{}` when signing is unavailable or fails. */
export async function wbaHeadersFor(
  env: WbaEnv,
  authority: string,
): Promise<Record<string, string>> {
  const jwkJson = env.WEB_BOT_AUTH_JWK;
  const agent = env.WEB_BOT_AUTH_SIGNATURE_AGENT;
  if (!jwkJson || !agent || !authority) return {};

  const now = Date.now();
  const cached = signatureCache.get(authority);
  if (cached && cached.expiresAt > now) return cached.headers;

  const signerPromise = getSigner(jwkJson);
  if (!signerPromise) return {};

  const agentHeader = signatureAgentHeaderValue(agent);
  const created = new Date(now);
  const headers = (async () => {
    const signer = await signerPromise;
    const signed = await signatureHeaders(
      new Request(`https://${authority}/`, {
        headers: { "Signature-Agent": agentHeader },
      }),
      signer,
      { created, expires: new Date(now + SIGNATURE_TTL_MS) },
    );
    return {
      signature: signed["Signature"],
      "signature-input": signed["Signature-Input"],
      "signature-agent": agentHeader,
    };
  })().catch((err: unknown) => {
    signatureCache.delete(authority);
    logOnce("sign-failed", err);
    return {};
  });

  if (signatureCache.size >= MAX_CACHED_AUTHORITIES) {
    const oldest = signatureCache.keys().next();
    if (!oldest.done) signatureCache.delete(oldest.value);
  }
  signatureCache.set(authority, {
    headers,
    expiresAt: now + SIGNATURE_TTL_MS - REFRESH_SKEW_MS,
  });
  return headers;
}

export function __resetWbaCachesForTest(): void {
  signatureCache.clear();
  signerCache.clear();
  loggedFailures.clear();
}
