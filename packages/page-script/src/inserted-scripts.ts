// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Gates and runs scripts inserted after parsing.
// Every inline insert and external fetch passes the shared script gate before it runs.

import { scriptSourceDigest } from "@kitesurf/script-gate";
import { ks_eval_page } from "./wasm-glue.js";
import { globalizeForBoa } from "./boa-classic.ts";
import { getInternalState, sendUpstreamEvent } from "./internal-state.js";
import { importModule, startupInsertedBaked } from "./startup-probe.ts";
import { nativeSetTimeout } from "./native-scheduling.ts";
import { fetchInsertedScript, resourceInflight } from "./resource-fetch.ts";
import { dispatchLifecycle, entryModuleGateAttributes, takeInlineModuleSource } from "./scripts.ts";
import {
  insertedResponseAllowed,
  insertedScriptAllowed,
  reportBlocked,
  reportOnly,
} from "./script-policy.ts";
import { state } from "./state.ts";

// Bound Boa parse input by bytes, and fetches by a count far past any chunk graph (large
// apps insert ~70): the byte budget only applies after a fetch, and unique URLs skip dedupe.
const MAX_INSERTED_SCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_INSERTED_SCRIPTS = 1024;
let insertedBytes = 0;
let insertedCount = 0;
const startedUrls = new Set<string>();
const bakedByUrl = new Map(startupInsertedBaked.map((e) => [e.url, e]));
export function evalInsertedOnBoa(source: string): void {
  ks_eval_page(globalizeForBoa(source));
}

async function runBaked(module: string): Promise<void> {
  const mod = (await importModule("./" + module)) as
    | { default?: { run?: () => unknown }; run?: () => unknown }
    | undefined;
  const run = mod?.default?.run ?? mod?.run;
  if (typeof run !== "function") throw new Error("baked insert has no run()");
  await run.call(globalThis);
}

function resolveUrl(src: string): string | null {
  try {
    return new URL(src, state.pageUrl || undefined).toString();
  } catch {
    return null;
  }
}

function fireLifecycle(nodeId: number, success: boolean): void {
  let resolvedNode: unknown = null;
  try {
    resolvedNode = state.resolveNodeId ? state.resolveNodeId(nodeId) : null;
  } catch {
    resolvedNode = null;
  }
  if (!resolvedNode) return;
  dispatchLifecycle(
    resolvedNode as { dispatchEvent?: (event: unknown) => boolean },
    success ? "load" : "error",
    { bubbles: false, cancelable: false },
  );
}

export interface InsertedScriptInfo {
  id: number;
  src: string;
  type: string;
  integrity?: string;
  nonce?: string;
  crossOrigin?: string | null;
  written?: boolean;
}

// A document.write'd script is parser-inserted, so it runs in write order,
// not fetch-completion order, and DOMContentLoaded waits for it. Pre-ES6
// loaders such as tdl.js depend on both. Gap: a parser-inserted script after
// the writing one does not wait; only DOMContentLoaded does.
let writtenChain: Promise<void> = Promise.resolve();
let writtenPending = 0;
// Written scripts in writtenPending whose code is running now. An inline
// script they write is not queued behind them, only behind the waiting ones.
let writtenExecuting = 0;

const trackWritten = (run: Promise<void>): void => {
  writtenPending++;
  const settled = run.then(
    () => {
      writtenPending--;
    },
    () => {
      writtenPending--;
    },
  );
  writtenChain = writtenChain.then(() => settled);
};

// Runs a written script's task in write order, in a fresh task after the
// queued ones settle. With nothing waiting ahead it runs now: an inline script
// runs inside the document.write that wrote it, even inside a written script.
export function queueWrittenScript(task: () => Promise<void> | undefined, inline: boolean): void {
  if (writtenPending - (inline ? writtenExecuting : 0) === 0) {
    const run = task();
    if (run) trackWritten(run);
    return;
  }
  const deferred = async () => {
    await new Promise<void>((resolve) => {
      nativeSetTimeout(resolve, 0);
    });
    // An external script's body counts itself while its code runs.
    if (inline) writtenExecuting++;
    try {
      await task();
    } finally {
      if (inline) writtenExecuting--;
    }
  };
  trackWritten(writtenChain.then(deferred, deferred));
}

// A written script can write more, so the drain re-checks the count instead
// of awaiting a snapshot. On timeout DCL goes ahead without the stragglers.
export async function drainWrittenScripts(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + (timeoutMs > 0 ? timeoutMs : 0);
  while (writtenPending > 0) {
    if (Date.now() > deadline) return false;
    const expired = new Promise<"t">((r) => {
      nativeSetTimeout(() => r("t"), Math.max(1, deadline - Date.now()));
    });
    const settled = writtenChain.then(
      () => "d" as const,
      () => "d" as const,
    );
    if ((await Promise.race([settled, expired])) === "t") return false;
    // A finished script queues its own writes synchronously, so one turn
    // makes them visible.
    await new Promise<void>((r) => {
      nativeSetTimeout(r, 0);
    });
  }
  return true;
}

