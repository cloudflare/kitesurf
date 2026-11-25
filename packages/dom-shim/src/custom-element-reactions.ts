// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Markup setters are [CEReactions]: what they parse upgrades when the outermost one returns, so a
// constructor sees its element in place rather than in insertAdjacentHTML's scratch element.

import { ksInternals } from "./internals.js";
import { dom, inScriptlessDocument } from "./state.js";

let depth = 0;
let parsed: number[][] = [];

export function withCustomElementReactions<T>(run: () => T): T {
  depth++;
  try {
    return run();
  } finally {
    depth--;
    if (depth === 0 && parsed.length > 0) {
      const batches = parsed;
      parsed = [];
      const upgrade = ksInternals.upgradeParsedCustomElements;
      for (const ids of batches) {
        try {
          upgrade?.(ids);
        } catch {}
      }
    }
  }
}

// PageScript installs the hook with its first definition, so a page without custom elements
// records nothing; a document with no browsing context has no registry to upgrade from.
export function recordParsedChildren(parent: { _id: number }): void {
  if (depth === 0 || typeof ksInternals.upgradeParsedCustomElements !== "function") return;
  if (inScriptlessDocument(parent)) return;
  parsed.push(Array.from(dom.childIds(parent._id)));
}
