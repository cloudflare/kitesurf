// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements CDP CSS commands and syncs stylesheet state with PageScript.

import type { CdpRequest, ParsedStyleSheet, StyleSheetEntry, TargetState } from "./types.ts";
import type { CdpMutation } from "@kitesurf/jsrpc-types/shared";
import type { DispatchCtx } from "./dispatch.ts";
import { decodableAcceptEncoding, type SandboxOutboundOverride } from "../eval/outbound.ts";
import type { PageScriptStub } from "../eval/page-script.ts";
import {
  sessionOf,
  stubQueryDom,
  type PageSession,
  type QueryDomCarrier,
  type EnumeratedStyleSheet,
} from "./page-session.ts";
import { ensureTargetDom } from "./dom-release.ts";

import type { Protocol } from "devtools-protocol";

export async function handleCss(ctx: DispatchCtx, req: CdpRequest): Promise<unknown> {
  const target = pickTarget(ctx, req.sessionId);
  const session = target ? sessionOf(ctx, target) : null;
  const ps = session?.ensure() ?? null;

  switch (req.method) {
    case "CSS.enable": {
      if (req.sessionId && target) {
        target.cssEnabledSessions.add(req.sessionId);
        for (const [id, entry] of target.styleSheets) {
          emitStyleSheetAddedToSession(ctx, target, id, entry, req.sessionId);
        }
      }
      if (target && ps) {
        try {
          await syncStyleSheetsFromEnumeration(ctx, target, ps);
        } catch {}
      }
      return {};
    }
    case "CSS.disable":
      if (req.sessionId && target) {
        target.cssEnabledSessions.delete(req.sessionId);
      }
      return {};

    case "CSS.getComputedStyleForNode": {
      const nodeId = req.params?.nodeId;
      if (typeof nodeId !== "number" || nodeId <= 0 || !session || !ps) {
        return {
          computedStyle: [],
          extraFields: { isAppearanceBase: false },
        } satisfies Protocol.CSS.GetComputedStyleForNodeResponse;
      }
      const r = await session.tryCall.getComputedStyle({ nodeId });
      return {
        computedStyle: copyNameValues(r?.computedStyle),
        extraFields: { isAppearanceBase: false },
      } satisfies Protocol.CSS.GetComputedStyleForNodeResponse;
    }

    case "CSS.getInlineStylesForNode": {
      const nodeId = req.params?.nodeId;
      if (typeof nodeId !== "number" || nodeId <= 0) {
        return {} satisfies Protocol.CSS.GetInlineStylesForNodeResponse;
      }
      const styleText = await readStyleAttribute(ctx, target, session, nodeId);
      if (styleText == null) {
        return {} satisfies Protocol.CSS.GetInlineStylesForNodeResponse;
      }
      const cssProperties = splitInlineDeclarations(styleText);
      const inlineStyle: Protocol.CSS.CSSStyle = {
        cssProperties,
        shorthandEntries: [],
        cssText: styleText,
      };
      return { inlineStyle } satisfies Protocol.CSS.GetInlineStylesForNodeResponse;
    }

    case "CSS.getMatchedStylesForNode": {
      const nodeId = req.params?.nodeId;
      if (typeof nodeId !== "number" || nodeId <= 0 || !session || !ps || !target) {
        return {
          matchedCSSRules: [],
          pseudoElements: [],
          inherited: [],
        } satisfies Protocol.CSS.GetMatchedStylesForNodeResponse;
      }
      const matched: Protocol.CSS.RuleMatch[] = [];
      for (const [styleSheetId, entry] of target.styleSheets) {
        const parsed = await getOrParseSheet(entry, ps);
        if (!parsed) continue;
        for (let ri = 0; ri < parsed.rules.length; ri++) {
          const rule = parsed.rules[ri];
          const rangeInfo = parsed.ranges[ri];
          if (!rule || !rangeInfo) continue;
          const matchResult = await session.call.matchSelectorList({
            nodeId,
            selectorListText: rule.selector_text,
          });
          const matchingSelectors = copyNumbers(matchResult?.matches);
          if (matchingSelectors.length === 0) continue;
          matched.push(
            buildRuleMatch(styleSheetId, rule, rangeInfo, matchingSelectors, entry.origin),
          );
        }
      }
      const inherited = await buildInheritedChain(target, ps, nodeId);
      return {
        matchedCSSRules: matched,
        pseudoElements: [],
        inherited,
      } satisfies Protocol.CSS.GetMatchedStylesForNodeResponse;
    }

    case "CSS.getStyleSheetText": {
      const id = req.params?.styleSheetId;
      if (typeof id !== "string" || !target) {
        return {
          text: "",
        } satisfies Protocol.CSS.GetStyleSheetTextResponse;
      }
      const entry = target.styleSheets.get(id);
      return {
        text: entry?.text ?? "",
      } satisfies Protocol.CSS.GetStyleSheetTextResponse;
    }

    case "CSS.getEnvironmentVariables":
      return {
        environmentVariables: {},
      } satisfies Protocol.CSS.GetEnvironmentVariablesResponse;

    case "CSS.getPlatformFontsForNode":
      return {
        fonts: [],
      } satisfies Protocol.CSS.GetPlatformFontsForNodeResponse;

    case "CSS.trackComputedStyleUpdates":
    case "CSS.trackComputedStyleUpdatesForNode":
      // Computed-style change badges are unsupported; style queries still work.
      return {};

    case "CSS.takeComputedStyleUpdates":
      return {
        nodeIds: [],
      } satisfies Protocol.CSS.TakeComputedStyleUpdatesResponse;

    default:
      return {};
  }
}

