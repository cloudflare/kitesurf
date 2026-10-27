// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Window object construction. `installWindow(document, dom)` is a
// factory called from buildDocument body (it needs per-navigate
// locals) and returns { window (Proxy), windowObj (target), Window
// (proto anchor) }. Named-globals helpers live at module scope.

import { makeStyleDeclaration, type StyleDeclarationBackend } from "./style-declaration.js";
import {
  ksGlobal,
  dom,
  documentImpl,
  getCurrentUrl,
  setCurrentUrl,
  getComputedStyleForAuthId,
  getComputedStyleValueForAuthId,
  getInlinePropertyValue,
  WINDOW_KEY,
  setWindowObj,
  setWindowProxy,
  windowProxy,
  windowObj as stateWindowObj,
  opts,
  pageUrl,
  cookieString,
  setCookieString,
} from "./state.js";
import { stampedNames, nodeIdName, forgetIdGlobal, boundFromGlobal } from "./registries.js";
import { getDocId } from "./mutations/attached.js";
import {
  DEFAULT_VIEWPORT_HEIGHT_CSS_PX,
  DEFAULT_VIEWPORT_WIDTH_CSS_PX,
  GET_COMPUTED_STYLE_INTERNAL,
  MS_PER_SECOND,
  notSupported,
} from "./constants.js";
import { ksSpan } from "./otel.js";
import { isReservedGlobalName, cssPropCamelToKebab } from "./util/strings.js";
import { normalizeScrollArgs } from "./util/scroll-args.js";
import type { Element } from "./element/element.js";
import {
  addListener,
  removeListener,
  dispatchOnKey,
  dispatchTrustedOnKey,
} from "./events/dispatch.js";
import { scrollOffset, setScrollOffset } from "./layout/scroll.js";
import { getSelection as selectionSingleton } from "./range.js";
import { getInternalState } from "./internal-state.js";
import { KsPopStateEvent, postMessageEvent } from "./events/event.js";
import type * as Idl from "./idl/types.generated.js";
import { sendUpstreamEvent } from "./internal-state.js";
import {
  GLOBAL_EVENT_HANDLERS,
  WINDOW_EVENT_HANDLERS,
  EXTRA_EVENT_HANDLERS,
} from "./event-handler-names.js";

const runtimeToString = Function.prototype.toString;

export function locUrl(): URL | null {
  try {
    return new URL(getCurrentUrl());
  } catch {
    return null;
  }
}

type LocationMutation = { url: string; kind: "hash" | "navigate" };

function hrefMutation(cur: URL, value: string): LocationMutation {
  const next = new URL(value, cur.toString());
  const sameDocument =
    next.toString() !== cur.toString() &&
    next.toString().split("#")[0] === cur.toString().split("#")[0];
  return { url: next.toString(), kind: sameDocument ? "hash" : "navigate" };
}

function componentMutation(cur: URL, component: "hash" | "pathname" | "search", value: string) {
  const next = new URL(cur.toString());
  switch (component) {
    case "hash":
      next.hash = value.startsWith("#") ? value.slice(1) : value;
      return { url: next.toString(), kind: "hash" } as const;
    case "pathname":
      next.pathname = value;
      return { url: next.toString(), kind: "navigate" } as const;
    case "search":
      next.search = value;
      return { url: next.toString(), kind: "navigate" } as const;
    default:
      return null;
  }
}

function resolveLocationMutation(
  cur: URL,
  component: "hash" | "pathname" | "search" | "href",
  value: string,
): LocationMutation | null {
  try {
    if (component === "href") return hrefMutation(cur, value);
    return componentMutation(cur, component, value);
  } catch {
    return null;
  }
}

export function locationMutate(
  component: "hash" | "pathname" | "search" | "href",
  value: string,
): void {
  if (!setCurrentUrl) return;
  const cur = locUrl();
  if (!cur) return;
  const mutation = resolveLocationMutation(cur, component, value);
  if (mutation) setCurrentUrl(mutation.url, mutation.kind);
}

type LocationSurface = Pick<
  Idl.Location,
  | "href"
  | "origin"
  | "protocol"
  | "host"
  | "hostname"
  | "port"
  | "pathname"
  | "search"
  | "hash"
  | "assign"
  | "replace"
  | "reload"
  | "toString"
>;

export const location: LocationSurface = Object.create(Object.prototype);

// Shared callbacks preserve getter identity across DocumentImpl instances.
export function __ks_documentImpl_location_get(): LocationSurface {
  return location;
}
export function __ks_documentImpl_location_set(v: unknown): void {
  location.href = String(v);
}

Object.defineProperties(location, {
  href: {
    get: () => getCurrentUrl(),
    set: (v: any) => locationMutate("href", String(v)),
    enumerable: true,
    configurable: false,
  },
  origin: { get: () => locUrl()?.origin ?? "", enumerable: true, configurable: false },
  protocol: { get: () => locUrl()?.protocol ?? "", enumerable: true, configurable: false },
  host: { get: () => locUrl()?.host ?? "", enumerable: true, configurable: false },
  hostname: { get: () => locUrl()?.hostname ?? "", enumerable: true, configurable: false },
  port: { get: () => locUrl()?.port ?? "", enumerable: true, configurable: false },
  pathname: {
    get: () => locUrl()?.pathname ?? "",
    set: (v: any) => locationMutate("pathname", String(v)),
    enumerable: true,
    configurable: false,
  },
  search: {
    get: () => locUrl()?.search ?? "",
    set: (v: any) => locationMutate("search", String(v)),
    enumerable: true,
    configurable: false,
  },
  hash: {
    get: () => locUrl()?.hash ?? "",
    set: (v: any) => locationMutate("hash", String(v)),
    enumerable: true,
    configurable: false,
  },
  toString: {
    value: () => getCurrentUrl(),
    writable: false,
    enumerable: true,
    configurable: false,
  },
  valueOf: {
    value: Object.prototype.valueOf,
    writable: false,
    enumerable: false,
    configurable: false,
  },
  assign: {
    value: (url: any) => locationMutate("href", String(url)),
    writable: false,
    enumerable: true,
    configurable: false,
  },
  replace: {
    value: (url: any) => locationMutate("href", String(url)),
    writable: false,
    enumerable: true,
    configurable: false,
  },
  reload: {
    value: () => {
      try {
        const cur =
          opts && typeof opts.getCurrentUrl === "function" ? opts.getCurrentUrl() : pageUrl;
        locationMutate("href", String(cur));
      } catch {}
    },
    writable: false,
    enumerable: true,
    configurable: false,
  },
});

Object.defineProperty(location, Symbol.toPrimitive, {
  value: undefined,
  writable: false,
  enumerable: false,
  configurable: false,
});

const COOKIE_NAME_FORBIDDEN_CODES = new Set([
  0x22, 0x28, 0x29, 0x2c, 0x2f, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x40, 0x5b, 0x5c, 0x5d, 0x7b,
  0x7d,
]);
const COOKIE_VALUE_FORBIDDEN_CODES = new Set([0x22, 0x2c, 0x3b, 0x5c]);

function isVisibleCookieCode(code: number): boolean {
  return code >= 0x21 && code <= 0x7e;
}

function isValidCookieNameCode(code: number): boolean {
  return isVisibleCookieCode(code) && !COOKIE_NAME_FORBIDDEN_CODES.has(code);
}

function isValidCookieName(s: string): boolean {
  if (!s) return false;
  for (let i = 0; i < s.length; i++) {
    if (!isValidCookieNameCode(s.charCodeAt(i))) return false;
  }
  return true;
}

