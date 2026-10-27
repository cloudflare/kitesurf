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
  ksGlobalByKey,
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
import type { DocumentImpl } from "./document.js";
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

export function locationMutate(
  component: "hash" | "pathname" | "search" | "href",
  value: string,
): void {
  if (!setCurrentUrl) return;
  const cur = locUrl();
  if (!cur) return;
  let next: URL;
  let kind: "hash" | "navigate";
  try {
    if (component === "href") {
      next = new URL(value, cur.toString());
      const sameDocument =
        next.toString() !== cur.toString() &&
        next.toString().split("#")[0] === cur.toString().split("#")[0];
      kind = sameDocument ? "hash" : "navigate";
    } else {
      next = new URL(cur.toString());
      if (component === "hash") {
        const stripped = value.startsWith("#") ? value.slice(1) : value;
        next.hash = stripped;
        kind = "hash";
      } else if (component === "pathname") {
        next.pathname = value;
        kind = "navigate";
      } else if (component === "search") {
        next.search = value;
        kind = "navigate";
      } else {
        return;
      }
    }
  } catch {
    return;
  }
  setCurrentUrl(next.toString(), kind);
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
    set: (v: unknown) => locationMutate("href", String(v)),
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
    set: (v: unknown) => locationMutate("pathname", String(v)),
    enumerable: true,
    configurable: false,
  },
  search: {
    get: () => locUrl()?.search ?? "",
    set: (v: unknown) => locationMutate("search", String(v)),
    enumerable: true,
    configurable: false,
  },
  hash: {
    get: () => locUrl()?.hash ?? "",
    set: (v: unknown) => locationMutate("hash", String(v)),
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
    value: (url: unknown) => locationMutate("href", String(url)),
    writable: false,
    enumerable: true,
    configurable: false,
  },
  replace: {
    value: (url: unknown) => locationMutate("href", String(url)),
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

function isValidCookieName(s: string): boolean {
  if (!s) return false;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch < 0x21 || ch > 0x7e) return false;
    if (ch === 0x28 || ch === 0x29 || ch === 0x2c || ch === 0x2f) return false;
    if (ch >= 0x3a && ch <= 0x40) return false;
    if (ch === 0x5b || ch === 0x5c || ch === 0x5d) return false;
    if (ch === 0x7b || ch === 0x7d) return false;
    if (ch === 0x22) return false;
  }
  return true;
}
function isValidCookieValue(s: string): boolean {
  let v = s;
  if (v.length >= 2 && v.charCodeAt(0) === 0x22 && v.charCodeAt(v.length - 1) === 0x22) {
    v = v.slice(1, -1);
  }
  for (let i = 0; i < v.length; i++) {
    const ch = v.charCodeAt(i);
    if (ch < 0x21 || ch > 0x7e) return false;
    if (ch === 0x22 || ch === 0x2c || ch === 0x3b || ch === 0x5c) return false;
  }
  return true;
}

export function applyLocalCookieWrite(raw: unknown): void {
  if (typeof raw !== "string") return;
  const trimmed = raw.trim();
  if (!trimmed) return;
  const segs = trimmed
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segs.length === 0) return;
  const first = segs[0];
  const eq = first.indexOf("=");
  if (eq < 0) return;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return;
  if (!isValidCookieName(name)) return;
  if (!isValidCookieValue(value)) return;

  let expiresAt: number | null = null;
  for (let i = 1; i < segs.length; i++) {
    const seg = segs[i];
    const seqEq = seg.indexOf("=");
    if (seqEq < 0) continue;
    const attrName = seg.slice(0, seqEq).trim().toLowerCase();
    const attrVal = seg.slice(seqEq + 1).trim();
    if (attrName === "max-age") {
      const ma = Number(attrVal);
      if (Number.isFinite(ma)) expiresAt = Date.now() + ma * MS_PER_SECOND;
    } else if (attrName === "expires" && expiresAt == null) {
      const t = Date.parse(attrVal);
      if (Number.isFinite(t)) expiresAt = t;
    }
  }
  const isDelete = expiresAt != null && expiresAt <= Date.now();

  const parts = cookieString ? cookieString.split("; ").filter(Boolean) : [];
  let replaced = false;
  for (let i = 0; i < parts.length; i++) {
    const peq = parts[i].indexOf("=");
    const pname = peq < 0 ? parts[i] : parts[i].slice(0, peq);
    if (pname === name) {
      if (isDelete) {
        parts.splice(i, 1);
      } else {
        parts[i] = name + "=" + value;
      }
      replaced = true;
      break;
    }
  }
  if (!replaced && !isDelete) parts.push(name + "=" + value);
  setCookieString(parts.join("; "));
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