function pickTarget(ctx: DispatchCtx, sessionId: string | undefined) {
  if (sessionId) {
    for (const t of ctx.browser.targets.values()) {
      if (t.sessions.has(sessionId)) return t;
    }
  }
  for (const t of ctx.browser.targets.values()) {
    if (t.type === "page") return t;
  }
  return undefined;
}

async function readStyleAttribute(
  _ctx: DispatchCtx,
  target: TargetState | undefined,
  session: PageSession | null,
  nodeId: number,
): Promise<string | null> {
  const r = session ? await session.tryCall.getAttributes({ nodeId }) : null;
  const attrs = r?.attributes;
  if (Array.isArray(attrs)) {
    return findStyleInFlat(attrs);
  }
  const fallbackDom = target ? ensureTargetDom(target) : null;
  if (fallbackDom) {
    try {
      const info = fallbackDom.nodeInfo(nodeId) as { attributes?: string[] };
      if (Array.isArray(info?.attributes)) {
        return findStyleInFlat(info.attributes);
      }
    } catch {}
  }
  return null;
}

function findStyleInFlat(attrs: string[]): string | null {
  for (let i = 0; i + 1 < attrs.length; i += 2) {
    const n = attrs[i];
    if (typeof n === "string" && n.toLowerCase() === "style") {
      const v = attrs[i + 1];
      return typeof v === "string" ? v : "";
    }
  }
  return null;
}

function splitInlineDeclarations(text: string): Protocol.CSS.CSSProperty[] {
  const stripped = stripCssComments(text);
  const out: Protocol.CSS.CSSProperty[] = [];
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let segStart = 0;

  const flush = (end: number) => {
    const seg = stripped.slice(segStart, end);
    const decl = parseOneDeclaration(seg);
    if (decl) out.push(decl);
  };

  for (let i = 0; i < stripped.length; i++) {
    const c = stripped[i];
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      if (depth > 0) depth--;
      continue;
    }
    if (c === ";" && depth === 0) {
      flush(i);
      segStart = i + 1;
    }
  }
  flush(stripped.length);
  return out;
}

function parseOneDeclaration(segment: string): Protocol.CSS.CSSProperty | null {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let colon = -1;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      if (depth > 0) depth--;
      continue;
    }
    if (c === ":" && depth === 0) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const name = segment.slice(0, colon).trim();
  let value = segment.slice(colon + 1).trim();
  if (!name || !value) return null;

  let important = false;
  const m = value.match(/!\s*important\s*$/i);
  if (m) {
    important = true;
    value = value.slice(0, m.index).trimEnd();
  }
  if (!value) return null;

  const prop: Protocol.CSS.CSSProperty = { name, value };
  if (important) prop.important = true;
  return prop;
}

function stripCssComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return out;
      i = end + 2;
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

function makeStyleSheetId(target: TargetState, ownerNodeId: number, rev: number): string {
  return `${target.targetId}.${target.navigateGeneration}.${ownerNodeId}.${rev}`;
}

