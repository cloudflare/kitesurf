// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// page-script modules load through vi.importActual: engine's tsconfig must not type-check them.

import type { SessionOutbound } from "@kitesurf/jsrpc-types/page-script";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { installFetchShim } = (await vi.importActual("../../page-script/src/fetch-shim.ts")) as {
  installFetchShim: () => void;
};
const { cancelSessionResponseBodies, clearSessionOutbound, setSessionOutbound } =
  (await vi.importActual("../../page-script/src/session-outbound.ts")) as {
    cancelSessionResponseBodies: () => void;
    clearSessionOutbound: (stub: SessionOutbound) => void;
    setSessionOutbound: (stub: SessionOutbound) => void;
  };
const { state } = (await vi.importActual("../../page-script/src/state.ts")) as {
  state: { pageUrl: string; documentOrigin: string };
};

const PAGE_URL = "https://origin.test/page.html";
const REDIRECT_URL = "https://origin.test/hop";
const TARGET_URL = "https://origin.test/target";
const CROSS_ORIGIN_URL = "https://other.test/asset";

const originalFetch = globalThis.fetch;
const originalPageUrl = state.pageUrl;
const originalDocumentOrigin = state.documentOrigin;

beforeAll(() => {
  state.pageUrl = PAGE_URL;
  state.documentOrigin = new URL(PAGE_URL).origin;
  installFetchShim();
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  state.pageUrl = originalPageUrl;
  state.documentOrigin = originalDocumentOrigin;
});

let installed: SessionOutbound | null = null;

afterEach(() => {
  cancelSessionResponseBodies();
  if (installed) clearSessionOutbound(installed);
  installed = null;
});

// A redirect whose body stays open until the client cancels it.
function redirectWithOpenBody(onCancel: () => void): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("moved"));
    },
    cancel() {
      onCancel();
    },
  });
  return new Response(body, { status: 302, headers: { location: TARGET_URL } });
}

function routeRedirectThenTarget(onRedirectCancel: () => void): void {
  installed = async (request) =>
    request.url === REDIRECT_URL
      ? redirectWithOpenBody(onRedirectCancel)
      : new Response("arrived", { status: 200 });
  setSessionOutbound(installed);
}

describe("fetch shim redirect bodies", () => {
  it("ends the body of a redirect it follows", async () => {
    let cancelled = false;
    routeRedirectThenTarget(() => {
      cancelled = true;
    });

    const response = await fetch(REDIRECT_URL);

    expect(cancelled).toBe(true);
    expect(await response.text()).toBe("arrived");
    expect(response.redirected).toBe(true);
  });

  it("ends the body of a manual redirect it returns as opaque", async () => {
    let cancelled = false;
    routeRedirectThenTarget(() => {
      cancelled = true;
    });

    const response = await fetch(REDIRECT_URL, { redirect: "manual" });

    expect(response.type).toBe("opaqueredirect");
    expect(cancelled).toBe(true);
  });

  it("ends the body of a cross-origin response it returns as opaque", async () => {
    let cancelled = false;
    installed = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 },
      );
    setSessionOutbound(installed);

    // Workers' RequestInit omits mode, but page code passes it and the shim reads it.
    const noCors = { method: "GET", mode: "no-cors" };
    const response = await fetch(CROSS_ORIGIN_URL, noCors);

    expect(response.type).toBe("opaque");
    expect(cancelled).toBe(true);
  });
});
