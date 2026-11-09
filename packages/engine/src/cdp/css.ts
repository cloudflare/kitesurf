// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements CDP CSS commands and syncs stylesheet state with PageScript.

import type { CdpRequest, ParsedStyleSheet, StyleSheetEntry, TargetState } from "./types.ts";
import type { CdpMutation } from "@kitesurf/jsrpc-types/shared";
import type { DispatchCtx } from "./dispatch.ts";
import { outboundPolicyRefusal } from "../eval/outbound.ts";
import type { PageScriptStub } from "../eval/page-script.ts";
import {
  sessionOf,
  stubQueryDom,
  type PageSession,
  type QueryDomCarrier,
  type EnumeratedStyleSheet,
} from "./page-session.ts";
import { ensureTargetDom, releasedFallbackError } from "./dom-release.ts";
import { parseStyleSheetRules } from "../wasm.ts";
import { cookieKeyFor } from "./cookie-jar-registry.ts";
import { originOf } from "./frames.ts";
import { effectiveExtraHeaders } from "./network.ts";
import { privateNetworkRefusal } from "../eval/private-network.ts";
import { getInterception, interceptionMatches } from "./fetch-interception.ts";
import { walkRedirects } from "../eval/redirect-walk.ts";
import {
  MAX_CONCURRENT_READ_BYTES,
  MAX_STYLESHEET_BYTES,
  readCappedText,
  type CappedFailure,
} from "../read-capped.ts";

import type { Protocol } from "devtools-protocol";

// CSS.getMatchedStylesForNode output is a DevTools diagnostic: one request may spend one
// stylesheet-sized reply, and a match that would not fit is skipped instead of failing the
// navigation.
const MAX_ANCESTOR_STYLE_HOPS = 128; // page-script's getAncestorElementIds walk stops here.

interface MatchBudget {
  remaining: number;
  warned: boolean;
}

function warnMatchBudget(budget: MatchBudget): void {
  if (budget.warned) return;
  budget.warned = true;
  console.warn("kitesurf: CSS matched-style reply is over budget; skipping larger matches");
}

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
      const budget: MatchBudget = {
        remaining: MAX_STYLESHEET_BYTES,
        warned: false,
      };
      for (const [styleSheetId, entry] of target.styleSheets) {
        const parsed = await getOrParseSheet(entry, ps);
        if (!parsed) continue;
        for (let ri = 0; ri < parsed.rules.length; ri++) {
          const rule = parsed.rules[ri];
          const rangeInfo = parsed.ranges[ri];
          if (!rule || !rangeInfo) continue;
          // No match could fit, so stop asking the page to evaluate selectors.
          if (budget.remaining < MIN_MATCH_CHARGE) {
            warnMatchBudget(budget);
            break;
          }
          const matchResult = await session.call.matchSelectorList({
            nodeId,
            selectorListText: rule.selector_text,
          });
          addMatch(matched, budget, styleSheetId, entry, rule, rangeInfo, matchResult?.matches);
        }
      }
      const inherited = await buildInheritedChain(target, ps, nodeId, budget);
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
  // `nodeId` belongs to PageScript when one exists; the engine DOM numbers nodes differently.
  const useFallback = target !== undefined && !session?.available();
  if (useFallback && target.fallbackHtmlReleased) {
    throw releasedFallbackError("CSS.getInlineStylesForNode");
  }
  const fallbackDom = useFallback ? ensureTargetDom(target) : null;
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

// Only the last line start is needed, so this tracks it in one pass instead of allocating one
// entry per line, and keeps computeLineStarts' CR, CRLF and FF semantics.
function computeEndPosition(text: string): { endLine: number; endColumn: number } {
  let endLine = 0;
  let lineStart = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) i++;
      endLine++;
      lineStart = i + 1;
    } else if (c === 10 || c === 12) {
      endLine++;
      lineStart = i + 1;
    }
  }
  return { endLine, endColumn: text.length - lineStart };
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

interface OpaqueSheetTextEntry {
  text: string;
  hops: string[];
  // A failed fetch is cached until `failedUntil` so repeated enumerations do not refetch it.
  failedUntil?: number;
  // A policy refusal is cached too, but the cache hit re-runs admission so a removed filter
  // restores the sheet.
  policyRefused?: boolean;
}

const opaqueSheetText = new Map<string, OpaqueSheetTextEntry>();
let opaqueSheetTextBytes = 0;
const OPAQUE_SHEET_TEXT_MAX = 32;
const OPAQUE_SHEET_FETCH_CAP = 12;
const OPAQUE_SHEET_FETCH_TIMEOUT_MS = 5_000;
const OPAQUE_SHEET_FAILURE_TTL_MS = 30_000;