function makeStyleSheetHeader(
  target: TargetState,
  styleSheetId: string,
  entry: StyleSheetEntry,
): Protocol.CSS.CSSStyleSheetHeader {
  const header: Protocol.CSS.CSSStyleSheetHeader = {
    styleSheetId,
    frameId: target.frameId,
    sourceURL: entry.isInline ? target.url : entry.sourceURL,
    origin: entry.origin,
    title: "",
    disabled: false,
    isInline: entry.isInline,
    isMutable: false,
    isConstructed: false,
    startLine: 0,
    startColumn: 0,
    length: entry.text.length,
    ...computeEndPosition(entry.text),
  };
  if (entry.ownerNodeId >= 0) header.ownerNode = entry.ownerNodeId;
  return header;
}

function computeEndPosition(text: string): { endLine: number; endColumn: number } {
  let endLine = 0;
  let lastNewlineIdx = -1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      endLine++;
      lastNewlineIdx = i;
    }
  }
  const endColumn = text.length - lastNewlineIdx - 1;
  return { endLine, endColumn };
}

function emitStyleSheetAdded(
  ctx: DispatchCtx,
  target: TargetState,
  styleSheetId: string,
  entry: StyleSheetEntry,
): void {
  if (target.cssEnabledSessions.size === 0) return;
  const header = makeStyleSheetHeader(target, styleSheetId, entry);
  for (const sessionId of target.cssEnabledSessions) {
    ctx.emit({
      method: "CSS.styleSheetAdded",
      params: { header },
      sessionId: sessionId.length === 0 ? undefined : sessionId,
    });
  }
}

function emitStyleSheetAddedToSession(
  ctx: DispatchCtx,
  target: TargetState,
  styleSheetId: string,
  entry: StyleSheetEntry,
  sessionId: string,
): void {
  const header = makeStyleSheetHeader(target, styleSheetId, entry);
  ctx.emit({
    method: "CSS.styleSheetAdded",
    params: { header },
    sessionId: sessionId.length === 0 ? undefined : sessionId,
  });
}

function emitStyleSheetRemoved(ctx: DispatchCtx, target: TargetState, styleSheetId: string): void {
  if (target.cssEnabledSessions.size === 0) return;
  for (const sessionId of target.cssEnabledSessions) {
    ctx.emit({
      method: "CSS.styleSheetRemoved",
      params: { styleSheetId },
      sessionId: sessionId.length === 0 ? undefined : sessionId,
    });
  }
}

function emitStyleSheetChanged(ctx: DispatchCtx, target: TargetState, styleSheetId: string): void {
  if (target.cssEnabledSessions.size === 0) return;
  for (const sessionId of target.cssEnabledSessions) {
    ctx.emit({
      method: "CSS.styleSheetChanged",
      params: { styleSheetId },
      sessionId: sessionId.length === 0 ? undefined : sessionId,
    });
  }
}

function findEntryByOwner(
  target: TargetState,
  ownerNodeId: number,
): { id: string; entry: StyleSheetEntry } | null {
  for (const [id, entry] of target.styleSheets) {
    if (entry.ownerNodeId === ownerNodeId) return { id, entry };
  }
  return null;
}

const opaqueSheetText = new Map<string, string>();
const OPAQUE_SHEET_TEXT_MAX = 32;
const OPAQUE_SHEET_FETCH_CAP = 12;
const OPAQUE_SHEET_FETCH_TIMEOUT_MS = 5_000;

async function fetchOpaqueSheetText(
  sandboxOutbound: SandboxOutboundOverride,
  url: string,
): Promise<string> {
  const hostEgress = sandboxOutbound.external;
  if (!hostEgress) {
    const hit = opaqueSheetText.get(url);
    if (hit !== undefined) return hit;
  }
  let text = "";
  try {
    const resp = await sandboxOutbound.final(
      new Request(url, {
        headers: {
          accept: "text/css,*/*;q=0.1",
          "accept-encoding": decodableAcceptEncoding(null, false),
        },
        signal: AbortSignal.timeout(OPAQUE_SHEET_FETCH_TIMEOUT_MS),
      }),
    );
    if (resp.ok) text = await resp.text();
  } catch {}
  if (hostEgress) return text;
  if (opaqueSheetText.size >= OPAQUE_SHEET_TEXT_MAX) {
    const oldest = opaqueSheetText.keys().next().value;
    if (oldest !== undefined) opaqueSheetText.delete(oldest);
  }
  opaqueSheetText.set(url, text);
  return text;
}

