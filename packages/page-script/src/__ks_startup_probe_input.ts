// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// @ks-declaration-twin for the synthetic sibling generated per navigation.
// External bodies ride the classic bundle; descriptors retain their byte length.

export declare const html: string | null;
export declare const url: string | null;
export declare const cookies: string;
export declare const scriptDescriptors: Array<{
  src: string | null;
  kind: "classic" | "module";
  defer: boolean;
  async: boolean;
  body: string;
  prefetchedLength?: number;
  prefetchError?: string;
}>;
export declare const userAgent: string | null;
export declare const referrer: string;
// The document response's Referrer-Policy header, verbatim ("" = none).
export declare const referrerPolicy: string;
// Manifest of which user-script buckets were baked into the
// modules-map; navigate() uses these to gate dynamic-imports.
export declare const hasClassicRegular: boolean;
export declare const hasClassicAsync: boolean;
export declare const moduleScriptCount: number;
export declare const resourceDrainQuietTurns: number;
export declare const pixelFree: boolean;
export declare const fontDefer: boolean;
// The connection's UA font profile, validated by the engine (cdp/font-profile.ts).
export declare const fontProfile: string;
export declare const moduleScriptUrls: string[];
// Module URLs the navigate baked as JSON records; the runtime loader may answer only these
// from the module map when an import requests type "json".
export declare const jsonModuleUrls: string[];
export declare const cdpDebug: boolean;
export declare const lagWatchdog: boolean;
export declare const csp: string[];
export declare const metaCsp: string[];
export declare const insertedBaked: Array<{ url: string; module: string; digest: string }>;
