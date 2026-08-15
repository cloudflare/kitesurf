// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Second generation: only reachable if the drain re-checks for scripts
// written BY a written script, rather than awaiting its initial snapshot.
window.__written = window.__written || [];
window.__written.push("b");
