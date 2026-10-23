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
import { isRecord } from "../guards.ts";

type CssHandler = (
  ctx: DispatchCtx,
  target: TargetState | undefined,
  session: PageSession | null,
  ps: PageScriptStub | null,
  req: CdpRequest,
) => Promise<unknown> | unknown;

const CSS_HANDLERS: Partial<Record<CdpRequest["method"], CssHandler>> = {
  "CSS.enable": enableCss,
  "CSS.disable": disableCss,
  "CSS.getComputedStyleForNode": getComputedStyleForNode,
  "CSS.getInlineStylesForNode": getInlineStylesForNode,
  "CSS.getMatchedStylesForNode": getMatchedStylesForNode,
  "CSS.getStyleSheetText": getStyleSheetText,
  "CSS.getEnvironmentVariables": getEnvironmentVariables,
  "CSS.getPlatformFontsForNode": getPlatformFontsForNode,
  "CSS.trackComputedStyleUpdates": acknowledgeCssWatch,
  "CSS.trackComputedStyleUpdatesForNode": acknowledgeCssWatch,
  "CSS.takeComputedStyleUpdates": takeComputedStyleUpdates,
};

export async function handleCss(ctx: DispatchCtx, req: CdpRequest): Promise<unknown> {
  const target = pickTarget(ctx, req.sessionId);
  const session = target ? sessionOf(ctx, target) : null;
  const ps = session?.ensure() ?? null;
  const handler = CSS_HANDLERS[req.method];
  return handler ? handler(ctx, target, session, ps, req) : {};
}

async function enableCss(
  ctx: DispatchCtx,
  target: TargetState | undefined,
  _session: PageSession | null,
  ps: PageScriptStub | null,
  req: CdpRequest,
): Promise<Record<string, never>> {
  registerCssSession(ctx, target, req.sessionId);
  await syncCssSheetsBestEffort(ctx, target, ps);
  return {};
}

function registerCssSession(
  ctx: DispatchCtx,
  target: TargetState | undefined,
  sessionId: string | undefined,
): void {
  if (!sessionId || !target) return;
  target.cssEnabledSessions.add(sessionId);
  for (const [id, entry] of target.styleSheets) {
    emitStyleSheetAddedToSession(ctx, target, id, entry, sessionId);
  }
}

async function syncCssSheetsBestEffort(
  ctx: DispatchCtx,
  target: TargetState | undefined,
  ps: PageScriptStub | null,
): Promise<void> {
  if (!target || !ps) return;
  try {
    await syncStyleSheetsFromEnumeration(ctx, target, ps);
  } catch {}
}

function disableCss(
  _ctx: DispatchCtx,
  target: TargetState | undefined,
  _session: PageSession | null,
  _ps: PageScriptStub | null,
  req: CdpRequest,
): Record<string, never> {
  removeCssSession(target, req.sessionId);
  return {};
}

function removeCssSession(target: TargetState | undefined, sessionId: string | undefined): void {
  if (sessionId && target) target.cssEnabledSessions.delete(sessionId);
}

async function getComputedStyleForNode(
  _ctx: DispatchCtx,
  _target: TargetState | undefined,
  session: PageSession | null,
  ps: PageScriptStub | null,
  req: CdpRequest,
): Promise<Protocol.CSS.GetComputedStyleForNodeResponse> {
  const nodeId = nodeIdFromCssRequest(req, "CSS.getComputedStyleForNode");
  if (nodeId === null) return emptyComputedStyleResponse();
  return (await computedStyleResponse(session, ps, nodeId)) ?? emptyComputedStyleResponse();
}

async function computedStyleResponse(
  session: PageSession | null,
  ps: PageScriptStub | null,
  nodeId: number,
): Promise<Protocol.CSS.GetComputedStyleForNodeResponse | null> {
  if (!session) return null;
  if (!ps) return null;
  const result = await session.tryCall.getComputedStyle({ nodeId });
  return {
    computedStyle: result?.computedStyle ?? [],
    extraFields: { isAppearanceBase: false },
  } satisfies Protocol.CSS.GetComputedStyleForNodeResponse;
}

function emptyComputedStyleResponse(): Protocol.CSS.GetComputedStyleForNodeResponse {
  return {
    computedStyle: [],
    extraFields: { isAppearanceBase: false },
  };
}

