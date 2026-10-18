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
import { dispatchLifecycle } from "./scripts.ts";
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
}

export function fetchGatedModuleSource(url: string): Promise<string> {
  let pending = moduleSourceInflight.get(url);
  if (!pending) {
    pending = fetchGatedModuleSourceOnce(url).finally(() => moduleSourceInflight.delete(url));
    moduleSourceInflight.set(url, pending);
  }
  return pending;
}

const moduleSourceInflight = new Map<string, Promise<string>>();

async function fetchGatedModuleSourceOnce(url: string): Promise<string> {
  const meta = { url, module: true };
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

  void (async () => {
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
  })();
}
