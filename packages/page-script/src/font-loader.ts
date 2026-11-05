// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Registers and loads fonts for core layout and text rendering.
// Fonts come from engine Static Assets through the `kitesurf-fonts` sentinel host and must be
// registered before the first DomHandle, or text renders as tofu.

import {
  register_ua_fonts,
  register_emoji_font,
  register_symbol_fonts,
  register_cjk_font,
  register_script_font,
  setFontShapingLazy,
  pendingLazyFontPaths,
  upgradeFontFace,
  finishFontUpgrade,
} from "./wasm-glue.js";
import { NativePromise } from "./native-scheduling.ts";
import { startupFontDefer, startupPixelFree } from "./startup-probe.ts";
import { CJK_SCAN, EMOJI_BMP_SCAN, SCRIPT_RANGES } from "./source-scan.ts";
import type { SourceFontScan } from "@kitesurf/jsrpc-types/page-script";

let pending: Promise<void> | null = null;

let emojiPending: Promise<void> | null = null;

const ASSET_HOST = "http://kitesurf-fonts";

const UA_FONT_PATHS = ["/fonts/NotoSans.ttf", "/fonts/NotoSans-Italic.ttf", "/fonts/NotoSerif.ttf"];

const MONO_FONT_PATH = "/fonts/NotoSansMono.ttf";

const SYMBOL_FONT_PATHS = ["/fonts/NotoSansSymbols.ttf", "/fonts/NotoSansSymbols2.ttf"];

const EMOJI_FONT_PATH = "/fonts/noto-color-emoji.woff2";

const CJK_FONT_PATH = "/fonts/NotoSansCJKsc-Regular.woff2";

const EMOJI_SHAPING_PATH = "/fonts/noto-color-emoji.shaping.otf";

const CJK_SHAPING_PATH = "/fonts/NotoSansCJKsc-Regular.shaping.otf";

let cjkPending: Promise<void> | null = null;

let symbolPending: Promise<void> | null = null;

interface ScriptFont {
  tag: string;
  path: string;
  range: RegExp;
}
const SCRIPT_FONT_FILES: Record<string, string> = {
  Arab: "NotoSansArabic.ttf",
  Hebr: "NotoSansHebrew.ttf",
  Deva: "NotoSansDevanagari.ttf",
  Thai: "NotoSansThai.ttf",
  Beng: "NotoSansBengali.ttf",
  Taml: "NotoSansTamil.ttf",
  Ethi: "NotoSansEthiopic.ttf",
  Guru: "NotoSansGurmukhi.ttf",
  Gujr: "NotoSansGujarati.ttf",
  Knda: "NotoSansKannada.ttf",
  Mlym: "NotoSansMalayalam.ttf",
  Telu: "NotoSansTelugu.ttf",
  Sinh: "NotoSansSinhala.ttf",
  Mymr: "NotoSansMyanmar.ttf",
  Khmr: "NotoSansKhmer.ttf",
  Laoo: "NotoSansLao.ttf",
  Geor: "NotoSansGeorgian.ttf",
  Armn: "NotoSansArmenian.ttf",
};
const SCRIPT_FONTS: ScriptFont[] = SCRIPT_RANGES.map(({ tag, range }) => {
  const file = SCRIPT_FONT_FILES[tag];
  if (!file) throw new Error(`[kitesurf-fonts] no face file for script ${tag}`);
  return { tag, path: `/fonts/${file}`, range };
});

const scriptPending = new Map<string, Promise<void>>();

function registerScriptIfNeeded(scriptFont: ScriptFont): Promise<void> {
  const existing = scriptPending.get(scriptFont.tag);
  if (existing) return existing;
  const registrationPromise = (async () => {
    try {
      const bytes = await fetchFaceBytes(scriptFont.path);
      register_script_font(bytes, scriptFont.tag);
      console.log(`[kitesurf-fonts] registered ${scriptFont.tag} (${bytes.byteLength} bytes)`);
    } catch (e) {
      console.warn(`[kitesurf-fonts] ${scriptFont.tag} registration failed:`, String(e));
      scriptPending.delete(scriptFont.tag);
      throw e;
    }
  })();
  scriptPending.set(scriptFont.tag, registrationPromise);
  return registrationPromise;
}

