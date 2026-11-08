// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Whole-source scans a navigation needs before the parse: the fonts it wants, its leading doctype
// and whether it has `on…=` attributes. The engine runs them and sends PageScript UTF-8 bytes, so
// the page isolate never holds the source as a string, which would live until a major GC.

import type { NavigateSource, SourceFontScan } from "@kitesurf/jsrpc-types/page-script";

// These BMP characters use emoji presentation by default. Most loaded fonts do not contain them.
// U+FE0F requests emoji presentation for other characters. Keep the escapes for classRanges.
export const EMOJI_BMP_SCAN =
  /[\u231A-\u231B\u23E9-\u23EC\u23F0\u23F3\u25FD-\u25FE\u2614-\u2615\u2648-\u2653\u267F\u2693\u26A1\u26AA-\u26AB\u26BD-\u26BE\u26C4-\u26C5\u26CE\u26D4\u26EA\u26F2-\u26F3\u26F5\u26FA\u26FD\u2705\u270A-\u270B\u2728\u274C\u274E\u2753-\u2755\u2757\u2795-\u2797\u27B0\u27BF\u2B1B-\u2B1C\u2B50\u2B55\uFE0F]/;

function needsEmoji(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  return /[\u{1F000}-\u{1FFFF}]/u.test(text) || EMOJI_BMP_SCAN.test(text);
}

export const CJK_SCAN =
  /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/;

function needsCjk(html: string): boolean {
  if (typeof html !== "string" || html.length === 0) return false;
  return CJK_SCAN.test(html);
}

function hasListMarkers(html: string): boolean {
  return /<(?:ul|ol|li)[\s/>]/i.test(html);
}

function needsSymbols(html: string): boolean {
  if (typeof html !== "string" || html.length === 0) return false;
  return /[\u{2100}-\u{2BFF}]/u.test(html) || hasListMarkers(html);
}

/** Script faces in registration order, each with the characters that want it. */
export const SCRIPT_RANGES: readonly { tag: string; range: RegExp }[] = [
  { tag: "Arab", range: /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/ },
  { tag: "Hebr", range: /[\u0590-\u05FF\uFB1D-\uFB4F]/ },
  { tag: "Deva", range: /[\u0900-\u097F\uA8E0-\uA8FF]/ },
  { tag: "Thai", range: /[\u0E00-\u0E7F]/ },
  { tag: "Beng", range: /[\u0980-\u09FF]/ },
  { tag: "Taml", range: /[\u0B80-\u0BFF]/ },
  { tag: "Ethi", range: /[\u1200-\u137F\u1380-\u139F\u2D80-\u2DDF]/ },
  { tag: "Guru", range: /[\u0A00-\u0A7F]/ },
  { tag: "Gujr", range: /[\u0A80-\u0AFF]/ },
  { tag: "Knda", range: /[\u0C80-\u0CFF]/ },
  { tag: "Mlym", range: /[\u0D00-\u0D7F]/ },
  { tag: "Telu", range: /[\u0C00-\u0C7F]/ },
  { tag: "Sinh", range: /[\u0D80-\u0DFF]/ },
  { tag: "Mymr", range: /[\u1000-\u109F\uAA60-\uAA7F\uA9E0-\uA9FF]/ },
  { tag: "Khmr", range: /[\u1780-\u17FF\u19E0-\u19FF]/ },
  { tag: "Laoo", range: /[\u0E80-\u0EFF]/ },
  { tag: "Geor", range: /[\u10A0-\u10FF\u2D00-\u2D2F\u1C90-\u1CBF]/ },
  { tag: "Armn", range: /[\u0530-\u058F\uFB13-\uFB17]/ },
];

