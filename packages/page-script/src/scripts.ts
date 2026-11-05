// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Runs the source-based legacy script plan and dispatches document lifecycle events.
// The normal path bundles classic scripts into one sloppy CJS module; this plan runs only when the
// parent supplied no bundle (an OOPIF child, or a navigate whose bake threw). Everything runs on
// boa. Only external modules and their imports pass the script gate; classic and inline do not.

import { globalizeForBoa } from "./boa-classic.ts";
import { ksEventCtors, state } from "./state.ts";
import { trustedFetch } from "./trusted-fetch.ts";
import type { ShimElement } from "./types.ts";
import { ks_eval_page, ks_import } from "./wasm-glue.js";

export interface ScriptDescriptor {
  src: string | null;
  kind: "classic" | "module";
  defer: boolean;
  async: boolean;
  body: string;
  // Empty collapses to null, the rule scan.rs and the engine's DOM fallback use.
  nonce: string | null;
  integrity: string | null;
  nodeId?: number;
  _resolvedUrl?: string;
}

interface FetchResultOk {
  ok: true;
  source: string;
}
interface FetchResultErr {
  ok: false;
  error: string;
}
type FetchResult = FetchResultOk | FetchResultErr;

export interface ScriptPlan {
  regular: ScriptDescriptor[];
  deferred: ScriptDescriptor[];
  async_: ScriptDescriptor[];
  modules: ScriptDescriptor[];
  sourceCache: Map<string, Promise<FetchResult>>;
}

export function extractScripts(): ScriptDescriptor[] {
  const dom = state.dom;
  if (!dom) return [];
  let ids: ArrayLike<number>;
  try {
    ids = dom.querySelectorAll("script");
  } catch {
    return [];
  }
  const out: ScriptDescriptor[] = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    let info: ReturnType<typeof dom.nodeInfo> | null;
    try {
      info = dom.nodeInfo(id);
    } catch {
      continue;
    }
    const flat: unknown[] =
      (info && ((info as { attributes?: unknown[] }).attributes as unknown[])) || [];
    const attrs: Record<string, string> = {};
    for (let j = 0; j + 1 < flat.length; j += 2) {
      attrs[String(flat[j]).toLowerCase()] = String(flat[j + 1] ?? "");
    }
    const rawType = (attrs.type || "").trim().toLowerCase();
    if (
      rawType !== "" &&
      rawType !== "text/javascript" &&
      rawType !== "application/javascript" &&
      rawType !== "module"
    ) {
      continue;
    }
    const src = attrs.src ? String(attrs.src).trim() : "";
    let body = "";
    if (!src) {
      try {
        body = dom.textContent(id);
      } catch {
        body = "";
      }
    }
    if (!src && (!body || !body.trim())) continue;
    out.push({
      src: src || null,
      kind: rawType === "module" ? "module" : "classic",
      defer: "defer" in attrs,
      async: "async" in attrs,
      body,
      nonce: attrs.nonce || null,
      integrity: attrs.integrity?.trim() || null,
      nodeId: id,
    });
  }
  return out;
}

function resolveScriptUrl(src: string | null | undefined): string | null {
  if (!src) return null;
  try {
    return state.pageUrl ? new URL(src, state.pageUrl).toString() : new URL(src).toString();
  } catch {
    return null;
  }
}

async function fetchScriptSource(url: string): Promise<string> {
  const response = await trustedFetch(
    url,
    { headers: { accept: "*/*" } },
    { resourceType: "Script", initiator: "parser" },
  );
  if (!response.ok) {
    throw new Error("<script src> fetch returned HTTP " + response.status + " for " + url);
  }
  return await response.text();
}

// The loaded worker refuses native code generation after startup, so the body runs on boa,
// globalized like a runtime insert so its top-level declarations land on window.
async function runOneClassic(source: string, label: string): Promise<void> {
  if (!source) return;
  try {
    ks_eval_page(globalizeForBoa(source));
  } catch (err) {
    console.error("[" + label + "]", err);
  }
}