export async function syncStyleSheetsFromEnumeration(
  ctx: DispatchCtx,
  target: TargetState,
  ps: PageScriptStub,
): Promise<void> {
  let sheets: EnumeratedStyleSheet[] = [];
  try {
    const r = await stubQueryDom(ps, "enumerateStyleSheets", {});
    const enumerated = r?.sheets;
    if (Array.isArray(enumerated)) sheets = enumerated;
  } catch {
    sheets = [];
  }

  const needsFetch = sheets.filter((s) => s.cors === "opaque" && !s.text && !!s.sourceURL);
  if (needsFetch.length > 0) {
    await Promise.all(
      needsFetch.slice(0, OPAQUE_SHEET_FETCH_CAP).map(async (s) => {
        const sourceURL = s.sourceURL;
        if (!sourceURL) return;
        s.text = await fetchOpaqueSheetText(ctx.browser.sandboxOutbound, sourceURL);
      }),
    );
  }

  const seenOwnerIds = new Set<number>();
  for (const s of sheets) {
    seenOwnerIds.add(s.ownerNodeId);
    const existing = findEntryByOwner(target, s.ownerNodeId);
    if (existing) {
      if (existing.entry.text !== s.text) {
        existing.entry.text = s.text;
        existing.entry.parsed = null;
        emitStyleSheetChanged(ctx, target, existing.id);
      }
    } else {
      const rev = (target.nextStyleSheetRev.get(s.ownerNodeId) ?? 0) + 1;
      target.nextStyleSheetRev.set(s.ownerNodeId, rev);
      const id = makeStyleSheetId(target, s.ownerNodeId, rev);
      const entry: StyleSheetEntry = {
        ownerNodeId: s.ownerNodeId,
        rev,
        text: s.text,
        isInline: s.isInline !== false,
        sourceURL: s.sourceURL ?? "",
        origin: s.origin ?? "regular",
        parsed: null,
      };
      target.styleSheets.set(id, entry);
      emitStyleSheetAdded(ctx, target, id, entry);
    }
  }

  for (const [id, entry] of Array.from(target.styleSheets)) {
    if (!seenOwnerIds.has(entry.ownerNodeId)) {
      target.styleSheets.delete(id);
      emitStyleSheetRemoved(ctx, target, id);
    }
  }
}

export function clearStyleSheetsForNavigate(ctx: DispatchCtx, target: TargetState): void {
  for (const id of Array.from(target.styleSheets.keys())) {
    emitStyleSheetRemoved(ctx, target, id);
  }
  target.styleSheets.clear();
  target.nextStyleSheetRev.clear();
}

export function syncStyleSheetsFromMutations(
  ctx: DispatchCtx,
  target: TargetState,
  mutations: CdpMutation[],
): void {
  if (target.cssEnabledSessions.size === 0) return;
  let needsEnumerate = false;
  for (const m of mutations) {
    const kind = m.kind;
    if (!kind) continue;
    if (
      kind === "childNodeInserted" ||
      kind === "childNodeRemoved" ||
      kind === "characterDataModified" ||
      kind === "childNodeCountUpdated" ||
      kind === "stylesheetResourceLoaded"
    ) {
      needsEnumerate = true;
      break;
    }
  }
  if (!needsEnumerate) return;
  const ps = target.pageScript;
  if (!ps) return;
  ctx.ctx.waitUntil(
    (async () => {
      try {
        await syncStyleSheetsFromEnumeration(ctx, target, ps);
      } catch {}
    })(),
  );
}

async function getOrParseSheet(
  entry: StyleSheetEntry,
  ps: QueryDomCarrier,
): Promise<ParsedStyleSheet | null> {
  if (entry.parsed) return entry.parsed;
  let sheet: ParsedStyleSheet["rules"] | null = null;
  try {
    const r = await stubQueryDom(ps, "parseStyleSheet", { text: entry.text });
    sheet = copyParsedRules(r?.sheet?.rules);
  } catch {
    sheet = null;
  }
  if (!sheet) return null;
  const ranges = buildSourceRanges(entry.text, sheet);
  const parsed: ParsedStyleSheet = { rules: sheet, ranges };
  entry.parsed = parsed;
  return parsed;
}