const ANY_SCRIPT_RANGE = new RegExp(
  "[" +
    SCRIPT_RANGES.map(({ tag, range }) => {
      const source = range.source;
      if (!source.startsWith("[") || !source.endsWith("]")) {
        throw new Error(
          `[kitesurf-fonts] SCRIPT_RANGES[${tag}] must be a bare char class, got ${source}`,
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
    const cp = Number.parseInt(match[1] ?? match[2] ?? "", match[1] ? 16 : 10);
    if (cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) {
      decoded += String.fromCodePoint(cp);
    }
  }
  return decoded ? html + decoded : html;
}

const SYMBOLS2_EXCLUSIVE =
  /[\u21AF\u21E6-\u21F0\u21F3\u2218-\u2219\u2299\u22C4-\u22C6\u2316\u2318\u231A-\u231B\u2324-\u2328\u232B\u237B\u237D-\u237F\u23CE-\u23CF\u23E9-\u23EA\u23ED-\u23EF\u23F1-\u2426\u2440-\u244A\u25A0-\u25CB\u25CD-\u2609\u260E-\u2612\u2614-\u2623\u2630-\u2637\u263C\u2654-\u2668\u267F-\u268F\u269E-\u26A1\u26AA-\u26AC\u26BD-\u26CD\u26CF-\u26E1\u2700-\u2704\u2706-\u2709\u270B-\u271C\u2722-\u2727\u2729-\u274B\u274D\u274F-\u2753\u2756-\u2775\u2794\u2798-\u27AF\u27B1-\u27BE\u2800-\u28FF\u2981\u29BF\u29EB\u2B00-\u2B0D\u2B12-\u2B2F\u2B4D-\u2B73\u2B76-\u2B95\u2B97-\u2BFD\u2BFF]/;

function needsSymbols2(html: string): boolean {
  return SYMBOLS2_EXCLUSIVE.test(html) || hasListMarkers(html);
}

function needsMono(html: string): boolean {
  if (typeof html !== "string" || html.length === 0) return false;
  if (/<(pre|code|kbd|samp|tt|xmp|listing|plaintext)[\s/>]/i.test(html)) return true;
  const mono = /(?:monospace|font-mono|DM(?:%20|\+|\s)+Mono)/i;
  // Scanned with indexOf rather than a lazy regex: `<style` with no closing `>` or `</style>`
  // made every candidate rescan the rest of the page, and this runs in the engine isolate
  // before the navigate RPC.
  const opens = /<style/gi;
  let scannedTo = -1;
  for (let match = opens.exec(html); match !== null; match = opens.exec(html)) {
    const at = match.index;
    if (isAsciiWordChar(html.charCodeAt(at + "<style".length))) continue;
    if (at < scannedTo) continue;
    const open = html.indexOf(">", at);
    if (open < 0) break;
    const closes = /<\/style>/gi;
    closes.lastIndex = open + 1;
    const close = closes.exec(html);
    if (!close) break;
    scannedTo = close.index + "</style>".length;
    if (mono.test(html.slice(open + 1, close.index))) return true;
  }
  for (const [context] of html.matchAll(/(?:class|style)\s*=\s*(?:"[^"]*"|'[^']*')/gi)) {
    if (mono.test(context)) return true;
  }
  return false;
}

function needsSerif(html: string): boolean {
  if (typeof html !== "string" || html.length === 0) return false;
  if (hasSerifOutsideSansSerif(html)) return true;
  return /\b(?:times(?:\s+new\s+roman)?|georgia|cambria|garamond|palatino|baskerville|didot|merriweather|noto\s+serif|pt\s+serif|source\s+serif|dm\s+serif|playfair|slabo|roboto\s+slab|constantia|sabon|book\s+antiqua)\b/i.test(
    html,
  );
}

const SANS_SERIF_LENGTH = "sans-serif".length;

function isAsciiWordChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

// Same answer as testing /\bserif\b/i after html.replace(/sans-serif/gi, " "), without copying
// the page. Neither token can overlap another, so a `sans-serif` match only matters as the space
// it would leave beside a `serif`.
function hasSerifOutsideSansSerif(html: string): boolean {
  const tokens = /sans-serif|serif/gi;
  const sansSerifAt = /sans-serif/iy;
  let sansSerifEnd = -1;
  for (let match = tokens.exec(html); match !== null; match = tokens.exec(html)) {
    const start = match.index;
    const end = start + match[0].length;
    if (match[0].length === SANS_SERIF_LENGTH) {
      sansSerifEnd = end;
      continue;
    }
    const boundaryBefore =
      start === 0 || start === sansSerifEnd || !isAsciiWordChar(html.charCodeAt(start - 1));
    sansSerifAt.lastIndex = end;
    const boundaryAfter =
      end === html.length || !isAsciiWordChar(html.charCodeAt(end)) || sansSerifAt.test(html);
    if (boundaryBefore && boundaryAfter) return true;
  }
  return false;
}

function needsOutlineConsumers(html: string): boolean {
  if (typeof html !== "string" || html.length === 0) return false;
  if (/<canvas[\s/>]/i.test(html)) return true;
  return /<svg[\s/>]/i.test(html) && /<text[\s/>]/i.test(html);
}

/** The font faces `html` wants before its first layout. */
export function scanSourceFonts(html: string): SourceFontScan {
  const symbols = !!html && needsSymbols(html);
  const scripts: string[] = [];
  const perScriptScan = html ? scriptScanText(html) : "";
  if (perScriptScan && ANY_SCRIPT_RANGE.test(perScriptScan)) {
    for (const { tag, range } of SCRIPT_RANGES) {
      if (range.test(perScriptScan)) scripts.push(tag);
    }
  }
  return {
    outline: !!html && needsOutlineConsumers(html),
    symbols,
    symbols2: symbols && needsSymbols2(html),
    emoji: needsEmoji(perScriptScan),
    cjk: !!html && needsCjk(html),
    mono: !!html && needsMono(html),
    serif: !!html && needsSerif(html),
    scripts,
  };
}

// A comment ends at its first `-->`. A lazy `<!--[\s\S]*?-->` may span several comments and
// backtracks exponentially on `<!----><!---->…` without a doctype.
const LEADING_COMMENTS = String.raw`(?:\s|<!--(?:(?!-->)[\s\S])*-->)*`;
const SOURCE_DOCTYPE = new RegExp(String.raw`^(${LEADING_COMMENTS})(<!doctype\b[^>]*>)`, "i");

/** The leading doctype, normalised, and the UTF-16 offset just past it. */
export function sourceDoctypeOf(html: string): { markup: string; end: number } | null {
  const match = html.match(SOURCE_DOCTYPE);
  const raw = match?.[2];
  if (!raw) return null;
  const prefix = match?.[1] ?? "";
  const end = prefix.length + raw.length;

  const body = raw.slice("<!doctype".length, -1).trim();
  const parsed = body.match(
    /^([^\s>]+)(?:\s+(PUBLIC|SYSTEM)\s+(?:"([^"]*)"|'([^']*)')(?:\s+(?:"([^"]*)"|'([^']*)'))?)?$/i,
  );
  if (!parsed) return { markup: raw, end };

  const name = parsed[1]?.toLowerCase() ?? "html";
  const keyword = parsed[2]?.toUpperCase();
  const firstId = parsed[3] ?? parsed[4];
  const secondId = parsed[5] ?? parsed[6];
  const quote = (value: string) => (value.includes('"') ? `'${value}'` : `"${value}"`);
  if (keyword === "PUBLIC" && firstId !== undefined) {
    const system = secondId === undefined ? "" : ` ${quote(secondId)}`;
    return {
      markup: `<!DOCTYPE ${name} PUBLIC ${quote(firstId)}${system}>`,
      end,
    };
  }
  if (keyword === "SYSTEM" && firstId !== undefined) {
    return {
      markup: `<!DOCTYPE ${name} SYSTEM ${quote(firstId)}>`,
      end,
    };
  }
  return { markup: `<!DOCTYPE ${name}>`, end };
}

/** Frees `source`'s bytes now rather than at the next GC. Its scans stay readable. */
export function releaseNavigateSource(source: NavigateSource): void {
  const { buffer, byteLength } = source.utf8;
  // Detach only a buffer the view owns whole; another view may share a larger one.
  if (buffer instanceof ArrayBuffer && !buffer.detached && buffer.byteLength === byteLength) {
    buffer.transfer(0);
  }
}

/** `html` as UTF-8 with the scans PageScript runs before the parse. */
export function navigateSourceOf(html: string): NavigateSource {
  const encoder = new TextEncoder();
  const doctype = sourceDoctypeOf(html);
  return {
    utf8: encoder.encode(html),
    fonts: scanSourceFonts(html),
    eventHandlerAttributes: /\son\w+\s*=/i.test(html),
    doctype: doctype
      ? { markup: doctype.markup, utf8End: encoder.encode(html.slice(0, doctype.end)).length }
      : null,
  };
}
