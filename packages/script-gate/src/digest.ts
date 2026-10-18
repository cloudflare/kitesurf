// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Hashes UTF-16 script-source code units for baked-script identity checks.

export async function scriptSourceDigest(source: string): Promise<string> {
  const SCRIPT_DIGEST_HEX_RADIX = 16;
  const SCRIPT_DIGEST_HEX_BYTE_WIDTH = 2;
  const units = new Uint16Array(source.length);
  for (let codeUnitIndex = 0; codeUnitIndex < source.length; codeUnitIndex++) {
    units[codeUnitIndex] = source.charCodeAt(codeUnitIndex);
  }
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", units));
  let hex = "";
  for (const byte of hash) {
    hex += byte.toString(SCRIPT_DIGEST_HEX_RADIX).padStart(SCRIPT_DIGEST_HEX_BYTE_WIDTH, "0");
  }
  return hex;
}
