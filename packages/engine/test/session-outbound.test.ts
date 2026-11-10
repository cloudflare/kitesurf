// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A routed fetch whose signal aborts before the session stub answers still resolves on the
// private continuation. Nobody is left to read that response, so its body must be cancelled.
// page-script modules load through vi.importActual: engine's tsconfig must not type-check them.

import { afterEach, expect, it, vi } from "vitest";

type Stub = (request: unknown) => Promise<Response>;

const sessionOutbound = (await vi.importActual("../../page-script/src/session-outbound.ts")) as {
  routeViaSession: (native: typeof globalThis.fetch) => typeof globalThis.fetch;
  setSessionOutbound: (stub: Stub) => void;
  clearSessionOutbound: (stub: Stub) => void;
};

let installed: Stub | null = null;

afterEach(() => {
  if (installed) sessionOutbound.clearSessionOutbound(installed);
  installed = null;
});

it("cancels a response body that arrives after the abort", async () => {
  let release!: (response: Response) => void;
  let requested!: () => void;
  const inFlight = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const stub: Stub = () => {
    requested();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  };
  installed = stub;
  sessionOutbound.setSessionOutbound(stub);

  const routed = sessionOutbound.routeViaSession(globalThis.fetch);
  const controller = new AbortController();
  // The page fetch shim follows redirects itself and hands the session a manual request.
  const pending = routed("https://ks.invalid/sse", {
    signal: controller.signal,
    redirect: "manual",
  });
  await inFlight;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });

  let canceled = false;
  release(
    new Response(
      new ReadableStream({
        cancel() {
          canceled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(canceled).toBe(true);
});
