// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Gates and runs scripts inserted after parsing.
// Every inline insert and external fetch passes the shared script gate before it runs.

import { scriptSourceDigest } from "@kitesurf/script-gate";
import type { ModulePreloadPin } from "@kitesurf/jsrpc-types/page-script";
import { ks_eval_page, ks_eval_page_at, ks_import } from "./wasm-glue.js";
import { globalizeForBoa } from "./boa-classic.ts";
import { getInternalState, sendUpstreamEvent } from "./internal-state.js";
import { importModule, startupInsertedBaked } from "./startup-probe.ts";
import { nativeSetTimeout } from "./native-scheduling.ts";
import { fetchInsertedScript, resourceInflight } from "./resource-fetch.ts";
import {
  clearEntryModuleGateAttributes,
  dispatchLifecycle,
  entryModuleGateAttributes,
  setEntryModuleGateAttributes,
  takeInlineModuleSource,
} from "./scripts.ts";
import {
  importHitFailedFetch,
  insertedRedirectGate,
  insertedResponseAllowed,
  insertedScriptAllowed,
  markModuleFetchFailed,
  parserRedirectGate,
  parserResponseAllowed,
  parserScriptAllowed,
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
export function evalInsertedOnBoa(source: string, url?: string): void {
  if (url) ks_eval_page_at(globalizeForBoa(source), url);
  else ks_eval_page(globalizeForBoa(source));
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
    return new URL(src, state.documentUrl || state.pageUrl || undefined).toString();
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
type WrittenTask = () => Promise<void> | undefined;
const writtenQueue: WrittenTask[] = [];
let writtenCurrent = false;
// Set while the current written script's code runs. Its writes go in at
// writtenInsertAt, after what it wrote before and ahead of its later
// siblings, as at the parser insertion point.
let writtenExecuting = 0;
let writtenInsertAt = 0;
let writtenIdleWaiters: Array<() => void> = [];

const pumpWritten = async (): Promise<void> => {
  if (writtenCurrent) return;
  writtenCurrent = true;
  for (let task = writtenQueue.shift(); task; task = writtenQueue.shift()) {
    writtenInsertAt = 0;
    await new Promise<void>((resolve) => {
      nativeSetTimeout(resolve, 0);
    });
    try {
      await task();
    } catch {}
  }
  writtenCurrent = false;
  const waiters = writtenIdleWaiters;
  writtenIdleWaiters = [];
  for (const wake of waiters) wake();
};

// An external script's body counts its own code. An inline task counts here.
const runAsWritten =
  (task: WrittenTask): WrittenTask =>
  () => {
    writtenExecuting++;
    let run: Promise<void> | undefined;
    try {
      run = task();
    } catch (err) {
      writtenExecuting--;
      throw err;
    }
    if (!run) {
      writtenExecuting--;
      return undefined;
    }
    return run.finally(() => {
      writtenExecuting--;
    });
  };

// Queues a written script's task in write order. An inline script with nothing
// waiting ahead of it runs now, inside the document.write that wrote it.
export function queueWrittenScript(task: WrittenTask, inline: boolean): void {
  const inWriter = writtenExecuting > 0;
  const nothingAhead = inWriter
    ? writtenInsertAt === 0
    : writtenQueue.length === 0 && !writtenCurrent;
  let queued: WrittenTask = inline ? runAsWritten(task) : task;
  if (inline && nothingAhead) {
    const run = task();
    if (!run) return;
    // An async gate holds the scripts written after this one until it settles.
    queued = () => run;
  }
  if (inWriter) writtenQueue.splice(writtenInsertAt++, 0, queued);
  else writtenQueue.push(queued);
  void pumpWritten();
}

const writtenIdle = (): Promise<void> =>
  !writtenCurrent && writtenQueue.length === 0
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        writtenIdleWaiters.push(resolve);
      });

