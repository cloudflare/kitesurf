// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Resolves same-origin external SVG sprites used by <use> elements.
// Inline SVG paints from a usvg snapshot, which cannot fetch, so each sprite file is parsed into a
// hidden holder in the document and `<use>` is rewritten to the local fragment.

import { state } from "./state.ts";
import { resourceInflight } from "./resource-fetch.ts";
import { nativeSleep } from "./native-scheduling.ts";

const loadedSprites = new Map<string, Set<string>>();
const failedSprites = new Set<string>();

const MAX_SPRITES = 8;
const MAX_SPRITE_BYTES = 2 * 1024 * 1024;

interface ExternalRef {
  url: string;
  id: string;
  attr: string;
}

interface HrefReference {
  attr: string;
  raw: string;
}

function readHrefReference(use: any): HrefReference | null {
  const attr = use.hasAttribute("href")
    ? "href"
    : use.hasAttribute("xlink:href")
      ? "xlink:href"
      : null;
  if (!attr) return null;
  return { attr, raw: String(use.getAttribute(attr) || "") };
}

function hrefReference(use: any): HrefReference | null {
  try {
    return readHrefReference(use);
  } catch {
    return null;
  }
}

function fragmentReference(raw: string, attr: string): ExternalRef | null {
  const fragmentIndex = raw.indexOf("#");
  if (fragmentIndex <= 0) return null;
  const id = raw.slice(fragmentIndex + 1);
  if (!id) return null;
  const url = sameOriginSpriteUrl(raw.slice(0, fragmentIndex));
  if (!url) return null;
  return { url, id, attr };
}

function sameOriginSpriteUrl(path: string): string | null {
  let abs: URL;
  let page: URL;
  try {
    page = new URL(state.pageUrl);
    abs = new URL(path, state.pageUrl);
  } catch {
    return null;
  }
  if (abs.origin !== page.origin) return null;
  return abs.toString();
}

function externalRef(use: any): ExternalRef | null {
  const reference = hrefReference(use);
  if (!reference) return null;
  return fragmentReference(reference.raw, reference.attr);
}

function collectUses(): any[] {
  try {
    return Array.from((state.document as any).querySelectorAll("svg use"));
  } catch {
    return [];
  }
}

export function rewriteSpriteUses(): number {
  let rewritten = 0;
  for (const use of collectUses()) {
    rewritten += rewriteLoadedSpriteUse(use);
  }
  return rewritten;
}

function rewriteLoadedSpriteUse(use: any): number {
  const ref = externalRef(use);
  if (!ref) return 0;
  const ids = loadedSprites.get(ref.url);
  if (!ids || !ids.has(ref.id)) return 0;
  try {
    use.setAttribute("href", "#" + ref.id);
    return 1;
  } catch {
    return 0;
  }
}

function warnRejectedSprite(url: string, response: Response | null | undefined): void {
  try {
    console.warn(`[ks-sprites] sprite fetch ${url}: HTTP ${response ? response.status : "null"}`);
  } catch {}
}

function warnOversizedSprite(url: string, text: string): void {
  try {
    console.warn(
      `[ks-sprites] sprite rejected ${url}: ${text ? text.length : 0} bytes (cap ${MAX_SPRITE_BYTES})`,
    );
  } catch {}
}

async function fetchSpriteText(url: string): Promise<string | null> {
  const response = await fetch(url);
  if (!response || !response.ok) {
    warnRejectedSprite(url, response);
    return null;
  }
  const text = await response.text();
  if (!text || text.length > MAX_SPRITE_BYTES) {
    warnOversizedSprite(url, text);
    return null;
  }
  return text;
}

function spriteIdsIn(holder: any): Set<string> {
  const ids = new Set<string>();
  for (const element of Array.from(holder.querySelectorAll("[id]")) as any[]) {
    try {
      ids.add(String(element.getAttribute("id")));
    } catch {}
  }
  return ids;
}

function installSpriteHolder(url: string, text: string): Set<string> {
  const doc = state.document as any;
  const holder = doc.createElement("div");
  holder.setAttribute("style", "display:none");
  holder.setAttribute("aria-hidden", "true");
  holder.setAttribute("data-ks-sprite", url);
  holder.innerHTML = text;
  (doc.body || doc.documentElement).appendChild(holder);
  return spriteIdsIn(holder);
}

async function loadSprite(url: string): Promise<void> {
  try {
    const text = await fetchSpriteText(url);
    if (!text) {
      failedSprites.add(url);
      return;
    }
    loadedSprites.set(url, installSpriteHolder(url, text));
  } catch (e) {
    warnSpriteLoadFailure(url, e);
    failedSprites.add(url);
  }
}

function warnSpriteLoadFailure(url: string, error: unknown): void {
  const MAX_SPRITE_ERROR_MESSAGE_CHARS = 160;
  try {
    console.warn(
      `[ks-sprites] sprite load failed ${url}: ${String((error as any)?.message || error).slice(0, MAX_SPRITE_ERROR_MESSAGE_CHARS)}`,
    );
  } catch {}
}

function collectWantedSprites(): string[] {
  const wanted: string[] = [];
  for (const use of collectUses()) {
    const ref = externalRef(use);
    if (!ref || !isUnseenSprite(ref.url, wanted)) continue;
    wanted.push(ref.url);
    if (wanted.length >= MAX_SPRITES) break;
  }
  return wanted;
}

function isUnseenSprite(url: string, wanted: string[]): boolean {
  return !loadedSprites.has(url) && !failedSprites.has(url) && !wanted.includes(url);
}

async function fetchWantedSprites(wanted: string[]): Promise<void> {
  for (const url of wanted) resourceInflight.add("sprite:" + url);
  try {
    await Promise.all(
      wanted.map((url) => loadSprite(url).finally(() => resourceInflight.delete("sprite:" + url))),
    );
    rewriteSpriteUses();
  } catch {
    for (const url of wanted) resourceInflight.delete("sprite:" + url);
  }
}

export function resolveExternalSvgSprites(): Promise<void> {
  const wanted = collectWantedSprites();
  if (wanted.length === 0) {
    rewriteSpriteUses();
    return Promise.resolve();
  }
  try {
    console.warn(`[ks-sprites] fetching ${wanted.length} sprite(s): ${wanted.join(", ")}`);
  } catch {}
  return fetchWantedSprites(wanted);
}

const LATE_SPRITE_SWEEP_PASSES = 12;
const LATE_SPRITE_SWEEP_INTERVAL_MS = 1_000;

export function startLateSpriteSweep(
  passes = LATE_SPRITE_SWEEP_PASSES,
  intervalMs = LATE_SPRITE_SWEEP_INTERVAL_MS,
): void {
  void (async () => {
    for (let i = 0; i < passes; i++) {
      await nativeSleep(intervalMs);
      try {
        await resolveExternalSvgSprites();
      } catch {}
    }
  })();
}