type CssNodeMethod =
  | "CSS.getComputedStyleForNode"
  | "CSS.getInlineStylesForNode"
  | "CSS.getMatchedStylesForNode";

function nodeIdFromCssRequest(req: CdpRequest, method: CssNodeMethod): number | null {
  if (req.method !== method) return null;
  return positiveCssNodeId(req.params);
}

function positiveCssNodeId(params: unknown): number | null {
  if (!isRecord(params)) return null;
  const nodeId = params.nodeId;
  if (typeof nodeId !== "number" || nodeId <= 0) return null;
  return nodeId;
}

async function getInlineStylesForNode(
  ctx: DispatchCtx,
  target: TargetState | undefined,
  session: PageSession | null,
  _ps: PageScriptStub | null,
  req: CdpRequest,
): Promise<Protocol.CSS.GetInlineStylesForNodeResponse> {
  const nodeId = nodeIdFromCssRequest(req, "CSS.getInlineStylesForNode");
  if (nodeId === null) return {};
  const styleText = await readStyleAttribute(target, session, nodeId);
  if (styleText == null) return {};
  return { inlineStyle: inlineCssStyle(styleText) };
}

function inlineCssStyle(styleText: string): Protocol.CSS.CSSStyle {
  return {
    cssProperties: splitInlineDeclarations(styleText),
    shorthandEntries: [],
    cssText: styleText,
  };
}

async function getMatchedStylesForNode(
  _ctx: DispatchCtx,
  target: TargetState | undefined,
  session: PageSession | null,
  ps: PageScriptStub | null,
  req: CdpRequest,
): Promise<Protocol.CSS.GetMatchedStylesForNodeResponse> {
  const nodeId = nodeIdFromCssRequest(req, "CSS.getMatchedStylesForNode");
  if (nodeId === null) return emptyMatchedStylesResponse();
  const context = matchedStylesContext(target, session, ps);
  if (!context) return emptyMatchedStylesResponse();
  const matchedCSSRules = await matchedStyleRules(
    context.target,
    context.session,
    context.ps,
    nodeId,
  );
  const inherited = await buildInheritedChain(context.target, context.ps, nodeId);
  return { matchedCSSRules, pseudoElements: [], inherited };
}

function matchedStylesContext(
  target: TargetState | undefined,
  session: PageSession | null,
  ps: PageScriptStub | null,
): { target: TargetState; session: PageSession; ps: PageScriptStub } | null {
  if (!target) return null;
  if (!session) return null;
  if (!ps) return null;
  return { target, session, ps };
}

function emptyMatchedStylesResponse(): Protocol.CSS.GetMatchedStylesForNodeResponse {
  return { matchedCSSRules: [], pseudoElements: [], inherited: [] };
}

async function matchedStyleRules(
  target: TargetState,
  session: PageSession,
  ps: PageScriptStub,
  nodeId: number,
): Promise<Protocol.CSS.RuleMatch[]> {
  const matched: Protocol.CSS.RuleMatch[] = [];
  for (const [styleSheetId, entry] of target.styleSheets) {
    await appendMatchedSheetRules(matched, styleSheetId, entry, ps, session, nodeId);
  }
  return matched;
}

async function appendMatchedSheetRules(
  matched: Protocol.CSS.RuleMatch[],
  styleSheetId: string,
  entry: StyleSheetEntry,
  ps: PageScriptStub,
  session: PageSession,
  nodeId: number,
): Promise<void> {
  const parsed = await getOrParseSheet(entry, ps);
  if (!parsed) return;
  for (let index = 0; index < parsed.rules.length; index++) {
    await appendMatchedRule(matched, styleSheetId, entry, parsed, index, session, nodeId);
  }
}

async function appendMatchedRule(
  matched: Protocol.CSS.RuleMatch[],
  styleSheetId: string,
  entry: StyleSheetEntry,
  parsed: ParsedStyleSheet,
  index: number,
  session: PageSession,
  nodeId: number,
): Promise<void> {
  const rule = parsed.rules[index];
  const range = parsed.ranges[index];
  if (!rule) return;
  if (!range) return;
  const selectors = await matchSelectorsForNode(session, nodeId, rule.selector_text);
  if (selectors.length === 0) return;
  matched.push(buildRuleMatch(styleSheetId, rule, range, selectors, entry.origin));
}