// Keys page code adds, and the keys the window Proxy forwards by name.
type Expandos = { [key: string]: unknown; [key: symbol]: unknown };
// The [LegacyUnforgeable] accessors (and [Replaceable] parent) that
// installWindow defines after the window literal.
interface WindowAccessors<W> {
  readonly window: W;
  readonly document: DocumentImpl;
  location: LocationSurface;
  readonly top: W | ParentWindowStub;
  readonly parent: W | ParentWindowStub;
}
// window.parent and window.top in an OOPIF child isolate.
interface ParentWindowStub {
  closed: boolean;
  location: { href: string; toString(): string };
  frames: never[];
  postMessage(...args: unknown[]): void;
  focus(): void;
  blur(): void;
  addEventListener(): void;
  removeEventListener(): void;
  dispatchEvent(): boolean;
  self?: ParentWindowStub;
  window?: ParentWindowStub;
  parent?: ParentWindowStub;
  top?: ParentWindowStub;
}
// The window object (windowObj) and its Proxy (window) share this type.
export type ShimWindow = ReturnType<typeof installWindow>["windowObj"];

// The return type is the window literal's own, inferred inside buildWindow.
export function installWindow(document: DocumentImpl): ReturnType<typeof buildWindow> {
  return buildWindow(document);
}