// Replies come from the page isolate, whose realm page script shares. A field there can be a stub
// that runs page code when the engine calls a method on it, so copy every reply the engine keeps
// or walks into fresh engine values of the expected primitive types.
function copyParsedRules(raw: unknown): ParsedStyleSheet["rules"] | null {
  if (!Array.isArray(raw)) return null;
  const rules: ParsedStyleSheet["rules"] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.selector_text !== "string") continue;
    const declarations: ParsedStyleSheet["rules"][number]["declarations"] = [];
    if (Array.isArray(r.declarations)) {
      for (const d of r.declarations) {
        if (!d || typeof d !== "object") continue;
        const { name, value, important } = d as Record<string, unknown>;
        if (typeof name !== "string" || typeof value !== "string") continue;
        declarations.push(important === true ? { name, value, important } : { name, value });
      }
    }
    rules.push({
      selector_text: r.selector_text,
      selector_specificities: copyNumbers(r.selector_specificities),
      declarations,
      source_line: typeof r.source_line === "number" ? r.source_line : 0,
      source_column: typeof r.source_column === "number" ? r.source_column : 0,
    });
  }
  return rules;
}

function copyNumbers(raw: unknown): number[] {
  const out: number[] = [];
  if (Array.isArray(raw)) for (const n of raw) if (typeof n === "number") out.push(n);
  return out;
}

function copyNameValues(raw: unknown): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { name, value } = item as Record<string, unknown>;
    if (typeof name === "string" && typeof value === "string") out.push({ name, value });
  }
  return out;
}

function buildSourceRanges(
  text: string,
  rules: ParsedStyleSheet["rules"],
): ParsedStyleSheet["ranges"] {
  const lineStarts = computeLineStarts(text);
  const offsetToPos = (offset: number) => offsetToLineCol(offset, lineStarts);
  const result: ParsedStyleSheet["ranges"] = [];

  for (const rule of rules) {
    const startOffset = lineColToOffset(
      rule.source_line,
      Math.max(0, rule.source_column - 1),
      lineStarts,
      text.length,
    );
    const openBrace = findCharAtDepth(text, startOffset, "{");
    if (openBrace < 0) {
      result.push(emptyRangeInfo());
      continue;
    }
    const closeBrace = findMatchingBrace(text, openBrace);
    if (closeBrace < 0) {
      result.push(emptyRangeInfo());
      continue;
    }

    const selectorAreaStart = startOffset;
    const selectorAreaEnd = openBrace;
    const selectorRanges = splitSelectorRanges(
      text,
      selectorAreaStart,
      selectorAreaEnd,
      offsetToPos,
    );

    const declarationRanges = splitDeclarationRanges(text, openBrace + 1, closeBrace, offsetToPos);

    result.push({
      ruleRange: {
        ...offsetToPos(startOffset),
        ...{
          endLine: offsetToPos(closeBrace + 1).startLine,
          endColumn: offsetToPos(closeBrace + 1).startColumn,
        },
      },
      bodyRange: {
        ...offsetToPos(openBrace),
        ...{
          endLine: offsetToPos(closeBrace + 1).startLine,
          endColumn: offsetToPos(closeBrace + 1).startColumn,
        },
      },
      selectorRanges,
      declarationRanges,
    });
  }
  return result;
}

function emptyRangeInfo(): ParsedStyleSheet["ranges"][number] {
  const zero = { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 };
  return {
    ruleRange: { ...zero },
    bodyRange: { ...zero },
    selectorRanges: [],
    declarationRanges: [],
  };
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function offsetToLineCol(
  offset: number,
  lineStarts: number[],
): { startLine: number; startColumn: number } {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { startLine: lo, startColumn: offset - lineStarts[lo]! };
}

function lineColToOffset(line: number, col: number, lineStarts: number[], maxLen: number): number {
  if (line < 0 || line >= lineStarts.length) return 0;
  const off = lineStarts[line]! + col;
  return Math.min(off, maxLen);
}

function findCharAtDepth(text: string, from: number, target: string): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (c === "(" || c === "[") {
      depth++;
      continue;
    }
    if (c === ")" || c === "]") {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0 && c === target) return i;
  }
  return -1;
}

