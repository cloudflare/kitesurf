// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// @ks-declaration-twin for the runtime-resolved sibling `./__ks_import_map.js`.

export declare function resolveImportMap(specifier: unknown, importer: string): string;

// Throws for a name outside http(s): the registry also holds this isolate's own modules.
export declare function resolveModuleRegistryUrl(url: unknown): string;