// With interception matching any hop, only a real request can ask the client.
function sheetIntercepted(connectionId: string, hops: readonly string[]): boolean {
  const interception = connectionId ? getInterception(connectionId) : undefined;
  return (
    interception !== undefined &&
    hops.some((hop) => interceptionMatches(interception, hop, "Stylesheet"))
  );
}

// Cached text must still pass the connection's current filters, blocklist and private-network
// check and interception on every hop.
function cachedSheetAdmissible(
  ctx: DispatchCtx,
  target: TargetState,
  hops: readonly string[],
): boolean {
  const connectionId = ctx.connectionId;
  if (!connectionId) return true;
  if (sheetIntercepted(connectionId, hops)) return false;
  const pageOrigin = originOf(target.url);
  const initiator = pageOrigin === "://" ? "" : pageOrigin;
  let pageHost = "";
  try {
    pageHost = new URL(initiator).hostname;
  } catch {}
  return hops.every((hop) => {
    let hopUrl: URL;
    try {
      hopUrl = new URL(hop);
    } catch {
      return false;
    }
    return (
      (ctx.env.KITESURF_ALLOW_PRIVATE_NETWORK === "1" ||
        privateNetworkRefusal(hopUrl, initiator) === null) &&
      outboundPolicyRefusal(connectionId, hop, "Stylesheet", pageHost, false) === null
    );
  });
}