function findMatchingBrace(text: string, openIdx: number): number {
  let depth = 1;
  let quote: '"' | "'" | null = null;
  for (let i = openIdx + 1; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitSelectorRanges(
  text: string,
  start: number,
  end: number,
  offsetToPos: (off: number) => { startLine: number; startColumn: number },
): Array<{ startLine: number; startColumn: number; endLine: number; endColumn: number }> {
  const out: Array<{ startLine: number; startColumn: number; endLine: number; endColumn: number }> =
    [];
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let segStart = start;
  const flush = (segEnd: number) => {
    let a = segStart;
    while (a < segEnd && isWhitespace(text.charCodeAt(a))) a++;
    let b = segEnd;
    while (b > a && isWhitespace(text.charCodeAt(b - 1))) b--;
    if (a >= b) return;
    out.push(rangeBetween(a, b, offsetToPos));
  };
  for (let i = start; i < end; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "(" || c === "[") {
      depth++;
      continue;
    }
    if (c === ")" || c === "]") {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0 && c === ",") {
      flush(i);
      segStart = i + 1;
    }
  }
  flush(end);
  return out;
}

function splitDeclarationRanges(
  text: string,
  start: number,
  end: number,
  offsetToPos: (off: number) => { startLine: number; startColumn: number },
): Array<{ startLine: number; startColumn: number; endLine: number; endColumn: number }> {
  const out: Array<{ startLine: number; startColumn: number; endLine: number; endColumn: number }> =
    [];
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let segStart = start;
  const flush = (segEnd: number) => {
    let a = segStart;
    while (a < segEnd && isWhitespace(text.charCodeAt(a))) a++;
    let b = segEnd;
    while (b > a && isWhitespace(text.charCodeAt(b - 1))) b--;
    if (a >= b) return;
    let hasColon = false;
    for (let i = a; i < b; i++) {
      if (text[i] === ":") {
        hasColon = true;
        break;
      }
    }
    if (!hasColon) return;
    out.push(rangeBetween(a, b, offsetToPos));
  };
  for (let i = start; i < end; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0 && c === ";") {
      flush(i);
      segStart = i + 1;
    }
  }
  flush(end);
  return out;
}

function rangeBetween(
  startOff: number,
  endOff: number,
  offsetToPos: (off: number) => { startLine: number; startColumn: number },
): { startLine: number; startColumn: number; endLine: number; endColumn: number } {
  const s = offsetToPos(startOff);
  const e = offsetToPos(endOff);
  return {
    startLine: s.startLine,
    startColumn: s.startColumn,
    endLine: e.startLine,
    endColumn: e.startColumn,
  };
}

function isWhitespace(code: number): boolean {
  return code === 9 || code === 10 || code === 13 || code === 32;
}

function buildRuleMatch(
  styleSheetId: string,
  rule: ParsedStyleSheet["rules"][number],
  rangeInfo: ParsedStyleSheet["ranges"][number],
  matchingSelectors: number[],
  origin: Protocol.CSS.StyleSheetOrigin,
): Protocol.CSS.RuleMatch {
  const selectorTexts = splitTopLevelCommas(rule.selector_text);
  const selectors: Protocol.CSS.Value[] = selectorTexts.map((t, i) => {
    const v: Protocol.CSS.Value = { text: t.trim() };
    if (rangeInfo.selectorRanges[i]) v.range = rangeInfo.selectorRanges[i];
    if (typeof rule.selector_specificities[i] === "number") {
      v.specificity = unpackSpecificity(rule.selector_specificities[i]);
    }
    return v;
  });

  const cssProperties: Protocol.CSS.CSSProperty[] = rule.declarations.map((d, i) => {
    const p: Protocol.CSS.CSSProperty = { name: d.name, value: d.value };
    if (d.important) p.important = true;
    if (rangeInfo.declarationRanges[i]) p.range = rangeInfo.declarationRanges[i];
    return p;
  });
  const cssText = rule.declarations
    .map((d) => `${d.name}: ${d.value}${d.important ? " !important" : ""};`)
    .join(" ");

  const style: Protocol.CSS.CSSStyle = {
    styleSheetId,
    cssProperties,
    shorthandEntries: [],
    cssText,
    range: rangeInfo.bodyRange,
  };

  return {
    rule: {
      styleSheetId,
      selectorList: {
        selectors,
        text: rule.selector_text,
      },
      origin,
      style,
    },
    matchingSelectors,
  };
}

function unpackSpecificity(packed: number): Protocol.CSS.Specificity {
  return {
    a: (packed >>> 24) & 0xff,
    b: (packed >>> 16) & 0xff,
    c: packed & 0xffff,
  };
}

function splitTopLevelCommas(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let segStart = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "(" || c === "[") {
      depth++;
      continue;
    }
    if (c === ")" || c === "]") {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0 && c === ",") {
      out.push(text.slice(segStart, i));
      segStart = i + 1;
    }
  }
  out.push(text.slice(segStart));
  return out;
}