function buildWindow(document: DocumentImpl) {
  type HistoryEntry = { url: string; state: unknown };

  const historyStack: HistoryEntry[] = [{ url: getCurrentUrl() || "", state: null }];
  let historyIndex = 0;

  const resolveHistoryUrl = (
    rawUrl: string | null | undefined,
    method: "pushState" | "replaceState",
  ): string => {
    const cur = locUrl();
    const curStr = cur?.toString() ?? "";
    if (rawUrl === undefined || rawUrl === null) {
      return historyStack[historyIndex]?.url ?? curStr;
    }
    let target: URL;
    try {
      target = new URL(String(rawUrl), curStr || undefined);
    } catch {
      throw new ksGlobal.DOMException(
        `Failed to execute '${method}' on 'History': '${rawUrl}' could not be parsed as a URL.`,
        "SecurityError",
      );
    }
    if (cur) {
      const sameOrigin = target.origin !== "null" && target.origin === cur.origin;
      const bothOpaqueAndSameScheme =
        target.origin === "null" && cur.origin === "null" && target.protocol === cur.protocol;
      if (!sameOrigin && !bothOpaqueAndSameScheme) {
        throw new ksGlobal.DOMException(
          `Failed to execute '${method}' on 'History': A history state object with URL '${target.toString()}' cannot be created in a document with origin '${cur.origin}' and URL '${curStr}'.`,
          "SecurityError",
        );
      }
    }
    return target.toString();
  };

  const history = {
    get state() {
      return historyStack[historyIndex]?.state ?? null;
    },
    get length() {
      return historyStack.length;
    },
    scrollRestoration: "auto" as "auto" | "manual",
    pushState(state: unknown, _title: string, url?: string | null) {
      const target = resolveHistoryUrl(url, "pushState");
      historyStack.length = historyIndex + 1;
      historyStack.push({ url: target, state: state ?? null });
      historyIndex = historyStack.length - 1;
      if (setCurrentUrl) setCurrentUrl(target, "pushState");
    },
    replaceState(state: unknown, _title: string, url?: string | null) {
      const target = resolveHistoryUrl(url, "replaceState");
      historyStack[historyIndex] = { url: target, state: state ?? null };
      if (setCurrentUrl) setCurrentUrl(target, "replaceState");
    },
    go(n?: number) {
      const delta = n == null ? 0 : Number(n) | 0;
      if (delta === 0) return;
      const target = historyIndex + delta;
      if (target < 0 || target >= historyStack.length) return;
      const prevEntry = historyStack[historyIndex];
      const prevUrl = prevEntry?.url ?? "";
      historyIndex = target;
      const nextEntry = historyStack[historyIndex];
      const nextUrl = nextEntry?.url ?? "";
      const sameDoc = prevUrl.split("#")[0] === nextUrl.split("#")[0];
      if (setCurrentUrl) {
        setCurrentUrl(nextUrl, sameDoc ? "hash" : "historyApi");
      }
      const stateForPopstate = nextEntry?.state ?? null;
      const queuePopstate = (cb: () => void) => {
        try {
          ksGlobal.setTimeout(cb, 0);
        } catch {
          try {
            cb();
          } catch {}
        }
      };
      queuePopstate(() => {
        try {
          const ev = new KsPopStateEvent("popstate", {
            bubbles: false,
            cancelable: false,
            state: stateForPopstate,
          });
          dispatchTrustedOnKey(WINDOW_KEY, ev);
        } catch {}
      });
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

  const windowLiteral = {
    get navigator() {
      return navigator;
    },
    get history() {
      return history;
    },
    get self(): WindowObj {
      return window;
    },
    get parent(): WindowObj {
      return window;
    },
    get frames(): WindowObj {
      return window;
    },
    get length() {
      try {
        return documentImpl?.querySelectorAll("iframe").length ?? 0;
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
    scrollTo(_xOrOptions?: unknown, _y?: unknown) {
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
    scroll(this: { scrollTo(...args: unknown[]): unknown }, ...args: unknown[]) {
      return this.scrollTo(...args);
    },
    scrollBy(_xOrOptions?: unknown, _y?: unknown) {
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
    getComputedStyle(element: unknown, pseudoArg?: unknown) {
      return windowObj[GET_COMPUTED_STYLE_INTERNAL](element, pseudoArg, false);
    },
    [GET_COMPUTED_STYLE_INTERNAL](
      element: unknown,
      pseudoArg?: unknown,
      computedValuesOnly = false,
    ) {
      const nodeId =
        typeof element === "object" &&
        element !== null &&
        "_id" in element &&
        typeof element._id === "number"
          ? element._id
          : -1;
      const pseudoNorm = (() => {
        if (pseudoArg == null || pseudoArg === "") return "";
        const p = String(pseudoArg).trim().replace(/^:+/, "").toLowerCase();
        return ["before", "after", "marker", "selection", "first-letter"].includes(p)
          ? "::" + p
          : "";
      })();
      const hasNodeId = nodeId >= 0 && !!getComputedStyleForAuthId;
      let cachedSeq = -1;
      let cachedMap: Map<string, string> | null = null;
      let cachedUnresolved: Map<string, string> | null = null;
      let cachedCssText: string | null = null;
      const valueForAuthId = getComputedStyleValueForAuthId;
      const singleOk = hasNodeId && !pseudoNorm && !computedValuesOnly && !!valueForAuthId;
      let singleSeq = -1;
      let singleValues: Map<string, string> | null = null;
      function single(dash: string): string | null {
        const curSeq = ksState().mutationSeq | 0;
        if (cachedMap !== null && cachedSeq === curSeq) return null;
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
      }
      function resolve(): Map<string, string> | null {
        if (!hasNodeId) return null;
        const curSeq = ksState().mutationSeq | 0;
        if (cachedMap !== null && cachedSeq === curSeq) return cachedMap;
        const props = ksSpan("dom.getComputedStyle", null, () =>
          getComputedStyleForAuthId?.(nodeId, pseudoNorm || undefined),
        );
        if (!Array.isArray(props)) {
          cachedMap = null;
          cachedUnresolved = null;
          cachedCssText = null;
          cachedSeq = curSeq;
          return null;
        }
        const map = new Map<string, string>();
        const unresolved = new Map<string, string>();
        for (const p of props) {
          if (p && typeof p.name === "string") {
            const value =
              computedValuesOnly && typeof p.computed === "string" ? p.computed : p.value;
            map.set(p.name, String(value ?? ""));
            if (!computedValuesOnly && typeof p.unresolved === "string") {
              unresolved.set(p.name, p.unresolved);
            }
          }
        }
        cachedMap = map;
        cachedUnresolved = unresolved;
        cachedCssText = null;
        cachedSeq = curSeq;
        return map;
      }
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
      function lookup(prop: string): string {
        const dash = prop.indexOf("-") >= 0 ? prop : cssPropCamelToKebab(prop);
        if (singleOk) {
          const value = single(dash);
          if (value !== null) return value;
        }
        const map = resolve();
        if (!map) return "";
        const direct = map.get(dash);
        if (direct !== undefined) return direct;
        return lookupViaStylo(map, dash);
      }
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
          // Custom properties live only on the single-value path: the bulk longhand list has none.
          if (k.startsWith("--")) {
            if (!hasNodeId || pseudoNorm || !valueForAuthId) return "";
            const value = valueForAuthId(nodeId, k);
            return typeof value === "string" ? value : "";
          }
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
    getSelection: markNoBind(function (this: unknown) {
      assertWindowReceiver(this);
      return selectionSingleton();
    }, "getSelection"),
    addEventListener(type: string, listener: unknown, options?: unknown) {
      if (arguments.length < 2) {
        throw new TypeError(
          "Failed to execute 'addEventListener' on 'EventTarget': 2 arguments required, but only " +
            arguments.length +
            " present.",
        );
      }
      addListener(WINDOW_KEY, type, listener, options);
    },
    removeEventListener(type: string, listener: unknown, options?: unknown) {
      if (arguments.length < 2) {
        throw new TypeError(
          "Failed to execute 'removeEventListener' on 'EventTarget': 2 arguments required, but only " +
            arguments.length +
            " present.",
        );
      }
      removeListener(WINDOW_KEY, type, listener, options);
    },
    dispatchEvent(event: unknown) {
      return dispatchOnKey(WINDOW_KEY, event);
    },
    event: undefined as unknown,
    // Return the runtime callback directly; a forwarding wrapper can re-enter its wasm FnMut.
    get requestAnimationFrame(): unknown {
      const g = ksGlobal.requestAnimationFrame;
      if (typeof g === "function") return g;
      return (rafFallbackFn ??= (cb) => setTimeout(() => cb(Date.now()), RAF_FALLBACK_DELAY_MS));
    },
    set requestAnimationFrame(v: unknown) {
      ksGlobalByKey.requestAnimationFrame = v;
    },
    get cancelAnimationFrame(): unknown {
      const g = ksGlobal.cancelAnimationFrame;
      if (typeof g === "function") return g;
      // The page's id goes to clearTimeout unchanged; it converts it itself.
      return (cafFallbackFn ??= (id) => clearTimeout(id as number));
    },
    set cancelAnimationFrame(v: unknown) {
      ksGlobalByKey.cancelAnimationFrame = v;
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
    open: (url?: unknown, _target?: unknown, _features?: unknown) => {
      const raw = url == null || url === "" ? "about:blank" : String(url);
      const base =
        typeof windowObj.document !== "undefined" &&
        windowObj.document &&
        typeof windowObj.document.baseURI === "string"
          ? windowObj.document.baseURI
          : undefined;
      try {
        new URL(raw, base);
      } catch {
        throw new ksGlobal.DOMException(
          "Failed to execute 'open' on 'Window': '" + raw + "' is not a valid URL.",
          "SyntaxError",
        );
      }
      const stub = {
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
    },
  };

  class Window {}
  Object.setPrototypeOf(windowLiteral, Window.prototype);
  // defineProperties below adds the [LegacyUnforgeable] accessors the
  // literal leaves out, and page code or the Proxy traps may write any key.
  type WindowObj = typeof windowLiteral & WindowAccessors<WindowObj> & Expandos;
  const windowObj = windowLiteral as WindowObj;

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

  for (const m of ["blur", "close", "focus", "print", "stop", "captureEvents", "releaseEvents"]) {
    if (typeof Reflect.get(windowObj, m) === "function") continue;
    Reflect.set(windowObj, m, { [m]: function () {} }[m]);
  }

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
  const pmConvertTransfer = (raw: unknown): object[] => {
    if (raw === undefined) return [];
    if (
      raw === null ||
      typeof raw !== "object" ||
      typeof (raw as Partial<Iterable<unknown>>)[Symbol.iterator] !== "function"
    ) {
      throw new TypeError(
        "Failed to execute 'postMessage' on 'Window': The provided value cannot be converted to a sequence.",
      );
    }
    const out: object[] = [];
    for (const v of raw as Iterable<unknown>) {
      if (v === null || (typeof v !== "object" && typeof v !== "function")) {
        throw new TypeError(
          "Failed to execute 'postMessage' on 'Window': Transferable entry is not an object.",
        );
      }
      out.push(v as object);
    }
    return out;
  };
  const pmParseArgs = (args: readonly unknown[]): { target: string; transfer: object[] } => {
    if (args.length === 0) {
      throw new TypeError(
        "Failed to execute 'postMessage' on 'Window': 1 argument required, but only 0 present.",
      );
    }
    let targetOrigin: unknown = args[1];
    let rawTransfer: unknown = args.length >= 3 ? args[2] : undefined;
    if (
      args.length < 3 &&
      targetOrigin !== undefined &&
      (targetOrigin === null || typeof targetOrigin === "object")
    ) {
      const opts = (targetOrigin ?? {}) as {
        targetOrigin?: unknown;
        transfer?: unknown;
      };
      rawTransfer = opts.transfer;
      targetOrigin = opts.targetOrigin;
    }
    return {
      target: pmCheckTargetOrigin(targetOrigin),
      transfer: pmConvertTransfer(rawTransfer),
    };
  };
  const pmSerializeWithTransfer = (
    message: unknown,
    transfer: readonly object[],
  ): { cloned: unknown; ports: Idl.MessagePort[] } => {
    const MP = (globalThis as { MessagePort?: unknown }).MessagePort;
    const seen = new Set<object>();
    const buffers: ArrayBuffer[] = [];
    const ports: PmTransferablePort[] = [];
    for (const t of transfer) {
      if (seen.has(t)) {
        throw pmDataCloneError("Duplicate transferable in transfer list.");
      }
      seen.add(t);
      if (typeof MP === "function" && t instanceof MP) {
        const port = t as PmTransferablePort;
        if (port._closed || port._detached) {
          throw pmDataCloneError("MessagePort is already detached.");
        }
        ports.push(port);
      } else if (t instanceof ArrayBuffer) {
        buffers.push(t);
      } else {
        throw pmDataCloneError("Value is not transferable.");
      }
    }
    const SC = (globalThis as { structuredClone?: PmStructuredClone }).structuredClone;
    let cloned: unknown;
    if (typeof SC === "function") {
      cloned = buffers.length ? SC(message, { transfer: buffers }) : SC(message);
    } else {
      cloned = JSON.parse(pmSerialize(message)) as unknown;
    }
    const outPorts = ports.map(
      (p) => (typeof p.__ksTransfer === "function" ? p.__ksTransfer() : p) as Idl.MessagePort,
    );
    return { cloned, ports: outPorts };
  };
  const frameContext = getInternalState().frameContext;
  const parentWindowStub: ParentWindowStub | null = frameContext
    ? {
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
      }
    : null;
  if (parentWindowStub) {
    parentWindowStub.self = parentWindowStub;
    parentWindowStub.window = parentWindowStub;
    parentWindowStub.parent = parentWindowStub;
    parentWindowStub.top = parentWindowStub;
  }
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
      set: (v: unknown) => {
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

  const pageDefinedGetters = new Set<string | symbol>();
  // Preserve target descriptors before global fallback to satisfy Window's Proxy invariants.
  const window: WindowObj = new Proxy(windowObj, {
    has(_t, prop) {
      if (prop in windowObj || prop in globalThis) return true;
      return namedAccess(prop) !== undefined;
    },
    get(_t, prop) {
      if (prop in windowObj) {
        const v = windowObj[prop];
        if (typeof v !== "function") return v;
        if (Reflect.get(v, KS_NO_BIND) || pageAssigned.has(v)) return v;
        if (typeof prop === "string" && windowHandlerNames.has(prop)) return v;
        try {
          if (v.prototype && v.prototype.constructor === v) return v;
        } catch {}
        const cachedOwn = boundFromWindow.get(v);
        if (cachedOwn) return cachedOwn;
        const own = bindKeepingIdlShape(v, windowObj);
        getInternalState().markNative?.(own, typeof prop === "string" ? prop : "");
        boundFromWindow.set(v, own);
        return own;
      }
      const v = ksGlobalByKey[prop];
      if (v === undefined && !(prop in globalThis)) {
        const named = namedAccess(prop);
        if (named !== undefined) return named;
        return undefined;
      }
      if (typeof v !== "function") return v;
      if (pageAssigned.has(v)) return v;
      try {
        if (Object.prototype.hasOwnProperty.call(v, "prototype") && v.prototype != null) {
          return v;
        }
      } catch {}
      const cached = boundFromGlobal.get(v);
      if (cached) return cached;
      if (!isRuntimeNative(v)) return v;
      // Preserve globalThis as receiver for runtime-native functions exposed through this fallback.
      const bound = bindKeepingIdlShape(v, globalThis);
      getInternalState().markNative?.(bound, typeof prop === "string" ? prop : "");
      boundFromGlobal.set(v, bound);
      return bound;
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
      if (guard) {
        const isAccessor = guard.get !== undefined || guard.set !== undefined;
        if (
          isAccessor &&
          guard.set === undefined &&
          (guard.configurable === false || pageDefinedGetters.has(prop))
        ) {
          return false;
        }
        if (
          guard.configurable === false &&
          !isAccessor &&
          !guard.writable &&
          !Object.is(guard.value, value)
        ) {
          return false;
        }
      }
      const onWindow = prop in windowObj;
      const onGlobal = prop in ksGlobal;
      if (typeof value === "function") pageAssigned.add(value);
      if (onWindow) {
        try {
          windowObj[prop] = value;
        } catch {}
      }
      if (onGlobal || !onWindow) {
        try {
          ksGlobalByKey[prop] = value;
        } catch {}
      }
      return true;
    },
    defineProperty(_t, prop, desc) {
      const mirror =
        typeof prop === "string" &&
        desc &&
        ("value" in desc || desc.get !== undefined || desc.set !== undefined) &&
        !Object.prototype.hasOwnProperty.call(windowObj, prop) &&
        !(prop in ksGlobal);
      if (desc && typeof desc.value === "function") pageAssigned.add(desc.value);
      const ok = Reflect.defineProperty(windowObj, prop, desc);
      if (ok) {
        const isGetterOnly = desc !== undefined && desc.get !== undefined && desc.set === undefined;
        if (isGetterOnly) pageDefinedGetters.add(prop);
        else pageDefinedGetters.delete(prop);
      }
      if (ok && mirror) {
        try {
          if ("value" in desc) {
            ksGlobalByKey[prop] = desc.value;
          } else {
            Reflect.defineProperty(ksGlobal, prop, {
              get: desc.get ? () => windowObj[prop] : undefined,
              set: desc.set
                ? (v: unknown) => {
                    windowObj[prop] = v;
                  }
                : undefined,
              enumerable: desc.enumerable ?? false,
              configurable: true,
            });
          }
        } catch {}
      }
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

function recordNamedGlobal(nodeId: number, name: string, connected: boolean): void {
  if (nodeIdName.get(nodeId) !== name) forgetIdGlobal(nodeId);
  if (typeof name !== "string" || name.length === 0) return;
  if (/^[0-9_$]/.test(name)) return;
  nodeIdName.set(nodeId, name);
  let entry = stampedNames.get(name);
  if (!entry) {
    entry = { getter: () => namedGlobalValue(name), nodeIds: new Set() };
    stampedNames.set(name, entry);
  }
  entry.nodeIds.add(nodeId);
  // An own property here is a real global or the page's own; a named property never shadows it.
  if (!connected || isReservedGlobalName(name)) return;
  const getter = entry.getter;
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
function namedGlobalValue(name: string): unknown {
  try {
    const el = documentImpl?.getElementById(name);
    if (!el) return undefined;
    if (el.localName === "iframe" && el.getAttribute("name") === name) {
      const frame: NamedIframe = el;
      return frame.contentWindow ?? undefined;
    }
    return el;
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

function namedIframeAccess(doc: IframeRoot, prop: string): NamedIframeAccess {
  for (const iframe of documentIframes(doc)) {
    try {
      if (iframe.getAttribute?.("name") === prop) {
        return { matched: true, value: iframe.contentWindow ?? undefined };
      }
    } catch {}
  }
  return { matched: false };
}

function namedAccess(prop: PropertyKey) {
  if (typeof prop !== "string" || prop.length === 0) return undefined;
  if (/^\d+$/.test(prop)) {
    try {
      const doc = documentImpl;
      const iframes = doc?.querySelectorAll ? documentIframes(doc) : undefined;
      const el = iframes ? iframes[Number(prop)] : undefined;
      return el ? (el.contentWindow ?? undefined) : undefined;
    } catch {
      return undefined;
    }
  }
  if (/^[_$]/.test(prop)) return undefined;
  try {
    const doc = documentImpl;
    if (doc?.querySelectorAll) {
      // A frame name resolves to its window before element lookup; an iframe ID alone still
      // resolves to the element, as in Chrome.
      const iframe = namedIframeAccess(doc, prop);
      if (iframe.matched) return iframe.value;
    }
    if (doc && typeof doc.getElementById === "function") {
      const el = doc.getElementById(prop);
      if (el) return el;
    }
  } catch {}
  return undefined;
}

export function stampSubtreeNamedGlobals(el: Element): void {
  try {
    const withIds = el.querySelectorAll("[id]");
    for (let i = 0; i < withIds.length; i++) {
      const node = withIds[i];
      const id = node && node.getAttribute && node.getAttribute("id");
      if (typeof id === "string" && id.length > 0) stampNamedGlobal(node._id, id);
    }
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
    Reflect.set(fn, KS_NO_BIND, true);
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

function assertWindowReceiver(self: unknown) {
  if (self === null || self === undefined) return;
  if (self === stateWindowObj || self === windowProxy || self === globalThis) return;
  throw new TypeError("Illegal invocation");
}

function idFromNodeInfo(info: unknown) {
  // nodeInfo is wasm-owned; this scan only needs its dynamic attributes field.
  const attributes: unknown = info && (info as { attributes?: unknown }).attributes;
  if (!Array.isArray(attributes)) return null;
  for (let i = 0; i < attributes.length - 1; i += 2) {
    if (attributes[i] !== "id") continue;
    const id = attributes[i + 1];
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

export function stampInitialNamedGlobals(): void {
  let ids: Int32Array | null;
  try {
    ids = dom.querySelectorAll("[id]");
  } catch {
    return;
  }
  for (let i = 0; i < ids.length; i++) {
    const nodeId = ids[i];
    if (typeof nodeId !== "number" || nodeId <= 0) continue;
    const id = idAttributeOf(nodeId);
    // A document-scoped query only returns connected nodes.
    if (id !== null) recordNamedGlobal(nodeId, id, true);
  }
}
