// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Top-level await on a fetch. At module init the init shim parks the
// fetch, so the import() stays pending until the page-script's module
// loop drains the shims for it; the module then finishes inside the
// settle window, before DOMContentLoaded.
const response = await fetch("/__fixtures/module-registry-config.json");
const config = await response.json();
globalThis.registryTla = {
  greeting: config.greeting,
  dclBefore: globalThis.registryDcl === true,
};