async function matchSelectorsForNode(
  session: PageSession,
  nodeId: number,
  selectorListText: string,
): Promise<number[]> {
  const result = await session.call.matchSelectorList({ nodeId, selectorListText });
  return result?.matches ?? [];
}

function getStyleSheetText(
  _ctx: DispatchCtx,
  target: TargetState | undefined,
  _session: PageSession | null,
  _ps: PageScriptStub | null,
  req: CdpRequest,
): Protocol.CSS.GetStyleSheetTextResponse {
  const id = styleSheetIdFromRequest(req);
  if (id === null) return { text: "" };
  if (!target) return { text: "" };
  return { text: target.styleSheets.get(id)?.text ?? "" };
}

function styleSheetIdFromRequest(req: CdpRequest): string | null {
  if (!isCssRequest(req, "CSS.getStyleSheetText")) return null;
  const id = req.params?.styleSheetId;
  if (typeof id !== "string") return null;
  return id;
}

function getEnvironmentVariables(): Protocol.CSS.GetEnvironmentVariablesResponse {
  return { environmentVariables: {} };
}

function getPlatformFontsForNode(): Protocol.CSS.GetPlatformFontsForNodeResponse {
  return { fonts: [] };
}

function acknowledgeCssWatch(): Record<string, never> {
  return {};
}

function takeComputedStyleUpdates(): Protocol.CSS.TakeComputedStyleUpdatesResponse {
  return { nodeIds: [] };
}

function isCssRequest<M extends CdpRequest["method"]>(
  req: CdpRequest,
  method: M,
): req is Extract<CdpRequest, { method: M }> {
  return req.method === method;
}

function pickTarget(ctx: DispatchCtx, sessionId: string | undefined) {
  if (sessionId) {
    const sessionTarget = findTargetForSession(ctx, sessionId);
    if (sessionTarget) return sessionTarget;
  }
  return findPageTarget(ctx);
}

function findTargetForSession(ctx: DispatchCtx, sessionId: string): TargetState | undefined {
  for (const t of ctx.browser.targets.values()) {
    if (t.sessions.has(sessionId)) return t;
  }
  return undefined;
}

function findPageTarget(ctx: DispatchCtx): TargetState | undefined {
  for (const t of ctx.browser.targets.values()) {
    if (t.type === "page") return t;
  }
  return undefined;
}

async function readStyleAttribute(
  target: TargetState | undefined,
  session: PageSession | null,
  nodeId: number,
): Promise<string | null> {
  const attrs = await readPageAttributes(session, nodeId);
  if (attrs) return findStyleInFlat(attrs);
  return readFallbackStyleAttribute(target, nodeId);
}

async function readPageAttributes(
  session: PageSession | null,
  nodeId: number,
): Promise<string[] | null> {
  if (!session) return null;
  const result = await session.tryCall.getAttributes({ nodeId });
  const attrs = result?.attributes;
  return Array.isArray(attrs) ? attrs : null;
}

function readFallbackStyleAttribute(
  target: TargetState | undefined,
  nodeId: number,
): string | null {
  if (!target) return null;
  const fallbackDom = ensureTargetDom(target);
  if (!fallbackDom) return null;
  try {
    return readStyleFromDom(fallbackDom, nodeId);
  } catch {
    return null;
  }
}

function readStyleFromDom(
  dom: NonNullable<ReturnType<typeof ensureTargetDom>>,
  nodeId: number,
): string | null {
  const info = dom.nodeInfo(nodeId) as { attributes?: string[] };
  const attrs = info?.attributes;
  return Array.isArray(attrs) ? findStyleInFlat(attrs) : null;
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
  const segment = { start: 0 };
  forEachTopLevelDelimiter(stripped, 0, stripped.length, ";", CSS_BRACKETS_AND_BRACES, (end) => {
    appendInlineDeclaration(out, stripped, segment.start, end);
    segment.start = end + 1;
  });
  appendInlineDeclaration(out, stripped, segment.start, stripped.length);
  return out;
}

function appendInlineDeclaration(
  out: Protocol.CSS.CSSProperty[],
  text: string,
  start: number,
  end: number,
): void {
  const declaration = parseOneDeclaration(text.slice(start, end));
  if (declaration) out.push(declaration);
}