// A written script can write more, so the drain re-checks instead of awaiting
// a snapshot. On timeout DCL goes ahead without the stragglers.
export async function drainWrittenScripts(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + (timeoutMs > 0 ? timeoutMs : 0);
  while (writtenCurrent || writtenQueue.length > 0) {
    if (Date.now() > deadline) return false;
    const expired = new Promise<"t">((r) => {
      nativeSetTimeout(() => r("t"), Math.max(1, deadline - Date.now()));
    });
    const idle = writtenIdle().then(() => "d" as const);
    if ((await Promise.race([idle, expired])) === "t") return false;
    // A finished script queues its own writes synchronously, so one turn
    // makes them visible.
    await new Promise<void>((r) => {
      nativeSetTimeout(r, 0);
    });
  }
  return true;
}

// The nonce each module was fetched with. An import inherits its referrer's nonce, as HTML's
// descendant script fetch options do, but not its integrity; a preload can supply its own pin.
const moduleFetchNonces = new Map<string, string | null>();
let modulePreloadIntegrity = new Map<string, string | null>();

export function setModulePreloadPins(pins: readonly ModulePreloadPin[]): void {
  modulePreloadIntegrity = new Map(pins.map(({ url, integrity }) => [url, integrity]));
}

function moduleGateAttributes(
  url: string,
  referrer: string | undefined,
): { nonce: string | null; integrity: string | null; parser: boolean } {
  const entry = entryModuleGateAttributes(url);
  const nonce = entry
    ? entry.nonce
    : referrer === undefined
      ? null
      : (moduleFetchNonces.get(referrer) ?? null);
  return {
    nonce,
    integrity: entry?.integrity || modulePreloadIntegrity.get(url) || null,
    parser: entry?.parser === true,
  };
}

export function fetchGatedModuleSource(
  url: string,
  referrer?: string,
  expectedModuleType?: "json",
): Promise<string> {
  const attributes = moduleGateAttributes(url, referrer);
  moduleFetchNonces.set(url, attributes.nonce);
  const inline = takeInlineModuleSource(url);
  if (inline !== undefined) return Promise.resolve(inline);
  // A parser entry and a runtime insert at one URL are authorized by different rules, so they
  // never share an in-flight fetch: an insert must not lend 'strict-dynamic' to a parser entry.
  // A JSON request is a different load too: the gate checks the requested type.
  const key =
    (attributes.parser ? "parser:" : "inserted:") +
    (expectedModuleType === undefined ? "" : `${expectedModuleType}:`) +
    url;
  let pending = moduleSourceInflight.get(key);
  if (!pending) {
    pending = fetchGatedModuleSourceOnce(url, attributes, expectedModuleType)
      .catch((err: unknown) => {
        markModuleFetchFailed(url);
        throw err;
      })
      .finally(() => moduleSourceInflight.delete(key));
    moduleSourceInflight.set(key, pending);
  }
  return pending;
}

const moduleSourceInflight = new Map<string, Promise<string>>();

async function fetchGatedModuleSourceOnce(
  url: string,
  attributes: { nonce: string | null; integrity: string | null; parser: boolean },
  expectedModuleType?: "json",
): Promise<string> {
  const meta = {
    url,
    module: true,
    nonce: attributes.nonce,
    integrity: attributes.integrity,
    ...(expectedModuleType === undefined ? {} : { expectedModuleType }),
  };
  const pre = await (attributes.parser ? parserScriptAllowed(meta) : insertedScriptAllowed(meta));
  // A parser entry was already gated by runModulePhase; this fetch repeats the decision so the
  // source cannot slip past the gate, but reporting it again would duplicate the violation.
  if (!attributes.parser) reportOnly(pre);
  if (!pre.allowed) {
    reportBlocked(pre);
    throw new Error(pre.message ?? "module blocked by policy");
  }
  const redirects = attributes.parser ? parserRedirectGate(meta) : insertedRedirectGate(meta);
  const response = await fetchInsertedScript(
    pre.upgradeTo ?? url,
    "",
    redirects.check,
    attributes.parser ? "parser" : "script",
  );
  if (redirects.refusal) {
    reportBlocked(redirects.refusal);
    throw new Error(redirects.refusal.message ?? "module blocked by policy");
  }
  if (response.status === 0) throw new Error(`fetch(${url}) failed`);
  if (response.status >= 400) throw new Error(`fetch(${url}) HTTP ${response.status}`);
  const responseAllowed = attributes.parser ? parserResponseAllowed : insertedResponseAllowed;
  const post = await responseAllowed(
    meta,
    {
      contentType: response.contentType,
      contentTypeOptions: response.nosniff,
      bytes: response.bytes,
      opaque: response.opaque,
      ...(response.finalUrl ? { finalUrl: response.finalUrl } : {}),
    },
    pre.upgradeTo ?? url,
  );
  if (!post.allowed) {
    reportBlocked(post);
    throw new Error(post.message ?? "module blocked by policy");
  }
  // Module source feeds the same boa parse as inserted classic source, so it shares the budget.
  // A refused fetch fails the graph, so the element gets error.
  if (insertedBytes + response.bytes.length > MAX_INSERTED_SCRIPT_BYTES) {
    throw new Error(`fetch(${url}) refused: byte budget exceeded (${response.bytes.length} bytes)`);
  }
  insertedBytes += response.bytes.length;
  if (post.moduleType === "json") {
    return "export default " + JSON.stringify(JSON.parse(response.source)) + ";";
  }
  return response.source;
}

