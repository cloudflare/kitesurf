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

let pending: Promise<void> | null = null;

let emojiPending: Promise<void> | null = null;

// These BMP characters use emoji presentation by default. Most loaded fonts do not contain them.
// U+FE0F requests emoji presentation for other characters. Keep the escapes for classRanges.
const EMOJI_BMP_SCAN =
  /[\u231A-\u231B\u23E9-\u23EC\u23F0\u23F3\u25FD-\u25FE\u2614-\u2615\u2648-\u2653\u267F\u2693\u26A1\u26AA-\u26AB\u26BD-\u26BE\u26C4-\u26C5\u26CE\u26D4\u26EA\u26F2-\u26F3\u26F5\u26FA\u26FD\u2705\u270A-\u270B\u2728\u274C\u274E\u2753-\u2755\u2757\u2795-\u2797\u27B0\u27BF\u2B1B-\u2B1C\u2B50\u2B55\uFE0F]/;

function needsEmoji(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  return /[\u{1F000}-\u{1FFFF}]/u.test(text) || EMOJI_BMP_SCAN.test(text);
}

const ASSET_HOST = "http://kitesurf-fonts";

const UA_FONT_PATHS = ["/fonts/NotoSans.ttf", "/fonts/NotoSans-Italic.ttf", "/fonts/NotoSerif.ttf"];

const MONO_FONT_PATH = "/fonts/NotoSansMono.ttf";

const EMPTY_FACE = new Uint8Array(0);

const SYMBOL_FONT_PATHS = ["/fonts/NotoSansSymbols.ttf", "/fonts/NotoSansSymbols2.ttf"];

const EMOJI_FONT_PATH = "/fonts/noto-color-emoji.woff2";

const CJK_FONT_PATH = "/fonts/NotoSansCJKsc-Regular.woff2";

const EMOJI_SHAPING_PATH = "/fonts/noto-color-emoji.shaping.otf";

const CJK_SHAPING_PATH = "/fonts/NotoSansCJKsc-Regular.shaping.otf";

const CJK_SCAN = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/;
let cjkPending: Promise<void> | null = null;

function needsCjk(html: string): boolean {
  if (typeof html !== "string" || html.length === 0) return false;
  return CJK_SCAN.test(html);
}

let symbolPending: Promise<void> | null = null;

function hasListMarkers(html: string): boolean {
  return /<(?:ul|ol|li)[\s/>]/i.test(html);
}

function needsSymbols(html: string): boolean {
  if (typeof html !== "string" || html.length === 0) return false;
  return /[\u{2100}-\u{2BFF}]/u.test(html) || hasListMarkers(html);
}