function parseOneDeclaration(segment: string): Protocol.CSS.CSSProperty | null {
  const colon = findCssDelimiter(segment, 0, segment.length, ":", CSS_BRACKETS_AND_BRACES, false);
  if (colon < 0) return null;
  const name = segment.slice(0, colon).trim();
  if (!name) return null;
  const value = segment.slice(colon + 1).trim();
  if (!value) return null;
  return declarationWithImportance(name, value);
}

function declarationWithImportance(name: string, value: string): Protocol.CSS.CSSProperty | null {
  const importantMatch = value.match(/!\s*important\s*$/i);
  const parsedValue = importantMatch ? value.slice(0, importantMatch.index).trimEnd() : value;
  if (!parsedValue) return null;
  const prop: Protocol.CSS.CSSProperty = { name, value: parsedValue };
  if (importantMatch) prop.important = true;
  return prop;
}

type CssQuote = '"' | "'";

interface CssScanState {
  depth: number;
  quote: CssQuote | null;
  escaped: boolean;
}

interface CssScanBrackets {
  open: ReadonlySet<string>;
  close: ReadonlySet<string>;
}

const CSS_PARENS_AND_BRACKETS: CssScanBrackets = {
  open: new Set(["(", "["]),
  close: new Set([")", "]"]),
};
const CSS_BRACKETS_AND_BRACES: CssScanBrackets = {
  open: new Set(["(", "[", "{"]),
  close: new Set([")", "]", "}"]),
};
const CSS_BRACES: CssScanBrackets = { open: new Set(["{"]), close: new Set(["}"]) };

function newCssScanState(): CssScanState {
  return { depth: 0, quote: null, escaped: false };
}

function consumeCssSyntax(
  text: string,
  index: number,
  state: CssScanState,
  brackets: CssScanBrackets,
  comments: boolean,
): number | null {
  if (state.quote !== null) return consumeQuotedCssCharacter(text, index, state);
  if (comments) {
    const commentEnd = cssCommentEnd(text, index);
    if (commentEnd !== null) return commentEnd;
  }
  return consumeCssDelimiter(text[index] ?? "", index, state, brackets);
}

function consumeQuotedCssCharacter(text: string, index: number, state: CssScanState): number {
  if (state.escaped) {
    state.escaped = false;
    return index;
  }
  const character = text[index] ?? "";
  if (character === "\\") state.escaped = true;
  else if (character === state.quote) state.quote = null;
  return index;
}

function consumeCssDelimiter(
  character: string,
  index: number,
  state: CssScanState,
  brackets: CssScanBrackets,
): number | null {
  if (character === '"' || character === "'") {
    state.quote = character;
    return index;
  }
  if (brackets.open.has(character)) {
    state.depth++;
    return index;
  }
  if (brackets.close.has(character)) {
    state.depth = Math.max(0, state.depth - 1);
    return index;
  }
  return null;
}

function cssCommentEnd(text: string, index: number): number | null {
  if (text[index] !== "/" || text[index + 1] !== "*") return null;
  const end = text.indexOf("*/", index + 2);
  return end < 0 ? -1 : end + 1;
}

function isTopLevelDelimiter(
  state: CssScanState,
  text: string,
  index: number,
  delimiter: string,
): boolean {
  return state.depth === 0 && text[index] === delimiter;
}

function forEachTopLevelDelimiter(
  text: string,
  start: number,
  end: number,
  delimiter: string,
  brackets: CssScanBrackets,
  onDelimiter: (index: number) => void,
): void {
  const state = newCssScanState();
  for (let index = start; index < end; index++) {
    const consumed = consumeCssSyntax(text, index, state, brackets, false);
    if (consumed !== null) {
      if (consumed < 0) return;
      index = consumed;
      continue;
    }
    if (isTopLevelDelimiter(state, text, index, delimiter)) onDelimiter(index);
  }
}

function findCssDelimiter(
  text: string,
  start: number,
  end: number,
  delimiter: string,
  brackets: CssScanBrackets,
  comments: boolean,
): number {
  const state = newCssScanState();
  for (let index = start; index < end; index++) {
    const consumed = consumeCssSyntax(text, index, state, brackets, comments);
    if (consumed !== null) {
      if (consumed < 0) return -1;
      index = consumed;
      continue;
    }
    if (isTopLevelDelimiter(state, text, index, delimiter)) return index;
  }
  return -1;
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
  const text = await requestOpaqueSheetText(sandboxOutbound, url);
  if (hostEgress) return text;
  cacheOpaqueSheetText(url, text);
  return text;
}

