// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// First generation of a tdl-style written dependency chain: this module is
// itself document.write'd, and writes the next generation from its own body.
window.__written = window.__written || [];
window.__written.push("a");
document.write('<script src="/__fixtures/written-mod-b.js"><\/script>');