interface ScriptFont {
  tag: string;
  path: string;
  range: RegExp;
}
const SCRIPT_FONTS: ScriptFont[] = [
  {
    tag: "Arab",
    path: "/fonts/NotoSansArabic.ttf",
    range: /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/,
  },
  { tag: "Hebr", path: "/fonts/NotoSansHebrew.ttf", range: /[\u0590-\u05FF\uFB1D-\uFB4F]/ },
  { tag: "Deva", path: "/fonts/NotoSansDevanagari.ttf", range: /[\u0900-\u097F\uA8E0-\uA8FF]/ },
  { tag: "Thai", path: "/fonts/NotoSansThai.ttf", range: /[\u0E00-\u0E7F]/ },
  { tag: "Beng", path: "/fonts/NotoSansBengali.ttf", range: /[\u0980-\u09FF]/ },
  { tag: "Taml", path: "/fonts/NotoSansTamil.ttf", range: /[\u0B80-\u0BFF]/ },
  {
    tag: "Ethi",
    path: "/fonts/NotoSansEthiopic.ttf",
    range: /[\u1200-\u137F\u1380-\u139F\u2D80-\u2DDF]/,
  },
  { tag: "Guru", path: "/fonts/NotoSansGurmukhi.ttf", range: /[\u0A00-\u0A7F]/ },
  { tag: "Gujr", path: "/fonts/NotoSansGujarati.ttf", range: /[\u0A80-\u0AFF]/ },
  { tag: "Knda", path: "/fonts/NotoSansKannada.ttf", range: /[\u0C80-\u0CFF]/ },
  { tag: "Mlym", path: "/fonts/NotoSansMalayalam.ttf", range: /[\u0D00-\u0D7F]/ },
  { tag: "Telu", path: "/fonts/NotoSansTelugu.ttf", range: /[\u0C00-\u0C7F]/ },
  { tag: "Sinh", path: "/fonts/NotoSansSinhala.ttf", range: /[\u0D80-\u0DFF]/ },
  {
    tag: "Mymr",
    path: "/fonts/NotoSansMyanmar.ttf",
    range: /[\u1000-\u109F\uAA60-\uAA7F\uA9E0-\uA9FF]/,
  },
  { tag: "Khmr", path: "/fonts/NotoSansKhmer.ttf", range: /[\u1780-\u17FF\u19E0-\u19FF]/ },
  { tag: "Laoo", path: "/fonts/NotoSansLao.ttf", range: /[\u0E80-\u0EFF]/ },
  {
    tag: "Geor",
    path: "/fonts/NotoSansGeorgian.ttf",
    range: /[\u10A0-\u10FF\u2D00-\u2D2F\u1C90-\u1CBF]/,
  },
  { tag: "Armn", path: "/fonts/NotoSansArmenian.ttf", range: /[\u0530-\u058F\uFB13-\uFB17]/ },
];

const ANY_SCRIPT_RANGE = new RegExp(
  "[" +
    SCRIPT_FONTS.map((scriptFont) => {
      const source = scriptFont.range.source;
      if (!source.startsWith("[") || !source.endsWith("]")) {
        throw new Error(
          `[kitesurf-fonts] SCRIPT_FONTS[${scriptFont.tag}] must be a bare char class, got ${source}`,
        );
      }
      return source.slice(1, -1);
    }).join("") +
    "]",
);

function scriptScanText(html: string): string {
  if (!html.includes("&#")) return html;
  let decoded = "";
  const refs = /&#(?:x([0-9a-f]+)|([0-9]+));?/gi;
  for (const match of html.matchAll(refs)) {
    const cp = Number.parseInt(match[1] ?? match[2], match[1] ? 16 : 10);
    if (cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) {
      decoded += String.fromCodePoint(cp);
    }
  }
  return decoded ? html + decoded : html;
}

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

const SYMBOLS2_EXCLUSIVE =
  /[\u21AF\u21E6-\u21F0\u21F3\u2218-\u2219\u2299\u22C4-\u22C6\u2316\u2318\u231A-\u231B\u2324-\u2328\u232B\u237B\u237D-\u237F\u23CE-\u23CF\u23E9-\u23EA\u23ED-\u23EF\u23F1-\u2426\u2440-\u244A\u25A0-\u25CB\u25CD-\u2609\u260E-\u2612\u2614-\u2623\u2630-\u2637\u263C\u2654-\u2668\u267F-\u268F\u269E-\u26A1\u26AA-\u26AC\u26BD-\u26CD\u26CF-\u26E1\u2700-\u2704\u2706-\u2709\u270B-\u271C\u2722-\u2727\u2729-\u274B\u274D\u274F-\u2753\u2756-\u2775\u2794\u2798-\u27AF\u27B1-\u27BE\u2800-\u28FF\u2981\u29BF\u29EB\u2B00-\u2B0D\u2B12-\u2B2F\u2B4D-\u2B73\u2B76-\u2B95\u2B97-\u2BFD\u2BFF]/;

function needsSymbols2(html: string): boolean {
  return SYMBOLS2_EXCLUSIVE.test(html) || hasListMarkers(html);
}

function needsMono(html: string): boolean {
  if (typeof html !== "string" || html.length === 0) return false;
  if (/<(pre|code|kbd|samp|tt|xmp|listing|plaintext)[\s/>]/i.test(html)) return true;
  for (const [context] of html.matchAll(
    /<style\b[^>]*>[\s\S]*?<\/style>|(?:class|style)\s*=\s*(?:"[^"]*"|'[^']*')/gi,
  )) {
    if (/(?:monospace|font-mono|DM(?:%20|\+|\s)+Mono)/i.test(context)) return true;
  }
  return false;
}