function unquoteCookieValue(value: string): string {
  if (
    value.length >= 2 &&
    value.charCodeAt(0) === 0x22 &&
    value.charCodeAt(value.length - 1) === 0x22
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isValidCookieValueCode(code: number): boolean {
  return isVisibleCookieCode(code) && !COOKIE_VALUE_FORBIDDEN_CODES.has(code);
}

function isValidCookieValue(value: string): boolean {
  const unquoted = unquoteCookieValue(value);
  for (let i = 0; i < unquoted.length; i++) {
    if (!isValidCookieValueCode(unquoted.charCodeAt(i))) return false;
  }
  return true;
}

interface LocalCookieWrite {
  name: string;
  value: string;
  expiresAt: number | null;
}

function cookieMaxAgeExpiry(value: string, current: number | null): number | null {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Date.now() + seconds * MS_PER_SECOND : current;
}

function cookieExpiresExpiry(value: string, current: number | null): number | null {
  if (current != null) return current;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : current;
}

function cookieExpiryForAttribute(
  name: string,
  value: string,
  current: number | null,
): number | null {
  if (name === "max-age") return cookieMaxAgeExpiry(value, current);
  if (name === "expires") {
    return cookieExpiresExpiry(value, current);
  }
  return current;
}

function cookieExpiryFromSegments(segments: string[]): number | null {
  let expiresAt: number | null = null;
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i];
    const equals = segment.indexOf("=");
    if (equals < 0) continue;
    const name = segment.slice(0, equals).trim().toLowerCase();
    const value = segment.slice(equals + 1).trim();
    expiresAt = cookieExpiryForAttribute(name, value, expiresAt);
  }
  return expiresAt;
}

function parseLocalCookiePair(first: string): { name: string; value: string } | null {
  const equals = first.indexOf("=");
  if (equals < 0) return null;
  const name = first.slice(0, equals).trim();
  const value = first.slice(equals + 1).trim();
  if (!name || !isValidCookieName(name) || !isValidCookieValue(value)) return null;
  return { name, value };
}

function parseLocalCookieWrite(raw: unknown): LocalCookieWrite | null {
  const segments = localCookieWriteSegments(raw);
  if (!segments) return null;
  const assignment = parseLocalCookiePair(segments[0]);
  if (!assignment) return null;
  return { ...assignment, expiresAt: cookieExpiryFromSegments(segments) };
}

function replaceMatchingCookiePart(
  parts: string[],
  name: string,
  value: string,
  isDelete: boolean,
): boolean {
  for (let i = 0; i < parts.length; i++) {
    if (cookieNameFromPair(parts[i]) !== name) continue;
    if (isDelete) parts.splice(i, 1);
    else parts[i] = name + "=" + value;
    return true;
  }
  return false;
}

function appendNewCookiePart(
  parts: string[],
  name: string,
  value: string,
  replaced: boolean,
  isDelete: boolean,
): void {
  if (!replaced && !isDelete) parts.push(name + "=" + value);
}

function updateLocalCookieParts(
  parts: string[],
  name: string,
  value: string,
  isDelete: boolean,
): string[] {
  const replaced = replaceMatchingCookiePart(parts, name, value, isDelete);
  appendNewCookiePart(parts, name, value, replaced, isDelete);
  return parts;
}

function localCookieWriteSegments(raw: unknown): string[] | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const segments = trimmed
    .split(";")
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.length > 0 ? segments : null;
}

function cookieNameFromPair(pair: string): string {
  const equals = pair.indexOf("=");
  return equals < 0 ? pair : pair.slice(0, equals);
}

export function applyLocalCookieWrite(raw: unknown): void {
  const write = parseLocalCookieWrite(raw);
  if (!write) return;
  const isDelete = write.expiresAt != null && write.expiresAt <= Date.now();
  const parts = cookieString ? cookieString.split("; ").filter(Boolean) : [];
  const updated = updateLocalCookieParts(parts, write.name, write.value, isDelete);
  setCookieString(updated.join("; "));
}

const RAF_FALLBACK_DELAY_MS = 16;
let rafFallbackFn: ((cb: (ts: number) => void) => unknown) | null = null;
let cafFallbackFn: ((id: unknown) => void) | null = null;

function ksState() {
  return getInternalState();
}

function viewportDims(): { w: number; h: number } {
  try {
    const s = getInternalState();
    const w = Number(s.viewportW);
    const h = Number(s.viewportH);
    if (w > 0 && h > 0) return { w, h };
  } catch {}
  return {
    w: DEFAULT_VIEWPORT_WIDTH_CSS_PX,
    h: DEFAULT_VIEWPORT_HEIGHT_CSS_PX,
  };
}

const COMPUTED_STYLE_PSEUDOS = new Set(["before", "after", "marker", "selection", "first-letter"]);

function computedStyleNodeId(element: any): number {
  return element && typeof element === "object" && typeof element._id === "number"
    ? element._id
    : -1;
}

function normalizePseudoSelector(pseudoArg: any): string {
  if (pseudoArg == null || pseudoArg === "") return "";
  const pseudo = String(pseudoArg).trim().replace(/^:+/, "").toLowerCase();
  return COMPUTED_STYLE_PSEUDOS.has(pseudo) ? "::" + pseudo : "";
}

function hasComputedStyleNode(nodeId: number): boolean {
  return nodeId >= 0 && !!getComputedStyleForAuthId;
}

function canUseSingleComputedStyle(
  hasNodeId: boolean,
  pseudo: string,
  computedValuesOnly: boolean,
  valueForAuthId: typeof getComputedStyleValueForAuthId,
): boolean {
  return hasNodeId && !pseudo && !computedValuesOnly && !!valueForAuthId;
}

function windowOpenUrl(url: any): string {
  return url == null || url === "" ? "about:blank" : String(url);
}

function windowOpenBase(windowObj: any): string | undefined {
  return typeof windowObj.document !== "undefined" &&
    windowObj.document &&
    typeof windowObj.document.baseURI === "string"
    ? windowObj.document.baseURI
    : undefined;
}

function validateWindowOpenUrl(raw: string, base: string | undefined): void {
  try {
    new URL(raw, base);
  } catch {
    throw new ksGlobal.DOMException(
      "Failed to execute 'open' on 'Window': '" + raw + "' is not a valid URL.",
      "SyntaxError",
    );
  }
}

function createOpenedWindowStub(raw: string): any {
  const stub: any = {
    closed: false,
    document: null,
    location: {
      href: raw,
      toString() {
        return raw;
      },
    },
    focus() {},
    blur() {},
    print() {},
    postMessage() {},
    close() {
      stub.closed = true;
    },
  };
  return stub;
}

type HistoryEntry = { url: string; state: unknown };
type HistoryMethod = "pushState" | "replaceState";

function parseHistoryTarget(rawUrl: string, currentUrl: string, method: HistoryMethod): URL {
  try {
    return new URL(String(rawUrl), currentUrl || undefined);
  } catch {
    throw new ksGlobal.DOMException(
      `Failed to execute '${method}' on 'History': '${rawUrl}' could not be parsed as a URL.`,
      "SecurityError",
    );
  }
}

function historyOriginsMatch(target: URL, current: URL): boolean {
  const sameOrigin = target.origin !== "null" && target.origin === current.origin;
  const bothOpaqueAndSameScheme =
    target.origin === "null" && current.origin === "null" && target.protocol === current.protocol;
  return sameOrigin || bothOpaqueAndSameScheme;
}