async function requestOpaqueSheetText(
  sandboxOutbound: SandboxOutboundOverride,
  url: string,
): Promise<string> {
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
    return resp.ok ? await resp.text() : "";
  } catch {
    return "";
  }
}

function cacheOpaqueSheetText(url: string, text: string): void {
  if (opaqueSheetText.size >= OPAQUE_SHEET_TEXT_MAX) {
    const oldest = opaqueSheetText.keys().next().value;
    if (oldest !== undefined) opaqueSheetText.delete(oldest);
  }
  opaqueSheetText.set(url, text);
}

export async function syncStyleSheetsFromEnumeration(
  ctx: DispatchCtx,
  target: TargetState,
  ps: PageScriptStub,
): Promise<void> {
  const sheets = await enumerateStyleSheets(ps);
  await fetchOpaqueStyleSheets(ctx, sheets);
  reconcileStyleSheets(ctx, target, sheets);
}

async function enumerateStyleSheets(ps: PageScriptStub): Promise<EnumeratedStyleSheet[]> {
  try {
    const r = await stubQueryDom(ps, "enumerateStyleSheets", {});
    const enumerated = r?.sheets;
    return Array.isArray(enumerated) ? enumerated : [];
  } catch {
    return [];
  }
}

async function fetchOpaqueStyleSheets(
  ctx: DispatchCtx,
  sheets: EnumeratedStyleSheet[],
): Promise<void> {
  const needsFetch = sheets.filter((s) => s.cors === "opaque" && !s.text && !!s.sourceURL);
  if (needsFetch.length === 0) return;
  await Promise.all(
    needsFetch.slice(0, OPAQUE_SHEET_FETCH_CAP).map((sheet) => fetchOpaqueStyleSheet(ctx, sheet)),
  );
}

async function fetchOpaqueStyleSheet(ctx: DispatchCtx, sheet: EnumeratedStyleSheet): Promise<void> {
  const sourceURL = sheet.sourceURL;
  if (!sourceURL) return;
  sheet.text = await fetchOpaqueSheetText(ctx.browser.sandboxOutbound, sourceURL);
}

function reconcileStyleSheets(
  ctx: DispatchCtx,
  target: TargetState,
  sheets: EnumeratedStyleSheet[],
): void {
  const seenOwnerIds = new Set<number>();
  for (const s of sheets) {
    seenOwnerIds.add(s.ownerNodeId);
    reconcileStyleSheet(ctx, target, s);
  }
  removeMissingStyleSheets(ctx, target, seenOwnerIds);
}

function reconcileStyleSheet(
  ctx: DispatchCtx,
  target: TargetState,
  sheet: EnumeratedStyleSheet,
): void {
  const existing = findEntryByOwner(target, sheet.ownerNodeId);
  if (existing) {
    updateStyleSheet(ctx, target, existing, sheet);
    return;
  }
  addStyleSheet(ctx, target, sheet);
}

function updateStyleSheet(
  ctx: DispatchCtx,
  target: TargetState,
  existing: { id: string; entry: StyleSheetEntry },
  sheet: EnumeratedStyleSheet,
): void {
  if (existing.entry.text === sheet.text) return;
  existing.entry.text = sheet.text;
  existing.entry.parsed = null;
  emitStyleSheetChanged(ctx, target, existing.id);
}

function addStyleSheet(ctx: DispatchCtx, target: TargetState, sheet: EnumeratedStyleSheet): void {
  const rev = (target.nextStyleSheetRev.get(sheet.ownerNodeId) ?? 0) + 1;
  target.nextStyleSheetRev.set(sheet.ownerNodeId, rev);
  const id = makeStyleSheetId(target, sheet.ownerNodeId, rev);
  const entry: StyleSheetEntry = {
    ownerNodeId: sheet.ownerNodeId,
    rev,
    text: sheet.text,
    isInline: sheet.isInline !== false,
    sourceURL: sheet.sourceURL ?? "",
    origin: sheet.origin ?? "regular",
    parsed: null,
  };
  target.styleSheets.set(id, entry);
  emitStyleSheetAdded(ctx, target, id, entry);
}

