// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";

import { dispatch, type DispatchCtx } from "../src/cdp/dispatch.ts";
import { storageIdOrigin } from "../src/cdp/dom-storage.ts";
import { SANDBOX_ALLOW_ALL } from "@kitesurf/script-gate";
import { detachSessions } from "../src/cdp/target.ts";
import type { CdpEvent, CdpRequest, FrameState, TargetState } from "../src/cdp/types.ts";
import type { PageScriptStub } from "../src/eval/page-script.ts";
import { LOCAL_STORAGE_QUOTA_UNITS, LocalStorage } from "../src/state/local-storage.ts";
import { MemorySessionStore } from "../src/state/session-store.ts";

const A = "https://a.test";

describe("storageIdOrigin", () => {
  it.each([
    [
      { securityOrigin: A, isLocalStorage: true },
      { origin: A, isLocalStorage: true },
    ],
    [
      { storageKey: `${A}/`, isLocalStorage: false },
      { origin: A, isLocalStorage: false },
    ],
    [
      { securityOrigin: "https://b.test", storageKey: `${A}/`, isLocalStorage: true },
      { origin: A, isLocalStorage: true },
    ],
  ])("reads %j", (id, expected) => {
    expect(storageIdOrigin(id)).toEqual(expected);
  });

  it.each([
    [null, "Invalid storageId format"],
    [{ securityOrigin: A }, "Invalid storageId format"],
    [{ securityOrigin: 1, isLocalStorage: true }, "Invalid storageId format"],
    [{ securityOrigin: "", isLocalStorage: true }, "Invalid storageId format"],
    [{ storageKey: `${A}/^0https://b.test`, isLocalStorage: true }, "Partitioned storage keys"],
    [{ securityOrigin: "about:blank", isLocalStorage: true }, "Frame not found"],
    [{ securityOrigin: "not a url", isLocalStorage: true }, "Frame not found"],
  ])("rejects %j", (id, message) => {
    expect(() => storageIdOrigin(id)).toThrow(message);
  });
});