export function planScripts(scripts: ScriptDescriptor[]): ScriptPlan {
  const regular: ScriptDescriptor[] = [];
  const deferred: ScriptDescriptor[] = [];
  const async_: ScriptDescriptor[] = [];
  const modules: ScriptDescriptor[] = [];
  for (const script of scripts) {
    if (script.kind === "module") {
      modules.push(script);
      continue;
    }
    if (script.async && script.src) {
      async_.push(script);
    } else if (script.defer && script.src) {
      deferred.push(script);
    } else {
      regular.push(script);
    }
  }

  const sourceCache = new Map<string, Promise<FetchResult>>();
  const startFetch = (url: string) => {
    const existing = sourceCache.get(url);
    if (existing) return existing;
    const fetchPromise: Promise<FetchResult> = (async () => {
      try {
        const source = await fetchScriptSource(url);
        return { ok: true, source };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })();
    sourceCache.set(url, fetchPromise);
    return fetchPromise;
  };

  // Boa's loader fetches module sources, through the script gate, when runModulePhase imports them.
  for (const script of [...regular, ...deferred, ...async_, ...modules]) {
    if (!script.src) continue;
    const url = resolveScriptUrl(script.src);
    if (!url) {
      console.error("[kitesurf] cannot resolve <script src>: " + String(script.src));
      continue;
    }
    script._resolvedUrl = url;
    if (script.kind !== "module") startFetch(url);
  }

  return { regular, deferred, async_, modules, sourceCache };
}

// The legacy plan runs in the document it scanned, so the scanned node id names the element.
function fireScriptLifecycle(script: ScriptDescriptor, ok: boolean): void {
  if (!script.src || typeof script.nodeId !== "number") return;
  let element: ShimElement | null = null;
  try {
    element = state.resolveNodeId(script.nodeId);
  } catch {}
  dispatchLifecycle(element, ok ? "load" : "error", { bubbles: false, cancelable: false });
}

export async function runRegularPhase(plan: ScriptPlan): Promise<void> {
  for (const script of plan.regular) {
    if (script.src) {
      const url = script._resolvedUrl;
      if (!url) {
        fireScriptLifecycle(script, false);
        continue;
      }
      const fetchResult = await plan.sourceCache.get(url);
      if (!fetchResult || !fetchResult.ok) {
        console.error(
          "[kitesurf] <script src> fetch failed for " + url + ": " + fetchErrorDetail(fetchResult),
        );
        fireScriptLifecycle(script, false);
        continue;
      }
      await runOneClassic(fetchResult.source, url);
      fireScriptLifecycle(script, true);
    } else {
      await runOneClassic(script.body, "<inline>");
    }
  }
  for (const script of plan.deferred) {
    const url = script._resolvedUrl;
    if (!url) {
      fireScriptLifecycle(script, false);
      continue;
    }
    const fetchResult = await plan.sourceCache.get(url);
    if (!fetchResult || !fetchResult.ok) {
      console.error(
        "[kitesurf] deferred <script src> fetch failed for " +
          url +
          ": " +
          fetchErrorDetail(fetchResult),
      );
      fireScriptLifecycle(script, false);
      continue;
    }
    await runOneClassic(fetchResult.source, url);
    fireScriptLifecycle(script, true);
  }
}

function fetchErrorDetail(result: FetchResult | undefined): string {
  if (!result) return "unknown";
  if (result.ok) return "unknown";
  return "error" in result ? result.error || "unknown" : "unknown";
}

export async function runAsyncPhase(plan: ScriptPlan): Promise<void> {
  await Promise.all(
    plan.async_.map(async (s) => {
      const url = s._resolvedUrl;
      if (!url) {
        fireScriptLifecycle(s, false);
        return;
      }
      const fetchResult = await plan.sourceCache.get(url);
      if (!fetchResult || !fetchResult.ok) {
        console.error(
          "[kitesurf] async <script src> fetch failed for " +
            url +
            ": " +
            fetchErrorDetail(fetchResult),
        );
        fireScriptLifecycle(s, false);
        return;
      }
      await runOneClassic(fetchResult.source, url);
      fireScriptLifecycle(s, true);
    }),
  );
}

// Boa's module loader parses each module and fetches its imports through the script gate
// (fetchGatedModuleSource). An inline module has no URL, so it goes in under a fragment of the
// document URL: relative imports still resolve against the document, and the fragment keeps each
// inline module a distinct record.
const inlineModuleSources = new Map<string, string>();
let inlineModuleCounter = 0;
// The gate needs an entry module's own nonce and integrity; its imports carry neither. Elements
// that share a URL share its one fetch, which a browser makes with the first one's options, so
// those stay until every holder releases them: a later element cannot replace them mid-fetch.
type EntryModuleAttributes = { nonce: string | null; integrity: string | null };
const entryModuleAttributes = new Map<
  string,
  { attributes: EntryModuleAttributes; holders: number }
>();

export function entryModuleGateAttributes(url: string): EntryModuleAttributes | undefined {
  return entryModuleAttributes.get(url)?.attributes;
}

export function setEntryModuleGateAttributes(url: string, attributes: EntryModuleAttributes): void {
  const held = entryModuleAttributes.get(url);
  if (held) held.holders++;
  else entryModuleAttributes.set(url, { attributes, holders: 1 });
}

export function clearEntryModuleGateAttributes(url: string): void {
  const held = entryModuleAttributes.get(url);
  if (held && --held.holders === 0) entryModuleAttributes.delete(url);
}

// One-shot: boa caches the parsed record, so the source is never asked for twice.
export function takeInlineModuleSource(url: string): string | undefined {
  const source = inlineModuleSources.get(url);
  if (source !== undefined) inlineModuleSources.delete(url);
  return source;
}

function inlineModuleUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.hash = "__ks_inline_module_" + ++inlineModuleCounter;
  return url.toString();
}