const INHERITABLE_PROPERTIES = new Set<string>([
  "color",
  "cursor",
  "direction",
  "font",
  "font-family",
  "font-feature-settings",
  "font-kerning",
  "font-language-override",
  "font-optical-sizing",
  "font-palette",
  "font-size",
  "font-size-adjust",
  "font-stretch",
  "font-style",
  "font-synthesis",
  "font-synthesis-position",
  "font-synthesis-small-caps",
  "font-synthesis-style",
  "font-synthesis-weight",
  "font-variant",
  "font-variant-alternates",
  "font-variant-caps",
  "font-variant-east-asian",
  "font-variant-emoji",
  "font-variant-ligatures",
  "font-variant-numeric",
  "font-variant-position",
  "font-variation-settings",
  "font-weight",
  "hanging-punctuation",
  "hyphenate-character",
  "hyphenate-limit-chars",
  "hyphens",
  "letter-spacing",
  "line-break",
  "line-height",
  "overflow-wrap",
  "paint-order",
  "quotes",
  "tab-size",
  "text-align",
  "text-align-last",
  "text-anchor",
  "text-decoration-skip",
  "text-decoration-skip-ink",
  "text-emphasis",
  "text-emphasis-color",
  "text-emphasis-position",
  "text-emphasis-style",
  "text-indent",
  "text-justify",
  "text-orientation",
  "text-rendering",
  "text-shadow",
  "text-size-adjust",
  "text-transform",
  "text-underline-offset",
  "text-underline-position",
  "text-wrap",
  "white-space",
  "white-space-collapse",
  "word-break",
  "word-spacing",
  "word-wrap",
  "writing-mode",
  "list-style",
  "list-style-image",
  "list-style-position",
  "list-style-type",
  "border-collapse",
  "border-spacing",
  "caption-side",
  "empty-cells",
  "appearance",
  "caret-color",
  "color-scheme",
  "forced-color-adjust",
  "image-orientation",
  "image-rendering",
  "pointer-events",
  "print-color-adjust",
  "user-select",
  "visibility",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "marker",
  "marker-end",
  "marker-mid",
  "marker-start",
  "speak",
  "speak-as",
  "voice-balance",
  "voice-duration",
  "voice-family",
  "voice-pitch",
  "voice-range",
  "voice-rate",
  "voice-stress",
  "voice-volume",
]);

function ruleHasInheritableDecl(rule: ParsedStyleSheet["rules"][number]): boolean {
  for (const d of rule.declarations) {
    if (d.name.startsWith("--")) return true;
    if (INHERITABLE_PROPERTIES.has(d.name)) return true;
  }
  return false;
}

async function buildInheritedChain(
  target: TargetState,
  ps: QueryDomCarrier,
  startNodeId: number,
): Promise<Protocol.CSS.InheritedStyleEntry[]> {
  let ancestorIds: number[] = [];
  try {
    const r = await stubQueryDom(ps, "getAncestorElementIds", {
      nodeId: startNodeId,
    });
    ancestorIds = copyNumbers(r?.ancestorIds);
  } catch {
    return [];
  }
  if (ancestorIds.length === 0) return [];

  const entries: Protocol.CSS.InheritedStyleEntry[] = [];
  for (const ancestorId of ancestorIds) {
    const matched: Protocol.CSS.RuleMatch[] = [];
    for (const [styleSheetId, entry] of target.styleSheets) {
      const parsed = await getOrParseSheet(entry, ps);
      if (!parsed) continue;
      for (let ri = 0; ri < parsed.rules.length; ri++) {
        const rule = parsed.rules[ri];
        const rangeInfo = parsed.ranges[ri];
        if (!rule || !rangeInfo) continue;
        if (!ruleHasInheritableDecl(rule)) continue;
        const matchResult = await stubQueryDom(ps, "matchSelectorList", {
          nodeId: ancestorId,
          selectorListText: rule.selector_text,
        });
        const matchingSelectors = copyNumbers(matchResult?.matches);
        if (matchingSelectors.length === 0) continue;
        matched.push(
          buildRuleMatch(styleSheetId, rule, rangeInfo, matchingSelectors, entry.origin),
        );
      }
    }
    entries.push({ matchedCSSRules: matched });
  }
  return entries;
}
