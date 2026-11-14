// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Resolves CDP targets to PageScript generations and routes typed DOM queries.

import type { Protocol } from "devtools-protocol";
import type { DispatchCtx } from "./dispatch.ts";
import { RawJsonResult, type TargetState } from "./types.ts";
import { withDeadline } from "../read-capped.ts";
import type { PageScriptStub } from "../eval/page-script.ts";
import type { PageScriptSession } from "@kitesurf/jsrpc-types/page-script";
export type {
  EnumeratedStyleSheet,
  QueryDomArgs,
  QueryDomMethod,
  QueryDomMethods,
  QueryDomResult,
} from "@kitesurf/jsrpc-types/query-dom";
import type {
  AccessibilityBudgetError,
  QueryDomArgs,
  QueryDomMethod,
  QueryDomResult,
  ReadStamp,
} from "@kitesurf/jsrpc-types/query-dom";

export type QueryDomCarrier = Pick<PageScriptSession, "queryDom">;

export function stubQueryDom<M extends QueryDomMethod>(
  stub: QueryDomCarrier,
  method: M,
  args: QueryDomArgs<M>,
): Promise<QueryDomResult<M>> {
  return stub.queryDom(method, args);
}

// Matches the PageScript RPC call budget; the cap is far above any page the isolate can hold.
const OUTER_HTML_READ_DEADLINE_MS = 60_000;
const MAX_OUTER_HTML_BYTES = 512 * 1024 * 1024;
const ACCESSIBILITY_READ_DEADLINE_MS = 60_000;
const MAX_ACCESSIBILITY_BYTES = 512 * 1024 * 1024;

type OuterHtmlRequest = (
  args: Pick<QueryDomArgs<"getOuterHTML">, "snapshot">,
) => Promise<QueryDomResult<"getOuterHTML">>;

/**
 * A `Protocol.DOM.GetOuterHTMLResponse` as JSON text, escaped a chunk at a time, so a large page
 * is never held as bytes, a decoded string and that string's JSON copy at once.
 */
export async function outerHtmlResponse(request: OuterHtmlRequest): Promise<RawJsonResult> {
  const live = await readOuterHtml(await request({}));
  if (live.complete) return outerHtmlJson(live.escaped);
  // The DOM changed while the live stream was read; a snapshot cannot tear.
  const snapshot = await readOuterHtml(await request({ snapshot: true }));
  if (snapshot.complete) return outerHtmlJson(snapshot.escaped);
  throw new Error(
    `DOM.getOuterHTML: PageScript stream ended after ${snapshot.filled} of ${snapshot.byteLength} bytes`,
  );
}

// `JSON.stringify` escapes each code point alone, and a streaming decode never splits one, so
// the pieces join to what stringifying the whole string gives.
function outerHtmlJson(escaped: readonly string[]): RawJsonResult {
  return new RawJsonResult(['{"outerHTML":"', ...escaped, '"}'], () => {
    const outerHTML = escaped.map(unescapeJsonPiece).join("");
    return { outerHTML } satisfies Protocol.DOM.GetOuterHTMLResponse;
  });
}

function unescapeJsonPiece(piece: string): string {
  const text: unknown = JSON.parse(`"${piece}"`);
  if (typeof text !== "string") throw new TypeError("DOM.getOuterHTML: piece is not a string");
  return text;
}

// A short read keeps no text, so a retry does not hold the discarded pieces.
type OuterHtmlRead =
  | { complete: true; escaped: string[] }
  | { complete: false; filled: number; byteLength: number };

async function readOuterHtml(result: QueryDomResult<"getOuterHTML">): Promise<OuterHtmlRead> {
  const { byteLength } = result;
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_OUTER_HTML_BYTES) {
    await result.outerHTMLUtf8.cancel("invalid byteLength").catch(() => {});
    throw new Error(`DOM.getOuterHTML: PageScript sent an invalid byteLength ${byteLength}`);
  }

  const { escaped, filled } = await readEscapedStream(result.outerHTMLUtf8, byteLength);
  if (filled !== byteLength) return { complete: false, filled, byteLength };
  return { complete: true, escaped };
}