export async function runModulePhase(plan: ScriptPlan): Promise<void> {
  // HTML evaluates parser-inserted modules in document order.
  for (const script of plan.modules) {
    let moduleUrl: string;
    if (script.src) {
      const url = script._resolvedUrl;
      if (!url) {
        console.error("[kitesurf] cannot resolve module <script src>: " + String(script.src));
        continue;
      }
      moduleUrl = url;
      setEntryModuleGateAttributes(url, { nonce: script.nonce, integrity: script.integrity });
    } else {
      const source = script.body || "";
      if (!source.trim()) continue;
      try {
        moduleUrl = inlineModuleUrl(state.pageUrl || "about:blank");
      } catch {
        console.error("[kitesurf] cannot address inline module for " + state.pageUrl);
        continue;
      }
      inlineModuleSources.set(moduleUrl, source);
      // No integrity for inline source, but its imports inherit its nonce.
      setEntryModuleGateAttributes(moduleUrl, { nonce: script.nonce, integrity: null });
    }
    try {
      await ks_import(moduleUrl, state.pageUrl || "about:blank");
    } catch (err) {
      console.error("[" + (script.src ? moduleUrl : "<inline-module>") + "]", err);
    } finally {
      inlineModuleSources.delete(moduleUrl);
      clearEntryModuleGateAttributes(moduleUrl);
    }
  }
}

// The document's scripts in scan order: scan.rs gives no ordinal to a script inside <template>,
// which the tree keeps in place, so those are left out here too.
export function scriptsInScanOrder(): ShimElement[] {
  const out: ShimElement[] = [];
  let all: ArrayLike<ShimElement> | undefined;
  try {
    all = state.document?.querySelectorAll("script");
  } catch {
    return out;
  }
  for (let i = 0; all && i < all.length; i++) {
    const node = all[i];
    let inTemplate = false;
    try {
      inTemplate = !!node?.closest?.("template");
    } catch {}
    if (node && !inTemplate) out.push(node);
  }
  return out;
}

// The bundle names a parser-inserted script by its scan ordinal. Earlier scripts can add or
// remove <script> nodes, so the ordinal must agree with src; else take the first src match.
export function findParserScript(
  domIndex: number,
  rawSrc: string,
  src: string,
): ShimElement | null {
  const scripts = scriptsInScanOrder();
  const matches = (node: ShimElement | undefined): boolean => {
    let attr: string | null | undefined;
    try {
      attr = node?.getAttribute?.("src");
    } catch {
      return false;
    }
    if (attr == null) return false;
    const trimmed = attr.trim();
    return trimmed === rawSrc || trimmed === src;
  };
  if (domIndex >= 0 && domIndex < scripts.length && matches(scripts[domIndex])) {
    return scripts[domIndex] ?? null;
  }
  for (let i = 0; i < scripts.length; i++) {
    if (matches(scripts[i])) return scripts[i] ?? null;
  }
  return null;
}

export function dispatchLifecycle(
  target: { dispatchEvent?: (ev: unknown) => boolean } | null,
  type: string,
  init?: Record<string, unknown>,
): void {
  if (!target || typeof target.dispatchEvent !== "function") return;
  const EventConstructor = ksEventCtors.Event;
  if (typeof EventConstructor !== "function") return;
  try {
    const event = new (EventConstructor as new (
      type: string,
      init?: Record<string, unknown>,
    ) => unknown)(type, init || {});
    target.dispatchEvent(event);
  } catch (err) {
    console.error("[kitesurf] lifecycle " + type + " dispatch failed", err);
  }
}