function needsSerif(html: string): boolean {
  if (typeof html !== "string" || html.length === 0) return false;
  const serifScanText = html.replace(/sans-serif/gi, " ");
  if (/\bserif\b/i.test(serifScanText)) return true;
  return /\b(?:times(?:\s+new\s+roman)?|georgia|cambria|garamond|palatino|baskerville|didot|merriweather|noto\s+serif|pt\s+serif|source\s+serif|dm\s+serif|playfair|slabo|roboto\s+slab|constantia|sabon|book\s+antiqua)\b/i.test(
    html,
  );
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

function needsOutlineConsumers(html: string): boolean {
  if (typeof html !== "string" || html.length === 0) return false;
  if (/<canvas[\s/>]/i.test(html)) return true;
  return /<svg[\s/>]/i.test(html) && /<text[\s/>]/i.test(html);
}

function decideFontMode(html: string | undefined): void {
  if (fontMode !== null) return;
  if (startupPixelFree) {
    fontMode = "pixelFree";
    return;
  }
  if (html && needsOutlineConsumers(html)) {
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

function computeFontWants(html?: string): {
  symbols: boolean;
  symbols2: boolean;
  emoji: boolean;
  cjk: boolean;
  mono: boolean;
  serif: boolean;
  scripts: ScriptFont[];
} {
  const symbols = !!html && needsSymbols(html);
  const scripts: ScriptFont[] = [];
  const perScriptScan = html ? scriptScanText(html) : "";
  if (perScriptScan && ANY_SCRIPT_RANGE.test(perScriptScan)) {
    for (const scriptFont of SCRIPT_FONTS) {
      if (scriptFont.range.test(perScriptScan)) scripts.push(scriptFont);
    }
  }
  return {
    symbols,
    symbols2: symbols && needsSymbols2(html),
    emoji: needsEmoji(perScriptScan),
    cjk: !!html && needsCjk(html),
    mono: forceMono || (!!html && needsMono(html)),
    serif: !!html && needsSerif(html),
    scripts,
  };
}

export async function ensureFontsRegistered(htmlForEmojiScan?: string): Promise<void> {
  decideFontMode(htmlForEmojiScan);
  const wants = computeFontWants(htmlForEmojiScan);
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
        // Only the sans pair is required; any other face settles empty and its generics use sans.
        const optional = (path: string): Promise<Uint8Array> =>
          fetchFaceBytes(path).catch((e) => {
            console.warn(`[kitesurf-fonts] ${path} fetch failed:`, String(e));
            return EMPTY_FACE;
          });
        const [sans, sansItalic, serif, mono] = await Promise.all([
          fetchFaceBytes(UA_FONT_PATHS[0]),
          fetchFaceBytes(UA_FONT_PATHS[1]),
          wantSerif ? optional(UA_FONT_PATHS[2]) : EMPTY_FACE,
          wantMono ? optional(MONO_FONT_PATH) : EMPTY_FACE,
        ]);

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
      register_ua_fonts(
        sans,
        sansItalic,
        deferStash.serif ?? new Uint8Array(0),
        deferStash.mono ?? new Uint8Array(0),
      );
      deferCoreRegistered = true;
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
    group("symbols", () => register_symbol_fonts(symbols, symbols2 ?? new Uint8Array(0)));
  }
  if (wants.emoji && emoji) group("emoji", () => register_emoji_font(emoji));
  if (wants.cjk && cjk) group("cjk", () => register_cjk_font(cjk));
  for (const [tag, bytes] of deferStash.scripts) {
    group(`script:${tag}`, () => register_script_font(bytes, tag));
  }
  return true;
}

export function startFontPrefetch(html?: string): void {
  if (deferStarted) return;
  deferStarted = true;
  decideFontMode(html);
  const wants = computeFontWants(html);
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
