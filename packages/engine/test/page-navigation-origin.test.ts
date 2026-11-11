// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A page-started navigation carries the answering document's origin to the transport. The
// redirect walk selects cookies for every hop, so outbound must not reselect them from the
// destination, and the POST identity must not be replaced by the destination.

import { afterEach, describe, expect, it } from "vitest";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import { registerCookieJar, unregisterCookieJar } from "../src/cdp/cookie-jar-registry.ts";
import { handleInput } from "../src/cdp/input.ts";
import { NetworkEventTracker } from "../src/cdp/network-events.ts";
import { handlePage, installUpstreamEventHandler } from "../src/cdp/page.ts";
import { createPageTarget } from "../src/cdp/target.ts";
import type { CdpRequest } from "../src/cdp/types.ts";
import { createCookieJar } from "../src/cookies.ts";
import {
  createSandboxOutboundOverride,
  type SandboxOutboundEnv,
  type SandboxOutboundExports,
} from "../src/eval/outbound.ts";
import type { PageScriptStub, UpstreamEventHandler } from "../src/eval/page-script.ts";

const CONN = "page-navigation-origin";
const SID = "session-1";
const VICTIM = "https://victim.test/";
const ATTACKER = "https://attacker.test";

type Sent = [
  method: string,
  url: string,
  body: string,
  contentType: string | null,
  origin: string | null,
  referer: string | null,
  cookie: string | null,
];

interface NavigateOptions {
  url: string;
  initiatorOrigin?: string;
  postData?: string;
  postContentType?: string;
  via?: "input" | "event";
}

async function navigate(opts: NavigateOptions) {
  const sent: Sent[] = [];
  const jar = createCookieJar();
  jar.setFromHeader(VICTIM, "session=1; Secure; HttpOnly; SameSite=Strict");
  registerCookieJar(CONN, jar);
  const sandboxOutbound = createSandboxOutboundOverride(
    {} as SandboxOutboundExports,
    {} as SandboxOutboundEnv,
    {
      fetch: async (req) => {
        sent.push([
          req.method,
          req.url,
          await req.text(),
          req.headers.get("content-type"),
          req.headers.get("origin"),
          req.headers.get("referer"),
          req.headers.get("cookie"),
        ]);
        return new Response(null, { status: 204 });
      },
    },
  );
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only fields navigate reads.
  const browser = {
    targets: new Map(),
    sandboxOutbound,
    cookies: jar,
    contexts: new Map(),
    networkEvents: new NetworkEventTracker(() => {}, CONN),
    dedicatedWorkers: { terminateTarget: () => {}, terminateFrame: () => {}, ownerFor: () => null },
  } as unknown as DispatchCtx["browser"];
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only fields navigate reads.
  const ctx = {
    browser,
    emit: () => {},
    env: {},
    ctx: { waitUntil: () => {} },
    connectionId: CONN,
  } as unknown as DispatchCtx;
  const target = createPageTarget(ctx, "about:blank");
  target.sessions.add(SID);
  const post = { url: opts.url, postData: opts.postData, postContentType: opts.postContentType };
  if (opts.via) {
    let handler: UpstreamEventHandler | null = null;
    // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the page-realm fields.
    const stub = {
      dispatchMouseEvent: async () => ({ navigatePost: post }),
      setUpstreamEventHandler: (h: UpstreamEventHandler | null) => (handler = h),
    } as unknown as PageScriptStub;
    installUpstreamEventHandler(ctx, target, stub, target.navigateGeneration, ATTACKER);
    if (opts.via === "input") {
      target.pageScript = stub;
      await handleInput(ctx, {
        id: 1,
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseReleased", x: 1, y: 1, button: "left", clickCount: 1 },
        sessionId: SID,
      });
    } else {
      handler!("kitesurf.formSubmitNavigate", post);
      await new Promise((resolve) => setTimeout(resolve, 0)); // the dispatch is not awaited.
    }
    return sent;
  }
  await handlePage(ctx, {
    id: 1,
    method: "Page.navigate",
    params: {
      url: opts.url,
      _kitesurfInternal: true,
      _kitesurfInitiatorOrigin: opts.initiatorOrigin,
      ...(opts.postData !== undefined
        ? { _kitesurfPostData: opts.postData, _kitesurfPostContentType: "application/json" }
        : {}),
    },
    sessionId: SID,
  } as CdpRequest);
  return sent;
}

afterEach(() => {
  unregisterCookieJar(CONN);
});

const cases: Array<[string, NavigateOptions, Sent[]]> = [
  [
    "a cross-site POST keeps its initiator and no Strict cookie",
    { url: VICTIM, initiatorOrigin: ATTACKER, postData: "{}" },
    [["POST", VICTIM, "{}", "application/json", ATTACKER, `${ATTACKER}/`, null]],
  ],
  [
    "a CDP navigation with no initiator keeps Strict",
    { url: VICTIM },
    [["GET", VICTIM, "", null, null, VICTIM, "session=1"]],
  ],
  [
    "an opaque initiator cannot reach a loopback address",
    { url: "http://127.0.0.1:9222/json", initiatorOrigin: "null" },
    [],
  ],
];

const FORM_POST: Sent[] = [["POST", VICTIM, "a=1", "text/plain", ATTACKER, `${ATTACKER}/`, null]];

describe("a page-started document navigation", () => {
  it.each(cases)("%s", async (_name, opts, expected) => {
    expect(await navigate(opts)).toEqual(expected);
  });

  it.each(["input", "event"] as const)("takes only a real form's enctype from %s", async (via) => {
    const form = { url: VICTIM, via, postData: "a=1" };
    expect(await navigate({ ...form, postContentType: "application/json" })).toEqual([]);
    expect(await navigate({ ...form, postContentType: "text/plain" })).toEqual(FORM_POST);
  });
});
