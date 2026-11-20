// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The DOMStorage domain. localStorage goes to the engine's area for the page's browser context,
// so it works for any http(s) origin, open or not (storage-copies.ts). sessionStorage lives in
// the page, so it works only for the origin of the page's document, as in Chrome.

import type { LocalStorageOp } from "@kitesurf/jsrpc-types/page-script";
import type { DispatchCtx } from "./dispatch.ts";
import type { CdpRequest, FrameState, TargetState } from "./types.ts";
import type { PageScriptStub } from "../eval/page-script.ts";
import { localStorageOrigin, type LocalStorage } from "../state/local-storage.ts";
import { findSessionOwner, localStorageForTarget } from "./target.ts";
import { resolveTarget } from "./page-session.ts";
import { changeLocalStorage, documentOrigin, liveCopies } from "./storage-copies.ts";

// How long a read waits for a page's flushed changes to arrive before it answers without them.
const FLUSH_WAIT_MS = 2_000;

// Ask each open copy to send its unsent changes, and wait until they are applied.
async function flushCopies(storage: LocalStorage, origin: string): Promise<void> {
  await Promise.all(
    liveCopies(storage, origin).map(async (copy) => {
      try {
        const { seq } = await copy.stub.webStorage({ op: "flush" });
        await copy.settled(seq, FLUSH_WAIT_MS);
      } catch {}
    }),
  );
}

/** The origin a DOMStorage StorageId names. Kitesurf keeps no partitioned (third-party) areas. */
export function storageIdOrigin(id: unknown): { origin: string; isLocalStorage: boolean } {
  if (typeof id !== "object" || id === null) throw new Error("Invalid storageId format");
  const { securityOrigin, storageKey, isLocalStorage } = id as Record<string, unknown>;
  const key = typeof storageKey === "string" && storageKey !== "" ? storageKey : securityOrigin;
  if (typeof isLocalStorage !== "boolean" || typeof key !== "string" || key === "") {
    throw new Error("Invalid storageId format");
  }
  // A partitioned key carries its top-level site after "^": "https://a.test/^0https://b.test".
  if (key.includes("^")) throw new Error("Partitioned storage keys are not supported");
  const origin = localStorageOrigin(key);
  if (!origin) throw new Error("Frame not found for the given storage id");
  return { origin, isLocalStorage };
}

function stringParam(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`Invalid parameters: ${name} must be a string`);
  return value;
}

function sessionStoragePage(target: TargetState, origin: string): PageScriptStub {
  if (target.type !== "page" || !target.pageScript || documentOrigin(target) !== origin) {
    throw new Error("Frame not found for the given storage id");
  }
  return target.pageScript;
}

async function changeStorage(
  ctx: DispatchCtx,
  target: TargetState,
  storageId: unknown,
  ops: LocalStorageOp[],
): Promise<Record<string, never>> {
  const { origin, isLocalStorage } = storageIdOrigin(storageId);
  if (!isLocalStorage) {
    const stub = sessionStoragePage(target, origin);
    await stub.webStorage({ op: "apply", area: "session", ops, url: target.url });
    return {};
  }
  const storage = localStorageForTarget(ctx, target);
  const result = await changeLocalStorage(ctx, storage, origin, ops, { url: target.url });
  if (result.applied.length < ops.length) throw new Error("Setting the value exceeded the quota");
  return {};
}

// A frame session acts for its page's browser context. With no session (page mode) the page
// target answers; an unknown session fails rather than act on some other page.
function sessionOwner(
  ctx: DispatchCtx,
  sessionId: string | undefined,
): { target: TargetState; frame: FrameState | null } {
  if (!sessionId) return { target: resolveTarget(ctx, undefined), frame: null };
  const owner = findSessionOwner(ctx, sessionId);
  if (!owner) throw new Error("Session with given id not found.");
  return owner;
}

export async function handleDomStorage(ctx: DispatchCtx, req: CdpRequest): Promise<unknown> {
  const { target, frame } = sessionOwner(ctx, req.sessionId);
  switch (req.method) {
    case "DOMStorage.enable":
      if (req.sessionId) target.domStorageSessions.set(req.sessionId, frame);
      return {};
    case "DOMStorage.disable":
      if (req.sessionId) target.domStorageSessions.delete(req.sessionId);
      return {};
    case "DOMStorage.getDOMStorageItems": {
      const { origin, isLocalStorage } = storageIdOrigin(req.params?.storageId);
      if (!isLocalStorage) {
        const reply = await sessionStoragePage(target, origin).webStorage({
          op: "entries",
          area: "session",
        });
        return { entries: reply.entries ?? [] };
      }
      const storage = localStorageForTarget(ctx, target);
      await flushCopies(storage, origin);
      return { entries: storage.entries(origin) };
    }
    case "DOMStorage.setDOMStorageItem": {
      const key = stringParam(req.params?.key, "key");
      const value = stringParam(req.params?.value, "value");
      return changeStorage(ctx, target, req.params?.storageId, [{ op: "set", key, value }]);
    }
    case "DOMStorage.removeDOMStorageItem": {
      const key = stringParam(req.params?.key, "key");
      return changeStorage(ctx, target, req.params?.storageId, [{ op: "remove", key }]);
    }
    case "DOMStorage.clear":
      return changeStorage(ctx, target, req.params?.storageId, [{ op: "clear" }]);
    default:
      return {};
  }
}
