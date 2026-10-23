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

type BakedModule = { default?: { run?: () => unknown }; run?: () => unknown } | undefined;

function bakedRunner(module: BakedModule): () => unknown {
  const run = moduleRunner(module);
  if (typeof run !== "function") throw new Error("baked insert has no run()");
  return run;
}

function moduleRunner(module: BakedModule): (() => unknown) | undefined {
  return module?.default?.run ?? module?.run;
}

async function runBaked(module: string): Promise<void> {
  const mod = (await importModule("./" + module)) as BakedModule;
  const run = bakedRunner(mod);
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

async function allowedModuleScript(meta: Parameters<typeof insertedScriptAllowed>[0]) {
  const pre = await insertedScriptAllowed(meta);
  reportOnly(pre);
  if (!pre.allowed) {
    reportBlocked(pre);
    throw new Error(pre.message ?? "module blocked by policy");
  }
  return pre;
}

async function allowedExternalScript(meta: Parameters<typeof insertedScriptAllowed>[0]) {
  const pre = await insertedScriptAllowed(meta);
  reportOnly(pre);
  if (!pre.allowed) {
    reportBlocked(pre);
    throw new Error(pre.reason ?? "blocked by policy");
  }
  return pre;
}

function assertModuleResponseStatus(
  response: Awaited<ReturnType<typeof fetchInsertedScript>>,
  url: string,
): void {
  if (response.status === 0) throw new Error(`fetch(${url}) failed`);
  if (response.status >= 400) throw new Error(`fetch(${url}) HTTP ${response.status}`);
}

async function allowedModuleResponse(
  meta: Parameters<typeof insertedScriptAllowed>[0],
  response: Awaited<ReturnType<typeof fetchInsertedScript>>,
) {
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
  return post;
}

async function allowedExternalResponse(
  meta: Parameters<typeof insertedScriptAllowed>[0],
  response: Awaited<ReturnType<typeof fetchInsertedScript>>,
): Promise<void> {
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
}

function moduleSource(
  response: Awaited<ReturnType<typeof fetchInsertedScript>>,
  moduleType: string | undefined,
): string {
  if (moduleType !== "json") return response.source;
  return "export default " + JSON.stringify(JSON.parse(response.source)) + ";";
}

async function fetchGatedModuleSourceOnce(url: string): Promise<string> {
  const meta = { url, module: true };
  const pre = await allowedModuleScript(meta);
  const response = await fetchInsertedScript(pre.upgradeTo ?? url, "");
  assertModuleResponseStatus(response, url);
  const post = await allowedModuleResponse(meta, response);
  return moduleSource(response, post.moduleType);
}

export function runInsertedExternalScript(info: InsertedScriptInfo): void {
  const rawSrc = info.src;
  const url = externalScriptUrl(info);
  if (!url) return;
  if (!markInsertedScriptStarted(url)) return;

  const inflightKey = "inserted-script:" + url;
  resourceInflight.add(inflightKey);
  void executeInsertedScriptTask(info, rawSrc, url, inflightKey);
}

function externalScriptUrl(info: InsertedScriptInfo): string | null {
  if (info.type === "module") return null;
  return resolveUrl(info.src);
}

function markInsertedScriptStarted(url: string): boolean {
  if (startedUrls.has(url)) return false;
  if (insertedCount >= MAX_INSERTED_SCRIPTS) {
    console.warn(
      `[ks-inserted-script] budget: skipping ${url} (cap ${MAX_INSERTED_SCRIPTS} per navigate)`,
    );
    return false;
  }
  startedUrls.add(url);
  insertedCount++;
  return true;
}

interface PreparedInsertedScript {
  source: string;
  baked: (typeof startupInsertedBaked)[number] | undefined;
  bakedModule: string | null;
}

interface SilentInsertedScript {
  silent: true;
  message: string;
}

async function fetchPreparedInsertedScript(
  info: InsertedScriptInfo,
  url: string,
): Promise<PreparedInsertedScript | SilentInsertedScript> {
  const meta = insertedScriptMeta(info, url);
  const pre = await allowedExternalScript(meta);
  const response = await fetchInsertedScript(pre.upgradeTo ?? url, info.crossOrigin ?? null);
  const failure = insertedResponseFailure(response);
  if (failure) return { silent: true, message: failure };
  await allowedExternalResponse(meta, response);
  const source = response.source;
  if (!reserveInsertedBytes(source)) {
    return { silent: true, message: "byte budget exceeded (" + source.length + " bytes)" };
  }
  const baked = bakedByUrl.get(url);
  const bakedModule = await matchingBakedModule(baked, source);
  return { source, baked, bakedModule };
}

function insertedResponseFailure(
  response: Awaited<ReturnType<typeof fetchInsertedScript>>,
): string | null {
  if (response.status === 0) return "fetch failed (no response)";
  if (response.status >= 400) throw new Error("HTTP " + response.status);
  return null;
}

function reserveInsertedBytes(source: string): boolean {
  if (insertedBytes + source.length > MAX_INSERTED_SCRIPT_BYTES) return false;
  insertedBytes += source.length;
  return true;
}

async function matchingBakedModule(
  baked: (typeof startupInsertedBaked)[number] | undefined,
  source: string,
): Promise<string | null> {
  if (!baked) return null;
  return baked.digest === (await scriptSourceDigest(source)) ? baked.module : null;
}

function insertedScriptMeta(info: InsertedScriptInfo, url: string) {
  return { url, integrity: info.integrity || null, nonce: info.nonce || null };
}

async function executeInsertedScriptTask(
  info: InsertedScriptInfo,
  rawSrc: string,
  url: string,
  inflightKey: string,
): Promise<void> {
  let outcome: "load" | "error" | "silent" = "error";
  try {
    outcome = await attemptInsertedScript(info, rawSrc, url);
  } finally {
    finishInsertedScript(info, inflightKey, outcome);
  }
}

async function attemptInsertedScript(
  info: InsertedScriptInfo,
  rawSrc: string,
  url: string,
): Promise<"load" | "error" | "silent"> {
  try {
    const prepared = await fetchPreparedInsertedScript(info, url);
    if ("silent" in prepared) {
      reportInsertedFailure(url, new Error(prepared.message), "silent");
      return "silent";
    }
    await yieldToNextTask();
    await runPreparedInsertedScript(prepared, url, rawSrc);
    return "load";
  } catch (error) {
    reportInsertedFailure(url, error, "error");
    return "error";
  }
}

function yieldToNextTask(): Promise<void> {
  return new Promise<void>((resolve) => {
    nativeSetTimeout(resolve, 0);
  });
}

async function runPreparedInsertedScript(
  prepared: PreparedInsertedScript,
  url: string,
  rawSrc: string,
): Promise<void> {
  const cs = getInternalState();
  try {
    cs.setCurrentScript?.(url, -1, "", rawSrc);
    await runInsertedSource(prepared, url);
  } finally {
    await endInsertedScript(cs);
  }
}

async function runInsertedSource(prepared: PreparedInsertedScript, url: string): Promise<void> {
  if (prepared.bakedModule) {
    await runBaked(prepared.bakedModule);
    sendInsertedScriptEvent(url, prepared.source.length, "baked");
    return;
  }
  evalInsertedOnBoa(prepared.source);
  sendInsertedScriptEvent(url, prepared.source.length, prepared.baked ? "stale" : "boa");
}

function sendInsertedScriptEvent(url: string, bytes: number, run: "baked" | "stale" | "boa"): void {
  sendUpstreamEvent({
    event: "kitesurf.insertedScriptRan",
    params: { url, bytes, run },
  });
}

async function endInsertedScript(cs: ReturnType<typeof getInternalState>): Promise<void> {
  try {
    if (cs.endClassicScript) await cs.endClassicScript();
    else cs.setCurrentScript?.(null);
  } catch {}
}

function reportInsertedFailure(url: string, error: unknown, outcome: "error" | "silent"): void {
  try {
    console.warn(
      "[ks-inserted-script] " +
        url +
        " failed: " +
        (error instanceof Error ? error.message : String(error)) +
        (outcome === "silent" ? " (no event fired)" : ""),
    );
  } catch {}
}

function finishInsertedScript(
  info: InsertedScriptInfo,
  inflightKey: string,
  outcome: "load" | "error" | "silent",
): void {
  resourceInflight.delete(inflightKey);
  if (outcome === "silent") return;
  try {
    fireLifecycle(info.id, outcome === "load");
  } catch {}
}
