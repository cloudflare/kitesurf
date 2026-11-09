// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import { pumpBackgroundEvents } from "../src/cdp/page.ts";
import type { TargetState } from "../src/cdp/types.ts";
import { createCookieJar } from "../src/cookies.ts";
import type { PageScriptStub } from "../src/eval/page-script.ts";

const FIRST = "https://first.test/";
const NEXT = "https://next.test/";

function setup(cookieWrites: string[]) {
  const background: Promise<unknown>[] = [];
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the drain method is stubbed.
  const stub = {
    drainConsole: async () => ({ console: [], cookieWrites }),
  } as unknown as PageScriptStub;
  const target = {
    type: "page",
    targetId: "T",
    frameId: "F",
    browserContextId: "",
    url: FIRST,
    pageScriptUrl: FIRST,
    pageScript: stub,
    domEnabledSessions: new Set(["S"]),
  } as TargetState;
  const cookies = createCookieJar();
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the fields the drain reads are set.
  const ctx = {
    browser: { wsClosing: false, cookies, contexts: new Map() },
    ctx: { waitUntil: (p: Promise<unknown>) => background.push(p) },
    emit: () => {},
  } as unknown as DispatchCtx;
  const pump = async () => {
    pumpBackgroundEvents(ctx, target);
    await Promise.all(background);
  };
  return { target, cookies, pump };
}

describe("background drain cookie writes", () => {
  it("stay on the draining document while a navigate moved target.url", async () => {
    const { target, cookies, pump } = setup(["a=1; Path=/"]);
    target.url = NEXT;
    await pump();
    expect(cookies.documentCookieString(NEXT)).toBe("");
    expect(cookies.documentCookieString(FIRST)).toBe("a=1");
  });

  it("land on the document after a same-origin history change", async () => {
    const { target, cookies, pump } = setup(["a=1"]);
    target.url = `${FIRST}app/page`;
    await pump();
    expect(cookies.documentCookieString(FIRST)).toBe("a=1");
  });
});
