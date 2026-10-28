// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The page isolate's entry module. A host may add modules to the isolate and name a Durable
// Object class in one of them; the class lookup reads the entry's exports alone, so when a host
// names one the engine generates an entry that re-exports page.js plus that class.

const ENTRY_MODULE = "__ks_entry.js";

/** The isolate's entry: `page.js`, or a generated one re-exporting it plus a host class. */
export function pageIsolateEntry(
  modules: Record<string, unknown>,
  pageIsolate?: { modules?: Record<string, string>; hostClassName?: string },
): string {
  for (const [name, source] of Object.entries(pageIsolate?.modules ?? {})) {
    // Engine modules win: a host adds to the isolate, it never replaces its runtime.
    if (!(name in modules)) modules[name] = source;
  }
  const className = pageIsolate?.hostClassName;
  const from = Object.keys(pageIsolate?.modules ?? {})[0];
  if (!className || !/^[A-Za-z_$][\w$]*$/.test(className) || !from) return "page.js";
  // A Durable Object class is resolved from the entry module's exports alone, so the entry has
  // to re-export the host's; `export *` keeps page.js's own surface and its default entrypoint.
  modules[ENTRY_MODULE] =
    'export * from "page.js";\nexport { default } from "page.js";\n' +
    `export { ${className} } from ${JSON.stringify(from)};\n`;
  return ENTRY_MODULE;
}
