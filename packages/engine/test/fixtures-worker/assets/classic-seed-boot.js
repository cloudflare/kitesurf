// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// SvelteKit's bootstrap shape: an EXTERNAL classic script whose only job
// is a literal dynamic import of the real entry. The specifier is
// relative to this script's URL, not the document's.
import("./classic-seed-chunk.js").then(
  (m) => {
    const el = document.getElementById("out");
    el.textContent = m.label;
    el.setAttribute("data-done", "1");
  },
  (e) => {
    const el = document.getElementById("out");
    el.textContent = "err:" + String((e && e.message) || e).slice(0, 200);
    el.setAttribute("data-done", "1");
  },
);