// The URL is page-chosen, so the fetch goes through the connection's gateway (filters,
// interception, cookies) and each redirect hop goes back through it. Returns null when the fetch
// failed, so a caller can keep text it already has.
async function fetchOpaqueSheetText(
  ctx: DispatchCtx,
  target: TargetState,
  url: string,
): Promise<string | null> {
  if (!/^https?:\/\//i.test(url)) return "";
  const sandboxOutbound = ctx.browser.sandboxOutbound;
  const cacheable = !sandboxOutbound.external;
  const cookieKey = cookieKeyFor(ctx.connectionId, target.browserContextId);
  // The response depends on the jar's cookies, so a cached text never crosses jars.
  const cacheKey = `${cookieKey}\n${url}`;
  if (cacheable) {
    const cached = opaqueSheetText.get(cacheKey);
    if (cached !== undefined) {
      const fresh = cached.failedUntil === undefined || Date.now() < cached.failedUntil;
      if (fresh && cached.policyRefused === true) {
        // A refusal is cached only while the connection still refuses the sheet, so removing the
        // filter restores it without waiting out the failure ttl. A matching interception still
        // sees the request.
        if (
          !sheetIntercepted(ctx.connectionId, cached.hops) &&
          !cachedSheetAdmissible(ctx, target, cached.hops)
        ) {
          return "";
        }
        dropOpaqueSheetText(cacheKey);
      } else if (fresh && cachedSheetAdmissible(ctx, target, cached.hops)) {
        // A cached failure reports null, so the caller keeps text the entry already has.
        return cached.failedUntil !== undefined ? null : cached.text;
      } else {
        dropOpaqueSheetText(cacheKey);
      }
    }
  }
  const result = await fetchSheetOnce(ctx, target, url, cookieKey);
  if (cacheable && !sheetIntercepted(ctx.connectionId, result.hops)) {
    // A budget refusal is transient: caching it would hide the sheet for the whole failure TTL.
    if (result.failure !== "budget") {
      storeOpaqueSheetText(cacheKey, {
        text: result.text ?? "",
        hops: result.hops,
        ...(result.text === null ? { failedUntil: Date.now() + OPAQUE_SHEET_FAILURE_TTL_MS } : {}),
        ...(result.failure === "policy" ? { policyRefused: true } : {}),
      });
    }
  }
  // A policy refusal is a decision about this sheet, not a failed refetch: report it as empty.
  return result.failure === "policy" ? "" : result.text;
}

function dropOpaqueSheetText(cacheKey: string): void {
  const entry = opaqueSheetText.get(cacheKey);
  if (entry === undefined) return;
  opaqueSheetTextBytes -= 2 * entry.text.length;
  opaqueSheetText.delete(cacheKey);
}

// Cached UTF-16 storage counts against the shared in-flight read ceiling; oldest entries go first.
function storeOpaqueSheetText(cacheKey: string, entry: OpaqueSheetTextEntry): void {
  dropOpaqueSheetText(cacheKey);
  const textBytes = 2 * entry.text.length;
  if (textBytes > MAX_CONCURRENT_READ_BYTES) return;
  while (
    opaqueSheetText.size > 0 &&
    (opaqueSheetText.size >= OPAQUE_SHEET_TEXT_MAX ||
      opaqueSheetTextBytes + textBytes > MAX_CONCURRENT_READ_BYTES)
  ) {
    const oldest = opaqueSheetText.keys().next().value;
    if (oldest === undefined) break;
    dropOpaqueSheetText(oldest);
  }
  opaqueSheetText.set(cacheKey, entry);
  opaqueSheetTextBytes += textBytes;
}

// Fetches the sheet once; `text` is null when it failed and `failure` says why. `hops` is the
// chain it walked.
async function fetchSheetOnce(
  ctx: DispatchCtx,
  target: TargetState,
  url: string,
  cookieKey: string,
): Promise<{ text: string | null; hops: string[]; failure: CappedFailure | "policy" | null }> {
  const sandboxOutbound = ctx.browser.sandboxOutbound;
  const pageOrigin = originOf(target.url);
  const outbound = sandboxOutbound.parent({
    pageOrigin: pageOrigin === "://" ? "" : pageOrigin,
    pageUrl: target.url,
    mainFrameId: target.frameId,
    mainLoaderId: target.loaderId,
    extraHeaders: effectiveExtraHeaders(target),
    connectionId: ctx.connectionId,
    cookieKey,
  });
  const hops = [url];
  try {
    const walk = await walkRedirects({
      url,
      // The page loaded this sheet without CORS, so the engine's copy skips the check too.
      headers: {
        accept: "text/css,*/*;q=0.1",
        "x-kitesurf-resource-type": "Stylesheet",
        "x-kitesurf-allow-cross-origin": "1",
      },
      signal: AbortSignal.timeout(OPAQUE_SHEET_FETCH_TIMEOUT_MS),
      fetchHop: (hopReq) => outbound.fetch(hopReq),
      onRedirect: (hop) => hops.push(hop.newUrl),
    });
    if (!walk.ok) return { text: null, hops, failure: null };
    if (!walk.response.ok) {
      // The connection's gateway refuses a filtered or blocked hop with this status.
      const policy =
        walk.response.status === 451 && walk.response.headers.has("x-kitesurf-blocked-reason");
      void walk.response.body?.cancel().catch(() => {});
      return { text: null, hops, failure: policy ? "policy" : null };
    }
    const got = await readCappedText(walk.response, MAX_STYLESHEET_BYTES, ctx.connectionId);
    return { text: got.ok ? got.text : null, hops, failure: got.ok ? null : got.failure };
  } catch {
    return { text: null, hops, failure: null };
  }
}

export async function syncStyleSheetsFromEnumeration(
  ctx: DispatchCtx,
  target: TargetState,
  ps: PageScriptStub,
): Promise<void> {
  const generation = target.navigateGeneration;
  const isCurrent = () => target.navigateGeneration === generation && target.pageScript === ps;
  let sheets: EnumeratedStyleSheet[] = [];
  try {
    const r = await stubQueryDom(ps, "enumerateStyleSheets", {});
    sheets = copyEnumeratedSheets(r?.sheets);
  } catch {
    sheets = [];
  }
  if (!isCurrent()) return;

  const needsFetch = sheets.filter((s) => s.cors === "opaque" && !s.text && !!s.sourceURL);
  // A failed refetch must not erase text the entry already has, so record which owners failed.
  const failedFetch = new Set<number>();
  if (needsFetch.length > 0) {
    await Promise.all(
      needsFetch.slice(0, OPAQUE_SHEET_FETCH_CAP).map(async (s) => {
        const sourceURL = s.sourceURL;
        if (!sourceURL) return;
        const text = await fetchOpaqueSheetText(ctx, target, sourceURL);
        if (text === null) failedFetch.add(s.ownerNodeId);
        else s.text = text;
      }),
    );
  }
  if (!isCurrent()) return;

  const byOwner = new Map<number, { id: string; entry: StyleSheetEntry }>();
  for (const [id, entry] of target.styleSheets) {
    if (!byOwner.has(entry.ownerNodeId)) byOwner.set(entry.ownerNodeId, { id, entry });
  }
  const seenOwnerIds = new Set<number>();
  for (const s of sheets) {
    seenOwnerIds.add(s.ownerNodeId);
    const existing = byOwner.get(s.ownerNodeId);
    if (existing) {
      const opaque = s.cors === "opaque";
      if (existing.entry.opaqueText !== opaque) {
        existing.entry.opaqueText = opaque;
        existing.entry.parsed = null;
      }
      if (failedFetch.has(s.ownerNodeId)) continue;
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
        opaqueText: s.cors === "opaque",
        parsed: null,
      };
      target.styleSheets.set(id, entry);
      byOwner.set(s.ownerNodeId, { id, entry });
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
    // The page shares its realm with every reply it returns, so it can hook the functions a
    // parsed sheet passes through. Only sheets the page can already read are parsed there.
    const rules = entry.opaqueText
      ? parseStyleSheetRules(entry.text)
      : (await stubQueryDom(ps, "parseStyleSheet", { text: entry.text }))?.sheet?.rules;
    sheet = copyParsedRules(rules, entry);
  } catch {
    sheet = null;
  }
  if (!sheet) return null;
  const ranges = buildSourceRanges(entry.text, sheet);
  const parsed: ParsedStyleSheet = { rules: sheet, ranges };
  entry.parsed = parsed;
  return parsed;
}

// A sheet this large is a diagnostic hazard: the parsed rules are retained per sheet, so a page
// could otherwise pin hundreds of megabytes with a few megabytes of `a{x:1}`.
export const MAX_PARSED_RULES_PER_SHEET = 8192;
// Declarations are retained per rule too, so the rule cap alone does not bound a sheet. 65,536 is
// far above a real large sheet: Bootstrap's full build has a few thousand declarations and
// Tailwind's utility output about ten thousand, so only an adversarial sheet reaches this.
export const MAX_PARSED_DECLARATIONS_PER_SHEET = 65_536;

// Replies come from the page isolate, whose realm page script shares. A field there can be a stub
// that runs page code when the engine calls a method on it, so copy every reply the engine keeps
// or walks into fresh engine values of the expected primitive types.
function copyParsedRules(raw: unknown, entry: StyleSheetEntry): ParsedStyleSheet["rules"] | null {
  if (!Array.isArray(raw)) return null;
  const rules: ParsedStyleSheet["rules"] = [];
  const limit = Math.min(raw.length, MAX_PARSED_RULES_PER_SHEET);
  if (raw.length > limit && entry.warnedRulesCap !== true) {
    entry.warnedRulesCap = true;
    console.warn(
      `kitesurf: stylesheet has more than ${MAX_PARSED_RULES_PER_SHEET} rules; keeping the first ${MAX_PARSED_RULES_PER_SHEET}`,
    );
  }
  let keptDeclarations = 0;
  for (let i = 0; i < limit; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.selector_text !== "string") continue;
    const declarations: ParsedStyleSheet["rules"][number]["declarations"] = [];
    let capped = false;
    if (Array.isArray(r.declarations)) {
      for (const d of r.declarations) {
        if (keptDeclarations >= MAX_PARSED_DECLARATIONS_PER_SHEET) {
          capped = true;
          break;
        }
        if (!d || typeof d !== "object") continue;
        const { name, value, important } = d as Record<string, unknown>;
        if (typeof name !== "string" || typeof value !== "string") continue;
        declarations.push(important === true ? { name, value, important } : { name, value });
        keptDeclarations++;
      }
    }
    rules.push({
      selector_text: r.selector_text,
      selector_specificities: copyNumbers(r.selector_specificities),
      declarations,
      source_line: typeof r.source_line === "number" ? r.source_line : 0,
      source_column: typeof r.source_column === "number" ? r.source_column : 0,
    });
    // Declarations are retained for the document's life, so stop copying at the cap.
    if (capped) {
      if (entry.warnedDeclarationsCap !== true) {
        entry.warnedDeclarationsCap = true;
        console.warn(
          `kitesurf: stylesheet has more than ${MAX_PARSED_DECLARATIONS_PER_SHEET} declarations; keeping the first ${MAX_PARSED_DECLARATIONS_PER_SHEET}`,
        );
      }
      break;
    }
  }
  return rules;
}

