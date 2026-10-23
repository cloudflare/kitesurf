// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Parses SRI metadata and checks fetched script bytes against its digests.

export type SriAlgorithm = "sha256" | "sha384" | "sha512";

export interface SriMetadataEntry {
  algorithm: SriAlgorithm;
  digest: string;
}

const ALGORITHM_STRENGTH: readonly SriAlgorithm[] = ["sha256", "sha384", "sha512"];

function parseIntegrityToken(token: string): SriMetadataEntry | null {
  const noOptions = token.split("?")[0] ?? "";
  const dash = noOptions.indexOf("-");
  if (dash <= 0) return null;
  const normalizedAlgorithm = noOptions.slice(0, dash).toLowerCase();
  const algorithm = ALGORITHM_STRENGTH.find((candidate) => candidate === normalizedAlgorithm);
  const digest = noOptions.slice(dash + 1);
  if (!algorithm || !digest) return null;
  return { algorithm, digest };
}

function strongestAlgorithm(entries: readonly SriMetadataEntry[]): SriAlgorithm | undefined {
  let strongestRank = 0;
  for (const entry of entries) {
    const rank = ALGORITHM_STRENGTH.indexOf(entry.algorithm);
    if (rank > strongestRank) strongestRank = rank;
  }
  return ALGORITHM_STRENGTH[strongestRank];
}

interface SubtleDigest {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
}

function subtleCrypto(): SubtleDigest | null {
  const cryptoApi = (globalThis as { crypto?: { subtle?: SubtleDigest } }).crypto;
  return cryptoApi?.subtle ?? null;
}

const SUBTLE_NAME: Record<SriAlgorithm, string> = {
  sha256: "SHA-256",
  sha384: "SHA-384",
  sha512: "SHA-512",
};

export function parseIntegrity(attribute: string | null | undefined): SriMetadataEntry[] {
  if (!attribute) return [];
  const entries: SriMetadataEntry[] = [];
  for (const token of attribute.split(/\s+/)) {
    const entry = parseIntegrityToken(token);
    if (entry !== null) entries.push(entry);
  }
  if (entries.length === 0) return [];
  const algorithm = strongestAlgorithm(entries);
  // A weaker digest must not authorize bytes when stronger metadata is present.
  return entries.filter((entry) => entry.algorithm === algorithm);
}

function decodeBase64(value: string): Uint8Array | null {
  const BASE64_QUANTUM_LENGTH = 4;
  const BASE64_INVALID_PADDING_REMAINDER = 1;
  let normalizedBase64 = value.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const paddingLength = normalizedBase64.length % BASE64_QUANTUM_LENGTH;
  if (paddingLength === BASE64_INVALID_PADDING_REMAINDER) return null;
  if (paddingLength !== 0) {
    normalizedBase64 += "=".repeat(BASE64_QUANTUM_LENGTH - paddingLength);
  }
  try {
    const binaryString = atob(normalizedBase64);
    const decodedBytes = new Uint8Array(binaryString.length);
    for (let byteIndex = 0; byteIndex < binaryString.length; byteIndex++) {
      decodedBytes[byteIndex] = binaryString.charCodeAt(byteIndex);
    }
    return decodedBytes;
  } catch {
    return null;
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let byteIndex = 0; byteIndex < left.length; byteIndex++) {
    difference |= (left[byteIndex] as number) ^ (right[byteIndex] as number);
  }
  return difference === 0;
}

async function digestBytes(bytes: Uint8Array, algorithm: SriAlgorithm): Promise<Uint8Array | null> {
  const subtle = subtleCrypto();
  if (!subtle) return null;
  try {
    // Snapshot before WebCrypto yields so caller mutation cannot change the digest input.
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return new Uint8Array(await subtle.digest(SUBTLE_NAME[algorithm], copy));
  } catch {
    return null;
  }
}

export async function integrityMatches(
  bytes: Uint8Array,
  metadata: readonly SriMetadataEntry[],
): Promise<boolean> {
  const strongest = metadata[0];
  if (!strongest) return true;
  const actual = await digestBytes(bytes, strongest.algorithm);
  if (actual === null) return false;
  return metadata.some((entry) => matchesDigest(actual, entry));
}

function matchesDigest(actual: Uint8Array, entry: SriMetadataEntry): boolean {
  const expected = decodeBase64(entry.digest);
  return expected !== null && bytesEqual(actual, expected);
}

export async function digestBase64(
  bytes: Uint8Array,
  algorithm: SriAlgorithm,
): Promise<string | null> {
  const digest = await digestBytes(bytes, algorithm);
  if (digest === null) return null;
  try {
    let binaryString = "";
    for (const byte of digest) binaryString += String.fromCharCode(byte);
    return `${algorithm}-${btoa(binaryString)}`;
  } catch {
    return null;
  }
}