function historyLocation(): { current: URL | null; url: string } {
  const current = locUrl();
  return { current, url: current ? current.toString() : "" };
}

function historyStackCurrentUrl(
  historyStack: HistoryEntry[],
  historyIndex: number,
  fallback: string,
): string {
  const entry = historyStack[historyIndex];
  return entry ? entry.url : fallback;
}

function assertHistoryTargetOrigin(
  target: URL,
  current: URL | null,
  currentUrl: string,
  method: HistoryMethod,
): void {
  if (!current) return;
  if (historyOriginsMatch(target, current)) return;
  throw new ksGlobal.DOMException(
    `Failed to execute '${method}' on 'History': A history state object with URL '${target.toString()}' cannot be created in a document with origin '${current.origin}' and URL '${currentUrl}'.`,
    "SecurityError",
  );
}

function resolveHistoryUrl(
  rawUrl: string | null | undefined,
  method: HistoryMethod,
  historyStack: HistoryEntry[],
  historyIndex: number,
): string {
  const { current, url: currentUrl } = historyLocation();
  if (rawUrl == null) return historyStackCurrentUrl(historyStack, historyIndex, currentUrl);
  const target = parseHistoryTarget(rawUrl, currentUrl, method);
  assertHistoryTargetOrigin(target, current, currentUrl, method);
  return target.toString();
}

function historyDelta(value?: number): number {
  return value == null ? 0 : Number(value) | 0;
}

function historyEntryUrl(entry: HistoryEntry | undefined): string {
  return entry ? entry.url : "";
}

function historyEntryState(entry: HistoryEntry | undefined): unknown {
  return entry ? entry.state : null;
}

function historyTargetIndex(index: number, delta: number, length: number): number | null {
  const target = index + delta;
  return target < 0 || target >= length ? null : target;
}

function setHistoryUrl(previousUrl: string, nextUrl: string): void {
  if (!setCurrentUrl) return;
  const sameDocument = previousUrl.split("#")[0] === nextUrl.split("#")[0];
  setCurrentUrl(nextUrl, sameDocument ? "hash" : "historyApi");
}

function queueHistoryPopstate(state: unknown): void {
  const queue = (callback: () => void) => {
    try {
      ksGlobal.setTimeout(callback, 0);
    } catch {
      try {
        callback();
      } catch {}
    }
  };
  queue(() => {
    try {
      const event: any = new KsPopStateEvent("popstate", {
        bubbles: false,
        cancelable: false,
        state,
      });
      dispatchTrustedOnKey(WINDOW_KEY, event);
    } catch {}
  });
}