function removeMissingStyleSheets(
  ctx: DispatchCtx,
  target: TargetState,
  seenOwnerIds: Set<number>,
): void {
  for (const [id, entry] of Array.from(target.styleSheets)) {
    if (seenOwnerIds.has(entry.ownerNodeId)) continue;
    target.styleSheets.delete(id);
    emitStyleSheetRemoved(ctx, target, id);
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
  if (!mutationBatchMayChangeStyleSheets(mutations)) return;
  scheduleStyleSheetSync(ctx, target);
}

const STYLE_SHEET_MUTATION_KINDS = new Set<CdpMutation["kind"]>([
  "childNodeInserted",
  "childNodeRemoved",
  "characterDataModified",
  "childNodeCountUpdated",
  "stylesheetResourceLoaded",
]);

function mutationBatchMayChangeStyleSheets(mutations: CdpMutation[]): boolean {
  return mutations.some((mutation) => STYLE_SHEET_MUTATION_KINDS.has(mutation.kind));
}

function scheduleStyleSheetSync(ctx: DispatchCtx, target: TargetState): void {
  const ps = target.pageScript;
  if (!ps) return;
  ctx.ctx.waitUntil(syncStyleSheetsFromEnumeration(ctx, target, ps).catch(() => {}));
}

async function getOrParseSheet(
  entry: StyleSheetEntry,
  ps: QueryDomCarrier,
): Promise<ParsedStyleSheet | null> {
  if (entry.parsed) return entry.parsed;
  const sheet = await parseSheetRules(entry, ps);
  if (!sheet) return null;
  return cacheParsedSheet(entry, sheet);
}

async function parseSheetRules(
  entry: StyleSheetEntry,
  ps: QueryDomCarrier,
): Promise<ParsedStyleSheet["rules"] | null> {
  try {
    const r = await stubQueryDom(ps, "parseStyleSheet", { text: entry.text });
    return r?.sheet?.rules ?? null;
  } catch {
    return null;
  }
}

function cacheParsedSheet(
  entry: StyleSheetEntry,
  sheet: ParsedStyleSheet["rules"],
): ParsedStyleSheet {
  const ranges = buildSourceRanges(entry.text, sheet);
  const parsed: ParsedStyleSheet = { rules: sheet, ranges };
  entry.parsed = parsed;
  return parsed;
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
  return findCssDelimiter(text, from, text.length, target, CSS_PARENS_AND_BRACKETS, true);
}

function findMatchingBrace(text: string, openIdx: number): number {
  const state = newCssScanState();
  state.depth = 1;
  return findClosingBrace(text, openIdx + 1, state);
}

function findClosingBrace(text: string, start: number, state: CssScanState): number {
  for (let index = start; index < text.length; index++) {
    const consumed = consumeCssSyntax(text, index, state, CSS_BRACES, true);
    if (consumed !== null) {
      if (consumed < 0) return -1;
      if (isMatchedClosingBrace(text, index, state)) return index;
      index = consumed;
    }
  }
  return -1;
}

function isMatchedClosingBrace(text: string, index: number, state: CssScanState): boolean {
  return text[index] === "}" && state.depth === 0;
}

function splitSelectorRanges(
  text: string,
  start: number,
  end: number,
  offsetToPos: (off: number) => { startLine: number; startColumn: number },
): Array<{ startLine: number; startColumn: number; endLine: number; endColumn: number }> {
  const out: Array<{ startLine: number; startColumn: number; endLine: number; endColumn: number }> =
    [];
  const segment = { start };
  forEachTopLevelDelimiter(text, start, end, ",", CSS_PARENS_AND_BRACKETS, (segmentEnd) => {
    appendTrimmedRange(out, text, segment.start, segmentEnd, offsetToPos);
    segment.start = segmentEnd + 1;
  });
  appendTrimmedRange(out, text, segment.start, end, offsetToPos);
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
  const segment = { start };
  forEachTopLevelDelimiter(text, start, end, ";", CSS_BRACKETS_AND_BRACES, (segmentEnd) => {
    appendTrimmedDeclarationRange(out, text, segment.start, segmentEnd, offsetToPos);
    segment.start = segmentEnd + 1;
  });
  appendTrimmedDeclarationRange(out, text, segment.start, end, offsetToPos);
  return out;
}

function appendTrimmedRange(
  out: Array<{ startLine: number; startColumn: number; endLine: number; endColumn: number }>,
  text: string,
  start: number,
  end: number,
  offsetToPos: (off: number) => { startLine: number; startColumn: number },
): void {
  const range = trimRange(text, start, end);
  if (range.start >= range.end) return;
  out.push(rangeBetween(range.start, range.end, offsetToPos));
}

function appendTrimmedDeclarationRange(
  out: Array<{ startLine: number; startColumn: number; endLine: number; endColumn: number }>,
  text: string,
  start: number,
  end: number,
  offsetToPos: (off: number) => { startLine: number; startColumn: number },
): void {
  const range = trimRange(text, start, end);
  if (range.start >= range.end) return;
  if (!hasColon(text, range.start, range.end)) return;
  out.push(rangeBetween(range.start, range.end, offsetToPos));
}

function trimRange(text: string, start: number, end: number): { start: number; end: number } {
  let first = start;
  while (first < end && isWhitespace(text.charCodeAt(first))) first++;
  let last = end;
  while (last > first && isWhitespace(text.charCodeAt(last - 1))) last--;
  return { start: first, end: last };
}

function hasColon(text: string, start: number, end: number): boolean {
  for (let index = start; index < end; index++) {
    if (text[index] === ":") return true;
  }
  return false;
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
  const segment = { start: 0 };
  forEachTopLevelDelimiter(text, 0, text.length, ",", CSS_PARENS_AND_BRACKETS, (end) => {
    out.push(text.slice(segment.start, end));
    segment.start = end + 1;
  });
  out.push(text.slice(segment.start));
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
  const ancestorIds = await getAncestorElementIds(ps, startNodeId);
  if (ancestorIds.length === 0) return [];
  const entries: Protocol.CSS.InheritedStyleEntry[] = [];
  for (const ancestorId of ancestorIds) {
    entries.push(await buildInheritedEntry(target, ps, ancestorId));
  }
  return entries;
}

async function getAncestorElementIds(ps: QueryDomCarrier, startNodeId: number): Promise<number[]> {
  try {
    const result = await stubQueryDom(ps, "getAncestorElementIds", { nodeId: startNodeId });
    return Array.isArray(result?.ancestorIds) ? result.ancestorIds : [];
  } catch {
    return [];
  }
}

async function buildInheritedEntry(
  target: TargetState,
  ps: QueryDomCarrier,
  ancestorId: number,
): Promise<Protocol.CSS.InheritedStyleEntry> {
  const matchedCSSRules: Protocol.CSS.RuleMatch[] = [];
  for (const [styleSheetId, entry] of target.styleSheets) {
    await appendInheritedSheetRules(matchedCSSRules, styleSheetId, entry, ps, ancestorId);
  }
  return { matchedCSSRules };
}

async function appendInheritedSheetRules(
  matched: Protocol.CSS.RuleMatch[],
  styleSheetId: string,
  entry: StyleSheetEntry,
  ps: QueryDomCarrier,
  ancestorId: number,
): Promise<void> {
  const parsed = await getOrParseSheet(entry, ps);
  if (!parsed) return;
  for (let index = 0; index < parsed.rules.length; index++) {
    await appendInheritedRule(matched, styleSheetId, entry, parsed, index, ps, ancestorId);
  }
}

async function appendInheritedRule(
  matched: Protocol.CSS.RuleMatch[],
  styleSheetId: string,
  entry: StyleSheetEntry,
  parsed: ParsedStyleSheet,
  index: number,
  ps: QueryDomCarrier,
  ancestorId: number,
): Promise<void> {
  const rule = parsed.rules[index];
  const range = parsed.ranges[index];
  if (!rule) return;
  if (!range) return;
  if (!ruleHasInheritableDecl(rule)) return;
  const matchingSelectors = await matchSelectorsForAncestor(ps, ancestorId, rule.selector_text);
  if (matchingSelectors.length === 0) return;
  matched.push(buildRuleMatch(styleSheetId, rule, range, matchingSelectors, entry.origin));
}

async function matchSelectorsForAncestor(
  ps: QueryDomCarrier,
  ancestorId: number,
  selectorListText: string,
): Promise<number[]> {
  const result = await stubQueryDom(ps, "matchSelectorList", {
    nodeId: ancestorId,
    selectorListText,
  });
  return result?.matches ?? [];
}
