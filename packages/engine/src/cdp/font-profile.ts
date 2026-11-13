// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Names the UA font profile a connection's page isolates register. Fonts register once per
// isolate, so every isolate a connection spawns keeps the profile the connection resolved.
// Core's fonts.rs owns each profile's faces (`UA_FONT_PROFILES`); keep the names in step.

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
// KITESURF_FONT_PROFILE var, else the default. Empty means unset; an unknown value is ignored
// with a warning, so a typo degrades to the default instead of failing every navigate.
export function resolveFontProfile(
  hostValue: string | undefined,
  queryValue: string | null,
  envValue: string | undefined,
): FontProfile {
  for (const [source, value] of [
    ["connectionOptions.fontProfile", hostValue],
    ["?ks_font_profile", queryValue],
    ["KITESURF_FONT_PROFILE", envValue],
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