async function fetchBytes(path: string): Promise<Uint8Array> {
  const response = await fetch(ASSET_HOST + path);
  if (!response.ok) {
    throw new Error(`[kitesurf-fonts] ${path}: HTTP ${response.status} ${response.statusText}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function shapingVariant(path: string): string {
  return path.replace(/\.ttf$/, ".shaping.otf");
}

let fontMode: "full" | "pixelFree" | "lazy" | null = null;

export function fontLoaderMode(): "full" | "pixelFree" | "lazy" {
  return fontMode ?? "full";
}

function decideFontMode(scan: SourceFontScan | undefined): void {
  if (fontMode !== null) return;
  if (startupPixelFree) {
    fontMode = "pixelFree";
    return;
  }
  if (scan?.outline) {
    fontMode = "full";
    return;
  }
  fontMode = "lazy";
  try {
    setFontShapingLazy(true);
  } catch {}
}

async function fetchFaceBytes(path: string): Promise<Uint8Array> {
  if (fontLoaderMode() === "full") return fetchBytes(path);
  return fetchBytes(shapingVariant(path)).catch(() => fetchBytes(path));
}

let upgradePending: Promise<void> | null = null;
let onUpgraded: (() => void) | null = null;

export function setFontUpgradeCallback(cb: () => void): void {
  onUpgraded = cb;
}

let authorUpgradeHook: (() => Promise<void>) | null = null;

export function setAuthorFontUpgradeHook(hook: () => Promise<void>): void {
  authorUpgradeHook = hook;
}

export function upgradePendingPromise(): Promise<void> | null {
  return upgradePending;
}

export function upgradeToFullFonts(): Promise<void> | null {
  if (fontLoaderMode() !== "lazy") return upgradePending;
  if (upgradePending) return upgradePending;
  upgradePending = (async () => {
    const startedAt =
      typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    let fontPaths: string[] = [];
    try {
      fontPaths = pendingLazyFontPaths();
    } catch {}
    const fetchedFonts = await Promise.all(
      fontPaths.map(async (fontPath) => {
        try {
          return [fontPath, await fetchBytes(fontPath)] as const;
        } catch (e) {
          console.warn(`[kitesurf-fonts] upgrade fetch ${fontPath} failed:`, String(e));
          return [fontPath, null] as const;
        }
      }),
    );
    let swappedCount = 0;
    for (const [fontPath, fontBytes] of fetchedFonts) {
      if (!fontBytes) continue;
      try {
        if (upgradeFontFace(fontPath, fontBytes)) swappedCount++;
      } catch (e) {
        console.warn(`[kitesurf-fonts] upgrade swap ${fontPath} failed:`, String(e));
      }
    }
    try {
      await authorUpgradeHook?.();
    } catch {}
    let finished = false;
    try {
      finished = finishFontUpgrade();
    } catch {}
    if (finished) {
      fontMode = "full";
    } else {
      upgradePending = null;
    }
    const finishedAt =
      typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    console.log(
      `[kitesurf-fonts] upgraded ${swappedCount}/${fontPaths.length} faces to full in ${(finishedAt - startedAt).toFixed(1)}ms`,
    );
    if (swappedCount > 0) {
      try {
        onUpgraded?.();
      } catch {}
    }
  })();
  return upgradePending;
}

function registerSymbolsIfNeeded(wantSymbols2: boolean): Promise<void> {
  if (symbolPending) return symbolPending;
  symbolPending = (async () => {
    try {
      const fontFetches = [fetchFaceBytes(SYMBOL_FONT_PATHS[0])];
      if (wantSymbols2) fontFetches.push(fetchFaceBytes(SYMBOL_FONT_PATHS[1]));
      const fetchedFonts = await Promise.all(fontFetches);
      const symbols = fetchedFonts[0];
      const symbols2 = wantSymbols2 ? fetchedFonts[1] : new Uint8Array(0);
      register_symbol_fonts(symbols, symbols2);
      console.log(
        `[kitesurf-fonts] registered ${wantSymbols2 ? 2 : 1} symbol font(s) (${symbols.byteLength + symbols2.byteLength} bytes)`,
      );
    } catch (e) {
      console.warn("[kitesurf-fonts] symbol registration failed:", String(e));
      symbolPending = null;
      throw e;
    }
  })();
  return symbolPending;
}

function registerCjkIfNeeded(): Promise<void> {
  if (cjkPending) return cjkPending;
  cjkPending = (async () => {
    try {
      const startedAt =
        typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
      const bytes = await fetchBytes(CJK_SHAPING_PATH).catch(() => fetchBytes(CJK_FONT_PATH));
      register_cjk_font(bytes);
      const finishedAt =
        typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
      console.log(
        `[kitesurf-fonts] registered CJK font (${bytes.byteLength} bytes) in ${(finishedAt - startedAt).toFixed(1)}ms`,
      );
    } catch (e) {
      console.warn("[kitesurf-fonts] CJK registration failed:", String(e));
      cjkPending = null;
      throw e;
    }
  })();
  return cjkPending;
}

function registerEmojiIfNeeded(): Promise<void> {
  if (emojiPending) return emojiPending;
  emojiPending = (async () => {
    try {
      const emoji = await fetchBytes(EMOJI_SHAPING_PATH).catch(() => fetchBytes(EMOJI_FONT_PATH));
      register_emoji_font(emoji);
      console.log(`[kitesurf-fonts] registered color emoji (${emoji.byteLength} bytes)`);
    } catch (e) {
      console.warn("[kitesurf-fonts] emoji registration failed:", String(e));
      emojiPending = null;
      throw e;
    }
  })();
  return emojiPending;
}

export function emojiPendingPromise(): Promise<void> | null {
  return emojiPending;
}

export function cjkPendingPromise(): Promise<void> | null {
  return cjkPending;
}

export function scriptPendingPromises(): Promise<void>[] {
  return [...scriptPending.values()];
}

interface ScriptTextProbe {
  nonLatinTextWrites?(): number;
  textUsesCodepoints?(ranges: Uint32Array): boolean;
}

let nonLatinWritesSeen = 0;

function classRanges(unicodeRange: RegExp): Uint32Array {
  const out: number[] = [];
  for (const match of unicodeRange.source.matchAll(/\\u([0-9A-F]{4})(?:-\\u([0-9A-F]{4}))?/gi)) {
    const start = Number.parseInt(match[1], 16);
    out.push(start, match[2] ? Number.parseInt(match[2], 16) : start);
  }
  return Uint32Array.from(out);
}
const CJK_RANGES = classRanges(CJK_SCAN);
const EMOJI_RANGES = Uint32Array.from([...classRanges(EMOJI_BMP_SCAN), 0x1f000, 0x1ffff]);
const SCRIPT_FACE_RANGES = SCRIPT_FONTS.map((scriptFont) => ({
  scriptFont,
  ranges: classRanges(scriptFont.range),
}));

export function noteNavigateText(dom: ScriptTextProbe): void {
  nonLatinWritesSeen = dom.nonLatinTextWrites?.() ?? 0;
}

export function demandFacesForScriptText(dom: ScriptTextProbe): void {
  if (!dom.nonLatinTextWrites || !dom.textUsesCodepoints) return;
  const writes = dom.nonLatinTextWrites();
  if (writes === nonLatinWritesSeen) return;
  nonLatinWritesSeen = writes;
  const tasks: Promise<void>[] = [];
  if (!cjkPending && dom.textUsesCodepoints(CJK_RANGES)) {
    tasks.push(registerCjkIfNeeded());
  }
  if (!emojiPending && dom.textUsesCodepoints(EMOJI_RANGES)) {
    tasks.push(registerEmojiIfNeeded());
  }
  for (const { scriptFont, ranges } of SCRIPT_FACE_RANGES) {
    if (!scriptPending.has(scriptFont.tag) && dom.textUsesCodepoints(ranges)) {
      tasks.push(registerScriptIfNeeded(scriptFont));
    }
  }
  if (tasks.length === 0) return;
  void NativePromise.all(tasks.map((task) => task.catch(() => {}))).then(() => onUpgraded?.());
}

let forceMono = false;

export function forceMonoFace(): void {
  forceMono = true;
}

function computeFontWants(scan?: SourceFontScan): {
  symbols: boolean;
  symbols2: boolean;
  emoji: boolean;
  cjk: boolean;
  mono: boolean;
  serif: boolean;
  scripts: ScriptFont[];
} {
  return {
    symbols: !!scan?.symbols,
    symbols2: !!scan?.symbols2,
    emoji: !!scan?.emoji,
    cjk: !!scan?.cjk,
    mono: forceMono || !!scan?.mono,
    serif: !!scan?.serif,
    scripts: scan ? SCRIPT_FONTS.filter(({ tag }) => scan.scripts.includes(tag)) : [],
  };
}

export async function ensureFontsRegistered(scan?: SourceFontScan): Promise<void> {
  decideFontMode(scan);
  const wants = computeFontWants(scan);
  const wantSymbols = wants.symbols;
  const wantSymbols2 = wants.symbols2;
  const wantEmoji = wants.emoji;
  const wantCjk = wants.cjk;
  const wantMono = wants.mono;
  const wantSerif = wants.serif;

  if (!pending) {
    pending = (async () => {
      const startedAt =
        typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
      try {
        const coreFetches = [fetchFaceBytes(UA_FONT_PATHS[0]), fetchFaceBytes(UA_FONT_PATHS[1])];
        if (wantSerif) coreFetches.push(fetchFaceBytes(UA_FONT_PATHS[2]));
        if (wantMono) coreFetches.push(fetchFaceBytes(MONO_FONT_PATH));
        const faces = await Promise.all(coreFetches);
        const sans = faces[0];
        const sansItalic = faces[1];
        let faceIndex = 2;
        const serif = wantSerif ? faces[faceIndex++] : new Uint8Array(0);
        const mono = wantMono ? faces[faceIndex++] : new Uint8Array(0);

        register_ua_fonts(sans, sansItalic, serif, mono);

        const completedAt =
          typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
        const totalBytes =
          sans.byteLength + sansItalic.byteLength + serif.byteLength + mono.byteLength;
        console.log(
          `[kitesurf-fonts] registered ${wantMono ? 4 : 3} Latin UA fonts (${totalBytes} bytes) in ${(completedAt - startedAt).toFixed(1)}ms`,
        );
      } catch (e) {
        console.warn("[kitesurf-fonts] registration failed:", String(e));
        pending = null;
        throw e;
      }
    })();
  }

  try {
    await pending;
  } catch {
    return;
  }

  const tasks: Promise<void>[] = [];
  if (wantSymbols) tasks.push(registerSymbolsIfNeeded(wantSymbols2).catch(() => {}));
  if (wantEmoji) tasks.push(registerEmojiIfNeeded().catch(() => {}));
  if (wantCjk) tasks.push(registerCjkIfNeeded().catch(() => {}));
  for (const scriptFont of wants.scripts) {
    tasks.push(registerScriptIfNeeded(scriptFont).catch(() => {}));
  }
  if (tasks.length) await Promise.all(tasks);
}

let deferStarted = false;
let deferDemandArmed = false;
let deferCoreRegistered = false;
let deferCoreFailed = false;
let deferDegradedReads = 0;
let deferFetchSettled: Promise<void> | null = null;
let deferWants: ReturnType<typeof computeFontWants> | null = null;
const deferRegistered = new Set<string>();
const deferStash: {
  sans: Uint8Array | null;
  sansItalic: Uint8Array | null;
  serif: Uint8Array | null;
  mono: Uint8Array | null;
  symbols: Uint8Array | null;
  symbols2: Uint8Array | null;
  emoji: Uint8Array | null;
  cjk: Uint8Array | null;
  scripts: Map<string, Uint8Array>;
} = {
  sans: null,
  sansItalic: null,
  serif: null,
  mono: null,
  symbols: null,
  symbols2: null,
  emoji: null,
  cjk: null,
  scripts: new Map(),
};

export function fontsDeferredUnregistered(): boolean {
  return deferStarted && !deferCoreRegistered;
}

export function deferredDegradedReads(): number {
  return deferDegradedReads;
}

const deferSettledEmpty = new Set<string>();

function deferCoreBytesReady(): boolean {
  if (!deferWants) return false;
  if (!deferStash.sans || !deferStash.sansItalic) return false;
  if (deferWants.serif && !deferStash.serif && !deferSettledEmpty.has("serif")) return false;
  if (deferWants.mono && !deferStash.mono && !deferSettledEmpty.has("mono")) return false;
  return true;
}

function tryRegisterDeferred(): boolean {
  const wants = deferWants;
  if (!wants || deferCoreFailed) return false;
  if (!deferCoreRegistered) {
    const { sans, sansItalic } = deferStash;
    if (!sans || !sansItalic || !deferCoreBytesReady()) return false;
    try {
      const registered = register_ua_fonts(
        sans,
        sansItalic,
        deferStash.serif ?? new Uint8Array(0),
        deferStash.mono ?? new Uint8Array(0),
      );
      deferCoreRegistered = true;
      // Completed handoffs no longer need their JS staging buffers.
      if (registered) {
        deferStash.sans = null;
        deferStash.sansItalic = null;
        deferStash.serif = null;
        deferStash.mono = null;
      }
      console.log("[kitesurf-fonts] deferred: registered Latin UA core on demand");
    } catch (e) {
      console.warn("[kitesurf-fonts] deferred core registration failed:", String(e));
      deferCoreFailed = true;
      return false;
    }
  }
  const group = (name: string, run: () => void): void => {
    if (deferRegistered.has(name)) return;
    deferRegistered.add(name);
    try {
      run();
    } catch (e) {
      console.warn(`[kitesurf-fonts] deferred ${name} registration failed:`, String(e));
    }
  };
  const { symbols, symbols2, emoji, cjk } = deferStash;
  if (wants.symbols && symbols && (!wants.symbols2 || symbols2)) {
    group("symbols", () => {
      if (register_symbol_fonts(symbols, symbols2 ?? new Uint8Array(0))) {
        deferStash.symbols = null;
        deferStash.symbols2 = null;
      }
    });
  }
  if (wants.emoji && emoji) {
    group("emoji", () => {
      if (register_emoji_font(emoji)) deferStash.emoji = null;
    });
  }
  if (wants.cjk && cjk) {
    group("cjk", () => {
      if (register_cjk_font(cjk)) deferStash.cjk = null;
    });
  }
  for (const [tag, bytes] of deferStash.scripts) {
    group(`script:${tag}`, () => {
      if (register_script_font(bytes, tag)) deferStash.scripts.delete(tag);
    });
  }
  return true;
}

export function startFontPrefetch(scan?: SourceFontScan): void {
  if (deferStarted) return;
  deferStarted = true;
  decideFontMode(scan);
  const wants = computeFontWants(scan);
  deferWants = wants;
  const all: Promise<void>[] = [];
  const kick = (
    fetchPromise: Promise<Uint8Array>,
    storeBytes: (bytes: Uint8Array) => void,
    tier: "core" | "optional" | "extra",
    label: string,
  ): void => {
    all.push(
      fetchPromise
        .then((bytes) => {
          storeBytes(bytes);
          if (deferDemandArmed) tryRegisterDeferred();
        })
        .catch((error) => {
          if (tier === "core") deferCoreFailed = true;
          if (tier === "optional") {
            deferSettledEmpty.add(label);
            if (deferDemandArmed) tryRegisterDeferred();
          }
          console.warn(`[kitesurf-fonts] deferred ${label} fetch failed:`, String(error));
        }),
    );
  };
  kick(fetchFaceBytes(UA_FONT_PATHS[0]), (bytes) => (deferStash.sans = bytes), "core", "sans");
  kick(
    fetchFaceBytes(UA_FONT_PATHS[1]),
    (bytes) => (deferStash.sansItalic = bytes),
    "core",
    "sans-italic",
  );
  if (wants.serif) {
    kick(
      fetchFaceBytes(UA_FONT_PATHS[2]),
      (bytes) => (deferStash.serif = bytes),
      "optional",
      "serif",
    );
  }
  if (wants.mono) {
    kick(fetchFaceBytes(MONO_FONT_PATH), (bytes) => (deferStash.mono = bytes), "optional", "mono");
  }
  if (wants.symbols) {
    kick(
      fetchFaceBytes(SYMBOL_FONT_PATHS[0]),
      (bytes) => (deferStash.symbols = bytes),
      "extra",
      "symbols",
    );
  }
  if (wants.symbols2) {
    kick(
      fetchFaceBytes(SYMBOL_FONT_PATHS[1]),
      (bytes) => (deferStash.symbols2 = bytes),
      "extra",
      "symbols2",
    );
  }
  if (wants.emoji) {
    kick(
      fetchBytes(EMOJI_SHAPING_PATH).catch(() => fetchBytes(EMOJI_FONT_PATH)),
      (bytes) => (deferStash.emoji = bytes),
      "extra",
      "emoji",
    );
  }
  if (wants.cjk) {
    kick(
      fetchBytes(CJK_SHAPING_PATH).catch(() => fetchBytes(CJK_FONT_PATH)),
      (bytes) => (deferStash.cjk = bytes),
      "extra",
      "cjk",
    );
  }
  for (const scriptFont of wants.scripts) {
    kick(
      fetchFaceBytes(scriptFont.path),
      (bytes) => deferStash.scripts.set(scriptFont.tag, bytes),
      "extra",
      scriptFont.tag,
    );
  }
  deferFetchSettled = Promise.all(all).then(() => undefined);
  console.log(
    `[kitesurf-fonts] deferred: prefetching ${all.length} face file(s), registration on demand`,
  );
}

let parkedFontReleaseHook: (() => void) | null = null;

export function setParkedFontReleaseHook(cb: () => void): void {
  parkedFontReleaseHook = cb;
}

export function fontDemandFired(): boolean {
  return deferDemandArmed;
}

function releaseParkedFonts(): void {
  try {
    parkedFontReleaseHook?.();
  } catch (e) {
    console.warn("[kitesurf-fonts] parked font release failed:", String(e));
  }
}

export function demandDeferredFonts(): boolean {
  if (!deferStarted) {
    releaseParkedFonts();
    return true;
  }
  deferDemandArmed = true;
  releaseParkedFonts();
  if (deferCoreRegistered) {
    tryRegisterDeferred();
    return true;
  }
  if (tryRegisterDeferred()) return true;
  deferDegradedReads++;
  if (deferDegradedReads === 1) {
    console.warn(
      "[kitesurf-fonts] layout demand before deferred font bytes arrived — degraded read",
    );
  }
  return false;
}

export async function awaitDeferredFontBytes(): Promise<void> {
  if (!deferStarted || deferFetchSettled === null) return;
  await deferFetchSettled;
}

export async function awaitDeferredFonts(): Promise<void> {
  if (!deferStarted) return;
  deferDemandArmed = true;
  releaseParkedFonts();
  if (deferFetchSettled) await deferFetchSettled;
  tryRegisterDeferred();
}

export function fontDeferActive(): boolean {
  return startupFontDefer === true && startupPixelFree === true;
}