// An inserted module runs on boa through the parser modules' loader, which gates every fetch
// in its graph. A failed fetch fires error; a module that throws while evaluating still fires
// load, as in browsers. The module map runs a URL once, but each element gets its event.
function runInsertedModuleScript(info: InsertedScriptInfo): void {
  const url = resolveUrl(info.src);
  if (!url) return;
  if (insertedCount >= MAX_INSERTED_SCRIPTS) {
    console.warn(
      `[ks-inserted-script] budget: skipping ${url} (cap ${MAX_INSERTED_SCRIPTS} per navigate)`,
    );
    return;
  }
  insertedCount++;
  const inflightKey = "inserted-module:" + info.id + ":" + url;
  resourceInflight.add(inflightKey);
  const body = async (): Promise<void> => {
    let ok = false;
    let holdsAttributes = false;
    try {
      // Off the inserting call stack: the insert can come from code running on boa.
      await new Promise<void>((resolve) => {
        nativeSetTimeout(resolve, 0);
      });
      setEntryModuleGateAttributes(url, {
        nonce: info.nonce || null,
        integrity: info.integrity || null,
        parser: false,
      });
      holdsAttributes = true;
      await ks_import(url, state.pageUrl || "about:blank");
      ok = true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      ok = !importHitFailedFetch(reason);
      try {
        console.error(
          "[ks-inserted-script] module " + url + (ok ? " threw: " : " failed: "),
          reason,
        );
      } catch {}
    } finally {
      if (holdsAttributes) clearEntryModuleGateAttributes(url);
      resourceInflight.delete(inflightKey);
      try {
        fireLifecycle(info.id, ok);
      } catch {}
    }
  };
  void body();
}

export function runInsertedExternalScript(info: InsertedScriptInfo): void {
  const rawSrc = info.src;
  if (info.type === "module") {
    runInsertedModuleScript(info);
    return;
  }
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
      const redirects = insertedRedirectGate(meta);
      const response = await fetchInsertedScript(
        pre.upgradeTo ?? url,
        info.crossOrigin ?? null,
        redirects.check,
      );
      if (redirects.refusal) {
        reportBlocked(redirects.refusal);
        throw new Error(redirects.refusal.reason ?? "blocked by policy");
      }
      if (response.status === 0) {
        // Suppress the script error event for no-response fetches: Next's chunk loader
        // can turn it into a fatal ChunkLoadError and discard usable SSR markup.
        // Real HTTP failures still take the normal error-event path.
        outcome = "silent";
        throw new Error("fetch failed (no response)");
      }
      if (response.status >= 400) throw new Error("HTTP " + response.status);
      const post = await insertedResponseAllowed(
        meta,
        {
          contentType: response.contentType,
          contentTypeOptions: response.nosniff,
          bytes: response.bytes,
          opaque: response.opaque,
          ...(response.finalUrl ? { finalUrl: response.finalUrl } : {}),
        },
        pre.upgradeTo ?? url,
      );
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
          // A redirected script is named by the URL that served it, and its relative imports
          // resolve against that URL, not the one the page asked for.
          evalInsertedOnBoa(source, response.finalUrl ?? pre.upgradeTo ?? url);
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
