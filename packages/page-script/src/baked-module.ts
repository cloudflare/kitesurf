// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The baked module registry names a module by the registry name its resolver assigns, not by the
// requested URL: a query or hash variant bakes under a `.__ks_query_N` name. Every lookup into
// the bake has to go through the resolver or it misses those records.

/**
 * The registry name of `url` when this navigate baked it as a JSON record, else undefined.
 * Any other URL goes to the gate, which parses the body as JSON, never as JavaScript.
 */
export function bakedJsonModuleName(
  url: unknown,
  bakedJsonNames: ReadonlySet<string>,
  resolveRegistryUrl: (url: unknown) => string,
): string | undefined {
  const name = resolveRegistryUrl(url);
  return bakedJsonNames.has(name) ? name : undefined;
}
