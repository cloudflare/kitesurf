// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Names the UA font profile a connection's page isolates register. Fonts register once per
// isolate, so every isolate a connection spawns keeps the profile the connection resolved.

export const FONT_PROFILES = ["noto", "macos"] as const;
export type FontProfile = (typeof FONT_PROFILES)[number];

export const DEFAULT_FONT_PROFILE: FontProfile = "noto";

function asFontProfile(value: string): FontProfile | null {
  for (const profile of FONT_PROFILES) {
    if (profile === value) return profile;
  }
  return null;
}

// The first valid value of the host option, the `?ks_font_profile=` query parameter and the
// KITESURF_FONT_PROFILE var, else the default. Each is trimmed, as a secret often ends in a
// newline; empty means unset, and an unknown value is ignored with a warning.
export function resolveFontProfile(
  hostValue: string | undefined,
  queryValue: string | null,
  envValue: string | undefined,
): FontProfile {
  for (const [source, value] of [
    ["connectionOptions.fontProfile", hostValue?.trim()],
    ["?ks_font_profile", queryValue?.trim()],
    ["KITESURF_FONT_PROFILE", envValue?.trim()],
  ] as const) {
    if (!value) continue;
    const profile = asFontProfile(value);
    if (profile) return profile;
    console.warn(
      `[kitesurf-fonts] ignoring unknown ${source}=${JSON.stringify(value)}; ` +
        `expected one of ${FONT_PROFILES.join(", ")}`,
    );
  }
  return DEFAULT_FONT_PROFILE;
}
