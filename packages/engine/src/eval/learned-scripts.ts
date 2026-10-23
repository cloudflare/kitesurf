// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Records page-inserted script outcomes per browser context and origin for reuse.

const MIN_LEARNED_BYTES = 8 * 1024;
const MAX_URLS_PER_ORIGIN = 24;
const MAX_ORIGINS = 32;
const MAX_IDLE_NAVIGATES = 3;

interface OriginScripts {
  urls: Map<string, number>;
  refused: Set<string>;
  queried: Set<string>;
}

export type LearnedScripts = Map<string, OriginScripts>;

export type InsertedRun = "boa" | "baked" | "stale";

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

function storeKey(pageUrl: string, contextId: string): string | null {
  const origin = originOf(pageUrl);
  return origin ? `${contextId}|${origin}` : null;
}

function hasQuery(url: string): boolean {
  try {
    return new URL(url).search !== "";
  } catch {
    return false;
  }
}

function touch<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
}

function trimOldest<K>(
  keyed: { keys(): Iterable<K>; delete(key: K): boolean; readonly size: number },
  max: number,
): void {
  for (const key of keyed.keys()) {
    if (keyed.size <= max) return;
    keyed.delete(key);
  }
}

export function recordInsertedScript(
  store: LearnedScripts,
  pageUrl: string,
  scriptUrl: string,
  bytes: number,
  run: InsertedRun = "boa",
  contextId = "",
): void {
  recordInsertedScriptForRun(store, pageUrl, scriptUrl, bytes, run, contextId);
}

function scriptRecordingKey(pageUrl: string, scriptUrl: string, contextId: string): string | null {
  const key = storeKey(pageUrl, contextId);
  if (!key) return null;
  if (!originOf(scriptUrl)) return null;
  return key;
}

function markStaleScript(entry: OriginScripts | undefined, scriptUrl: string): void {
  if (!entry) return;
  entry.urls.delete(scriptUrl);
  entry.refused.delete(scriptUrl);
  entry.refused.add(scriptUrl);
  trimOldest(entry.refused, MAX_URLS_PER_ORIGIN);
}

function shouldRecordScript(
  entry: OriginScripts | undefined,
  scriptUrl: string,
  bytes: number,
  run: InsertedRun,
): boolean {
  return run === "baked"
    ? isKnownBakedScript(entry, scriptUrl)
    : isEligibleBoaScript(entry, scriptUrl, bytes);
}

function isKnownBakedScript(entry: OriginScripts | undefined, scriptUrl: string): boolean {
  return entry !== undefined && entry.urls.has(scriptUrl);
}

function isEligibleBoaScript(
  entry: OriginScripts | undefined,
  scriptUrl: string,
  bytes: number,
): boolean {
  return bytes >= MIN_LEARNED_BYTES && (entry === undefined || !entry.refused.has(scriptUrl));
}

function getOrCreateOriginScripts(entry: OriginScripts | undefined): OriginScripts {
  return entry ?? { urls: new Map(), refused: new Set(), queried: new Set() };
}

function shouldRecordQueryOnce(entry: OriginScripts, scriptUrl: string, run: InsertedRun): boolean {
  return (
    run === "boa" &&
    hasQuery(scriptUrl) &&
    !entry.urls.has(scriptUrl) &&
    !entry.queried.delete(scriptUrl)
  );
}

function recordInsertedScriptForRun(
  store: LearnedScripts,
  pageUrl: string,
  scriptUrl: string,
  bytes: number,
  run: InsertedRun,
  contextId: string,
): void {
  const key = scriptRecordingKey(pageUrl, scriptUrl, contextId);
  if (key === null) return;
  let entry = store.get(key);
  if (run === "stale") {
    markStaleScript(entry, scriptUrl);
    return;
  }
  if (!shouldRecordScript(entry, scriptUrl, bytes, run)) return;
  entry = getOrCreateOriginScripts(entry);
  touch(store, key, entry);
  trimOldest(store, MAX_ORIGINS);
  if (shouldRecordQueryOnce(entry, scriptUrl, run)) {
    entry.queried.add(scriptUrl);
    trimOldest(entry.queried, MAX_URLS_PER_ORIGIN);
    return;
  }
  touch(entry.urls, scriptUrl, 0);
  trimOldest(entry.urls, MAX_URLS_PER_ORIGIN);
}

export function forgetLearnedScript(
  store: LearnedScripts,
  pageUrl: string,
  scriptUrl: string,
  contextId = "",
): void {
  const key = storeKey(pageUrl, contextId);
  if (key) store.get(key)?.urls.delete(scriptUrl);
}

export function clearLearnedScripts(store: LearnedScripts, contextId: string): void {
  for (const key of store.keys()) {
    if (key.startsWith(`${contextId}|`)) store.delete(key);
  }
}

export function learnedScriptsFor(
  store: LearnedScripts,
  pageUrl: string,
  contextId = "",
): string[] {
  return learnedScriptsForContext(store, pageUrl, contextId);
}

function learnedScriptsForContext(
  store: LearnedScripts,
  pageUrl: string,
  contextId: string,
): string[] {
  const key = storeKey(pageUrl, contextId);
  if (!key) return [];
  const entry = store.get(key);
  if (!entry) return [];
  touch(store, key, entry);
  return advanceLearnedScripts(entry);
}

function advanceLearnedScripts(entry: OriginScripts): string[] {
  const out: string[] = [];
  for (const [url, idle] of entry.urls) {
    if (idle >= MAX_IDLE_NAVIGATES) {
      entry.urls.delete(url);
    } else {
      entry.urls.set(url, idle + 1);
      out.push(url);
    }
  }
  return out;
}