/** Reads the whole stream as JSON-escaped pieces, or reports how many bytes arrived. */
async function readEscapedStream(
  stream: ReadableStream<Uint8Array>,
  byteLength: number,
): Promise<{ escaped: string[]; filled: number }> {
  // Same decoder options as the wasm-bindgen string return this replaced, so output is identical.
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
  const escaped: string[] = [];
  const escape = (text: string) => {
    if (text) escaped.push(JSON.stringify(text).slice(1, -1));
  };
  // The RPC deadline ends when the result arrives, so the stream needs its own.
  const reader = withDeadline(stream, OUTER_HTML_READ_DEADLINE_MS).getReader();
  let filled = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > byteLength - filled) {
        throw new Error(`DOM.getOuterHTML: PageScript sent more than ${byteLength} bytes`);
      }
      escape(decoder.decode(value, { stream: true }));
      filled += value.byteLength;
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  // Only a complete read flushes the decoder: a truncated stream may end mid-character.
  if (filled === byteLength) escape(decoder.decode());
  return { escaped, filled };
}

export type AccessibilityTreeRequest = (
  buffered: boolean,
) => Promise<QueryDomResult<"accessibilityTree">>;

export type AccessibilityTreeReply =
  | { budgetError: AccessibilityBudgetError }
  | { result: RawJsonResult; readStamp?: ReadStamp };

// A short read keeps no text, so a retry does not hold the discarded pieces.
type AccessibilityTreeRead =
  | { complete: true; pieces: string[] }
  | { complete: false; filled: number; byteLength: number };

export async function accessibilityTreeResponse(
  request: AccessibilityTreeRequest,
  method: string,
): Promise<AccessibilityTreeReply> {
  const live = await request(false);
  if ("budgetError" in live) return live;
  const first = await readAccessibilityTree(live);
  if (first.complete) return { result: new RawJsonResult(first.pieces), readStamp: live.readStamp };

  // A stream built as the caller pulls can tear if the page mutates; a buffered read cannot.
  const buffered = await request(true);
  if ("budgetError" in buffered) return buffered;
  const retry = await readAccessibilityTree(buffered);
  if (retry.complete) {
    return { result: new RawJsonResult(retry.pieces), readStamp: buffered.readStamp };
  }
  throw new Error(
    `${method}: PageScript stream ended after ${retry.filled} of ${retry.byteLength} bytes`,
  );
}

async function readAccessibilityTree(
  result: Extract<QueryDomResult<"accessibilityTree">, { byteLength: number }>,
): Promise<AccessibilityTreeRead> {
  const { byteLength } = result;
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_ACCESSIBILITY_BYTES) {
    await result.json.cancel("invalid byteLength").catch(() => {});
    throw new Error(`Accessibility: PageScript sent an invalid byteLength ${byteLength}`);
  }
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
  const pieces: string[] = [];
  const reader = withDeadline(result.json, ACCESSIBILITY_READ_DEADLINE_MS).getReader();
  let filled = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > byteLength - filled) {
        throw new Error(`Accessibility: PageScript sent more than ${byteLength} bytes`);
      }
      filled += value.byteLength;
      const piece = decoder.decode(value, { stream: true });
      if (piece) pieces.push(piece);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (filled !== byteLength) return { complete: false, filled, byteLength };
  const tail = decoder.decode();
  if (tail) pieces.push(tail);
  return { complete: true, pieces };
}

type EnsurePageScriptFn = (
  dctx: DispatchCtx,
  target: TargetState | undefined,
) => PageScriptStub | null;

let ensureImpl: EnsurePageScriptFn | null = null;

export function registerEnsurePageScript(fn: EnsurePageScriptFn): void {
  ensureImpl = fn;
}

export function resolveTarget(
  ctx: DispatchCtx,
  sessionId: string | undefined,
  noTargetMessage = "No page target attached to session",
): TargetState {
  if (sessionId) {
    for (const t of ctx.browser.targets.values()) {
      if (t.sessions.has(sessionId)) return t;
    }
  }
  for (const t of ctx.browser.targets.values()) {
    if (t.type === "page") return t;
  }
  throw new Error(noTargetMessage);
}

export type SessionOps = {
  readonly [M in QueryDomMethod]: (args: QueryDomArgs<M>) => Promise<QueryDomResult<M>>;
};

export type SessionSoftOps = {
  readonly [M in QueryDomMethod]: (args: QueryDomArgs<M>) => Promise<QueryDomResult<M> | null>;
};