describe("DOMStorage sessions", () => {
  const B = "https://b.test";

  // A page in a second browser context comes first, where a wrong fallback would land.
  function setup() {
    const storage = new LocalStorage(new MemorySessionStore());
    const other = new LocalStorage(new MemorySessionStore());
    const emitted: CdpEvent[] = [];
    const targets = new Map<string, TargetState>();
    const page = (id: string, contextId: string, session: string) => {
      const target = {
        targetId: id,
        frameId: `${id}-frame`,
        type: "page",
        browserContextId: contextId,
        navigateGeneration: 1,
        url: `${A}/`,
        pageScriptUrl: `${A}/`,
        pageScript: null,
        sessions: new Set([session]),
        frames: new Map<string, FrameState>(),
        domStorageSessions: new Map(),
      } as TargetState;
      targets.set(id, target);
      return target;
    };
    page("elsewhere", "ctx2", "p2");
    const target = page("main", "", "p1");
    const frame = (
      frameId: string,
      url: string,
      parentFrameId: string | null,
      session?: string,
      sandbox = SANDBOX_ALLOW_ALL,
    ) => {
      const f = {
        frameId,
        parentFrameId,
        url,
        pageScriptUrl: null,
        pageScript: null,
        sandbox,
        detached: false,
        sessions: new Set(session ? [session] : []),
      } as FrameState;
      target.frames.set(frameId, f);
      return f;
    };
    frame(target.frameId, `${A}/`, null);
    // A cross-origin child with its own isolate: dispatch would hand its session to the OOPIF path.
    const child = frame("child", `${B}/`, target.frameId, "f1");
    child.pageScript = {} as PageScriptStub;
    // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the fields these read.
    const ctx = {
      browser: {
        targets,
        localStorage: storage,
        contexts: new Map([["ctx2", { localStorage: other }]]),
        networkEvents: { drain: () => {}, forgetSession: () => {} },
        rendererSessionId: null,
        engineSessionId: null,
      },
      emit: (e: CdpEvent) => emitted.push(e),
    } as unknown as DispatchCtx;
    const send = (
      sessionId: string | undefined,
      method: CdpRequest["method"],
      params: Record<string, unknown> = {},
    ) => dispatch(ctx, { id: 1, sessionId, method, params } as CdpRequest);
    // Each origin written through the page session, and the sessions that got an event for it.
    const seen = async () => {
      emitted.length = 0;
      for (const origin of [A, B]) {
        const params = { storageId: local(origin), key: "k", value: origin };
        await send("p1", "DOMStorage.setDOMStorageItem", params);
      }
      return emitted.map((e) => [
        e.sessionId,
        (e.params as { storageId: { securityOrigin: string } }).storageId.securityOrigin,
      ]);
    };
    return { ctx, storage, other, emitted, send, seen, target, frame, child };
  }

  const local = (origin: string) => ({ securityOrigin: origin, isLocalStorage: true });

  it("acts on the browser context of a frame session's page", async () => {
    const { storage, other, send } = setup();
    const params = { storageId: local(B), key: "k", value: "v" };
    expect(await send("f1", "DOMStorage.setDOMStorageItem", params)).toMatchObject({ result: {} });
    expect(storage.entries(B)).toEqual([["k", "v"]]);
    expect(other.entries(B)).toEqual([]);
    const read = await send("f1", "DOMStorage.getDOMStorageItems", { storageId: local(B) });
    expect(read).toMatchObject({ result: { entries: [["k", "v"]] } });
  });

  it("fails for a session it does not know", async () => {
    const { other, send } = setup();
    const params = { storageId: local(A), key: "k", value: "v" };
    expect(await send("nope", "DOMStorage.setDOMStorageItem", params)).toMatchObject({
      error: { message: "Session with given id not found." },
    });
    expect(other.entries(A)).toEqual([]);
  });

  it("sends each session the events of the origin its frame shows", async () => {
    const { emitted, send } = setup();
    await send("f1", "DOMStorage.enable");
    await send("p1", "DOMStorage.enable");
    for (const origin of [A, B]) {
      const params = { storageId: local(origin), key: "k", value: "v" };
      await send("p2", "DOMStorage.setDOMStorageItem", params);
      await send("p1", "DOMStorage.setDOMStorageItem", params);
    }
    const seen = emitted.map((e) => [
      e.sessionId,
      (e.params as { storageId: { securityOrigin: string } }).storageId.securityOrigin,
    ]);
    expect(seen).toEqual([
      ["p1", A],
      ["f1", B],
    ]);
  });

  it("gives about:blank and srcdoc frames their embedder's events, and opaque frames none", async () => {
    const { send, seen, target, frame, child } = setup();
    frame("srcdoc", "about:srcdoc", target.frameId, "s-srcdoc");
    frame("nested", "about:blank", child.frameId, "s-nested");
    frame("data", "data:text/html,x", target.frameId, "s-data");
    const sandbox = { ...SANDBOX_ALLOW_ALL, sameOrigin: false };
    frame("sandboxed", "about:srcdoc", target.frameId, "s-sandboxed", sandbox);
    for (const session of ["s-srcdoc", "s-nested", "s-data", "s-sandboxed"]) {
      await send(session, "DOMStorage.enable");
    }
    expect(await seen()).toEqual([
      ["s-srcdoc", A],
      ["s-nested", B],
    ]);
  });

  it("stops a session's events once the session detaches", async () => {
    const { ctx, send, seen, target, child } = setup();
    await send("f1", "DOMStorage.enable");
    detachSessions(ctx, child.sessions, target.targetId);
    // A navigation revives the frame in place.
    child.sessions.add("f2");
    expect(await seen()).toEqual([]);
  });

  it("refuses a set past the quota", async () => {
    const { storage, send } = setup();
    const value = "x".repeat(LOCAL_STORAGE_QUOTA_UNITS);
    const params = { storageId: local(A), key: "k", value };
    expect(await send("p1", "DOMStorage.setDOMStorageItem", params)).toMatchObject({
      error: { message: "Setting the value exceeded the quota" },
    });
    expect(storage.entries(A)).toEqual([]);
  });
});