export function installWindow(
  document: any,
  dom: any,
): {
  window: any;
  windowObj: any;
  Window: any;
} {
  void dom;

  const historyStack: HistoryEntry[] = [{ url: getCurrentUrl() || "", state: null }];
  let historyIndex = 0;

  const history: any = {
    get state() {
      return historyStack[historyIndex]?.state ?? null;
    },
    get length() {
      return historyStack.length;
    },
    scrollRestoration: "auto" as "auto" | "manual",
    pushState(state: unknown, _title: string, url?: string | null) {
      const target = resolveHistoryUrl(url, "pushState", historyStack, historyIndex);
      historyStack.length = historyIndex + 1;
      historyStack.push({ url: target, state: state ?? null });
      historyIndex = historyStack.length - 1;
      if (setCurrentUrl) setCurrentUrl(target, "pushState");
    },
    replaceState(state: unknown, _title: string, url?: string | null) {
      const target = resolveHistoryUrl(url, "replaceState", historyStack, historyIndex);
      historyStack[historyIndex] = { url: target, state: state ?? null };
      if (setCurrentUrl) setCurrentUrl(target, "replaceState");
    },
    go(n?: number) {
      const delta = historyDelta(n);
      if (delta === 0) return;
      const target = historyTargetIndex(historyIndex, delta, historyStack.length);
      if (target === null) return;
      const previousUrl = historyEntryUrl(historyStack[historyIndex]);
      historyIndex = target;
      const nextEntry = historyStack[historyIndex];
      const nextUrl = historyEntryUrl(nextEntry);
      setHistoryUrl(previousUrl, nextUrl);
      queueHistoryPopstate(historyEntryState(nextEntry));
    },
    back() {
      history.go(-1);
    },
    forward() {
      history.go(1);
    },
  };

  const navigator = {
    userAgent: (opts && typeof opts.userAgent === "string" && opts.userAgent) || "Kitesurf/0.0.1",
    appName: "Kitesurf",
    appVersion: "0.0.1",
    platform: "Cloudflare Workers",
    language: "en-US",
    languages: ["en-US", "en"],
    onLine: true,
    cookieEnabled: false,
    sendBeacon(url: string, _data?: string | object | null) {
      new URL(url, getCurrentUrl());
      return true;
    },
  };

  const windowObj: any = {
    get navigator() {
      return navigator;
    },
    get history() {
      return history;
    },
    get self() {
      return window;
    },
    get parent() {
      return window;
    },
    get frames() {
      return window;
    },
    get length() {
      try {
        const doc = (documentImpl as any)?.get?.() ?? documentImpl;
        return doc?.querySelectorAll?.("iframe")?.length ?? 0;
      } catch {
        return 0;
      }
    },
    get opener() {
      return null;
    },
    get frameElement() {
      return null;
    },
    get innerWidth() {
      return viewportDims().w;
    },
    get innerHeight() {
      return viewportDims().h;
    },
    get outerWidth() {
      return viewportDims().w;
    },
    get outerHeight() {
      return viewportDims().h;
    },
    get scrollX() {
      return scrollOffset().x;
    },
    get scrollY() {
      return scrollOffset().y;
    },
    get pageXOffset() {
      return scrollOffset().x;
    },
    get pageYOffset() {
      return scrollOffset().y;
    },
    scrollTo(xOrOptions: any, y: any) {
      void xOrOptions;
      void y;
      const args = arguments;
      return (async () => {
        const norm = normalizeScrollArgs(args, "scrollTo");
        if (norm === null) return;
        const cur = scrollOffset();
        const left = norm.left == null ? cur.x : norm.left;
        const top = norm.top == null ? cur.y : norm.top;
        setScrollOffset(left, top);
      })();
    },
    scroll(...args: any[]) {
      return (this as any).scrollTo(...args);
    },
    scrollBy(xOrOptions: any, y: any) {
      void xOrOptions;
      void y;
      const args = arguments;
      return (async () => {
        const norm = normalizeScrollArgs(args, "scrollBy");
        if (norm === null) return;
        const cur = scrollOffset();
        setScrollOffset(
          cur.x + (norm.left == null ? 0 : norm.left),
          cur.y + (norm.top == null ? 0 : norm.top),
        );
      })();
    },
    get devicePixelRatio() {
      return 1;
    },
    get screen() {
      const { w, h } = viewportDims();
      return Object.freeze({
        width: w,
        height: h,
        availWidth: w,
        availHeight: h,
        colorDepth: 24,
        pixelDepth: 24,
      });
    },
    get fetch() {
      return globalThis.fetch;
    },
    getComputedStyle(element: any, pseudoArg?: any) {
      return windowObj[GET_COMPUTED_STYLE_INTERNAL](element, pseudoArg, false);
    },
    [GET_COMPUTED_STYLE_INTERNAL](element: any, pseudoArg?: any, computedValuesOnly = false) {
      const nodeId = computedStyleNodeId(element);
      const pseudoNorm = normalizePseudoSelector(pseudoArg);
      const hasNodeId = hasComputedStyleNode(nodeId);
      let cachedSeq = -1;
      let cachedMap: Map<string, string> | null = null;
      let cachedUnresolved: Map<string, string> | null = null;
      let cachedCssText: string | null = null;
      const valueForAuthId = getComputedStyleValueForAuthId;
      const singleOk = canUseSingleComputedStyle(
        hasNodeId,
        pseudoNorm,
        computedValuesOnly,
        valueForAuthId,
      );
      let singleSeq = -1;
      let singleValues: Map<string, string> | null = null;
      const isCachedAtSequence = (sequence: number) => cachedMap !== null && cachedSeq === sequence;
      const single = (dash: string): string | null => {
        const curSeq = ksState().mutationSeq | 0;
        if (isCachedAtSequence(curSeq)) return null;
        if (singleSeq !== curSeq) {
          singleSeq = curSeq;
          singleValues = null;
        }
        const hit = singleValues?.get(dash);
        if (hit !== undefined) return hit;
        if (!valueForAuthId) return null;
        const value = valueForAuthId(nodeId, dash);
        if (typeof value !== "string") return null;
        (singleValues ??= new Map()).set(dash, value);
        return value;
      };
      const clearResolvedCache = (sequence: number) => {
        cachedMap = null;
        cachedUnresolved = null;
        cachedCssText = null;
        cachedSeq = sequence;
      };
      const isComputedStyleProperty = (property: any): boolean =>
        !!property && typeof property.name === "string";
      const computedStyleValue = (property: any): unknown =>
        computedValuesOnly && typeof property.computed === "string"
          ? property.computed
          : property.value;
      const unresolvedStyleValue = (property: any): string | null => {
        if (computedValuesOnly) return null;
        return typeof property.unresolved === "string" ? property.unresolved : null;
      };
      const addComputedStyleProperty = (
        property: any,
        map: Map<string, string>,
        unresolved: Map<string, string>,
      ) => {
        if (!isComputedStyleProperty(property)) return;
        map.set(property.name, String(computedStyleValue(property) ?? ""));
        const unresolvedValue = unresolvedStyleValue(property);
        if (unresolvedValue !== null) unresolved.set(property.name, unresolvedValue);
      };
      const buildComputedStyleMaps = (props: any[]) => {
        const map = new Map<string, string>();
        const unresolved = new Map<string, string>();
        for (const property of props) addComputedStyleProperty(property, map, unresolved);
        return { map, unresolved };
      };
      const resolve = (): Map<string, string> | null => {
        if (!hasNodeId) return null;
        const curSeq = ksState().mutationSeq | 0;
        if (isCachedAtSequence(curSeq)) return cachedMap;
        const props = ksSpan("dom.getComputedStyle", null, () =>
          (getComputedStyleForAuthId as any)(nodeId, pseudoNorm || undefined),
        );
        if (!Array.isArray(props)) {
          clearResolvedCache(curSeq);
          return null;
        }
        const maps = buildComputedStyleMaps(props);
        cachedMap = maps.map;
        cachedUnresolved = maps.unresolved;
        cachedCssText = null;
        cachedSeq = curSeq;
        return maps.map;
      };
      function getCssText(map: Map<string, string>): string {
        if (cachedCssText !== null) return cachedCssText;
        const parts: string[] = [];
        for (const [k, v] of map) {
          parts.push(k + ": " + (cachedUnresolved?.get(k) ?? v));
        }
        cachedCssText = parts.join("; ");
        return cachedCssText;
      }
      function lookupViaStylo(map: Map<string, string>, dashName: string): string {
        if (!getInlinePropertyValue) return "";
        const css = getCssText(map);
        if (!css) return "";
        try {
          return getInlinePropertyValue(css, dashName) || "";
        } catch {
          return "";
        }
      }
      const lookupResolved = (dash: string, map: Map<string, string> | null): string => {
        if (!map) return "";
        const direct = map.get(dash);
        if (direct !== undefined) return direct;
        return lookupViaStylo(map, dash);
      };
      const lookup = (prop: string): string => {
        const dash = prop.indexOf("-") >= 0 ? prop : cssPropCamelToKebab(prop);
        const singleValue = singleOk ? single(dash) : null;
        if (singleValue !== null) return singleValue;
        return lookupResolved(dash, resolve());
      };
      function readOnlyThrow(name: string): never {
        throw new (ksGlobal.DOMException || Error)(
          "Cannot modify a computed style declaration (" + name + ")",
          "NoModificationAllowedError",
        );
      }
      const backend: StyleDeclarationBackend = {
        // getPropertyValue takes the property name verbatim (kebab-case in
        // CSSOM); a camelCase name reads "" (WPT). A direct map hit wins,
        // then Stylo assembles shorthands (font, margin, background, ...).
        getPropertyValue(name) {
          const k = String(name);
          if (singleOk) {
            const value = single(k);
            if (value !== null) return value;
          }
          const map = resolve();
          if (!map) return "";
          const direct = map.get(k);
          if (direct !== undefined) return direct;
          return lookupViaStylo(map, k);
        },
        getPropertyPriority: () => "",
        setProperty(name) {
          readOnlyThrow("setProperty(" + name + ")");
        },
        removeProperty(name) {
          readOnlyThrow("removeProperty(" + name + ")");
        },
        cssText() {
          const map = resolve();
          if (!map) return "";
          const parts: string[] = [];
          for (const [k, v] of map) parts.push(k + ": " + v);
          return parts.join("; ");
        },
        setCssText() {
          readOnlyThrow("cssText");
        },
        length() {
          const map = resolve();
          return map ? map.size : 0;
        },
        item(idx) {
          const map = resolve();
          if (!map) return "";
          let i = 0;
          for (const k of map.keys()) {
            if (i === idx) return k;
            i++;
          }
          return "";
        },
        parentRule: () => null,
        // Iteration yields each property name in declaration order (WPT
        // getComputedStyle-logical-enumeration).
        names() {
          const map = resolve();
          return map ? map.keys() : [][Symbol.iterator]();
        },
      };
      // The CSS properties, camelCase or kebab-case, and the indexes.
      return makeStyleDeclaration(backend, {
        get(_t, prop) {
          if (typeof prop === "string" && /^\d+$/.test(prop)) return backend.item(+prop);
          return lookup(String(prop));
        },
        // A computed declaration is read-only: writes throw
        // NoModificationAllowedError.
        set(_t, prop) {
          if (typeof prop !== "string") return false;
          readOnlyThrow(prop);
        },
        has(_t, prop) {
          if (typeof prop !== "string") return false;
          const map = resolve();
          if (!map) return false;
          const dash = prop.indexOf("-") >= 0 ? prop : cssPropCamelToKebab(prop);
          if (map.has(dash)) return true;
          // Every supported property, longhand or shorthand, is `in` the
          // declaration (computed-testcommon.js checks support this way),
          // so ask Stylo whether it can assemble a value.
          return !!lookupViaStylo(map, dash);
        },
        ownKeys() {
          const map = resolve();
          return map ? [...map.keys()] : [];
        },
        getOwnPropertyDescriptor(_t, prop) {
          if (typeof prop !== "string") return undefined;
          const map = resolve();
          if (!map) return undefined;
          const value = lookup(prop);
          if (value === "" && !map.has(prop)) return undefined;
          return {
            value,
            writable: false,
            enumerable: true,
            configurable: true,
          };
        },
      });
    },
    getSelection: markNoBind(function (this: any) {
      assertWindowReceiver(this);
      return selectionSingleton();
    }, "getSelection"),
    addEventListener(type: any, listener: any, options: any) {
      if (arguments.length < 2) {
        throw new TypeError(
          "Failed to execute 'addEventListener' on 'EventTarget': 2 arguments required, but only " +
            arguments.length +
            " present.",
        );
      }
      addListener(WINDOW_KEY, type, listener, options);
    },
    removeEventListener(type: any, listener: any, options: any) {
      if (arguments.length < 2) {
        throw new TypeError(
          "Failed to execute 'removeEventListener' on 'EventTarget': 2 arguments required, but only " +
            arguments.length +
            " present.",
        );
      }
      removeListener(WINDOW_KEY, type, listener, options);
    },
    dispatchEvent(event: any) {
      return dispatchOnKey(WINDOW_KEY, event);
    },
    event: undefined,
    // Return the runtime callback directly; a forwarding wrapper can re-enter its wasm FnMut.
    get requestAnimationFrame(): any {
      const g = ksGlobal.requestAnimationFrame;
      if (typeof g === "function") return g;
      return (rafFallbackFn ??= (cb) => setTimeout(() => cb(Date.now()), RAF_FALLBACK_DELAY_MS));
    },
    set requestAnimationFrame(v: any) {
      ksGlobal.requestAnimationFrame = v;
    },
    get cancelAnimationFrame(): any {
      const g = ksGlobal.cancelAnimationFrame;
      if (typeof g === "function") return g;
      return (cafFallbackFn ??= (id) => clearTimeout(id as any));
    },
    set cancelAnimationFrame(v: any) {
      ksGlobal.cancelAnimationFrame = v;
    },
    alert: () => {
      throw notSupported("alert");
    },
    confirm: () => {
      throw notSupported("confirm");
    },
    prompt: () => {
      throw notSupported("prompt");
    },
    open: (url?: any, _target?: any, _features?: any) => {
      const raw = windowOpenUrl(url);
      validateWindowOpenUrl(raw, windowOpenBase(windowObj));
      return createOpenedWindowStub(raw);
    },
  };

  class Window {}
  Object.setPrototypeOf(windowObj, Window.prototype);

  const boundFromWindow = new WeakMap<object, Function>();
  const pageAssigned = new WeakSet<object>();
  const nativeness = new WeakMap<object, boolean>();
  const isRuntimeNative = (fn: object): boolean => {
    const known = nativeness.get(fn);
    if (known !== undefined) return known;
    let native = true;
    try {
      native = runtimeToString.call(fn).includes("[native code]");
    } catch {}
    nativeness.set(fn, native);
    return native;
  };

  const bindKeepingIdlShape = (fn: Function, thisArg: unknown): Function => {
    const bound = fn.bind(thisArg);
    try {
      Object.defineProperty(bound, "name", {
        value: fn.name,
        writable: false,
        enumerable: false,
        configurable: true,
      });
      Object.defineProperty(bound, "length", {
        value: fn.length,
        writable: false,
        enumerable: false,
        configurable: true,
      });
    } catch {}
    return bound;
  };
  type WinHandlerEntry = { fn: Function; wrapper: (event: unknown) => unknown };
  const winHandlerSlots = new Map<string, WinHandlerEntry>();
  const nameWinAccessor = <F>(fn: F, name: string): F => {
    Object.defineProperty(fn, "name", {
      value: name,
      writable: false,
      enumerable: false,
      configurable: true,
    });
    return fn;
  };
  const windowHandlerNames = new Set<string>([
    ...GLOBAL_EVENT_HANDLERS,
    ...WINDOW_EVENT_HANDLERS,
    ...EXTRA_EVENT_HANDLERS,
  ]);
  const installWindowEventHandlers = function (): void {
    for (const propName of windowHandlerNames) {
      const eventType = propName.slice(2);
      const assertWindowThis = assertWindowReceiver;
      const getter = nameWinAccessor(function (this: unknown) {
        assertWindowThis(this);
        return winHandlerSlots.get(eventType)?.fn ?? null;
      }, "get " + propName);
      const setter = nameWinAccessor(function (this: unknown, value: unknown) {
        assertWindowThis(this);
        const prev = winHandlerSlots.get(eventType);
        if (prev) {
          windowObj.removeEventListener(eventType, prev.wrapper, false);
          winHandlerSlots.delete(eventType);
        }
        if (typeof value !== "function") return;
        const wrapper = function (this: unknown, event: unknown) {
          const fn = winHandlerSlots.get(eventType)?.fn;
          if (typeof fn !== "function") return undefined;
          return fn.call(this, event);
        };
        winHandlerSlots.set(eventType, { fn: value, wrapper });
        windowObj.addEventListener(eventType, wrapper, false);
      }, "set " + propName);
      Object.defineProperty(windowObj, propName, {
        configurable: true,
        enumerable: true,
        get: getter,
        set: setter,
      });
    }
  };
  installWindowEventHandlers();

  const installWindowMethodStubs = function (): void {
    for (const method of [
      "blur",
      "close",
      "focus",
      "print",
      "stop",
      "captureEvents",
      "releaseEvents",
    ]) {
      if (typeof Reflect.get(windowObj, method) === "function") continue;
      Reflect.set(windowObj, method, { [method]: function () {} }[method]);
    }
  };
  installWindowMethodStubs();

  const ownOrigin = (() => {
    try {
      return new URL(getCurrentUrl() || pageUrl || "").origin;
    } catch {
      return "";
    }
  })();
  type PmDomExceptionCtor = new (message?: string, name?: string) => Error;
  type PmStructuredClone = (value: unknown, options?: { transfer: ArrayBuffer[] }) => unknown;
  interface PmTransferablePort {
    _closed?: boolean;
    _detached?: boolean;
    __ksTransfer?: () => object;
  }
  const pmDomException = (msg: string, name: string): Error => {
    const DE = (globalThis as { DOMException?: PmDomExceptionCtor }).DOMException;
    return typeof DE === "function" ? new DE(msg, name) : Object.assign(new Error(msg), { name });
  };
  const pmDataCloneError = (msg: string): Error => pmDomException(msg, "DataCloneError");
  const pmSerialize = (message: unknown): string => {
    try {
      return JSON.stringify(message === undefined ? null : message) ?? "null";
    } catch {
      throw pmDataCloneError("The object could not be cloned.");
    }
  };
  const pmCheckTargetOrigin = (t: unknown): string => {
    const s = t === undefined ? "/" : String(t);
    if (s === "*" || s === "/") return s;
    try {
      return new URL(s).origin;
    } catch {
      throw pmDomException(
        `Failed to execute 'postMessage' on 'Window': Invalid target origin '${s}'.`,
        "SyntaxError",
      );
    }
  };
  const isTransferSequence = (raw: unknown): raw is Iterable<unknown> =>
    raw !== null &&
    typeof raw === "object" &&
    typeof (raw as Partial<Iterable<unknown>>)[Symbol.iterator] === "function";
  const transferSequence = (raw: unknown): Iterable<unknown> => {
    if (!isTransferSequence(raw)) {
      throw new TypeError(
        "Failed to execute 'postMessage' on 'Window': The provided value cannot be converted to a sequence.",
      );
    }
    return raw;
  };
  const isTransferableObject = (value: unknown): value is object =>
    value !== null && (typeof value === "object" || typeof value === "function");
  const pmConvertTransfer = (raw: unknown): object[] => {
    if (raw === undefined) return [];
    const out: object[] = [];
    for (const v of transferSequence(raw)) {
      if (!isTransferableObject(v)) {
        throw new TypeError(
          "Failed to execute 'postMessage' on 'Window': Transferable entry is not an object.",
        );
      }
      out.push(v);
    }
    return out;
  };
  const postMessageUsesOptions = (args: readonly unknown[]): boolean => {
    const target = args[1];
    if (args.length >= 3 || target === undefined) return false;
    return target === null || typeof target === "object";
  };
  const postMessageInput = (args: readonly unknown[]) => {
    let targetOrigin: unknown = args[1];
    let rawTransfer: unknown = args.length >= 3 ? args[2] : undefined;
    if (postMessageUsesOptions(args)) {
      const options = (targetOrigin ?? {}) as {
        targetOrigin?: unknown;
        transfer?: unknown;
      };
      rawTransfer = options.transfer;
      targetOrigin = options.targetOrigin;
    }
    return { targetOrigin, rawTransfer };
  };
  const pmParseArgs = (args: readonly unknown[]): { target: string; transfer: object[] } => {
    if (args.length === 0) {
      throw new TypeError(
        "Failed to execute 'postMessage' on 'Window': 1 argument required, but only 0 present.",
      );
    }
    const { targetOrigin, rawTransfer } = postMessageInput(args);
    return {
      target: pmCheckTargetOrigin(targetOrigin),
      transfer: pmConvertTransfer(rawTransfer),
    };
  };
  const isMessagePortTransfer = (
    value: object,
    MessagePortCtor: unknown,
  ): value is PmTransferablePort =>
    typeof MessagePortCtor === "function" && value instanceof MessagePortCtor;
  const assertTransferPortIsAttached = (port: PmTransferablePort): void => {
    if (port._closed || port._detached) {
      throw pmDataCloneError("MessagePort is already detached.");
    }
  };
  const addPostMessageTransfer = (
    value: object,
    MessagePortCtor: unknown,
    seen: Set<object>,
    buffers: ArrayBuffer[],
    ports: PmTransferablePort[],
  ): void => {
    if (seen.has(value)) throw pmDataCloneError("Duplicate transferable in transfer list.");
    seen.add(value);
    if (isMessagePortTransfer(value, MessagePortCtor)) {
      assertTransferPortIsAttached(value);
      ports.push(value);
      return;
    }
    if (value instanceof ArrayBuffer) {
      buffers.push(value);
      return;
    }
    throw pmDataCloneError("Value is not transferable.");
  };
  const clonePostMessageValue = (message: unknown, buffers: ArrayBuffer[]): unknown => {
    const clone = (globalThis as { structuredClone?: PmStructuredClone }).structuredClone;
    if (typeof clone === "function") {
      return buffers.length ? clone(message, { transfer: buffers }) : clone(message);
    }
    return JSON.parse(pmSerialize(message)) as unknown;
  };
  const transferPostMessagePorts = (ports: PmTransferablePort[]): Idl.MessagePort[] =>
    ports.map(
      (port) =>
        (typeof port.__ksTransfer === "function" ? port.__ksTransfer() : port) as Idl.MessagePort,
    );
  const pmSerializeWithTransfer = (
    message: unknown,
    transfer: readonly object[],
  ): { cloned: unknown; ports: Idl.MessagePort[] } => {
    const MessagePortCtor = (globalThis as { MessagePort?: unknown }).MessagePort;
    const seen = new Set<object>();
    const buffers: ArrayBuffer[] = [];
    const ports: PmTransferablePort[] = [];
    for (const value of transfer) {
      addPostMessageTransfer(value, MessagePortCtor, seen, buffers, ports);
    }
    return {
      cloned: clonePostMessageValue(message, buffers),
      ports: transferPostMessagePorts(ports),
    };
  };
  const frameContext = getInternalState().frameContext;
  const createParentWindowStub = function (): any {
    if (!frameContext) return null;
    const stub: any = {
      closed: false,
      location: { href: "", toString: () => "" },
      frames: [],
      postMessage(...args: unknown[]) {
        const { target, transfer } = pmParseArgs(args);
        const dataJson = pmSerialize(args[0]);
        pmSerializeWithTransfer(undefined, transfer);
        sendUpstreamEvent({
          event: "kitesurf.postMessage",
          params: {
            toParent: true,
            dataJson,
            targetOrigin: target,
            sourceOrigin: ownOrigin,
          },
        });
      },
      focus() {},
      blur() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return true;
      },
    };
    stub.self = stub;
    stub.window = stub;
    stub.parent = stub;
    stub.top = stub;
    return stub;
  };
  const parentWindowStub = createParentWindowStub();
  windowObj.postMessage = function (...args: unknown[]) {
    const { target, transfer } = pmParseArgs(args);
    const { cloned, ports } = pmSerializeWithTransfer(args[0], transfer);
    if (target !== "*" && target !== "/" && target !== ownOrigin) return;
    setTimeout(() => {
      try {
        dispatchOnKey(WINDOW_KEY, postMessageEvent(cloned, ownOrigin, window, ports));
      } catch {}
    }, 0);
  };

  Object.defineProperties(windowObj, {
    window: {
      get: () => window,
      set: undefined,
      enumerable: true,
      configurable: false,
    },
    document: {
      get: () => document,
      set: undefined,
      enumerable: true,
      configurable: false,
    },
    location: {
      get: () => location,
      set: (v: any) => {
        location.href = String(v);
      },
      enumerable: true,
      configurable: false,
    },
    top: {
      get: () => parentWindowStub ?? window,
      set: undefined,
      enumerable: true,
      configurable: false,
    },
    parent: {
      get: () => parentWindowStub ?? window,
      set: undefined,
      enumerable: true,
      configurable: true,
    },
  });

  const pageDefinedGetters = new Set<PropertyKey>();
  const windowFunctionNeedsNoBinding = (fn: Function, prop: PropertyKey): boolean => {
    if (Reflect.get(fn, KS_NO_BIND) || pageAssigned.has(fn)) return true;
    return typeof prop === "string" && windowHandlerNames.has(prop);
  };
  const isWindowConstructor = (fn: Function): boolean => {
    try {
      return !!fn.prototype && fn.prototype.constructor === fn;
    } catch {
      return false;
    }
  };
  const isGlobalConstructor = (fn: Function): boolean => {
    try {
      return Object.prototype.hasOwnProperty.call(fn, "prototype") && fn.prototype != null;
    } catch {
      return false;
    }
  };
  const bindAndCacheFunction = (
    fn: Function,
    receiver: unknown,
    cache: WeakMap<Function, Function>,
    prop: PropertyKey,
  ): Function => {
    const cached = cache.get(fn);
    if (cached) return cached;
    const bound = bindKeepingIdlShape(fn, receiver);
    getInternalState().markNative?.(bound, typeof prop === "string" ? prop : "");
    cache.set(fn, bound);
    return bound;
  };
  const bindWindowFunction = (fn: Function, prop: PropertyKey): Function => {
    if (windowFunctionNeedsNoBinding(fn, prop) || isWindowConstructor(fn)) return fn;
    return bindAndCacheFunction(fn, windowObj, boundFromWindow, prop);
  };
  const bindGlobalFunction = (fn: Function, prop: PropertyKey): Function => {
    if (pageAssigned.has(fn) || isGlobalConstructor(fn) || !isRuntimeNative(fn)) return fn;
    return bindAndCacheFunction(fn, globalThis, boundFromGlobal, prop);
  };
  const readOwnWindowValue = (prop: PropertyKey): unknown => {
    const value = windowObj[prop];
    return typeof value === "function" ? bindWindowFunction(value, prop) : value;
  };
  const readGlobalValue = (prop: PropertyKey): unknown => {
    const value = ksGlobal[prop];
    if (value === undefined && !(prop in globalThis)) return namedAccess(prop);
    return typeof value === "function" ? bindGlobalFunction(value, prop) : value;
  };
  const isAccessorDescriptor = (descriptor: PropertyDescriptor): boolean =>
    descriptor.get !== undefined || descriptor.set !== undefined;
  const accessorDescriptorBlocksWrite = (
    descriptor: PropertyDescriptor,
    prop: PropertyKey,
  ): boolean => {
    if (!isAccessorDescriptor(descriptor) || descriptor.set !== undefined) return false;
    return descriptor.configurable === false || pageDefinedGetters.has(prop);
  };
  const dataDescriptorBlocksWrite = (descriptor: PropertyDescriptor, value: unknown): boolean =>
    descriptor.configurable === false &&
    !isAccessorDescriptor(descriptor) &&
    !descriptor.writable &&
    !Object.is(descriptor.value, value);
  const canWriteWindowValue = (
    descriptor: PropertyDescriptor | undefined,
    prop: PropertyKey,
    value: unknown,
  ): boolean => {
    if (!descriptor) return true;
    if (accessorDescriptorBlocksWrite(descriptor, prop)) return false;
    if (dataDescriptorBlocksWrite(descriptor, value)) return false;
    return true;
  };
  const writeWindowObjectValue = (prop: PropertyKey, value: unknown): void => {
    try {
      windowObj[prop] = value;
    } catch {}
  };
  const writeGlobalValue = (prop: PropertyKey, value: unknown): void => {
    try {
      ksGlobal[prop] = value;
    } catch {}
  };
  const shouldWriteGlobalValue = (onGlobal: boolean, onWindow: boolean): boolean =>
    onGlobal || !onWindow;
  const writeWindowValue = (prop: PropertyKey, value: unknown): void => {
    if (typeof value === "function") pageAssigned.add(value);
    const onWindow = prop in windowObj;
    const onGlobal = prop in ksGlobal;
    if (onWindow) writeWindowObjectValue(prop, value);
    if (shouldWriteGlobalValue(onGlobal, onWindow)) writeGlobalValue(prop, value);
  };
  const descriptorHasValueOrAccessors = (descriptor: PropertyDescriptor): boolean =>
    "value" in descriptor || descriptor.get !== undefined || descriptor.set !== undefined;
  const shouldMirrorDescriptor = (prop: PropertyKey, descriptor: PropertyDescriptor): boolean => {
    if (typeof prop !== "string") return false;
    if (!descriptorHasValueOrAccessors(descriptor)) return false;
    if (Object.prototype.hasOwnProperty.call(windowObj, prop)) return false;
    return !(prop in ksGlobal);
  };
  const markPageAssignedDescriptor = (descriptor: PropertyDescriptor): void => {
    if (typeof descriptor.value === "function") pageAssigned.add(descriptor.value);
  };
  const updatePageGetterTracking = (prop: PropertyKey, descriptor: PropertyDescriptor): void => {
    const isGetterOnly = descriptor.get !== undefined && descriptor.set === undefined;
    if (isGetterOnly) pageDefinedGetters.add(prop);
    else pageDefinedGetters.delete(prop);
  };
  const descriptorGetter = (prop: PropertyKey, descriptor: PropertyDescriptor) =>
    descriptor.get ? () => windowObj[prop] : undefined;
  const descriptorSetter = (prop: PropertyKey, descriptor: PropertyDescriptor) =>
    descriptor.set
      ? (value: unknown) => {
          windowObj[prop] = value;
        }
      : undefined;
  const mirrorAccessorDescriptorToGlobal = (
    prop: PropertyKey,
    descriptor: PropertyDescriptor,
  ): void => {
    Reflect.defineProperty(ksGlobal, prop, {
      get: descriptorGetter(prop, descriptor),
      set: descriptorSetter(prop, descriptor),
      enumerable: descriptor.enumerable ?? false,
      configurable: true,
    });
  };
  const mirrorDescriptorToGlobal = (prop: PropertyKey, descriptor: PropertyDescriptor): void => {
    try {
      if ("value" in descriptor) {
        ksGlobal[prop] = descriptor.value;
        return;
      }
      mirrorAccessorDescriptorToGlobal(prop, descriptor);
    } catch {}
  };
  // Preserve target descriptors before global fallback to satisfy Window's Proxy invariants.
  const window = new Proxy(windowObj, {
    has(_t, prop) {
      if (prop in windowObj || prop in globalThis) return true;
      return namedAccess(prop) !== undefined;
    },
    get(_t, prop) {
      if (prop in windowObj) return readOwnWindowValue(prop);
      return readGlobalValue(prop);
    },
    getOwnPropertyDescriptor(t, prop) {
      const own = Object.getOwnPropertyDescriptor(t, prop);
      if (own) return own;
      const el = namedAccess(prop);
      if (el !== undefined) {
        return { value: el, writable: true, enumerable: false, configurable: true };
      }
      return undefined;
    },
    set(_t, prop, value) {
      const guard = Reflect.getOwnPropertyDescriptor(windowObj, prop);
      if (!canWriteWindowValue(guard, prop, value)) return false;
      writeWindowValue(prop, value);
      return true;
    },
    defineProperty(_t, prop, desc) {
      const mirror = shouldMirrorDescriptor(prop, desc);
      markPageAssignedDescriptor(desc);
      const ok = Reflect.defineProperty(windowObj, prop, desc);
      if (!ok) return false;
      updatePageGetterTracking(prop, desc);
      if (mirror) mirrorDescriptorToGlobal(prop, desc);
      return ok;
    },
  });

  setWindowObj(windowObj);
  setWindowProxy(window);

  return { window, windowObj, Window };
}