const SHEET_ORIGINS = new Set(["regular", "user-agent", "injected", "inspector"]);
const SHEET_CORS = new Set(["clean", "opaque", "pending"]);

function copyEnumeratedSheets(raw: unknown): EnumeratedStyleSheet[] {
  const out: EnumeratedStyleSheet[] = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    if (typeof s.ownerNodeId !== "number" || !Number.isFinite(s.ownerNodeId)) continue;
    const sheet: EnumeratedStyleSheet = {
      ownerNodeId: s.ownerNodeId,
      text: typeof s.text === "string" ? s.text : "",
    };
    if (typeof s.sourceURL === "string") sheet.sourceURL = s.sourceURL;
    if (typeof s.isInline === "boolean") sheet.isInline = s.isInline;
    if (typeof s.origin === "string" && SHEET_ORIGINS.has(s.origin)) {
      sheet.origin = s.origin as EnumeratedStyleSheet["origin"];
    }
    if (typeof s.cors === "string" && SHEET_CORS.has(s.cors)) {
      sheet.cors = s.cors as EnumeratedStyleSheet["cors"];
    }
    out.push(sheet);
  }
  return out;
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
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    } else if (c === 10 || c === 12) {
      starts.push(i + 1);
    }
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
    if (c === "\\") {
      i++;
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
    if (c === "\\") {
      i++;
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
    if (c === "\\") {
      i++;
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
    if (c === "\\") {
      i++;
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
  return code === 9 || code === 10 || code === 12 || code === 13 || code === 32;
}

// A close upper bound on what buildRuleMatch serializes for one match, checked before the object
// is built. Text counts twice (the selector list and each selector, the properties and cssText),
// so 12 per character covers escaping; 160 per selector and 144 per declaration cover keys,
// ranges, specificity and numbers, and 8 per matching index covers the index list.
const SELECTOR_CHARGE = 160;
const DECLARATION_CHARGE = 144;
const MATCH_INDEX_CHARGE = 8;
// matchCharge's floor: one selector, no text, one matching index.
const MIN_MATCH_CHARGE = 256 + SELECTOR_CHARGE + MATCH_INDEX_CHARGE;

function matchCharge(
  styleSheetId: string,
  rule: ParsedStyleSheet["rules"][number],
  selectorCount: number,
  matchCount: number,
): number {
  let charge = 256 + 12 * (styleSheetId.length + rule.selector_text.length);
  charge += SELECTOR_CHARGE * selectorCount;
  charge += MATCH_INDEX_CHARGE * matchCount;
  for (const d of rule.declarations) {
    charge += DECLARATION_CHARGE + 12 * (d.name.length + d.value.length);
  }
  return charge;
}

function buildRuleMatch(
  styleSheetId: string,
  rule: ParsedStyleSheet["rules"][number],
  rangeInfo: ParsedStyleSheet["ranges"][number],
  selectorTexts: string[],
  matchingSelectors: number[],
  origin: Protocol.CSS.StyleSheetOrigin,
): Protocol.CSS.RuleMatch {
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

// A rule that matched nothing costs nothing, so a page-supplied selector list cannot exhaust the
// budget. The charge is computed from the reply's length before its indices are copied: a sparse
// array of length 8M iterates for ~100 ms per rule even though it holds one index.
function addMatch(
  matched: Protocol.CSS.RuleMatch[],
  budget: MatchBudget,
  styleSheetId: string,
  entry: StyleSheetEntry,
  rule: ParsedStyleSheet["rules"][number],
  rangeInfo: ParsedStyleSheet["ranges"][number],
  rawMatches: unknown,
): void {
  const matchCount = Array.isArray(rawMatches) ? rawMatches.length : 0;
  if (matchCount === 0) return;
  const selectorTexts = splitTopLevelCommas(rule.selector_text);
  const charge = matchCharge(styleSheetId, rule, selectorTexts.length, matchCount);
  if (charge > budget.remaining) {
    warnMatchBudget(budget);
    return;
  }
  const matchingSelectors = copyNumbers(rawMatches);
  if (matchingSelectors.length === 0) return;
  budget.remaining -= charge;
  matched.push(
    buildRuleMatch(styleSheetId, rule, rangeInfo, selectorTexts, matchingSelectors, entry.origin),
  );
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
    if (c === "\\") {
      i++;
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
  budget: MatchBudget,
): Promise<Protocol.CSS.InheritedStyleEntry[]> {
  const ancestorIds: number[] = [];
  try {
    const r = await stubQueryDom(ps, "getAncestorElementIds", {
      nodeId: startNodeId,
    });
    // The reply is untrusted, so copy no more entries than the PageScript walk can produce.
    const raw = r?.ancestorIds;
    if (Array.isArray(raw)) {
      for (let i = 0; i < raw.length && i < MAX_ANCESTOR_STYLE_HOPS; i++) {
        const id = raw[i];
        if (typeof id === "number") ancestorIds.push(id);
      }
    }
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
        // No match could fit, so stop asking the page to evaluate selectors.
        if (budget.remaining < MIN_MATCH_CHARGE) {
          warnMatchBudget(budget);
          break;
        }
        const matchResult = await stubQueryDom(ps, "matchSelectorList", {
          nodeId: ancestorId,
          selectorListText: rule.selector_text,
        });
        addMatch(matched, budget, styleSheetId, entry, rule, rangeInfo, matchResult?.matches);
      }
    }
    entries.push({ matchedCSSRules: matched });
  }
  return entries;
}
