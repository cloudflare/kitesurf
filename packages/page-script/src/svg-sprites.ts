// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Resolves same-origin external SVG sprites used by <use> elements.
// Inline SVG paints from a usvg snapshot, which cannot fetch, so each sprite file is parsed into a
// hidden holder in the document and `<use>` is rewritten to the local fragment.

import { getInternalState } from "./internal-state.js";
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

function externalRef(use: any): ExternalRef | null {
  let attr: string | null = null;
  let raw = "";
  try {
    if (use.hasAttribute("href")) {
      attr = "href";
      raw = String(use.getAttribute("href") || "");
    } else if (use.hasAttribute("xlink:href")) {
      attr = "xlink:href";
      raw = String(use.getAttribute("xlink:href") || "");
    }
  } catch {
    return null;
  }
  if (!attr) return null;
  const fragmentIndex = raw.indexOf("#");
  if (fragmentIndex <= 0) return null;
  const id = raw.slice(fragmentIndex + 1);
  if (!id) return null;
  let abs: URL;
  let page: URL;
  try {
    page = new URL(state.pageUrl);
    abs = new URL(raw.slice(0, fragmentIndex), state.pageUrl);
  } catch {
    return null;
  }
  if (abs.origin !== page.origin) return null;
  return { url: abs.toString(), id, attr };
}

function collectUses(): any[] {
  try {
    return Array.from((state.document as any).querySelectorAll("svg use"));
  } catch {
    return [];
  }
}

export function rewriteSpriteUses(uses: any[] = collectUses()): number {
  let rewritten = 0;
  for (const use of uses) {
    const ref = externalRef(use);
    if (!ref) continue;
    const ids = loadedSprites.get(ref.url);
    if (!ids || !ids.has(ref.id)) continue;
    try {
      use.setAttribute("href", "#" + ref.id);
      rewritten++;
    } catch {}
  }
  return rewritten;
}

async function loadSprite(url: string): Promise<void> {
  try {
    const response = await fetch(url);
    if (!response || !response.ok) {
      try {
        console.warn(
          `[ks-sprites] sprite fetch ${url}: HTTP ${response ? response.status : "null"}`,
        );
      } catch {}
      failedSprites.add(url);
      return;
    }
    const text = await response.text();
    if (!text || text.length > MAX_SPRITE_BYTES) {
      try {
        console.warn(
          `[ks-sprites] sprite rejected ${url}: ${text ? text.length : 0} bytes (cap ${MAX_SPRITE_BYTES})`,
        );
      } catch {}
      failedSprites.add(url);
      return;
    }
    const doc = state.document as any;
    const holder = doc.createElement("div");
    holder.setAttribute("style", "display:none");
    holder.setAttribute("aria-hidden", "true");
    holder.setAttribute("data-ks-sprite", url);
    holder.innerHTML = text;
    (doc.body || doc.documentElement).appendChild(holder);
    const ids = new Set<string>();
    for (const element of Array.from(holder.querySelectorAll("[id]")) as any[]) {
      try {
        ids.add(String(element.getAttribute("id")));
      } catch {}
    }
    loadedSprites.set(url, ids);
  } catch (e) {
    const MAX_SPRITE_ERROR_MESSAGE_CHARS = 160;
    try {
      console.warn(
        `[ks-sprites] sprite load failed ${url}: ${String((e as any)?.message || e).slice(0, MAX_SPRITE_ERROR_MESSAGE_CHARS)}`,
      );
    } catch {}
    failedSprites.add(url);
  }
}

export function resolveExternalSvgSprites(): Promise<void> {
  const wanted: string[] = [];
  const uses = collectUses();
  for (const use of uses) {
    const ref = externalRef(use);
    if (!ref) continue;
    if (loadedSprites.has(ref.url) || failedSprites.has(ref.url)) continue;
    if (!wanted.includes(ref.url)) {
      wanted.push(ref.url);
      if (wanted.length >= MAX_SPRITES) break;
    }
  }
  if (wanted.length === 0) {
    rewriteSpriteUses(uses);
    return Promise.resolve();
  }
  try {
    console.warn(`[ks-sprites] fetching ${wanted.length} sprite(s): ${wanted.join(", ")}`);
  } catch {}
  for (const url of wanted) resourceInflight.add("sprite:" + url);
  return (async () => {
    try {
      await Promise.all(
        wanted.map((url) =>
          loadSprite(url).finally(() => resourceInflight.delete("sprite:" + url)),
        ),
      );
      rewriteSpriteUses();
    } catch {
      for (const url of wanted) resourceInflight.delete("sprite:" + url);
    }
  })();
}

const LATE_SPRITE_SWEEP_PASSES = 12;
const LATE_SPRITE_SWEEP_INTERVAL_MS = 1_000;

export function startLateSpriteSweep(
  passes = LATE_SPRITE_SWEEP_PASSES,
  intervalMs = LATE_SPRITE_SWEEP_INTERVAL_MS,
): void {
  void (async () => {
    // A pass searches the whole document, so skip it while the tree is unchanged since the last
    // one: on a 740k-node page each search took about 0.4 s of CPU.
    let scannedTreeSeq: number | null = null;
    for (let i = 0; i < passes; i++) {
      await nativeSleep(intervalMs);
      const treeSeq = getInternalState().treeSeq | 0;
      if (treeSeq === scannedTreeSeq) continue;
      scannedTreeSeq = treeSeq;
      try {
        await resolveExternalSvgSprites();
      } catch {}
    }
  })();
}