// Every owner is recorded, so reclaiming one node keeps the accessor for a connected same-ID node.
// The accessor is installed only once an owner is in the document: a detached-only ID must leave
// `name in window` false and a bare read a ReferenceError.
export function stampNamedGlobal(nodeId: number, name: string): void {
  recordNamedGlobal(nodeId, name, isConnectedNode(nodeId));
}

function isRecordableNamedGlobal(name: string): boolean {
  return typeof name === "string" && name.length > 0 && !/^[0-9_$]/.test(name);
}

function namedGlobalEntry(name: string) {
  let entry = stampedNames.get(name);
  if (!entry) {
    entry = { getter: () => namedGlobalValue(name), nodeIds: new Set() };
    stampedNames.set(name, entry);
  }
  return entry;
}

function installNamedGlobalAccessor(name: string, getter: () => unknown): void {
  try {
    Object.defineProperty(ksGlobal, name, {
      configurable: true,
      enumerable: true,
      get: getter,
      set(value: unknown) {
        stampedNames.delete(name);
        Object.defineProperty(ksGlobal, name, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      },
    });
  } catch {}
}

function recordNamedGlobal(nodeId: number, name: string, connected: boolean): void {
  if (nodeIdName.get(nodeId) !== name) forgetIdGlobal(nodeId);
  if (!isRecordableNamedGlobal(name)) return;
  nodeIdName.set(nodeId, name);
  const entry = namedGlobalEntry(name);
  entry.nodeIds.add(nodeId);
  // An own property here is a real global or the page's own; a named property never shadows it.
  if (!connected || isReservedGlobalName(name)) return;
  installNamedGlobalAccessor(name, entry.getter);
}

function isConnectedNode(nodeId: number): boolean {
  const docId = getDocId();
  if (docId < 0) return false;
  try {
    return dom.isInclusiveAncestor(docId, nodeId);
  } catch {
    return false;
  }
}

// Insertion is when a detached owner's name becomes visible. Read IDs from
// wasm so a page-replaced querySelectorAll or getAttribute is never called.
export function stampConnectedNamedGlobals(rootId: number): void {
  if (!isConnectedNode(rootId)) return;
  const rootIdAttr = idAttributeOf(rootId);
  if (rootIdAttr !== null) recordNamedGlobal(rootId, rootIdAttr, true);
  stampSubtreeIds(rootId, true);
}

function idAttributeOf(nodeId: number): string | null {
  try {
    return idFromNodeInfo(dom.nodeInfo(nodeId));
  } catch {
    return null;
  }
}

// Descendants only: the selector engine scopes to the root and skips it.
function stampSubtreeIds(rootId: number, connected: boolean) {
  try {
    for (const nodeId of dom.querySelectorAllInSubtree(rootId, "[id]")) {
      const id = idAttributeOf(nodeId);
      if (id !== null) recordNamedGlobal(nodeId, id, connected);
    }
  } catch {}
}

// The accessor behind a bare ID, resolved through blitz's ID map. Frame names without a
// matching ID go through the window proxy instead, which scans every iframe and would make
// each bare read O(document).
function isNamedIframeElement(element: any, name: string): boolean {
  return element.localName === "iframe" && element.getAttribute("name") === name;
}

function namedGlobalElementValue(element: any, name: string): unknown {
  if (!element) return undefined;
  if (!isNamedIframeElement(element, name)) return element;
  const frame: NamedIframe = element;
  return frame.contentWindow ?? undefined;
}

function namedGlobalValue(name: string): unknown {
  try {
    const el = documentImpl?.getElementById(name);
    return namedGlobalElementValue(el, name);
  } catch {
    return undefined;
  }
}

interface NamedIframe {
  getAttribute?(name: string): string | null;
  readonly contentWindow?: unknown;
}
interface IframeRoot {
  querySelectorAll(selector: "iframe"): Iterable<NamedIframe>;
}
let iframesDoc: IframeRoot | null = null;
let iframesSeq = -1;
let iframesList: NamedIframe[] = [];
function documentIframes(doc: IframeRoot): NamedIframe[] {
  const seq = ksState().childSeq | 0;
  if (doc !== iframesDoc || seq !== iframesSeq) {
    iframesList = Array.from(doc.querySelectorAll("iframe"));
    iframesDoc = doc;
    iframesSeq = seq;
  }
  return iframesList;
}

type NamedIframeAccess = { matched: false } | { matched: true; value: unknown };

function iframeNamedAccess(iframe: NamedIframe, prop: string): NamedIframeAccess | null {
  try {
    if (iframe.getAttribute?.("name") === prop) {
      return { matched: true, value: iframe.contentWindow ?? undefined };
    }
  } catch {}
  return null;
}

function namedIframeAccess(doc: IframeRoot, prop: string): NamedIframeAccess {
  for (const iframe of documentIframes(doc)) {
    const access = iframeNamedAccess(iframe, prop);
    if (access) return access;
  }
  return { matched: false };
}

function indexedNamedFrameAt(doc: IframeRoot | null | undefined, index: number): unknown {
  if (!doc?.querySelectorAll) return undefined;
  return documentIframes(doc)[index]?.contentWindow ?? undefined;
}

function indexedNamedFrameAccess(prop: string): unknown {
  try {
    return indexedNamedFrameAt(documentImpl, Number(prop));
  } catch {
    return undefined;
  }
}

function namedFrameAccess(doc: IframeRoot | null, prop: string): NamedIframeAccess {
  if (!doc?.querySelectorAll) return { matched: false };
  return namedIframeAccess(doc, prop);
}

function namedElementById(doc: typeof documentImpl, prop: string): unknown {
  if (!doc || typeof doc.getElementById !== "function") return undefined;
  const element = doc.getElementById(prop);
  return element ? element : undefined;
}

function namedAccessByName(prop: string): unknown {
  try {
    const doc = documentImpl;
    const iframe = namedFrameAccess(doc, prop);
    if (iframe.matched) return iframe.value;
    return namedElementById(doc, prop);
  } catch {}
  return undefined;
}

function namedAccess(prop: any) {
  if (typeof prop !== "string" || prop.length === 0) return undefined;
  if (/^\d+$/.test(prop)) return indexedNamedFrameAccess(prop);
  if (/^[_$]/.test(prop)) return undefined;
  return namedAccessByName(prop);
}

function stampNamedGlobalElement(node: Element): void {
  const id = node && node.getAttribute && node.getAttribute("id");
  if (typeof id === "string" && id.length > 0) stampNamedGlobal(node._id, id);
}

export function stampSubtreeNamedGlobals(el: Element): void {
  try {
    const withIds = el.querySelectorAll("[id]");
    for (let i = 0; i < withIds.length; i++) stampNamedGlobalElement(withIds[i]);
  } catch {}
}

// Parse-created fragments bypass setAttribute. Record their owners without
// page-replaceable DOM calls; insertion installs the accessors.
export function stampDetachedSubtreeNamedGlobals(rootId: number): void {
  stampSubtreeIds(rootId, isConnectedNode(rootId));
}

const KS_NO_BIND = Symbol("ks-no-bind");
function markNoBind<F extends object>(fn: F, idlName?: string): F {
  try {
    (fn as any)[KS_NO_BIND] = true;
  } catch {}
  if (idlName) {
    try {
      Object.defineProperty(fn, "name", {
        value: idlName,
        writable: false,
        enumerable: false,
        configurable: true,
      });
    } catch {}
  }
  return fn;
}

function isNullishWindowReceiver(self: unknown): boolean {
  return self === null || self === undefined;
}

function isAllowedWindowReceiver(self: unknown): boolean {
  return self === stateWindowObj || self === windowProxy || self === globalThis;
}

function assertWindowReceiver(self: unknown) {
  if (isNullishWindowReceiver(self)) return;
  if (isAllowedWindowReceiver(self)) return;
  throw new TypeError("Illegal invocation");
}

function findIdAttribute(attributes: unknown[]): string | null {
  for (let i = 0; i < attributes.length - 1; i += 2) {
    if (attributes[i] !== "id") continue;
    const id = attributes[i + 1];
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

function idFromNodeInfo(info: unknown) {
  // nodeInfo is wasm-owned; this scan only needs its dynamic attributes field.
  const attributes: unknown = info && (info as { attributes?: unknown }).attributes;
  if (!Array.isArray(attributes)) return null;
  return findIdAttribute(attributes);
}

function initialNamedNodeIds(): Int32Array | null {
  try {
    if (typeof dom.querySelectorAll !== "function") return null;
    return dom.querySelectorAll("[id]");
  } catch {
    return null;
  }
}

function stampInitialNamedGlobalId(nodeId: number): void {
  if (typeof nodeId !== "number" || nodeId <= 0) return;
  const id = idAttributeOf(nodeId);
  // A document-scoped query only returns connected nodes.
  if (id !== null) recordNamedGlobal(nodeId, id, true);
}

export function stampInitialNamedGlobals(): void {
  const ids = initialNamedNodeIds();
  if (!ids || typeof ids !== "object") return;
  for (let i = 0; i < ids.length; i++) stampInitialNamedGlobalId(ids[i]);
}