export class PageSession {
  readonly #dctx: DispatchCtx;
  readonly #target: TargetState;
  #pinned?: { generation: number; stub: PageScriptStub };

  readonly call: SessionOps;

  readonly tryCall: SessionSoftOps;

  readonly callIfLive: SessionSoftOps;

  constructor(dctx: DispatchCtx, target: TargetState) {
    this.#dctx = dctx;
    this.#target = target;
    this.call = this.#ops("call") as SessionOps;
    this.tryCall = this.#ops("try") as SessionSoftOps;
    this.callIfLive = this.#ops("ifLive") as SessionSoftOps;
  }

  #ops(kind: "call" | "try" | "ifLive"): unknown {
    const cache = new Map<string, (args: Record<string, unknown>) => unknown>();
    return new Proxy(Object.create(null), {
      get: (_t, prop) => {
        if (typeof prop !== "string" || prop === "then") return undefined;
        let fn = cache.get(prop);
        if (!fn) {
          fn = (args) => this.#dispatch(kind, prop as QueryDomMethod, args as never);
          cache.set(prop, fn);
        }
        return fn;
      },
    });
  }

  async #dispatch<M extends QueryDomMethod>(
    kind: "call" | "try" | "ifLive",
    method: M,
    args: QueryDomArgs<M>,
  ): Promise<QueryDomResult<M> | null> {
    if (this.#pinned) {
      const stub = this.live();
      if (!stub) {
        if (kind === "call") throw new Error("PageScript generation retired");
        return null;
      }
      try {
        return await stubQueryDom(stub, method, args);
      } catch (e) {
        if (kind === "call") throw e;
        return null;
      }
    }
    if (kind === "ifLive") {
      const stub = this.#target.pageScript;
      if (!stub) return null;
      try {
        await this.#settleBlank();
        return await stubQueryDom(stub, method, args);
      } catch {
        return null;
      }
    }
    const stub = await this.ready();
    if (!stub) {
      if (kind === "call") throw new Error("No PageScript isolate for target");
      return null;
    }
    if (kind === "call") return stubQueryDom(stub, method, args);
    try {
      return await stubQueryDom(stub, method, args);
    } catch {
      return null;
    }
  }

  /**
   * Waits for pending `about:blank` setup and checks that the PageScript is still current.
   * Returns `null` when no isolate is available.
   */
  async ready(): Promise<PageScriptStub | null> {
    if (this.#pinned) return this.live();
    for (;;) {
      const gate = this.#target.blankReady;
      if (gate) await gate;
      const stub = this.ensure();
      if (stub) {
        await this.#settleBlank();
        // Recheck after the await because navigation may have replaced this stub.
        if (this.#target.pageScript === stub) return stub;
        continue;
      }
      if (!this.#target.blankReady || this.#target.blankReady === gate) {
        return null;
      }
    }
  }

  // A pinned view must not hop to a newer document after an awaited read.
  /**
   * Pins calls to the current generation so an awaited read cannot switch documents.
   * Returns `null` when no PageScript is live.
   */
  pin(): PageSession | null {
    const stub = this.live();
    if (!stub) return null;
    const pinned = new PageSession(this.#dctx, this.#target);
    pinned.#pinned = { generation: this.#target.navigateGeneration, stub };
    return pinned;
  }

  live(): PageScriptStub | null {
    if (
      this.#pinned &&
      (this.#target.navigateGeneration !== this.#pinned.generation ||
        this.#target.pageScript !== this.#pinned.stub)
    )
      return null;
    return this.#pinned?.stub ?? this.#target.pageScript;
  }

  isLive(): boolean {
    return this.live() !== null;
  }

  ensure(): PageScriptStub | null {
    if (this.#pinned) return this.live();
    if (this.#target.pageScript) return this.#target.pageScript;
    return ensureImpl ? ensureImpl(this.#dctx, this.#target) : null;
  }

  available(): boolean {
    return this.ensure() !== null;
  }

  async #settleBlank(): Promise<void> {
    const blank = this.#target.blankReady;
    if (blank) await blank;
  }
}

export function sessionOf(dctx: DispatchCtx, target: TargetState): PageSession {
  return (target.pageSession ??= new PageSession(dctx, target));
}

export function resolveSession(ctx: DispatchCtx, sessionId: string | undefined): PageSession {
  return sessionOf(ctx, resolveTarget(ctx, sessionId));
}