export function fetchGatedModuleSource(url: string): Promise<string> {
  const inline = takeInlineModuleSource(url);
  if (inline !== undefined) return Promise.resolve(inline);
  let pending = moduleSourceInflight.get(url);
  if (!pending) {
    pending = fetchGatedModuleSourceOnce(url).finally(() => moduleSourceInflight.delete(url));
    moduleSourceInflight.set(url, pending);
  }
  return pending;
}

const moduleSourceInflight = new Map<string, Promise<string>>();

async function fetchGatedModuleSourceOnce(url: string): Promise<string> {
  const meta = { url, module: true, ...entryModuleGateAttributes(url) };
  const pre = await insertedScriptAllowed(meta);
  reportOnly(pre);
  if (!pre.allowed) {
    reportBlocked(pre);
    throw new Error(pre.message ?? "module blocked by policy");
  }
  const response = await fetchInsertedScript(pre.upgradeTo ?? url, "");
  if (response.status === 0) throw new Error(`fetch(${url}) failed`);
  if (response.status >= 400) throw new Error(`fetch(${url}) HTTP ${response.status}`);
  const post = await insertedResponseAllowed(meta, {
    contentType: response.contentType,
    contentTypeOptions: response.nosniff,
    bytes: response.bytes,
    opaque: response.opaque,
  });
  if (!post.allowed) {
    reportBlocked(post);
    throw new Error(post.message ?? "module blocked by policy");
  }
  if (post.moduleType === "json") {
    return "export default " + JSON.stringify(JSON.parse(response.source)) + ";";
  }
  return response.source;
}

export function runInsertedExternalScript(info: InsertedScriptInfo): void {
  const rawSrc = info.src;
  if (info.type === "module") return;
  const url = resolveUrl(rawSrc);
  if (!url) return;
  if (startedUrls.has(url)) return;
  if (insertedCount >= MAX_INSERTED_SCRIPTS) {
    console.warn(
      `[ks-inserted-script] budget: skipping ${url} (cap ${MAX_INSERTED_SCRIPTS} per navigate)`,
    );
    return;
  }
  startedUrls.add(url);
  insertedCount++;

  const meta = {
    url,
    integrity: info.integrity || null,
    nonce: info.nonce || null,
  };

  const inflightKey = "inserted-script:" + url;
  resourceInflight.add(inflightKey);

  const body = async () => {
    let outcome: "load" | "error" | "silent" = "error";
    try {
      const pre = await insertedScriptAllowed(meta);
      reportOnly(pre);
      if (!pre.allowed) {
        reportBlocked(pre);
        throw new Error(pre.reason ?? "blocked by policy");
      }
      const response = await fetchInsertedScript(pre.upgradeTo ?? url, info.crossOrigin ?? null);
      if (response.status === 0) {
        // Suppress the script error event for no-response fetches: Next's chunk loader
        // can turn it into a fatal ChunkLoadError and discard usable SSR markup.
        // Real HTTP failures still take the normal error-event path.
        outcome = "silent";
        throw new Error("fetch failed (no response)");
      }
      if (response.status >= 400) throw new Error("HTTP " + response.status);
      const post = await insertedResponseAllowed(meta, {
        contentType: response.contentType,
        contentTypeOptions: response.nosniff,
        bytes: response.bytes,
        opaque: response.opaque,
      });
      if (!post.allowed) {
        reportBlocked(post);
        throw new Error(post.reason ?? "blocked by policy");
      }
      const source = response.source;
      if (insertedBytes + source.length > MAX_INSERTED_SCRIPT_BYTES) {
        outcome = "silent";
        throw new Error("byte budget exceeded (" + source.length + " bytes)");
      }
      insertedBytes += source.length;
      const baked = bakedByUrl.get(url);
      const bakedModule =
        baked && baked.digest === (await scriptSourceDigest(source)) ? baked.module : null;

      // A fresh task prevents fetched code from re-entering frames left by the fetch continuation.
      await new Promise<void>((resolve) => {
        nativeSetTimeout(resolve, 0);
      });

      const cs = getInternalState();
      if (info.written) writtenExecuting++;
      try {
        cs.setCurrentScript?.(url, -1, "", rawSrc);
        if (bakedModule) {
          await runBaked(bakedModule);
          sendUpstreamEvent({
            event: "kitesurf.insertedScriptRan",
            params: { url, bytes: source.length, run: "baked" },
          });
        } else {
          evalInsertedOnBoa(source);
          sendUpstreamEvent({
            event: "kitesurf.insertedScriptRan",
            params: { url, bytes: source.length, run: baked ? "stale" : "boa" },
          });
        }
        outcome = "load";
      } finally {
        try {
          if (cs.endClassicScript) await cs.endClassicScript();
          else cs.setCurrentScript?.(null);
        } catch {}
        if (info.written) writtenExecuting--;
      }
    } catch (err) {
      if (outcome !== "silent") outcome = "error";
      try {
        console.warn(
          "[ks-inserted-script] " +
            url +
            " failed: " +
            (err instanceof Error ? err.message : String(err)) +
            (outcome === "silent" ? " (no event fired)" : ""),
        );
      } catch {}
    } finally {
      resourceInflight.delete(inflightKey);
      if (outcome !== "silent") {
        try {
          fireLifecycle(info.id, outcome === "load");
        } catch {}
      }
    }
  };

  if (info.written) queueWrittenScript(body, false);
  else void body();
}
