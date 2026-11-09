// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, it, vi } from "vitest";

// The isolate's wasm is read from the bundle, which a unit test worker does not have.
vi.mock("node:fs", () => ({
  default: {
    readdirSync: () => ["kitesurf_core_bg.wasm"],
    readFileSync: () => new Uint8Array(8),
  },
}));
import type { CallerOutboundProps, SandboxOutboundOverride } from "../src/eval/outbound.ts";
import { spawnFramePageScript } from "../src/eval/page-script.ts";

it("seals a frame isolate's outbound with its browser context's cookie jar", () => {
  const sealed: CallerOutboundProps[] = [];
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the props capture is needed.
  const sandboxOutbound = {
    external: false,
    loaded: (props: CallerOutboundProps) => {
      sealed.push(props);
      return {} as Fetcher;
    },
    session: (props: CallerOutboundProps) => {
      sealed.push(props);
      return async () => new Response(null);
    },
  } as unknown as SandboxOutboundOverride;
  spawnFramePageScript(
    {
      // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- a loader that never answers.
      LOADER: {
        load: () => ({ getEntrypoint: () => ({ openSession: () => new Promise(() => {}) }) }),
      } as unknown as WorkerLoader,
    },
    // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the tail export is read.
    { exports: { PageScriptTail: () => ({}) } } as unknown as ExecutionContext,
    {
      connectionId: "conn",
      targetId: "T",
      frameId: "F",
      frameLoaderId: "L",
      frameUrl: "https://frame.test/",
      cookieKey: "conn:context-1",
      sandboxOutbound,
    },
  );
  expect(sealed.map((p) => p.cookieKey)).toEqual(["conn:context-1", "conn:context-1"]);
});
