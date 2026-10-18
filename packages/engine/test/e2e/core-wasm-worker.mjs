// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { __setBridgeFetchResource, DomHandle, initSync } from "../../../core/pkg/kitesurf_core.js";
import coreWasm from "../../../core/pkg/kitesurf_core_bg.wasm";

__setBridgeFetchResource(() => {});
initSync({ module: coreWasm });

function panicUnwind() {
  const dom = new DomHandle("<!doctype html><p>hi</p>", "https://x.invalid/");
  try {
    const before = { nodeCount: dom.nodeCount(), isPoisoned: dom.isPoisoned() };
    let threw = false;
    try {
      dom.panicProbe("borrow-mut-then-panic");
    } catch {
      threw = true;
    }
    const after = { nodeCount: dom.nodeCount(), isPoisoned: dom.isPoisoned() };
    return { before, threw, after };
  } finally {
    dom.free();
  }
}

export default {
  /** @returns {Response} */
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/panic-unwind") return Response.json(panicUnwind());
    return new Response("not found\n", { status: 404 });
  },
};
