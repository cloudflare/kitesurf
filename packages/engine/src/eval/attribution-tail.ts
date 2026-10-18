// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Attaches CPU-attribution tails to workers when a connection supplies headers.

export interface AttributionTailProps {
  headers: Record<string, string>;
  scriptName: string;
}

export interface AttributionTailExports {
  AttributionTail?(opts: { props: AttributionTailProps }): Fetcher;
}

export function attributionTails(
  exports: AttributionTailExports,
  headers: Record<string, string>,
  scriptName: string,
): Fetcher[] {
  const tail = exports.AttributionTail;
  if (!tail || Object.keys(headers).length === 0) return [];
  return [tail({ props: { headers, scriptName } })];
}
